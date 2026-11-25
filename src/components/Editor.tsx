import pencilCursor from '../pencil-cursor.png';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadPdf, pdfjs, type PDFDocumentProxy } from '../lib/pdf';
import type { Annot, DocTab, RedactAnnot, Rect, Snapshot, StyleState, Tool } from '../types';
import { EditorCtx, type EditorApi, type Hit, type PendingImage } from './EditorContext';
import { PageView } from './PageView';
import { Thumbnails, type PageActions } from './Thumbnails';
import { SignatureDialog } from './SignatureDialog';
import { ToolDialog, resolveWatermark, type ToolKind, type ToolHandlers } from './ToolDialogs';
import { Icon } from './Icon';
import { bake } from '../lib/bake';
import { applyRedactions } from '../lib/redact';
import * as ops from '../lib/ops';
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
    { tool: 'editText', icon: 'editText', label: 'Edit existing text (E) — click any word/line', key: 'e' },
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
    { tool: 'rect', icon: 'rect', label: 'Rectangle (R) — Shift for square', key: 'r' },
    { tool: 'ellipse', icon: 'ellipse', label: 'Ellipse (O)', key: 'o' },
    { tool: 'line', icon: 'line', label: 'Line (L) — Shift snaps 45°', key: 'l' },
    { tool: 'arrow', icon: 'arrow', label: 'Arrow (A)', key: 'a' },
  ],
  [{ tool: 'redact', icon: 'redact', label: 'Redact — permanently removes content on save', key: 'x' }],
];

/** The tools people look for by name get a visible label, not just an icon. */
const SHORT: Partial<Record<Tool, string>> = {
  editText: 'Edit text',
  move: 'Move',
  text: 'Add text',
  highlight: 'Highlight',
  mark: 'Check',
};

const COLORS = ['#111111', '#c62828', '#1d5fbf', '#1f8a3b', '#d97706', '#6b3fbf', '#ffffff'];
const HL_COLORS = ['#ffe14d', '#7ee08a', '#7cc7ff', '#ff9ccf', '#ffb35c'];

export function Editor({ tab, onUpdate, openNew, registerSave }: Props) {
  const pointerRef = useRef<HTMLImageElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  // bumps every time a freshly loaded document is shown; keys pages so they never show stale content
  const [loadId, setLoadId] = useState(0);
  const [sizes, setSizes] = useState<{ w: number; h: number }[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [tool, setTool] = useState<Tool>('select');
  const [style, setStyle] = useState<StyleState>({
    color: '#c62828',
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
  });
  const [fonts, setFonts] = useState<string[]>([]);
  useEffect(() => {
    window.acro.listFonts().then(setFonts).catch(() => {});
  }, []);
  const [selectedId, setSelected] = useState<string | null>(null);
  const [editingId, setEditing] = useState<string | null>(null);
  const [panel, setPanel] = useState<'pages' | 'search' | 'comments' | null>('pages');
  const [current, setCurrent] = useState(0);
  const [pendingImage, setPendingImage] = useState<PendingImage | null>(null);
  const [sigDialog, setSigDialog] = useState<null | { tab?: 'stamp'; field?: { page: number; rect: Rect } }>(null);
  const [toolDialog, setToolDialog] = useState<ToolKind | null>(null);
  const [toolsMenu, setToolsMenu] = useState(false);
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
        // existing comments in the file
        const found: { page: number; author: string; text: string }[] = [];
        for (let i = 0; i < Math.min(d.numPages, 300); i++) {
          const anns = await (await d.getPage(i + 1)).getAnnotations();
          for (const a of anns as any[])
            if (['Text', 'FreeText', 'Highlight', 'Square', 'Ink'].includes(a.subtype) && a.contentsObj?.str)
              found.push({ page: i, author: a.titleObj?.str || '', text: a.contentsObj.str });
        }
        if (alive) setExistingComments(found);
      })
      .catch((e) => {
        if (alive) setLoadError(e?.name === 'PasswordException' ? 'This PDF is password protected. Password support is on the roadmap.' : errText(e));
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

  // fit width on first load
  const didFit = useRef(false);
  useEffect(() => {
    if (!sizes.length || didFit.current) return;
    didFit.current = true;
    fitWidth();
  }, [sizes]);

  const fitWidth = () => {
    const el = viewerRef.current;
    if (!el || !sizes.length) return;
    const maxW = Math.max(...sizes.map((s) => s.w));
    setZoom(Math.min(3, Math.max(0.25, (el.clientWidth - 64) / maxW)));
  };
  const fitPage = () => {
    const el = viewerRef.current;
    if (!el || !sizes.length) return;
    const s = sizes[current] || sizes[0];
    setZoom(Math.max(0.25, Math.min((el.clientWidth - 64) / s.w, (el.clientHeight - 40) / s.h)));
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
      const normal = t.annots.filter((a) => a.type !== 'redact');
      const redacts = t.annots.filter((a): a is RedactAnnot => a.type === 'redact');
      let out = t.bytes;
      if (normal.length || Object.keys(t.form).length || opts.flattenForms)
        out = await bake(out, normal, t.form, getViewport, {
          ...opts,
          author: localStorage.getItem('acro.user') || undefined,
          loadSystemFont: async (family, bold, italic) => (await window.acro.loadFont({ family, bold, italic }))?.data ?? null,
        });
      if (redacts.length) out = await applyRedactions(out, redacts);
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
        let path = t.path;
        if (as || !path) {
          path = await window.acro.saveFile(t.path ? t.path : t.name.endsWith('.pdf') ? t.name : t.name + '.pdf', out);
          if (!path) return false;
        } else await window.acro.writeFile(path, out);
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
    }),
    [zoom, tool, style, tab.annots, tab.form, selectedId, editingId, hits, activeHit, pendingImage, mutate, onUpdate],
  );

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

  const toolHandlers: ToolHandlers = {
    watermark: (o) => {
      setToolDialog(null);
      run('Adding watermark…', async (b) => ops.watermark(b, await resolveWatermark(o)));
    },
    numbers: (o) => {
      setToolDialog(null);
      run('Numbering pages…', (b) => ops.pageNumbers(b, o));
    },
    split: async (spec) => {
      setToolDialog(null);
      const folder = await window.acro.chooseFolder();
      if (!folder) return;
      setBusy({ msg: 'Splitting…' });
      try {
        const parts = await ops.split(await produceBytes(), spec);
        for (let i = 0; i < parts.length; i++) await window.acro.writeInFolder(folder, downloadName(tab.name, `-part${i + 1}`), parts[i]);
        toast(`Created ${parts.length} files`, 'ok');
        window.acro.showItem(folder);
      } catch (e) {
        toast(errText(e), 'error');
      } finally {
        setBusy(null);
      }
    },
    properties: (m) => {
      setToolDialog(null);
      run('Updating properties…', (b) => ops.setMetadata(b, m));
    },
    ocr: async ({ lang, scope }) => {
      setToolDialog(null);
      const pages = scope === 'current' ? [current] : Array.from({ length: pdf!.numPages }, (_, i) => i);
      setBusy({ msg: 'Preparing OCR…', frac: 0 });
      try {
        const base = await produceBytes();
        const basePdf = base === tab.bytes ? pdf! : await loadPdf(base);
        const res = await ocrDocument(base, basePdf, pages, lang, (msg, frac) => setBusy({ msg, frac }));
        mutate((t) => ({ bytes: res.bytes, annots: [], form: {}, rev: t.rev + 1 }));
        toast(`OCR complete — ${res.words} words recognized. Text is now searchable.`, 'ok');
      } catch (e) {
        toast('OCR failed: ' + errText(e), 'error');
      } finally {
        setBusy(null);
      }
    },
    toWord: (mode) => {
      setToolDialog(null);
      exportOffice(mode === 'exact' ? 'word-exact' : 'word-text');
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
    if (!t.annots.length && !Object.keys(t.form).length) return { doc: pdf!, temp: false };
    return { doc: await loadPdf(await produceBytes()), temp: true };
  };

  const exportOffice = async (kind: 'word-text' | 'word-exact' | 'excel' | 'ppt') => {
    const { pdfToDocx, pdfToXlsx, pdfToPptx } = await import('../lib/exporters');
    setBusy({ msg: 'Converting…', frac: 0 });
    let temp: PDFDocumentProxy | null = null;
    try {
      const { doc, temp: isTemp } = await currentPdf();
      if (isTemp) temp = doc;
      const prog = (i: number, n: number) => setBusy({ msg: `Converting page ${i} of ${n}…`, frac: i / n });
      const [bytes, ext, label] =
        kind === 'excel' ? [await pdfToXlsx(doc, prog), 'xlsx', 'Excel']
        : kind === 'ppt' ? [await pdfToPptx(doc, prog), 'pptx', 'PowerPoint']
        : [await pdfToDocx(doc, kind === 'word-exact' ? 'exact' : 'text', prog), 'docx', 'Word'];
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
    compress: async () => {
      const before = tab.bytes.length;
      const ok = await run('Optimizing…', (b) => ops.compress(b));
      if (ok) {
        const after = tabRef.current.bytes.length;
        toast(`Optimized: ${(before / 1024).toFixed(0)} KB → ${(after / 1024).toFixed(0)} KB`, 'ok');
      }
    },
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
      split: 'split', watermark: 'watermark', numbers: 'numbers', ocr: 'ocr', exportImages: 'exportImages', toWord: 'toWord', properties: 'properties',
    };
    if (dialogs[a]) setToolDialog(dialogs[a]);
    else if (a === 'sign') setSigDialog({});
    else if (a === 'redact' || a === 'editText') setTool(a);
    else if (a === 'pages') setPanel('pages');
    else if (a === 'compress') quickActions.compress();
    else if (a === 'flatten') quickActions.flatten();
    else if (a === 'toExcel') exportOffice('excel');
    else if (a === 'toPpt') exportOffice('ppt');
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
      if (mod && e.key.toLowerCase() === 's') {
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
      } else if (typing) return;
      else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        api.removeAnnot(selectedId);
      } else if (e.key === 'Escape') {
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
  const pendingCount = tab.annots.length + Object.keys(tab.form).length;
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
      <div className="editor"
        onPointerMoveCapture={(event) => {
          const pointer = pointerRef.current;
          if (!pointer) return;
          pointer.hidden = event.pointerType !== 'mouse' || !pointer.complete || !pointer.naturalWidth;
          pointer.style.transform = `translate3d(${event.clientX - 2}px, ${event.clientY - 29}px, 0)`;
        }}
        onPointerLeave={() => { if (pointerRef.current) pointerRef.current.hidden = true; }}
        onDragStartCapture={() => { if (pointerRef.current) pointerRef.current.hidden = true; }}
      >
        <img ref={pointerRef} className="editor-pencil" src={pencilCursor} alt="" hidden draggable={false} />
        {/* ---------- toolbar ---------- */}
        <div className="toolbar">
          <div className="tb-group">
            <button className="icon-btn" title="Save (Ctrl+S)" onClick={() => save(false)}>
              <Icon name="save" />
            </button>
            <button className="icon-btn" title="Undo (Ctrl+Z)" disabled={!tab.past.length} onClick={undo}>
              <Icon name="undo" />
            </button>
            <button className="icon-btn" title="Redo (Ctrl+Y)" disabled={!tab.future.length} onClick={redo}>
              <Icon name="redo" />
            </button>
          </div>
          {TOOL_GROUPS.map((g, gi) => (
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
          ))}
          <div className="tb-group">
            <button className="tb-btn accent" title="Fill & sign" onClick={() => setSigDialog({})}>
              <Icon name="sign" /> Sign
            </button>
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
            <button className="zoom-label" title="Fit width (Ctrl 0) — click again for fit page" onClick={() => (Math.abs(zoom - 1) < 0.01 ? fitWidth() : fitPage())}>
              {Math.round(zoom * 100)}%
            </button>
            <button className="icon-btn" title="Zoom in (Ctrl +)" onClick={() => zoomTo(zoom * 1.2)}>
              <Icon name="zoomIn" />
            </button>
            <button className="icon-btn" title="Fit width" onClick={fitWidth}>
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
            <button className={`tb-btn ${toolsMenu ? 'on' : ''}`} onClick={() => setToolsMenu((v) => !v)}>
              <Icon name="tools" /> All tools <Icon name="chevD" size={14} />
            </button>
            {toolsMenu && (
              <div className="menu" onMouseLeave={() => setToolsMenu(false)} onClick={() => setToolsMenu(false)}>
                <div className="menu-head">Organize</div>
                <button onClick={quickActions.combine}><Icon name="merge" /> Combine (append PDFs)</button>
                <button onClick={() => setToolDialog('split')}><Icon name="split" /> Split…</button>
                <button onClick={() => setPanel('pages')}><Icon name="pages" /> Organize pages</button>
                <div className="menu-head">Protect & finish</div>
                <button onClick={() => setTool('redact')}><Icon name="redact" /> Redact</button>
                <button onClick={() => setToolDialog('watermark')}><Icon name="water" /> Watermark…</button>
                <button onClick={() => setToolDialog('numbers')}><Icon name="hash" /> Page numbers / Bates…</button>
                <button onClick={quickActions.flatten}><Icon name="form" /> Flatten forms & markup</button>
                <button onClick={quickActions.compress}><Icon name="compress" /> Optimize file size</button>
                <div className="menu-head">Convert</div>
                <button onClick={() => setToolDialog('toWord')}><Icon name="word" /> Export to Word…</button>
                <button onClick={() => exportOffice('excel')}><Icon name="excel" /> Export to Excel</button>
                <button onClick={() => exportOffice('ppt')}><Icon name="ppt" /> Export to PowerPoint</button>
                <div className="menu-head">Scan & export</div>
                <button onClick={() => setToolDialog('ocr')}><Icon name="ocr" /> Recognize text (OCR)…</button>
                <button onClick={() => setToolDialog('exportImages')}><Icon name="image" /> Export as images…</button>
                <button onClick={quickActions.exportText}><Icon name="file" /> Export as text</button>
                <button onClick={quickActions.saveCopyFlattened}><Icon name="download" /> Save flattened copy…</button>
                <div className="menu-head">Document</div>
                <button onClick={() => setToolDialog('properties')}><Icon name="info" /> Properties…</button>
                <button onClick={() => save(true)}><Icon name="save" /> Save as…</button>
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
          <div className={`viewer tool-${tool}`} ref={viewerRef} onScroll={onScroll}>
            {pdf ? (
              sizes.map((s, i) => <PageView key={`${loadId}-${i}`} pdf={pdf} index={i} size={s} rev={loadId} registerEl={registerEl} />)
            ) : (
              <div className="empty-state">Opening…</div>
            )}
          </div>
        </div>

        <div className="statusbar">
          <span>{tab.path || 'Unsaved document'}</span>
          <span className="tb-spacer" />
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
        {sigDialog && <SignatureDialog initialTab={sigDialog.tab} onPick={onPickImage} onClose={() => setSigDialog(null)} />}
        {toolDialog && pdf && (
          <ToolDialog kind={toolDialog} bytes={tab.bytes} numPages={pdf.numPages} onClose={() => setToolDialog(null)} h={toolHandlers} />
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
    highlight: 'Select text to highlight it — or drag a box on scanned pages.',
    underline: 'Select text to underline it.',
    strike: 'Select text to strike it through.',
    whiteout: 'Drag to cover content with white (visual only — use Redact to truly remove).',
    redact: `Drag over anything sensitive. On save, marked pages are rebuilt so the content is gone for good.${redactCount ? ` (${redactCount} marked)` : ''}`,
    note: 'Click to drop a comment.',
    mark: 'Click the centre of a box to tick it. Works on printed boxes that are not real form fields.',
    move: 'Drag a box around text, lines, boxes or pictures, then drag the box where you want it. Saved as a real move, not a picture.',
    text: 'Click anywhere to type new text.',
    place: pendingImage ? 'Click where you want to place it. Esc to cancel.' : '',
    hand: 'Drag to pan.',
  };

  return (
    <div className="contextbar">
      {selected && <span className="ctx-label">{labelFor(selected)}</span>}
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
      {selected && (
        <button className="small danger" onClick={onDelete}>
          <Icon name="trash" size={14} /> Delete
        </button>
      )}
      {selected && (selected.type === 'text' || selected.type === 'replace') && <span className="ctx-hint">Double-click to edit text</span>}
    </div>
  );
}

function labelFor(a: Annot) {
  const m: Record<string, string> = {
    highlight: 'Highlight', underline: 'Underline', strike: 'Strikethrough', ink: 'Drawing', rect: 'Rectangle',
    ellipse: 'Ellipse', line: 'Line', arrow: 'Arrow', text: 'Text box', replace: 'Edited text', whiteout: 'Whiteout',
    redact: 'Redaction', image: 'Image', note: 'Comment', mark: 'Check mark', move: 'Moved area',
  };
  return (a.type === 'image' && a.label === 'signature' ? 'Signature' : m[a.type]) || a.type;
}
