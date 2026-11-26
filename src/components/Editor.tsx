import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadPdf, pdfjs, renderToCanvas, type PDFDocumentProxy } from '../lib/pdf';
import { applyProtection } from '../lib/pdfCrypt';
import type { Annot, DocTab, RedactAnnot, Rect, Snapshot, StyleState, Tool } from '../types';
import { EditorCtx, type EditorApi, type Hit, type PendingImage } from './EditorContext';
import { PageView } from './PageView';
import { Thumbnails, type PageActions } from './Thumbnails';
import { SignatureDialog } from './SignatureDialog';
import { ToolDialog, resolveNumbers, resolveWatermark, type CertSignRequest, type ToolKind, type ToolHandlers } from './ToolDialogs';
import { Icon } from './Icon';
import { bake } from '../lib/bake';
import { applyRedactions } from '../lib/redact';
import { optimize, type OptimizeReport } from '../lib/optimize';
import { signPdf, verifySignatures } from '../lib/digitalSign';
import { FieldProps } from './FieldProps';
import { PickedPicture } from './PickedPicture';
import { listPictures, pictureAt, pictureImage, whiteToTransparent } from '../lib/pagePictures';
import { loadSigs, saveSigs } from '../lib/stamps';
import { shrinkImage } from '../lib/imageShrink';
import * as ops from '../lib/ops';
import * as layout from '../lib/layout';
import * as nav from '../lib/navdata';
import { toPdfA, type PdfaReport } from '../lib/pdfa';
import { PdfaReportDialog } from './LayoutDialogs';
import { fieldSig, importFields, realEdits } from '../lib/formFields';
import { AttachmentsPanel, BookmarksPanel } from './NavPanels';
import { ocrDocument } from '../lib/ocr';
import { exportImages, extractText } from '../lib/convert';
import { baseName, downloadName, uid } from '../lib/util';
import { errText, toast } from '../lib/toast';

const snap = (t: DocTab): Snapshot => ({ bytes: t.bytes, annots: t.annots, form: t.form });

interface Props {
  tab: DocTab;
  onUpdate: (fn: (t: DocTab) => DocTab) => void;
  openNew: (bytes: Uint8Array, name: string) => void;
  registerSave: (fn: (as?: boolean) => Promise<boolean>) => void;
}

const TOOL_GROUPS: { tool: Tool; icon: string; label: string; key?: string }[][] = [
  [
    { tool: 'select', icon: 'select', label: 'Select (V)', key: 'v' },
    { tool: 'hand', icon: 'hand', label: 'Pan (H)', key: 'h' },
  ],
  [
    { tool: 'editText', icon: 'editText', label: 'Edit existing text (E): click any word or line', key: 'e' },
    { tool: 'text', icon: 'text', label: 'Add text (T)', key: 't' },
    { tool: 'move', icon: 'moveTool', label: 'Move (M): drag a box around anything, then drag the box to move it', key: 'm' },
    { tool: 'whiteout', icon: 'whiteout', label: 'Whiteout / cover (W)', key: 'w' },
  ],
  [
    { tool: 'highlight', icon: 'highlight', label: 'Highlight (select text or drag)', key: 'i' },
    { tool: 'underline', icon: 'underline', label: 'Underline', key: 'u' },
    { tool: 'strike', icon: 'strike', label: 'Strikethrough', key: 's' },
    { tool: 'note', icon: 'note', label: 'Comment / sticky note (N)', key: 'n' },
    { tool: 'mark', icon: 'check', label: 'Check mark (K): click a box to tick it with ✓ ✗ or ●', key: 'k' },
  ],
  [
    { tool: 'ink', icon: 'ink', label: 'Draw freehand (D)', key: 'd' },
    { tool: 'rect', icon: 'rect', label: 'Rectangle (R). Shift for square', key: 'r' },
    { tool: 'ellipse', icon: 'ellipse', label: 'Ellipse (O)', key: 'o' },
    { tool: 'line', icon: 'line', label: 'Line (L). Shift snaps 45°', key: 'l' },
    { tool: 'arrow', icon: 'arrow', label: 'Arrow (A)', key: 'a' },
  ],
  [{ tool: 'redact', icon: 'redact', label: 'Redact: permanently removes content on save', key: 'x' }],
  [{ tool: 'field', icon: 'form', label: 'Form designer (F): add fillable fields: text, check box, radio, dropdown, signature', key: 'f' }],
];

/** Toolbar groups (by position in TOOL_GROUPS) that fold into the "More" menu on narrow windows: markup, shapes, form field. */
const OVERFLOW_GROUPS = [2, 3, 5];

/** The tools people look for by name get a visible label, not just an icon. */
const SHORT: Partial<Record<Tool, string>> = {
  editText: 'Edit text',
  move: 'Move',
  text: 'Add text',
  highlight: 'Highlight',
  mark: 'Check',
  field: 'Form field',
};

const COLORS = ['#111111', '#c62828', '#1d5fbf', '#1f8a3b', '#d97706', '#6b3fbf', '#ffffff'];
const HL_COLORS = ['#ffe14d', '#7ee08a', '#7cc7ff', '#ff9ccf', '#ffb35c'];

export function Editor({ tab, onUpdate, openNew, registerSave }: Props) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  // bumps every time a freshly loaded document is shown; keys pages so they never show stale content
  const [loadId, setLoadId] = useState(0);
  const [sizes, setSizes] = useState<{ w: number; h: number }[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [tool, setTool] = useState<Tool>('select');
  const [book, setBook] = useState(false);
  const [style, setStyle] = useState<StyleState>({
    color: '#111111',
    width: 2,
    fontSize: 12,
    fill: null,
    highlight: '#ffe14d',
    mark: 'check',
    markSize: 12,
    dash: false,
    family: 'Arial',
    bold: false,
    italic: false,
    fieldKind: 'text',
  });
  const [fonts, setFonts] = useState<string[]>([]);
  // narrow windows: the markup, shape and form tools move into a "More" menu so the toolbar stays on one line
  const [compact, setCompact] = useState(() => window.innerWidth < 1180);
  const [moreMenu, setMoreMenu] = useState(false);
  const [saveMenu, setSaveMenu] = useState(false);
  useEffect(() => {
    const f = () => setCompact(window.innerWidth < 1180);
    window.addEventListener('resize', f);
    return () => window.removeEventListener('resize', f);
  }, []);
  useEffect(() => {
    window.acro.listFonts().then(setFonts).catch(() => {});
  }, []);
  const [selectedId, setSelected] = useState<string | null>(null);
  const [editingId, setEditing] = useState<string | null>(null);
  const [panel, setPanel] = useState<'pages' | 'search' | 'comments' | 'bookmarks' | 'attachments' | null>('pages');
  const [current, setCurrent] = useState(0);
  const [pendingImage, setPendingImage] = useState<PendingImage | null>(null);
  const [picked, setPicked] = useState<{ dataUrl: string; w: number; h: number; page: number; x: number; y: number } | null>(null);
  const [sigDialog, setSigDialog] = useState<null | { tab?: 'stamp'; field?: { page: number; rect: Rect } }>(null);
  const [toolDialog, setToolDialog] = useState<ToolKind | null>(null);
  const [toolsMenu, setToolsMenu] = useState(false);
  const [menuLeft, setMenuLeft] = useState(false);
  const [pdfaDone, setPdfaDone] = useState<{ report: PdfaReport; saved: string } | null>(null);
  const [busy, setBusy] = useState<{ msg: string; frac?: number } | null>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [activeHit, setActiveHit] = useState(-1);
  const [existingComments, setExistingComments] = useState<{ page: number; author: string; text: string }[]>([]);

  const viewerRef = useRef<HTMLDivElement>(null);
  const pageEls = useRef<(HTMLDivElement | null)[]>([]);
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const pdfRef = useRef(pdf);
  pdfRef.current = pdf;
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;

  // ---------- load ----------
  useEffect(() => {
    let alive = true;
    let doc: PDFDocumentProxy | null = null;
    setLoadError(null);
    loadPdf(tabRef.current.bytes)
      .then(async (d) => {
        doc = d;
        const s = await Promise.all(
          Array.from({ length: d.numPages }, (_, i) =>
            d.getPage(i + 1).then((p) => {
              const v = p.getViewport({ scale: 1 });
              return { w: v.width, h: v.height };
            }),
          ),
        );
        if (!alive) return d.destroy();
        setSizes(s);
        setLoadId((n) => n + 1);
        setPdf((old) => {
          old?.destroy();
          return d;
        });
        // existing comments in the file; text boxes added by other editors (PDFgear etc.) become editable text
        const found: { page: number; author: string; text: string }[] = [];
        const imported: Annot[] = [];
        for (let i = 0; i < Math.min(d.numPages, 300); i++) {
          const pg = await d.getPage(i + 1);
          const vp1 = pg.getViewport({ scale: 1 });
          const anns = await pg.getAnnotations();
          for (const a of anns as any[]) {
            const m = /^(\d+)R(\d*)$/.exec(String(a.id));
            const text = a.textContent?.length ? a.textContent.join('\n') : a.contentsObj?.str || '';
            if (a.subtype !== 'FreeText' || !m || !a.rect || !text.trim() || a.annotationFlags & (2 | 32)) continue;
            const [x1, y1, x2, y2] = vp1.convertToViewportRectangle(a.rect);
            const da = a.defaultAppearanceData;
            const c = da?.fontColor ? Array.from(da.fontColor as ArrayLike<number>).map((n) => Math.round(n).toString(16).padStart(2, '0')).join('') : '000000';
            const fam = String(da?.fontName || 'Arial');
            const box = { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
            imported.push({
              id: uid(), page: i, type: 'replace', ...box, orig: { ...box, h: Math.max(4, box.h - 3) }, text, origText: text, fontSize: da?.fontSize || 12, color: '#' + c,
              family: /^(Helv|Helvetica)$/i.test(fam) ? 'Arial' : fam, font: /times|serif/i.test(fam) ? 'serif' : /cour|mono/i.test(fam) ? 'mono' : 'sans',
              srcAnnot: { num: +m[1], gen: +(m[2] || 0) },
            } as Annot);
          }
          for (const a of anns as any[])
            if (['Text', 'FreeText', 'Highlight', 'Square', 'Ink'].includes(a.subtype) && a.contentsObj?.str)
              found.push({ page: i, author: a.titleObj?.str || '', text: a.contentsObj.str });
        }
        if (alive) setExistingComments(found);
        if (alive && imported.length)
          onUpdateRef.current((t) => {
            const have = new Set(t.annots.map((x) => (x.type === 'replace' && x.srcAnnot ? x.srcAnnot.num : -1)));
            const add = imported.filter((x) => !(x.type === 'replace' && x.srcAnnot && have.has(x.srcAnnot.num)));
            return add.length ? { ...t, annots: [...t.annots, ...add] } : t;
          });
      })
      .catch((e) => {
        if (alive) setLoadError(e?.name === 'PasswordException' ? 'This PDF is password protected. Close it and open it again to type the password.' : errText(e));
      });
    return () => {
      alive = false;
    };
  }, [tab.rev]);

  useEffect(
    () => () => {
      pdfRef.current?.destroy();
    },
    [],
  );

  // Form designer: the fields already in the PDF become editable boxes while the tool is on (see importFields)
  const importedAt = useRef(-1);
  useEffect(() => {
    if (tool === 'field') {
      if (!pdf || importedAt.current === loadId) return;
      importedAt.current = loadId;
      importFields(pdf, tabRef.current.annots, tabRef.current.bytes)
        .then((found) => {
          if (!found.length) return;
          onUpdateRef.current((t) => {
            const have = new Set(t.annots.map((a) => (a.type === 'field' && a.srcField ? a.srcField.id : '')));
            const add = found.filter((f) => !have.has(f.srcField!.id));
            return add.length ? { ...t, annots: [...t.annots, ...add] } : t;
          });
        })
        .catch(() => {});
    } else if (tabRef.current.annots.some((a) => a.type === 'field' && a.srcField && !a.gone && a.srcSig === fieldSig(a) && a.id !== selectedId)) {
      // leaving the tool: fields that were not touched go back to being ordinary live fields
      importedAt.current = -1;
      onUpdateRef.current((t) => ({ ...t, annots: t.annots.filter((a) => !(a.type === 'field' && a.srcField && !a.gone && a.srcSig === fieldSig(a) && a.id !== selectedId)) }));
    }
  }, [tool, pdf, loadId]);

  // fit width on first load
  const didFit = useRef(false);
  useEffect(() => {
    if (!sizes.length || didFit.current) return;
    didFit.current = true;
    fitWidth();
  }, [sizes]);

  const fitWidth = (twoUp = book) => {
    const el = viewerRef.current;
    if (!el || !sizes.length) return;
    const maxW = Math.max(...sizes.map((s) => s.w));
    setZoom(Math.min(3, Math.max(0.25, (el.clientWidth - 64) / (maxW * (twoUp ? 2 : 1)))));
  };
  const fitPage = (twoUp = book) => {
    const el = viewerRef.current;
    if (!el || !sizes.length) return;
    const s = sizes[current] || sizes[0];
    setZoom(Math.max(0.25, Math.min((el.clientWidth - 64) / (s.w * (twoUp ? 2 : 1)), (el.clientHeight - 40) / s.h)));
  };

  // ---------- state mutation helpers ----------
  const mutate = useCallback(
    (fn: (t: DocTab) => Partial<DocTab>, history = true) =>
      onUpdate((t) => ({
        ...t,
        ...(history ? { past: [...t.past.slice(-60), snap(t)], future: [] } : {}),
        ...fn(t),
        dirty: true,
      })),
    [onUpdate],
  );

  const undo = () =>
    onUpdate((t) => {
      if (!t.past.length) return t;
      const prev = t.past[t.past.length - 1];
      return { ...t, ...prev, past: t.past.slice(0, -1), future: [snap(t), ...t.future], rev: prev.bytes !== t.bytes ? t.rev + 1 : t.rev, dirty: true };
    });
  const redo = () =>
    onUpdate((t) => {
      if (!t.future.length) return t;
      const next = t.future[0];
      return { ...t, ...next, future: t.future.slice(1), past: [...t.past, snap(t)], rev: next.bytes !== t.bytes ? t.rev + 1 : t.rev, dirty: true };
    });

  const getViewport = useCallback(async (i: number) => (await pdfRef.current!.getPage(i + 1)).getViewport({ scale: 1 }), []);

  /** Bytes with all pending edits/forms/redactions written in. */
  const produceBytes = useCallback(
    async (opts: { flattenForms?: boolean } = {}) => {
      const t = tabRef.current;
      const normal = realEdits(t.annots).filter((a) => a.type !== 'redact');
      const redacts = t.annots.filter((a): a is RedactAnnot => a.type === 'redact');
      let out = t.bytes;
      if (normal.length || Object.keys(t.form).length || opts.flattenForms)
        out = await bake(out, normal, t.form, getViewport, {
          ...opts,
          author: localStorage.getItem('acro.user') || undefined,
          loadSystemFont: async (family, bold, italic) => {
            const r = await window.acro.loadFont({ family, bold, italic });
            return r ? { data: r.data, italic: (r as { italic?: boolean }).italic } : null;
          },
        });
      if (redacts.length)
        out = await applyRedactions(out, redacts, (r) =>
          toast(`Redacted ${r.boxes} area${r.boxes === 1 ? '' : 's'} on ${r.pages} page${r.pages === 1 ? '' : 's'}. ${r.textRemoved} piece${r.textRemoved === 1 ? '' : 's'} of text removed for good. ${r.asPicture ? `${r.asPicture} page${r.asPicture === 1 ? '' : 's'} became a picture because something other than plain text was under a box.` : 'The page text stays editable.'} Checked: nothing is left underneath.`, 'ok'),
        );
      return out;
    },
    [getViewport],
  );

  /** Run a page-level operation on the current (baked) bytes. */
  const run = useCallback(
    async (label: string, fn: (bytes: Uint8Array) => Promise<Uint8Array>) => {
      setBusy({ msg: label });
      try {
        const base = await produceBytes();
        const out = await fn(base);
        mutate((t) => ({ bytes: out, annots: [], form: {}, rev: t.rev + 1 }));
        setSelected(null);
        return true;
      } catch (e) {
        toast(errText(e), 'error');
        return false;
      } finally {
        setBusy(null);
      }
    },
    [produceBytes, mutate],
  );

  // delete a picture for real right away (bake it into the file and re-draw the page), instead of faking it with a preview
  const commitRef = useRef<(() => void) | undefined>(undefined);
  commitRef.current = () => void run('Removing the picture…', async (b) => b);

  // ---------- print ----------
  const printRef = useRef<() => void>(() => {});
  printRef.current = async () => {
    setBusy({ msg: 'Getting the pages ready to print…' });
    try {
      const bytes = await produceBytes();
      const doc = await loadPdf(bytes);
      try {
        const pages: { url: string; w: number; h: number }[] = [];
        for (let i = 1; i <= doc.numPages; i++) {
          const pg = await doc.getPage(i);
          const vp = pg.getViewport({ scale: 1 });
          const canvas = await renderToCanvas(pg, 200 / 72);
          pages.push({ url: canvas.toDataURL('image/jpeg', 0.92), w: vp.width, h: vp.height });
          canvas.width = canvas.height = 0;
        }
        setBusy(null);
        const r = await window.acro.printPages(pages);
        if (r !== 'ok' && r !== 'cancelled') toast(`Could not print: ${r}`, 'error');
      } finally {
        void doc.destroy();
      }
    } catch (e) {
      toast(errText(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  // ---------- save ----------
  const save = useCallback(
    async (as = false) => {
      // Saving mid-typing: finish the edit first (this runs the line push-along), then let React settle.
      const active = document.activeElement as HTMLElement | null;
      if (active && active.closest('.page')) {
        active.blur();
        await new Promise((r) => setTimeout(r, 120));
      }
      const t = tabRef.current;
      setBusy({ msg: 'Saving…' });
      try {
        const out = await produceBytes();
        const toDisk = await applyProtection(out, t.protect);
        let path = t.path;
        if (as || !path) {
          path = await window.acro.saveFile(t.path ? t.path : t.name.endsWith('.pdf') ? t.name : t.name + '.pdf', toDisk);
          if (!path) return false;
        } else {
          try {
            await window.acro.writeFile(path, toDisk);
          } catch (e) {
            // the file is open in another program: offer a copy instead of just failing
            if (!/FILE_LOCKED/.test(String(e))) throw e;
            toast(errText(e), 'info');
            path = await window.acro.saveFile(t.name.endsWith('.pdf') ? t.name : t.name + '.pdf', toDisk);
            if (!path) return false;
          }
        }
        const name = path.split(/[\\/]/).pop() || t.name;
        const changedBytes = out !== t.bytes;
        onUpdate((cur) => ({
          ...cur,
          past: changedBytes ? [...cur.past, snap(cur)] : cur.past,
          bytes: out,
          annots: [],
          form: {},
          path,
          name,
          dirty: false,
          protectDirty: false,
          rev: changedBytes ? cur.rev + 1 : cur.rev,
        }));
        toast(`Saved ${name}`, 'ok');
        return true;
      } catch (e) {
        toast(errText(e), 'error');
        return false;
      } finally {
        setBusy(null);
      }
    },
    [produceBytes, onUpdate],
  );
  useEffect(() => {
    registerSave(save);
  }, [registerSave, save]);

  // ---------- annotations API ----------
  const api: EditorApi = useMemo(
    () => ({
      zoom,
      tool,
      style,
      annots: tab.annots,
      form: tab.form,
      selectedId,
      editingId,
      hits,
      activeHit,
      pendingImage,
      addAnnot(a, edit) {
        mutate((t) => ({ annots: [...t.annots, a] }));
        if (edit) {
          setSelected(a.id);
          setEditing(a.id);
        }
      },
      changeAnnot(id, fn, history = true) {
        mutate((t) => ({ annots: t.annots.map((a) => (a.id === id ? fn(a) : a)) }), history);
      },
      removeAnnot(id) {
        // a text box that came from the PDF: deleting it blanks it, so the original is removed on save
        const cur = tabRef.current.annots.find((a) => a.id === id);
        // a picture picked with the Select tool: Delete moves it off the page on save (Delete again, or Undo, brings it back)
        if (cur && cur.type === 'move' && cur.picture && cur.dx > -4000) {
          mutate((t) => ({ annots: t.annots.map((a) => (a.id === id ? ({ ...a, dx: -5000, dy: 0 } as Annot) : a)) }));
          setTimeout(() => commitRef.current?.(), 80);
          return;
        }
        if (cur && cur.type === 'field' && cur.srcField) {
          mutate((t) => ({ annots: t.annots.map((a) => (a.id === id ? ({ ...a, gone: true } as Annot) : a)) }));
          setSelected((s) => (s === id ? null : s));
          return;
        }
        if (cur && cur.type === 'replace' && cur.srcAnnot) {
          mutate((t) => ({ annots: t.annots.map((a) => (a.id === id ? ({ ...a, text: '' } as Annot) : a)) }));
          return;
        }
        // an edit's line-reflow helpers go with it
        mutate((t) => ({ annots: t.annots.filter((a) => a.id !== id && !(a.type === 'replace' && a.pushedBy === id)) }));
        setSelected((s) => (s === id ? null : s));
      },
      pushHistory() {
        onUpdate((t) => ({ ...t, past: [...t.past.slice(-60), snap(t)], future: [] }));
      },
      select: setSelected,
      edit: setEditing,
      setFormValue(name, value) {
        mutate((t) => ({ form: { ...t.form, [name]: value } }), false);
      },
      placeImageAt(page, x, y, fit) {
        if (!pendingImage) return;
        let { w, h } = pendingImage;
        let px = x - w / 2, py = y - h / 2;
        if (fit) {
          const s = Math.min(fit.w / w, fit.h / h);
          w *= s;
          h *= s;
          px = fit.x + (fit.w - w) / 2;
          py = fit.y + (fit.h - h) / 2;
        }
        const id = uid();
        mutate((t) => ({ annots: [...t.annots, { id, page, type: 'image', x: px, y: py, w, h, dataUrl: pendingImage.dataUrl, label: pendingImage.label }] }));
        setSelected(id);
        setTool('select');
        setPendingImage(null);
      },
      signField(page, rect) {
        setSigDialog({ field: { page, rect } });
      },
      signArea(page, rect) {
        signAreaRef.current?.(page, rect);
      },
      pickPicture(page, x, y) {
        const doc = pdfRef.current;
        if (!doc) return;
        (async () => {
          const pg = await doc.getPage(page + 1);
          const hit = pictureAt(await listPictures(pg), x, y);
          if (!hit) return toast('No picture there. Click directly on a picture, such as a signature.', 'info');
          const img = await pictureImage(pg, hit.name);
          if (!img) return toast("Couldn't read that picture.", 'error');
          setPicked({ dataUrl: img.hasAlpha ? img.dataUrl : await whiteToTransparent(img.dataUrl), w: hit.w, h: hit.h, page, x: hit.x, y: hit.y });
          setTool('select');
        })().catch((e) => toast(errText(e), 'error'));
      },
    }),
    [zoom, tool, style, tab.annots, tab.form, selectedId, editingId, hits, activeHit, pendingImage, mutate, onUpdate],
  );

  const imageInput = useRef<HTMLInputElement>(null);
  /** Insert image: pick a picture file, shrink huge photos, then click on the page to place it. */
  const onImageFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const src = await new Promise<string>((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result));
        r.onerror = () => rej(r.error);
        r.readAsDataURL(file);
      });
      const img = await new Promise<HTMLImageElement>((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = () => rej(new Error('not an image'));
        i.src = src;
      });
      // keep phone photos from bloating the PDF: cap the longest side at 1800px
      const k = Math.min(1, 1800 / Math.max(img.naturalWidth, img.naturalHeight));
      let dataUrl = src;
      if (k < 1) {
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * k);
        c.height = Math.round(img.naturalHeight * k);
        c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
        dataUrl = c.toDataURL(file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.9);
      }
      const w = Math.min(240, img.naturalWidth);
      setTool('place');
      setPendingImage({ dataUrl, w, h: (img.naturalHeight / img.naturalWidth) * w, label: 'image' });
    } catch {
      toast("Couldn't open that picture. Try a JPG or PNG.", 'error');
    }
  };

  const onPickImage = (img: PendingImage) => {
    const field = sigDialog?.field;
    setSigDialog(null);
    if (field) {
      // place directly into the signature field
      const s = Math.min(field.rect.w / img.w, field.rect.h / img.h);
      const w = img.w * s, h = img.h * s;
      const id = uid();
      mutate((t) => ({
        annots: [...t.annots, { id, page: field.page, type: 'image', x: field.rect.x + (field.rect.w - w) / 2, y: field.rect.y + (field.rect.h - h) / 2, w, h, dataUrl: img.dataUrl, label: img.label }],
      }));
      setSelected(id);
      return;
    }
    setPendingImage(img);
    setTool('place');
    toast('Click on the page to place it', 'info');
  };

  // ---------- page actions ----------
  const pageActions: PageActions = {
    rotate: (idx, d) => run('Rotating…', (b) => ops.rotatePages(b, idx, d)),
    remove: (idx) => run('Deleting pages…', (b) => ops.deletePages(b, idx)),
    extract: async (idx) => {
      setBusy({ msg: 'Extracting…' });
      try {
        const out = await ops.extractPages(await produceBytes(), idx);
        openNew(out, `${baseName(tab.name)} (pages ${idx.map((i) => i + 1).join(',')}).pdf`);
      } catch (e) {
        toast(errText(e), 'error');
      } finally {
        setBusy(null);
      }
    },
    duplicate: (idx) =>
      run('Duplicating…', async (b) => {
        const n = pdf!.numPages;
        const order: number[] = [];
        for (let i = 0; i < n; i++) {
          order.push(i);
          if (idx.includes(i)) order.push(i);
        }
        return ops.reorderPages(b, order);
      }),
    insertBlank: (at) => run('Inserting page…', (b) => ops.insertBlank(b, at)),
    insertFile: async (at) => {
      const files = await window.acro.openPdfs({ title: 'Insert pages from…' });
      if (!files.length) return;
      run('Inserting pages…', async (b) => {
        let out = b;
        let pos = at;
        for (const f of files) {
          const cnt = await ops.pageCount(f.data);
          out = await ops.insertPdf(out, f.data, pos);
          pos += cnt;
        }
        return out;
      });
    },
    reorder: (order) => run('Reordering…', (b) => ops.reorderPages(b, order)),
    goto: (i) => scrollTo(i),
  };

  /** First page of each top-level bookmark, for "split by bookmarks". */
  const bookmarkStarts = async (): Promise<number[]> => {
    if (!pdf) return [];
    const outline = await pdf.getOutline();
    const starts: number[] = [];
    for (const it of outline || []) {
      try {
        let dest: any = it.dest;
        if (typeof dest === 'string') dest = await pdf.getDestination(dest);
        if (!Array.isArray(dest)) continue;
        const ref = dest[0];
        const idx = typeof ref === 'object' ? await pdf.getPageIndex(ref) : Number(ref);
        if (Number.isFinite(idx)) starts.push(idx);
      } catch {
        /* a bookmark that points nowhere is skipped */
      }
    }
    return starts;
  };

  /** certificate signing waits here while the user draws the signature box */
  const certPending = useRef<CertSignRequest | null>(null);
  const signAreaRef = useRef<((page: number, rect: Rect) => void) | null>(null);
  const doCertSign = async (req: CertSignRequest, visible?: { page: number; x: number; y: number; w: number; h: number }) => {
    setBusy({ msg: 'Signing…' });
    try {
      const bytes = await produceBytes();
      const earlier = await verifySignatures(tabRef.current.bytes);
      if (earlier.length && bytes !== tabRef.current.bytes) throw new Error('This PDF is already signed, and you have unsaved edits. Adding them would break the earlier signature. Undo the edits first (or save a separate copy), then add your signature.');
      const signed = await signPdf(bytes, req.cred, { reason: req.reason || undefined, location: req.location || undefined, contact: req.contact || undefined, visible });
      setBusy(null);
      const saved = await window.acro.saveFile(downloadName(tab.name, '-signed'), signed, [{ name: 'PDF', extensions: ['pdf'] }]);
      if (saved) {
        const broken = earlier.some((r) => r.status === 'invalid');
        toast(
          broken
            ? `Signed copy saved as ${saved.split(/[\\/]/).pop()}. The earlier signature was already broken by changes made before this.`
            : `Signed copy saved as ${saved.split(/[\\/]/).pop()}.${earlier.length ? ' The earlier signature is still intact.' : ''} Don't edit it afterwards, or the signatures will break.`,
          broken ? 'info' : 'ok',
        );
        window.acro.showItem(saved);
      }
    } catch (e) {
      toast(errText(e), 'error');
    } finally {
      setBusy(null);
    }
  };
  signAreaRef.current = (page, rect) => {
    const req = certPending.current;
    if (!req) return;
    certPending.current = null;
    setTool('select');
    doCertSign(req, { page, ...rect });
  };

  const toolHandlers: ToolHandlers = {
    certSign: (req) => {
      setToolDialog(null);
      if (req.visible) {
        certPending.current = req;
        setTool('certsign');
        toast('Draw a box where the signature should appear. Esc cancels.', 'info');
      } else doCertSign(req);
    },
    watermark: (o) => {
      setToolDialog(null);
      run('Adding watermark…', async (b) => ops.watermark(b, await resolveWatermark(o)));
    },
    numbers: (o) => {
      setToolDialog(null);
      run('Numbering pages…', async (b) => ops.pageNumbers(b, await resolveNumbers(o)));
    },
    split: async (spec) => {
      setToolDialog(null);
      const folder = await window.acro.chooseFolder();
      if (!folder) return;
      setBusy({ msg: 'Splitting…', frac: 0 });
      try {
        const base = await produceBytes();
        let parts: Uint8Array[];
        if (spec.maxMB) {
          const r = await ops.splitBySize(base, spec.maxMB * 1024 * 1024, (frac) => setBusy({ msg: 'Splitting…', frac }));
          parts = r.files;
          if (r.tooBig) toast(`${r.tooBig} page${r.tooBig === 1 ? ' is' : 's are'} bigger than ${spec.maxMB} MB on their own, so they got their own file.`, 'info');
        } else if (spec.bookmarks) {
          const starts = await bookmarkStarts();
          if (!starts.length) throw new Error('This PDF has no bookmarks to split on. Try page ranges instead.');
          parts = await ops.split(base, { starts });
        } else parts = await ops.split(base, spec);
        for (let i = 0; i < parts.length; i++) await window.acro.writeInFolder(folder, downloadName(tab.name, `-part${i + 1}`), parts[i]);
        toast(`Created ${parts.length} file${parts.length === 1 ? '' : 's'}`, 'ok');
        window.acro.showItem(folder);
      } catch (e) {
        toast(errText(e), 'error');
      } finally {
        setBusy(null);
      }
    },
    optimize: async (o) => {
      setToolDialog(null);
      let report: OptimizeReport | null = null;
      const ok = await run('Optimizing…', async (b) => {
        const r = await optimize(b, o, {
          shrinkImage,
          onProgress: (frac, msg) => setBusy({ msg, frac }),
        });
        report = r.report;
        return r.bytes;
      });
      const r = report as OptimizeReport | null;
      if (ok && r) {
        const kb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);
        toast(
          r.changed
            ? `Optimized: ${kb(r.before)} → ${kb(r.after)} (${Math.round((1 - r.after / r.before) * 100)}% smaller). ${r.imagesShrunk} of ${r.images} pictures shrunk.`
            : 'This file is already as small as it can get without losing quality, so it was left as it is.',
          r.changed ? 'ok' : 'info',
        );
      }
    },
    pdfa: async () => {
      setToolDialog(null);
      setBusy({ msg: 'Making the PDF/A copy…' });
      try {
        const { bytes: out, report } = await toPdfA(await produceBytes());
        setBusy(null);
        const saved = await window.acro.saveFile(downloadName(tab.name, '-PDFA'), out, [{ name: 'PDF', extensions: ['pdf'] }]);
        if (saved) {
          setPdfaDone({ report, saved: saved.split(/[\\/]/).pop() || saved });
          window.acro.showItem(saved);
        }
      } catch (e) {
        toast(errText(e), 'error');
      } finally {
        setBusy(null);
      }
    },
    crop: (r) => {
      setToolDialog(null);
      run(r.reset ? 'Resetting the crop…' : 'Cropping…', (b) => {
        const pages = layout.pickPages(r.pages, pdf!.numPages);
        if (!pages.length) throw new Error('No pages match that range.');
        return r.reset ? layout.resetCrop(b, pages) : layout.cropPages(b, pages, r.margins);
      });
    },
    sheets: async (r) => {
      setToolDialog(null);
      setBusy({ msg: r.mode === 'booklet' ? 'Making the booklet…' : 'Arranging the pages…' });
      try {
        const base = await produceBytes();
        const n = (await ops.pageCount(base)) || 1;
        const plan = r.mode === 'booklet' ? layout.bookletPlan(n, r.rightToLeft) : layout.nUpPlan(n, r.cols * r.rows);
        const out = await layout.imposePages(base, plan, r.cols, r.rows, {
          size: r.paper === 'first' ? 'first' : layout.PAPER[r.paper],
          landscape: r.landscape,
          margin: r.mode === 'booklet' ? 14 : 24,
          gap: r.mode === 'booklet' ? 0 : 12,
          border: r.border,
        });
        openNew(out, downloadName(tab.name, r.mode === 'booklet' ? '-booklet' : `-${r.cols * r.rows}up`));
        toast(r.mode === 'booklet' ? 'Booklet ready in a new tab. Print double-sided, flip on the short edge.' : 'Done. The arranged copy is open in a new tab.', 'ok');
      } catch (e) {
        toast(errText(e), 'error');
      } finally {
        setBusy(null);
      }
    },
    headers: (r) => {
      setToolDialog(null);
      run('Adding headers and footers…', async (b) => {
        if (!layout.pickPages(r.pages, pdf!.numPages).length) throw new Error('No pages match that range.');
        const all = Object.values(r.header).concat(Object.values(r.footer)).join('');
        const font = await resolveNumbers({ format: all, position: 'bottom-center', size: r.size, start: 1 });
        const now = new Date();
        return layout.headersFooters(b, {
          header: r.header,
          footer: r.footer,
          size: r.size,
          color: r.color,
          bold: r.bold,
          margin: r.marginMm * (72 / 25.4),
          start: r.start,
          pages: r.pages,
          skipFirst: r.skipFirst,
          fontBytes: font.fontBytes,
          context: {
            file: tab.name,
            title: (await ops.getMetadata(b)).title || baseName(tab.name),
            date: now.toLocaleDateString('en-PH', { day: 'numeric', month: 'long', year: 'numeric' }),
            time: now.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' }),
          },
        });
      });
    },
    protect: (p) => {
      setToolDialog(null);
      onUpdate((t) => ({ ...t, protect: p, protectDirty: true, dirty: true }));
      toast(p ? 'Password set. It is applied when you save.' : 'Password removed. The next save will be unprotected.', 'ok');
    },
    properties: (m) => {
      setToolDialog(null);
      run('Updating properties…', (b) => ops.setMetadata(b, m));
    },
    ocr: async ({ scope, ...opts }) => {
      setToolDialog(null);
      const pages = scope === 'current' ? [current] : Array.from({ length: pdf!.numPages }, (_, i) => i);
      setBusy({ msg: 'Preparing OCR…', frac: 0 });
      try {
        const base = await produceBytes();
        const basePdf = base === tab.bytes ? pdf! : await loadPdf(base);
        const res = await ocrDocument(base, basePdf, pages, opts, (msg, frac) => setBusy({ msg, frac }));
        if (!res.pagesDone) {
          toast(res.pagesSkipped ? 'Nothing to do: every page already has real text.' : 'No pages were read.', 'info');
        } else {
          mutate((t) => ({ bytes: res.bytes, annots: [], form: {}, rev: t.rev + 1 }));
          const skipped = res.pagesSkipped ? ` ${res.pagesSkipped} page${res.pagesSkipped === 1 ? '' : 's'} already had text and ${res.pagesSkipped === 1 ? 'was' : 'were'} left alone.` : '';
          const quality = res.confidence >= 85 ? 'Good read' : res.confidence >= 65 ? 'Fair read, check important numbers' : 'Poor read: try "Accurate", or a cleaner scan';
          toast(`OCR done: ${res.words} words on ${res.pagesDone} page${res.pagesDone === 1 ? '' : 's'} (${Math.round(res.confidence)}% sure, ${quality}).${skipped}`, res.confidence >= 65 ? 'ok' : 'info');
        }
      } catch (e) {
        toast('OCR failed: ' + errText(e), 'error');
      } finally {
        setBusy(null);
      }
    },
    toWord: (mode) => {
      setToolDialog(null);
      exportOffice(mode === 'exact' ? 'word-exact' : mode === 'layout' ? 'word-layout' : 'word-flow');
    },
    toPpt: (mode) => {
      setToolDialog(null);
      exportOffice(mode === 'exact' ? 'ppt-exact' : 'ppt-editable');
    },
    exportImages: async ({ format, dpi }) => {
      setToolDialog(null);
      try {
        const folder = await exportImages(pdf!, tab.name, format, dpi, (i, n) => setBusy({ msg: `Exporting page ${i}/${n}…`, frac: i / n }));
        if (folder) {
          toast('Export complete', 'ok');
          window.acro.showItem(folder);
        }
      } catch (e) {
        toast(errText(e), 'error');
      } finally {
        setBusy(null);
      }
    },
  };

  /** pdf.js doc that includes any unsaved edits */
  const currentPdf = async () => {
    const t = tabRef.current;
    if (!realEdits(t.annots).length && !Object.keys(t.form).length) return { doc: pdf!, temp: false };
    return { doc: await loadPdf(await produceBytes()), temp: true };
  };

  const exportOffice = async (kind: 'word-flow' | 'word-layout' | 'word-exact' | 'excel' | 'ppt-editable' | 'ppt-exact') => {
    const [{ pdfToDocx }, { pdfToXlsx }, { pdfToPptx }, { pdfjs }] = await Promise.all([import('../lib/toWord'), import('../lib/toExcel'), import('../lib/toPowerPoint'), import('../lib/pdf')]);
    setBusy({ msg: 'Converting…', frac: 0 });
    let temp: PDFDocumentProxy | null = null;
    try {
      const { doc, temp: isTemp } = await currentPdf();
      if (isTemp) temp = doc;
      const prog = (i: number, n: number) => setBusy({ msg: `Converting page ${i} of ${n}…`, frac: i / n });
      const [bytes, ext, label] =
        kind === 'excel' ? [await pdfToXlsx(doc, pdfjs as any, prog), 'xlsx', 'Excel']
        : kind === 'ppt-editable' || kind === 'ppt-exact' ? [await pdfToPptx(doc, pdfjs as any, kind === 'ppt-exact' ? 'exact' : 'editable', prog), 'pptx', 'PowerPoint']
        : [await pdfToDocx(doc, pdfjs as any, kind === 'word-exact' ? 'exact' : kind === 'word-layout' ? 'layout' : 'flow', prog), 'docx', 'Word'];
      setBusy(null);
      const saved = await window.acro.saveFile(downloadName(tab.name, '', ext), bytes, [{ name: label, extensions: [ext] }]);
      if (saved) {
        toast(`Saved ${saved.split(/[\\/]/).pop()}`, 'ok');
        window.acro.showItem(saved);
      }
    } catch (e) {
      toast('Conversion failed: ' + errText(e), 'error');
    } finally {
      temp?.destroy();
      setBusy(null);
    }
  };

  const quickActions = {
    combine: async () => {
      const files = await window.acro.openPdfs({ title: 'Append PDFs to the end' });
      if (files.length) run('Combining…', (b) => ops.merge([b, ...files.map((f) => f.data)]));
    },
    flatten: () => run('Flattening…', async () => produceBytes({ flattenForms: true })),
    compress: async () => setToolDialog('optimize'),
    exportText: async () => {
      setBusy({ msg: 'Extracting text…' });
      try {
        const txt = await extractText(pdf!);
        await window.acro.saveFile(downloadName(tab.name, '', 'txt'), new TextEncoder().encode(txt), [{ name: 'Text', extensions: ['txt'] }]);
      } finally {
        setBusy(null);
      }
    },
    saveCopyFlattened: async () => {
      setBusy({ msg: 'Preparing…' });
      try {
        const out = await produceBytes({ flattenForms: true });
        await window.acro.saveFile(downloadName(tab.name, ' (flattened)'), out);
      } catch (e) {
        toast(errText(e), 'error');
      } finally {
        setBusy(null);
      }
    },
  };

  // ---------- launch a tool requested from the Tool hub ----------
  useEffect(() => {
    const a = tab.startAction;
    if (!pdf || !a) return;
    onUpdate((t) => ({ ...t, startAction: undefined }));
    const dialogs: Record<string, ToolKind> = {
      split: 'split', watermark: 'watermark', numbers: 'numbers', ocr: 'ocr', exportImages: 'exportImages', toWord: 'toWord', properties: 'properties', certSign: 'certSign', sigCheck: 'sigCheck', protect: 'protect', pdfa: 'pdfa', crop: 'crop', sheets: 'sheets', headers: 'headers',
    };
    if (dialogs[a]) setToolDialog(dialogs[a]);
    else if (a === 'sign') setSigDialog({});
    else if (a === 'redact' || a === 'editText') setTool(a);
    else if (a === 'formDesigner') setTool('field');
    else if (a === 'pages') setPanel('pages');
    else if (a === 'compress') quickActions.compress();
    else if (a === 'flatten') quickActions.flatten();
    else if (a === 'toExcel') exportOffice('excel');
    else if (a === 'toPpt') setToolDialog('toPpt');
    else if (a === 'toText') quickActions.exportText();
  }, [pdf, tab.startAction]);

  // ---------- navigation ----------
  const scrollTo = (i: number, rect?: Rect) => {
    const el = pageEls.current[i];
    const v = viewerRef.current;
    if (!el || !v) return;
    const top = el.offsetTop - 16 + (rect ? rect.y * zoom - v.clientHeight / 3 : 0);
    v.scrollTo({ top, behavior: 'smooth' });
  };
  const registerEl = useCallback((i: number, el: HTMLDivElement | null) => {
    pageEls.current[i] = el;
  }, []);

  const onScroll = () => {
    const v = viewerRef.current!;
    const mid = v.scrollTop + v.clientHeight / 3;
    let best = 0;
    pageEls.current.forEach((el, i) => {
      if (el && el.offsetTop <= mid) best = i;
    });
    if (best !== current) setCurrent(best);
  };

  // keep zoom anchored when zooming
  const zoomTo = (z: number) => {
    const v = viewerRef.current;
    const nz = Math.min(5, Math.max(0.2, z));
    if (!v) return setZoom(nz);
    const ratio = nz / zoom;
    const cy = v.scrollTop + v.clientHeight / 2;
    setZoom(nz);
    requestAnimationFrame(() => (v.scrollTop = cy * ratio - v.clientHeight / 2));
  };

  useEffect(() => {
    const v = viewerRef.current;
    if (!v) return;
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      zoomTo(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    };
    v.addEventListener('wheel', wheel, { passive: false });
    return () => v.removeEventListener('wheel', wheel);
  });

  // ---------- search ----------
  const textCache = useRef<Map<number, any>>(new Map());
  useEffect(() => {
    textCache.current.clear();
  }, [pdf]);
  const runSearch = async (q: string) => {
    setQuery(q);
    if (!pdf || q.trim().length < 2) {
      setHits([]);
      setActiveHit(-1);
      return;
    }
    const needle = q.toLowerCase();
    const out: Hit[] = [];
    for (let i = 0; i < pdf.numPages; i++) {
      let entry = textCache.current.get(i);
      if (!entry) {
        const p = await pdf.getPage(i + 1);
        entry = { vp: p.getViewport({ scale: 1 }), tc: await p.getTextContent() };
        textCache.current.set(i, entry);
      }
      for (const it of entry.tc.items as any[]) {
        const s: string = it.str;
        if (!s) continue;
        const lower = s.toLowerCase();
        let idx = lower.indexOf(needle);
        while (idx >= 0) {
          const tx = pdfjs.Util.transform(entry.vp.transform, it.transform);
          const fh = Math.hypot(tx[2], tx[3]);
          const w = it.width;
          out.push({
            page: i,
            rect: { x: tx[4] + (w * idx) / s.length, y: tx[5] - fh * 0.9, w: (w * needle.length) / s.length, h: fh * 1.15 },
            snippet: s.slice(Math.max(0, idx - 30), idx + needle.length + 40),
          });
          idx = lower.indexOf(needle, idx + needle.length);
        }
      }
      if (out.length > 2000) break;
    }
    setHits(out);
    setActiveHit(out.length ? 0 : -1);
    if (out.length) scrollTo(out[0].page, out[0].rect);
  };
  const stepHit = (d: number) => {
    if (!hits.length) return;
    const n = (activeHit + d + hits.length) % hits.length;
    setActiveHit(n);
    scrollTo(hits[n].page, hits[n].rect);
  };
  const markHits = (type: 'highlight' | 'redact') => {
    if (!hits.length) return;
    mutate((t) => ({
      annots: [
        ...t.annots,
        ...hits.map((h): Annot =>
          type === 'highlight'
            ? { id: uid(), page: h.page, type: 'highlight', rects: [h.rect], color: style.highlight }
            : { id: uid(), page: h.page, type: 'redact', ...h.rect },
        ),
      ],
    }));
    toast(`${type === 'highlight' ? 'Highlighted' : 'Marked for redaction'} ${hits.length} matches`, 'ok');
  };

  // ---------- keyboard ----------
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing = /INPUT|TEXTAREA|SELECT/.test(target.tagName) || target.isContentEditable;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        printRef.current();
      } else if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        save(e.shiftKey);
      } else if (mod && e.key.toLowerCase() === 'z' && !typing) {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
      } else if (mod && e.key.toLowerCase() === 'y' && !typing) {
        e.preventDefault();
        redo();
      } else if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setPanel('search');
        setTimeout(() => (document.querySelector('.search-input') as HTMLInputElement | null)?.focus(), 0);
      } else if (mod && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        zoomTo(zoom * 1.2);
      } else if (mod && e.key === '-') {
        e.preventDefault();
        zoomTo(zoom / 1.2);
      } else if (mod && e.key === '0') {
        e.preventDefault();
        fitWidth();
      } else if (typing && e.key === 'Escape') {
        // Esc from a toolbar box (thickness, font size…) must still drop the tool and let you pick shapes
        target.blur();
        setSelected(null);
        setTool('select');
        setPendingImage(null);
      } else if (typing) return;
      else if ((e.key === 'Enter' || e.key === 'F2') && selectedId && ['text', 'replace', 'note'].includes(tabRef.current.annots.find((x) => x.id === selectedId)?.type || '')) {
        // Enter on a selected text box starts editing it
        e.preventDefault();
        setEditing(selectedId);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        api.removeAnnot(selectedId);
      } else if (e.key === 'Escape') {
        certPending.current = null;
        setSelected(null);
        setTool('select');
        setPendingImage(null);
      } else if (!mod && !e.altKey) {
        const t = TOOL_GROUPS.flat().find((x) => x.key === e.key.toLowerCase());
        if (t) setTool(t.tool);
        else if (e.key === 'PageDown') scrollTo(Math.min(current + 1, (pdf?.numPages || 1) - 1));
        else if (e.key === 'PageUp') scrollTo(Math.max(current - 1, 0));
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });

  const selected = tab.annots.find((a) => a.id === selectedId) || null;
  const pendingCount = realEdits(tab.annots).length + Object.keys(tab.form).length;
  const redactCount = tab.annots.filter((a) => a.type === 'redact').length;

  if (loadError)
    return (
      <div className="empty-state">
        <Icon name="info" size={36} />
        <h2>Couldn't open this PDF</h2>
        <p>{loadError}</p>
      </div>
    );

  return (
    <EditorCtx.Provider value={api}>
      <div className="editor">
        {/* ---------- toolbar ---------- */}
        <div className="toolbar">
          <div className="tb-group rel">
            <button className="icon-btn" title="Save (Ctrl+S)" onClick={() => save(false)}>
              <Icon name="save" />
            </button>
            <button className="icon-btn save-as-btn" title="Save as… PDF, Word, Excel, PowerPoint, images or text" aria-label="Save as" aria-expanded={saveMenu} onClick={() => setSaveMenu((v) => !v)}>
              <Icon name="chevD" size={14} />
            </button>
            {saveMenu && (
              <div className="menu more-menu" onMouseLeave={() => setSaveMenu(false)} onClick={() => setSaveMenu(false)}>
                <div className="menu-head">Save as</div>
                <button onClick={() => save(true)}><Icon name="save" /> PDF (a copy)</button>
                <button onClick={() => printRef.current()}><Icon name="print" /> Print (Ctrl+P)</button>
                <button onClick={() => setToolDialog('toWord')}><Icon name="word" /> Word document (.docx)</button>
                <button onClick={() => exportOffice('excel')}><Icon name="excel" /> Excel workbook (.xlsx)</button>
                <button onClick={() => setToolDialog('toPpt')}><Icon name="ppt" /> PowerPoint (.pptx)</button>
                <button onClick={() => setToolDialog('exportImages')}><Icon name="image" /> Images (JPG or PNG)</button>
                <button onClick={quickActions.exportText}><Icon name="txt" /> Plain text (.txt)</button>
              </div>
            )}
            <button className="icon-btn" title="Print (Ctrl+P)" aria-label="Print" onClick={() => printRef.current()}>
              <Icon name="print" />
            </button>
            <button className="icon-btn" title="Undo (Ctrl+Z)" disabled={!tab.past.length} onClick={undo}>
              <Icon name="undo" />
            </button>
            <button className="icon-btn" title="Redo (Ctrl+Y)" disabled={!tab.future.length} onClick={redo}>
              <Icon name="redo" />
            </button>
          </div>
          {TOOL_GROUPS.map((g, gi) => (
            compact && OVERFLOW_GROUPS.includes(gi) ? null : (
            <div className="tb-group" key={gi}>
              {g.map((t) => (
                <button
                  key={t.tool}
                  className={`icon-btn ${SHORT[t.tool] ? 'labeled' : ''} ${tool === t.tool ? 'on' : ''}`}
                  title={t.label}
                  aria-label={t.label}
                  aria-pressed={tool === t.tool}
                  onClick={() => setTool(t.tool)}
                >
                  <Icon name={t.icon} />
                  {SHORT[t.tool] && <span>{SHORT[t.tool]}</span>}
                </button>
              ))}
            </div>
            )
          ))}
          {compact && (
            <div className="tb-group rel">
              <button
                className={`icon-btn ${OVERFLOW_GROUPS.some((gi) => TOOL_GROUPS[gi].some((t) => t.tool === tool)) ? 'on' : ''}`}
                title="More tools: highlight, draw, shapes, notes, form fields"
                aria-label="More tools"
                aria-expanded={moreMenu}
                onClick={() => setMoreMenu((v) => !v)}
              >
                <Icon name="more" />
              </button>
              {moreMenu && (
                <div className="menu more-menu" onMouseLeave={() => setMoreMenu(false)}>
                  {OVERFLOW_GROUPS.flatMap((gi) => TOOL_GROUPS[gi]).map((t) => (
                    <button
                      key={t.tool}
                      className={tool === t.tool ? 'on' : ''}
                      onClick={() => {
                        setTool(t.tool);
                        setMoreMenu(false);
                      }}
                    >
                      <Icon name={t.icon} /> {t.label.replace(/\s*[(:].*$/, '')}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className="tb-group">
            <button className="tb-btn accent" title="Fill & sign" onClick={() => setSigDialog({})}>
              <Icon name="sign" /> Sign
            </button>
            <button className={`icon-btn ${tool === 'pickup' ? 'on' : ''}`} title="Pick up a picture from the page (like a signature): save it for reuse or copy it" aria-pressed={tool === 'pickup'} onClick={() => setTool('pickup')}>
              <Icon name="extract" />
            </button>
            <button className="icon-btn" title="Insert image" onClick={() => imageInput.current?.click()}>
              <Icon name="image" />
            </button>
            <input
              ref={imageInput}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                onImageFile(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
            <button className="icon-btn" title="Stamps" onClick={() => setSigDialog({ tab: 'stamp' })}>
              <Icon name="stamp" />
            </button>
            <button className="icon-btn" title="Watermark" onClick={() => setToolDialog('watermark')}>
              <Icon name="water" />
            </button>
          </div>
          <div className="tb-spacer" />
          <div className="tb-group">
            <button className="icon-btn" title="Zoom out (Ctrl -)" onClick={() => zoomTo(zoom / 1.2)}>
              <Icon name="zoomOut" />
            </button>
            <button className="zoom-label" title="Fit width (Ctrl 0). Click again for fit page" onClick={() => (Math.abs(zoom - 1) < 0.01 ? fitWidth() : fitPage())}>
              {Math.round(zoom * 100)}%
            </button>
            <button className="icon-btn" title="Zoom in (Ctrl +)" onClick={() => zoomTo(zoom * 1.2)}>
              <Icon name="zoomIn" />
            </button>
            <button className="icon-btn" title="Fit width" onClick={() => fitWidth()}>
              <Icon name="fit" />
            </button>
          </div>
          <div className="tb-group">
            <input
              className="page-input"
              value={current + 1}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                if (n >= 1 && n <= (pdf?.numPages || 0)) scrollTo(n - 1);
              }}
            />
            <span className="muted">/ {pdf?.numPages || '…'}</span>
          </div>
          <div className="tb-group rel">
            <button
              className={`tb-btn ${toolsMenu ? 'on' : ''}`}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setMenuLeft(r.left + r.width / 2 < window.innerWidth / 2); // open toward the middle of the window so it never runs off an edge
                setToolsMenu((v) => !v);
              }}
            >
              <Icon name="tools" /> <span className="tb-label">All tools</span> <Icon name="chevD" size={14} />
            </button>
            {toolsMenu && (
              <div className={`menu ${menuLeft ? 'menu-left' : ''}`} onMouseLeave={() => setToolsMenu(false)} onClick={() => setToolsMenu(false)}>
                <div className="menu-head">Organize</div>
                <button onClick={quickActions.combine}><Icon name="merge" /> Combine (append PDFs)</button>
                <button onClick={() => setToolDialog('split')}><Icon name="split" /> Split</button>
                <button onClick={() => setPanel('pages')}><Icon name="pages" /> Organize pages</button>
                <div className="menu-head">Forms</div>
                <button onClick={() => setTool('field')}><Icon name="form" /> Form designer: add fields</button>
                <button onClick={() => run('Making the fields fillable…', async (b) => b)}><Icon name="check" /> Test the form (apply fields)</button>
                <button onClick={quickActions.flatten}><Icon name="form" /> Flatten forms & markup</button>
                <div className="menu-head">Sign & protect</div>
                <button onClick={() => setToolDialog('protect')}><Icon name="lock" /> Protect with a password</button>
                <button onClick={() => setToolDialog('certSign')}><Icon name="sign" /> Sign with a certificate</button>
                <button onClick={() => setToolDialog('sigCheck')}><Icon name="check" /> Check signatures</button>
                <button onClick={() => setTool('redact')}><Icon name="redact" /> Redact</button>
                <div className="menu-head">Page layout</div>
                <button onClick={() => setToolDialog('watermark')}><Icon name="water" /> Watermark</button>
                <button onClick={() => setToolDialog('numbers')}><Icon name="hash" /> Page numbers / Bates</button>
                <button onClick={() => setToolDialog('headers')}><Icon name="hash" /> Headers and footers</button>
                <button onClick={() => setToolDialog('crop')}><Icon name="fit" /> Crop pages</button>
                <button onClick={() => setToolDialog('sheets')}><Icon name="copy" /> Pages per sheet / booklet</button>
                <div className="menu-head">Archive & compare</div>
                <button onClick={() => setToolDialog('compare')}><Icon name="copy" /> Compare with another PDF</button>
                <button onClick={() => setToolDialog('pdfa')}><Icon name="fileCheck" /> Save as PDF/A</button>
                <button onClick={quickActions.compress}><Icon name="compress" /> Optimize file size</button>
                <div className="menu-head">Convert</div>
                <button onClick={() => setToolDialog('toWord')}><Icon name="word" /> Export to Word</button>
                <button onClick={() => exportOffice('excel')}><Icon name="excel" /> Export to Excel</button>
                <button onClick={() => setToolDialog('toPpt')}><Icon name="ppt" /> Export to PowerPoint</button>
                <div className="menu-head">Scan & export</div>
                <button onClick={() => setToolDialog('ocr')}><Icon name="ocr" /> Recognize text (OCR)</button>
                <button onClick={() => setToolDialog('exportImages')}><Icon name="image" /> Export as images</button>
                <button onClick={quickActions.exportText}><Icon name="file" /> Export as text</button>
                <button onClick={quickActions.saveCopyFlattened}><Icon name="download" /> Save flattened copy</button>
                <div className="menu-head">Document</div>
                <button onClick={() => setToolDialog('properties')}><Icon name="info" /> Properties</button>
                <button onClick={() => save(true)}><Icon name="save" /> Save as</button>
              </div>
            )}
          </div>
        </div>

        {/* ---------- context bar (style for active tool / selection) ---------- */}
        <ContextBar
          tool={tool}
          style={style}
          setStyle={setStyle}
          selected={selected}
          onChangeSelected={(fn) => selected && api.changeAnnot(selected.id, fn)}
          onDelete={() => selected && api.removeAnnot(selected.id)}
          pendingImage={pendingImage}
          redactCount={redactCount}
          fonts={fonts}
        />

        <div className="workspace">
          {/* ---------- left rail ---------- */}
          <nav className="rail">
            {(
              [
                ['pages', 'pages', 'Pages'],
                ['search', 'search', 'Search'],
                ['comments', 'comments', 'Comments'],
                ['bookmarks', 'bookmark', 'Bookmarks'],
                ['attachments', 'paperclip', 'Files'],
              ] as const
            ).map(([k, icon, label]) => (
              <button key={k} className={`rail-btn ${panel === k ? 'on' : ''}`} title={label} aria-pressed={panel === k} onClick={() => setPanel(panel === k ? null : k)}>
                <Icon name={icon} size={20} />
                <span>{label}</span>
              </button>
            ))}
          </nav>
          {panel && pdf && (
            <aside className="side-panel">
              {panel === 'pages' && <Thumbnails pdf={pdf} rev={loadId} current={current} actions={pageActions} />}
              {panel === 'bookmarks' && (
                <BookmarksPanel pdf={pdf} rev={loadId} current={current} onGo={(p) => scrollTo(p)} onSave={(tree) => run('Updating bookmarks…', (b) => nav.writeOutline(b, tree))} />
              )}
              {panel === 'attachments' && (
                <AttachmentsPanel
                  pdf={pdf}
                  rev={loadId}
                  onAttach={(f) => run('Attaching the file…', (b) => nav.attachFile(b, f))}
                  onRemove={(name) => run('Removing the file…', (b) => nav.removeAttachment(b, name))}
                />
              )}
              {panel === 'search' && (
                <div className="search-panel">
                  <div className="search-row">
                    <input className="search-input" placeholder="Find in document…" defaultValue={query} onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Enter') {
                        const v = (e.target as HTMLInputElement).value;
                        if (v === query && hits.length) stepHit(e.shiftKey ? -1 : 1);
                        else runSearch(v);
                      }
                    }} />
                  </div>
                  <div className="row gap small-text">
                    <span className="muted">{query ? `${hits.length} result${hits.length === 1 ? '' : 's'}` : 'Press Enter to search'}</span>
                    <span className="tb-spacer" />
                    <button className="icon-btn" disabled={!hits.length} onClick={() => stepHit(-1)}><Icon name="chevL" /></button>
                    <button className="icon-btn" disabled={!hits.length} onClick={() => stepHit(1)}><Icon name="chevR" /></button>
                  </div>
                  {hits.length > 0 && (
                    <div className="row gap">
                      <button className="small" onClick={() => markHits('highlight')}>Highlight all</button>
                      <button className="small danger" onClick={() => markHits('redact')}>Redact all</button>
                    </div>
                  )}
                  <div className="results">
                    {hits.slice(0, 500).map((h, i) => (
                      <button key={i} className={`result ${i === activeHit ? 'on' : ''}`} onClick={() => {
                        setActiveHit(i);
                        scrollTo(h.page, h.rect);
                      }}>
                        <span className="muted">p.{h.page + 1}</span> {h.snippet}
                      </button>
                    ))}
                  </div>
                  {pdf && hits.length === 0 && query && (
                    <p className="muted small-text">No matches. If this is a scanned document, run <b>All tools → Recognize text (OCR)</b> first.</p>
                  )}
                </div>
              )}
              {panel === 'comments' && (
                <div className="comments-panel">
                  <div className="panel-hint">Pending comments are saved into the PDF as real sticky notes.</div>
                  {tab.annots.filter((a) => a.type === 'note').map((a) => (
                    <button key={a.id} className="result" onClick={() => {
                      setSelected(a.id);
                      scrollTo(a.page);
                    }}>
                      <span className="muted">p.{a.page + 1} · new</span> {(a as any).text || <i>(empty)</i>}
                    </button>
                  ))}
                  {existingComments.map((c, i) => (
                    <button key={i} className="result" onClick={() => scrollTo(c.page)}>
                      <span className="muted">p.{c.page + 1}{c.author ? ` · ${c.author}` : ''}</span> {c.text}
                    </button>
                  ))}
                  {!existingComments.length && !tab.annots.some((a) => a.type === 'note') && <p className="muted small-text">No comments yet. Use the comment tool (N).</p>}
                </div>
              )}
            </aside>
          )}

          {/* ---------- pages ---------- */}
          <div className={`viewer tool-${tool}${book ? ' book' : ''}`} ref={viewerRef} onScroll={onScroll}>
            {pdf ? (
              book ? (
                // two pages side by side: 1-2, 3-4 and so on
                Array.from({ length: Math.ceil(sizes.length / 2) }, (_, k) => {
                  const idx = [2 * k, 2 * k + 1].filter((i) => i < sizes.length);
                  return (
                    <div className="spread" key={`${loadId}-s${k}`}>
                      {idx.map((i) => (
                        <PageView key={`${loadId}-${i}`} pdf={pdf} index={i} size={sizes[i]} rev={loadId} registerEl={registerEl} />
                      ))}
                    </div>
                  );
                })
              ) : (
                sizes.map((s, i) => <PageView key={`${loadId}-${i}`} pdf={pdf} index={i} size={s} rev={loadId} registerEl={registerEl} />)
              )
            ) : (
              <div className="empty-state">Opening…</div>
            )}
          </div>
        </div>

        <div className="statusbar">
          <span>{tab.path || 'Unsaved document'}</span>
          <span className="tb-spacer" />
          <span className="view-switch" role="group" aria-label="View">
            <button className={!book ? 'on' : ''} onClick={() => {
              const keep = current;
              setBook(false);
              fitWidth(false);
              requestAnimationFrame(() => requestAnimationFrame(() => {
                const el = pageEls.current[keep];
                if (el && viewerRef.current) viewerRef.current.scrollTop = el.offsetTop - 16;
              }));
            }} title="One page at a time, scrolling down">Single</button>
            <button
              className={book ? 'on' : ''}
              disabled={!pdf || pdf.numPages < 2}
              title="Two pages side by side. Zoom and editing work as usual."
              onClick={() => {
                const keep = current;
                setBook(true);
                fitWidth(true);
                requestAnimationFrame(() => requestAnimationFrame(() => {
                  const el = pageEls.current[keep];
                  if (el && viewerRef.current) viewerRef.current.scrollTop = el.offsetTop - 16;
                }));
              }}
            >
              Double
            </button>
          </span>
          {pendingCount > 0 && <span className="pill">{pendingCount} unsaved edit{pendingCount === 1 ? '' : 's'}</span>}
          {redactCount > 0 && <span className="pill danger">{redactCount} redaction{redactCount === 1 ? '' : 's'} will be applied on save</span>}
          <span className="muted">{(tab.bytes.length / 1024).toFixed(0)} KB</span>
        </div>

        {busy && (
          <div className="busy">
            <div className="busy-card">
              <div className="spinner" />
              <div>{busy.msg}</div>
              {busy.frac !== undefined && (
                <div className="progress">
                  <div style={{ width: `${Math.round(busy.frac * 100)}%` }} />
                </div>
              )}
            </div>
          </div>
        )}
        {picked && (
          <PickedPicture
            pic={picked}
            onClose={() => setPicked(null)}
            onSave={() => {
              saveSigs([{ id: uid(), dataUrl: picked.dataUrl, kind: 'signature' }, ...loadSigs()]);
              toast('Saved. Find it under Sign, then Saved.', 'ok');
              setPicked(null);
            }}
            onDelete={() => {
              // the picture (and any drawing fully inside its box) is moved off the page on save: gone, while text and lines around it stay
              mutate((t) => ({ annots: [...t.annots, { id: uid(), page: picked.page, type: 'move', from: { x: picked.x, y: picked.y, w: picked.w, h: picked.h }, dx: -5000, dy: 0, snapshot: picked.dataUrl, texts: [], picture: true } as Annot] }));
              setTimeout(() => commitRef.current?.(), 80);
              toast('Picture removed. Press Undo to bring it back.', 'ok');
              setPicked(null);
            }}
            onPlace={() => {
              setPendingImage({ dataUrl: picked.dataUrl, w: picked.w, h: picked.h, label: 'signature' });
              setTool('place');
              setPicked(null);
            }}
          />
        )}
        {sigDialog && <SignatureDialog initialTab={sigDialog.tab} onPick={onPickImage} onClose={() => setSigDialog(null)} />}
        {pdfaDone && <PdfaReportDialog report={pdfaDone.report} saved={pdfaDone.saved} onClose={() => setPdfaDone(null)} />}
        {toolDialog && pdf && (
          <ToolDialog kind={toolDialog} currentPage={current} protection={tab.protect} bytes={tab.bytes} numPages={pdf.numPages} onClose={() => setToolDialog(null)} h={toolHandlers} />
        )}
      </div>
    </EditorCtx.Provider>
  );
}

function ContextBar({
  tool,
  style,
  setStyle,
  selected,
  onChangeSelected,
  onDelete,
  pendingImage,
  redactCount,
  fonts,
}: {
  tool: Tool;
  style: StyleState;
  setStyle: (s: StyleState) => void;
  selected: Annot | null;
  onChangeSelected: (fn: (a: Annot) => Annot) => void;
  onDelete: () => void;
  pendingImage: PendingImage | null;
  redactCount: number;
  fonts: string[];
}) {
  const sel: any = selected;
  const hasColor = selected ? 'color' in selected && selected.type !== 'whiteout' : ['ink', 'rect', 'ellipse', 'line', 'arrow', 'text', 'underline', 'strike', 'mark'].includes(tool);
  const isHL = selected ? selected.type === 'highlight' : tool === 'highlight';
  const STROKED = ['ink', 'rect', 'ellipse', 'line', 'arrow'];
  const hasWidth = STROKED.includes(selected ? selected.type : tool);
  const hasFont = selected ? selected.type === 'text' || selected.type === 'replace' : tool === 'text';
  const hasFill = selected ? selected.type === 'rect' || selected.type === 'ellipse' : tool === 'rect' || tool === 'ellipse';
  const isMark = selected ? selected.type === 'mark' : tool === 'mark';

  const color = sel?.color ?? (isHL ? style.highlight : style.color);
  const setColor = (c: string) => {
    if (selected) onChangeSelected((a) => ({ ...a, color: c }) as Annot);
    else setStyle(isHL ? { ...style, highlight: c } : { ...style, color: c });
  };

  const hints: Partial<Record<Tool, string>> = {
    select: 'Select & copy text · click markup to move/resize · fill form fields directly on the page',
    editText: 'Every outlined piece of text can be edited: click it, type, then Save. It keeps the original font and size. No outlines? The page is a scan; run All tools → OCR first.',
    highlight: 'Select text to highlight it, or drag a box on scanned pages.',
    underline: 'Select text to underline it.',
    strike: 'Select text to strike it through.',
    whiteout: 'Drag to cover content with white (visual only. Use Redact to truly remove).',
    redact: `Drag over anything sensitive. On save, the words under each box are removed for good. If a picture or drawing is under a box, that page becomes a picture instead. Keep the original.${redactCount ? ` (${redactCount} marked)` : ''}`,
    note: 'Click to drop a comment.',
    mark: 'Click the centre of a box to tick it. Works on printed boxes that are not real form fields.',
    move: 'Drag a box around text, lines, boxes or pictures, then drag the box where you want it. Saved as a real move, not a picture.',
    text: 'Click anywhere to type new text.',
    place: pendingImage ? 'Click where you want to place it. Esc to cancel.' : '',
    certsign: 'Drag a box where the signature should appear. Esc to cancel.',
    pickup: 'Click a picture on the page, such as a signature. You can then save it as one of your signatures or place a copy.',
    field: 'Click to drop a field or drag to size it. Click a field to change it. Save makes them fillable.',
    hand: 'Drag to pan.',
  };

  return (
    <div className="contextbar">
      {selected && <span className="ctx-label">{labelFor(selected)}</span>}
      {(tool === 'field' || selected?.type === 'field') && (
        <FieldProps field={selected?.type === 'field' ? selected : null} kind={style.fieldKind} setKind={(k) => setStyle({ ...style, fieldKind: k })} onChange={onChangeSelected} />
      )}
      {hasColor && (
        <div className="swatches">
          {(isHL ? HL_COLORS : COLORS).map((c) => (
            <button key={c} className={`swatch ${color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => setColor(c)} aria-label={`Color ${c}`} />
          ))}
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} title="Custom color" />
        </div>
      )}
      {hasWidth && (
        <>
          <div className="ctx-group" role="group" aria-label="Thickness">
            <span className="ctx-cap">Thickness</span>
            {[0.75, 1.5, 3, 5, 8].map((w) => (
              <button
                key={w}
                className={`thick ${(sel?.width ?? style.width) === w ? 'on' : ''}`}
                title={`${w} pt`}
                aria-pressed={(sel?.width ?? style.width) === w}
                onClick={() => (selected ? onChangeSelected((a) => ({ ...a, width: w }) as Annot) : setStyle({ ...style, width: w }))}
              >
                <span style={{ height: Math.max(1, w * 0.9), background: color }} />
              </button>
            ))}
            <input
              type="number"
              className="num"
              min={0.25}
              max={40}
              step={0.25}
              value={sel?.width ?? style.width}
              aria-label="Thickness in points"
              onChange={(e) => {
                const width = e.currentTarget.valueAsNumber;
                if (!Number.isFinite(width) || width < 0.25 || width > 40) return;
                if (selected) onChangeSelected((a) => ({ ...a, width }) as Annot);
                else setStyle({ ...style, width });
              }}
            />
          </div>
          <div className="seg small" role="group" aria-label="Line style">
            {[false, true].map((d) => (
              <button
                key={String(d)}
                aria-pressed={!!(sel ? sel.dash : style.dash) === d}
                className={!!(sel ? sel.dash : style.dash) === d ? 'on' : ''}
                onClick={() => (selected ? onChangeSelected((a) => ({ ...a, dash: d }) as Annot) : setStyle({ ...style, dash: d }))}
              >
                {d ? 'Dashed' : 'Solid'}
              </button>
            ))}
          </div>
        </>
      )}
      {hasFill && (
        <div className="ctx-group" role="group" aria-label="Fill">
          <span className="ctx-cap">Fill</span>
          {[null, '#ffffff', '#fff3b0', '#d6e6fb', '#fbd9e0', '#d8efd4', '#111111'].map((f) => {
            const cur = sel ? sel.fill : style.fill;
            return (
              <button
                key={String(f)}
                className={`swatch ${cur === f ? 'on' : ''} ${f ? '' : 'none'}`}
                style={f ? { background: f } : undefined}
                title={f ? `Fill ${f}` : 'No fill'}
                aria-label={f ? `Fill ${f}` : 'No fill'}
                onClick={() => (selected ? onChangeSelected((a) => ({ ...a, fill: f }) as Annot) : setStyle({ ...style, fill: f }))}
              />
            );
          })}
          <input
            type="color"
            title="Custom fill"
            value={(sel ? sel.fill : style.fill) || '#ffffff'}
            onChange={(e) => (selected ? onChangeSelected((a) => ({ ...a, fill: e.target.value }) as Annot) : setStyle({ ...style, fill: e.target.value }))}
          />
        </div>
      )}
      {selected && (selected.type === 'text' || (selected.type === 'replace' && selected.startX === undefined)) && (
        <div className="align-group" role="group" aria-label="Text alignment">
          {(['left', 'center', 'right', 'justify'] as const).map((al) => (
            <button
              key={al}
              className={`icon-btn ${(sel.align || 'left') === al ? 'on' : ''}`}
              title={`Align ${al}`}
              aria-label={`Align ${al}`}
              aria-pressed={(sel.align || 'left') === al}
              onClick={() => onChangeSelected((a) => ({ ...a, align: al }) as Annot)}
            >
              <Icon name={{ left: 'alignL', center: 'alignC', right: 'alignR', justify: 'alignJ' }[al]} />
            </button>
          ))}
          {selected.type === 'text' && (
            <button
              className={`icon-btn ${sel.wrap === false ? '' : 'on'}`}
              title={sel.wrap === false ? 'Wrap is off: lines stay as typed. Click to wrap text inside the box' : 'Wrap is on: text wraps inside the box. Click to turn off'}
              aria-pressed={sel.wrap !== false}
              onClick={() => onChangeSelected((a) => ({ ...a, wrap: a.type === 'text' && a.wrap === false }) as Annot)}
            >
              <Icon name="wrap" />
            </button>
          )}
        </div>
      )}
      {hasFont && (
        <>
          <select
            className="font-select"
            value={sel?.family ?? style.family}
            aria-label="Font"
            style={{ fontFamily: `"${sel?.family ?? style.family}"` }}
            onChange={(e) => (selected ? onChangeSelected((a) => ({ ...a, sourceFace: undefined, previewFamily: undefined, family: e.target.value }) as Annot) : setStyle({ ...style, family: e.target.value }))}
          >
            {!fonts.includes(sel?.family ?? style.family) && <option value={sel?.family ?? style.family}>{sel?.family ?? style.family}</option>}
            {fonts.map((f) => (
              <option key={f} value={f} style={{ fontFamily: `"${f}"` }}>
                {f}
              </option>
            ))}
          </select>
          <input
            type="number"
            className="num"
            min={4}
            max={144}
            step={0.5}
            value={sel?.fontSize ?? style.fontSize}
            aria-label="Font size"
            onChange={(e) => (selected ? onChangeSelected((a) => ({ ...a, fontSize: +e.target.value }) as Annot) : setStyle({ ...style, fontSize: +e.target.value }))}
          />
          <button
            className={`small style-btn ${(sel ? sel.bold : style.bold) ? 'on' : ''}`}
            aria-label="Bold"
            onClick={() => (selected ? onChangeSelected((a) => ({ ...a, sourceFace: undefined, previewFamily: undefined, bold: !(a as any).bold }) as Annot) : setStyle({ ...style, bold: !style.bold }))}
          >
            <b>B</b>
          </button>
          <button
            className={`small style-btn ${(sel ? sel.italic : style.italic) ? 'on' : ''}`}
            aria-label="Italic"
            onClick={() => (selected ? onChangeSelected((a) => ({ ...a, sourceFace: undefined, previewFamily: undefined, italic: !(a as any).italic }) as Annot) : setStyle({ ...style, italic: !style.italic }))}
          >
            <i>I</i>
          </button>
        </>
      )}
      {selected && (selected.type === 'image' || selected.type === 'text') && (
        <div className="ctx-group" role="group" aria-label="Rotate">
          <span className="ctx-cap">Rotate</span>
          <button className="icon-btn" title="Rotate left 90°" onClick={() => onChangeSelected((a) => ({ ...a, rotation: ((((a as any).rotation || 0) - 90) % 360 + 360) % 360 }) as Annot)}>
            <Icon name="rotL" size={16} />
          </button>
          <button className="icon-btn" title="Rotate right 90°" onClick={() => onChangeSelected((a) => ({ ...a, rotation: (((a as any).rotation || 0) + 90) % 360 }) as Annot)}>
            <Icon name="rotR" size={16} />
          </button>
          <input
            type="number"
            className="num"
            min={-360}
            max={360}
            value={sel.rotation || 0}
            aria-label="Angle in degrees"
            onChange={(e) => onChangeSelected((a) => ({ ...a, rotation: ((+e.target.value % 360) + 360) % 360 }) as Annot)}
          />
          <span className="ctx-cap">°</span>
        </div>
      )}
      {isMark && (
        <>
          <div className="seg small" role="group" aria-label="Mark">
            {(['check', 'cross', 'dot'] as const).map((k) => (
              <button
                key={k}
                className={(sel?.kind ?? style.mark) === k ? 'on' : ''}
                onClick={() => (selected ? onChangeSelected((a) => ({ ...a, kind: k }) as Annot) : setStyle({ ...style, mark: k }))}
              >
                {k === 'check' ? '✓ Check' : k === 'cross' ? '✗ Cross' : '● Dot'}
              </button>
            ))}
          </div>
          <label className="ctx-field">
            Size
            <input
              type="number"
              min={4}
              max={48}
              value={sel?.size ?? style.markSize}
              onChange={(e) => (selected ? onChangeSelected((a) => ({ ...a, size: +e.target.value }) as Annot) : setStyle({ ...style, markSize: +e.target.value }))}
            />
          </label>
        </>
      )}
      {!selected && hints[tool] && <span className="ctx-hint">{hints[tool]}</span>}
      {selected && (selected.type === 'text' || selected.type === 'replace') && <span className="ctx-hint">Double-click to edit text</span>}
      {selected && (
        <button className="small danger ctx-delete" onClick={onDelete}>
          <Icon name="trash" size={14} /> Delete
        </button>
      )}
    </div>
  );
}

function labelFor(a: Annot) {
  const m: Record<string, string> = {
    highlight: 'Highlight', underline: 'Underline', strike: 'Strikethrough', ink: 'Drawing', rect: 'Rectangle',
    ellipse: 'Ellipse', line: 'Line', arrow: 'Arrow', text: 'Text box', replace: 'Edited text', whiteout: 'Whiteout',
    redact: 'Redaction', image: 'Image', note: 'Comment', mark: 'Check mark', move: 'Moved area', field: 'Form field',
  };
  return (a.type === 'image' && a.label === 'signature' ? 'Signature' : m[a.type]) || a.type;
}
