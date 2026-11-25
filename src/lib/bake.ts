import { embeddedFace } from './embeddedFace';
import { addField } from './formFields';
// Writes pending annotations + form values into the PDF bytes using pdf-lib.
import {
  PDFDocument,
  PDFFont,
  PDFPage,
  PDFRef,
  StandardFonts,
  rgb,
  degrees,
  BlendMode,
  LineCapStyle,
  PDFTextField,
  PDFCheckBox,
  PDFRadioGroup,
  PDFDropdown,
  PDFOptionList,
  PDFName,
  PDFString,
  PDFHexString,
  pushGraphicsState,
  popGraphicsState,
  setCharacterSpacing,
  setCharacterSqueeze,
  setWordSpacing,
  setTextRise,
  moveTo, lineTo, stroke, setDashPattern, setLineWidth, setLineCap, setStrokingRgbColor,
  setTextRenderingMode,
  TextRenderingMode,
} from 'pdf-lib';
import type { PageViewport } from './pdf';
import type { Annot, FormValues, MoveAnnot, TextAnnot } from '../types';
import { moveGraphicsInRect, removeTextInRects } from './textremove';
import { markStrokes } from './marks';
import { NON_LATIN, dataUrlToBytes, hexToRgb01, normRect, winAnsiSafe } from './util';

export interface BakeOptions {
  flattenForms?: boolean;
  author?: string;
  /** returns the installed font file (TTF/OTF bytes) for a family + style, or null */
  loadSystemFont?: (family: string, bold: boolean, italic: boolean) => Promise<Uint8Array | null>;
}

type ViewportGetter = (pageIndex: number) => Promise<PageViewport>;

const col = (hex: string) => rgb(...hexToRgb01(hex));

export function wrapText(font: PDFFont, text: string, size: number, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    const words = para.split(/(\s+)/);
    let line = '';
    for (const w of words) {
      const test = line + w;
      if (line && font.widthOfTextAtSize(test.trimEnd(), size) > maxWidth) {
        out.push(line.trimEnd());
        line = w.trimStart();
      } else line = test;
    }
    out.push(line);
  }
  return out;
}

export async function bake(
  bytes: Uint8Array,
  annots: Annot[],
  form: FormValues,
  getViewport: ViewportGetter,
  opts: BakeOptions = {},
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const helvBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const pages = doc.getPages();
  const imageCache = new Map<string, Awaited<ReturnType<PDFDocument['embedPng']>>>();
  const fontCache = new Map<string, PDFFont>();
  const FONTS = {
    sans: [StandardFonts.Helvetica, StandardFonts.HelveticaBold],
    serif: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold],
    mono: [StandardFonts.Courier, StandardFonts.CourierBold],
  } as const;
  const ITALIC = {
    sans: [StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique],
    serif: [StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic],
    mono: [StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique],
  } as const;
  const getFont = async (family: 'sans' | 'serif' | 'mono', bold: boolean, italic = false) => {
    const name = (italic ? ITALIC : FONTS)[family][bold ? 1 : 0];
    if (!fontCache.has(name)) fontCache.set(name, await doc.embedFont(name));
    return fontCache.get(name)!;
  };
  /** The real installed typeface (e.g. Tahoma Bold) so edited text matches the original exactly. */
  let fontkitReady = false;
  const getSystemFont = async (family: string, bold: boolean, italic: boolean): Promise<PDFFont | null> => {
    if (!opts.loadSystemFont) return null;
    const key = `sys:${family}|${bold}|${italic}`;
    if (fontCache.has(key)) return fontCache.get(key)!;
    const res = await opts.loadSystemFont(family, bold, italic);
    if (!res) return null;
    if (!fontkitReady) {
      doc.registerFontkit((await import('@pdf-lib/fontkit')).default);
      fontkitReady = true;
    }
    try {
      const f = await doc.embedFont(res, { subset: true });
      fontCache.set(key, f);
      return f;
    } catch {
      return null;
    }
  };

  // ---- forms first so annotations can sit on top of flattened fields ----
  if (Object.keys(form).length || opts.flattenForms) {
    try {
      const f = doc.getForm();
      for (const [name, value] of Object.entries(form)) {
        try {
          const field = f.getField(name);
          if (field instanceof PDFTextField) field.setText(String(value ?? ''));
          else if (field instanceof PDFCheckBox) (value ? field.check() : field.uncheck());
          else if (field instanceof PDFRadioGroup) {
            if (value) field.select(String(value));
            else field.clear();
          } else if (field instanceof PDFDropdown) field.select(String(value));
          else if (field instanceof PDFOptionList) field.select(String(value));
        } catch (e) {
          console.warn('Could not set field', name, e);
        }
      }
      try {
        f.updateFieldAppearances(helv);
      } catch (e) {
        console.warn('appearance update failed', e);
      }
      if (opts.flattenForms) f.flatten();
    } catch (e) {
      console.warn('form handling failed', e);
    }
  }

  // text boxes imported from the PDF that were not touched are left exactly as they were
  annots = annots.filter((a) => !(a.type === 'replace' && a.srcAnnot && a.orig && a.text === a.origText && Math.abs(a.x - a.orig.x) < 0.01 && Math.abs(a.y - a.orig.y) < 0.01));
  const byPage = new Map<number, Annot[]>();
  for (const a of annots) {
    if (!byPage.has(a.page)) byPage.set(a.page, []);
    byPage.get(a.page)!.push({ ...a } as Annot); // copies: baking adjusts fields and must not touch editor state
  }

  for (const [pageIndex, list] of byPage) {
    const page = pages[pageIndex];
    if (!page) continue;
    // the original text box (annotation) of an edited imported text goes; the edited text is drawn into the page instead
    const gone = list.filter((a): a is TextAnnot => a.type === 'replace' && !!a.srcAnnot).map((a) => a.srcAnnot!.num);
    const annotArr = gone.length ? page.node.Annots() : undefined;
    if (annotArr)
      for (let k = annotArr.size() - 1; k >= 0; k--) {
        const r = annotArr.get(k);
        if (r instanceof PDFRef && gone.includes(r.objectNumber)) annotArr.remove(k);
      }
    const vp = await getViewport(pageIndex);
    const rot = vp.rotation % 360;
    const P = (x: number, y: number) => {
      const [px, py] = vp.convertToPdfPoint(x, y);
      return { x: px, y: py };
    };
    const box = (x: number, y: number, w: number, h: number) => {
      const a = P(x, y);
      const b = P(x + w, y + h);
      return normRect(a.x, a.y, b.x, b.y);
    };

    // Move tool: shift graphics/images inside the area in the content stream itself,
    // and turn the area's text runs into edits drawn at the new position.
    for (const mv of list.filter((a): a is MoveAnnot => a.type === 'move')) {
      const from = box(mv.from.x, mv.from.y, mv.from.w, mv.from.h);
      const p0 = P(mv.from.x, mv.from.y);
      const p1 = P(mv.from.x + mv.dx, mv.from.y + mv.dy);
      try {
        moveGraphicsInRect(doc, page, from, p1.x - p0.x, p1.y - p0.y);
      } catch (e) {
        console.warn('graphics move failed', e);
      }
      for (const t of mv.texts)
        list.push({
          id: `${mv.id}-${t.startX}-${t.baseline}`,
          page: pageIndex,
          type: 'replace',
          x: t.orig.x + mv.dx,
          y: t.orig.y + mv.dy,
          w: t.orig.w,
          h: t.orig.h,
          orig: t.orig,
          text: t.text,
          fontSize: t.fontSize,
          color: t.color,
          bg: '#ffffff',
          font: t.font,
          family: t.family,
          bold: t.bold,
          italic: t.italic,
          baseline: t.baseline + mv.dy,
          startX: t.startX + mv.dx,
        });
    }

    // Edited text: delete the original words from the page content (true edit, like Acrobat).
    // Only if that can't be done safely do we fall back to covering them with white.
    const replaces = list.filter((a): a is TextAnnot => a.type === 'replace' && !!a.orig);
    if (replaces.length) {
      let res: ReturnType<typeof removeTextInRects> = { removed: 0, unsafe: true, styles: [] };
      try {
        res = removeTextInRects(doc, page, replaces.map((a) => ({ ...box(a.orig!.x, a.orig!.y, a.orig!.w, a.orig!.h), size: a.fontSize })));
      } catch (e) {
        console.warn('text removal failed; covering instead', e);
      }
      const clean = res.removed > 0 && !res.unsafe;
      replaces.forEach((a, k) => {
        // a text box imported from the PDF needs no cover: its original box is removed instead (a cover would also hide nearby lines)
        a.bg = clean || a.srcAnnot ? null : a.bg || '#ffffff';
        const s = res.styles[k];
        if (s) {
          a.charSpacing = s.tc;
          a.hScale = s.th;
        }
      });
    }

    // Isolate the page's own content (q … Q) so settings it leaves behind (letter spacing,
    // scaling, render mode) can't leak into text we add: they made edits look thinner.
    if (!(page as any).contentStreamRef) {
      const start = doc.context.register(doc.context.contentStream([pushGraphicsState()]));
      const end = doc.context.register(doc.context.contentStream([popGraphicsState()]));
      page.node.wrapContentStreams(start, end);
    }

    // whiteouts & edit-text backgrounds go first so other markup draws above them
    const ordered = [...list].sort((a, b) => rank(a) - rank(b));
    for (const a of ordered)
      await drawAnnot(doc, page, a, { P, box, rot, helv, helvBold, font: getFont, systemFont: getSystemFont, imageCache, author: opts.author });
  }

  return doc.save({ useObjectStreams: true });
}

/** Rotate point p around c by `deg` clockwise as seen on screen (= negative angle in PDF's y-up space). */
function turn(p: { x: number; y: number }, c: { x: number; y: number }, deg: number) {
  if (!deg) return p;
  const t = (-deg * Math.PI) / 180;
  const dx = p.x - c.x, dy = p.y - c.y;
  return { x: c.x + dx * Math.cos(t) - dy * Math.sin(t), y: c.y + dx * Math.sin(t) + dy * Math.cos(t) };
}

function rank(a: Annot) {
  if (a.type === 'whiteout') return 0;
  if (a.type === 'replace') return 1;
  if (a.type === 'highlight') return 2;
  return 3;
}

interface Ctx {
  P: (x: number, y: number) => { x: number; y: number };
  box: (x: number, y: number, w: number, h: number) => { x: number; y: number; w: number; h: number };
  rot: number;
  helv: PDFFont;
  helvBold: PDFFont;
  font: (family: 'sans' | 'serif' | 'mono', bold: boolean, italic?: boolean) => Promise<PDFFont>;
  systemFont: (family: string, bold: boolean, italic: boolean) => Promise<PDFFont | null>;
  imageCache: Map<string, any>;
  author?: string;
}

async function drawAnnot(doc: PDFDocument, page: PDFPage, a: Annot, c: Ctx) {
  const { P, box, rot } = c;
  switch (a.type) {
    case 'whiteout': {
      const r = box(a.x, a.y, a.w, a.h);
      page.drawRectangle({ x: r.x, y: r.y, width: r.w, height: r.h, color: col(a.color) });
      break;
    }
    case 'highlight':
      for (const rr of a.rects) {
        const r = box(rr.x, rr.y, rr.w, rr.h);
        page.drawRectangle({
          x: r.x,
          y: r.y,
          width: r.w,
          height: r.h,
          color: col(a.color),
          opacity: 0.4,
          blendMode: BlendMode.Multiply,
        });
      }
      break;
    case 'underline':
    case 'strike':
      for (const rr of a.rects) {
        const yy = a.type === 'underline' ? rr.y + rr.h * 0.95 : rr.y + rr.h * 0.55;
        const thickness = Math.max(0.8, rr.h * 0.07);
        page.drawLine({ start: P(rr.x, yy), end: P(rr.x + rr.w, yy), thickness, color: col(a.color) });
      }
      break;
    case 'ink': {
      if (a.points.length < 2) break;
      const first = P(...a.points[0]);
      page.pushOperators(pushGraphicsState(), setLineWidth(a.width), setLineCap(LineCapStyle.Round),
        setStrokingRgbColor(...hexToRgb01(a.color)), setDashPattern(a.dash ? [3 * a.width, 2 * a.width] : [], 0),
        moveTo(first.x, first.y));
      for (const point of a.points.slice(1)) {
        const next = P(...point);
        page.pushOperators(lineTo(next.x, next.y));
      }
      page.pushOperators(stroke(), popGraphicsState());
      break;
    }
    case 'rect': {
      const r = box(a.x, a.y, a.w, a.h);
      page.drawRectangle({
        x: r.x,
        y: r.y,
        width: r.w,
        height: r.h,
        borderColor: col(a.color),
        borderWidth: a.width,
        borderDashArray: a.dash ? [a.width * 3, a.width * 2] : undefined,
        color: a.fill ? col(a.fill) : undefined,
      });
      break;
    }
    case 'ellipse': {
      const r = box(a.x, a.y, a.w, a.h);
      page.drawEllipse({
        x: r.x + r.w / 2,
        y: r.y + r.h / 2,
        xScale: r.w / 2,
        yScale: r.h / 2,
        borderColor: col(a.color),
        borderWidth: a.width,
        borderDashArray: a.dash ? [a.width * 3, a.width * 2] : undefined,
        color: a.fill ? col(a.fill) : undefined,
      });
      break;
    }
    case 'line':
    case 'arrow': {
      const s = P(a.x1, a.y1);
      const e = P(a.x2, a.y2);
      const color = col(a.color);
      page.drawLine({ start: s, end: e, thickness: a.width, color, lineCap: LineCapStyle.Round, dashArray: a.dash ? [a.width * 3, a.width * 2] : undefined });
      if (a.type === 'arrow') {
        const ang = Math.atan2(e.y - s.y, e.x - s.x);
        const len = Math.max(8, a.width * 4);
        for (const d of [Math.PI - 0.45, Math.PI + 0.45]) {
          page.drawLine({
            start: e,
            end: { x: e.x + len * Math.cos(ang + d), y: e.y + len * Math.sin(ang + d) },
            thickness: a.width,
            color,
            lineCap: LineCapStyle.Round,
          });
        }
      }
      break;
    }
    case 'field': {
      // a designed form field becomes a real, fillable field in the saved PDF
      addField(doc, page, a, box(a.x, a.y, a.w, a.h));
      break;
    }
    case 'text':
    case 'replace': {
      let sys: PDFFont | null = null;
      if (a.sourceFace) {
        try {
          const bytes = embeddedFace(page, a.sourceFace);
          if (bytes) {
            const kit = (await import('@pdf-lib/fontkit')).default;
            const source = kit.create(bytes);
            if ([...a.text].every(ch => ch === '\n' || source.glyphForCodePoint(ch.codePointAt(0)!).id !== 0)) {
              doc.registerFontkit(kit);
              sys = await doc.embedFont(bytes, { subset: true });
            }
          }
        } catch { /* Unsupported embedded font format. */ }
      }
      if (!sys && a.family) sys = await c.systemFont(a.family, !!a.bold, !!a.italic);
      // ₱, accents beyond Latin-1, Cyrillic, Greek, CJK…: the standard PDF fonts can't draw these, so find an
      // installed font that can (the chosen family first, then common wide-coverage Windows fonts)
      const covers = (f: PDFFont, s: string) => {
        const set = new Set(f.getCharacterSet());
        return [...s].filter((ch) => ch !== '\n' && ch !== '\t' && !set.has(ch.codePointAt(0)!)).length;
      };
      if (NON_LATIN.test(a.text) && (!sys || covers(sys, a.text) > 0)) {
        let best = sys, bestMissing = sys ? covers(sys, a.text) : Infinity;
        const tried = new Set<string>();
        for (const fam of [a.family, 'Segoe UI', 'Arial', 'Nirmala UI', 'Segoe UI Symbol', 'Microsoft YaHei', 'Yu Gothic', 'Malgun Gothic', 'Leelawadee UI']) {
          if (!fam || tried.has(fam)) continue;
          tried.add(fam);
          const f = await c.systemFont(fam, !!a.bold, !!a.italic);
          if (!f) continue;
          const missing = covers(f, a.text);
          if (missing < bestMissing) {
            best = f;
            bestMissing = missing;
          }
          if (!missing) break;
        }
        sys = best;
      }
      const font = sys || (await c.font(a.font || 'sans', !!a.bold, !!a.italic));
      const sysSet = sys ? new Set(sys.getCharacterSet()) : null;
      // with an embedded font keep every character it has; anything it lacks becomes "?" instead of crashing the save
      const safe = (s: string) =>
        sysSet
          ? [...s.replace(/\t/g, '    ')].map((ch) => (ch === '\n' || sysSet.has(ch.codePointAt(0)!) ? ch : '?')).join('')
          : winAnsiSafe(s);
      if (a.bg) {
        const r = a.orig ? box(a.orig.x, a.orig.y, a.orig.w, a.orig.h) : box(a.x, a.y, a.w, a.h);
        page.drawRectangle({ x: r.x, y: r.y, width: r.w, height: r.h, color: col(a.bg) });
      }
      // edited lines stay on one line at the original baseline; new text boxes wrap
      const lines = a.type === 'replace' || a.wrap === false ? safe(a.text).split('\n') : wrapText(font, safe(a.text), a.fontSize, Math.max(a.w - 4, 10));
      const avail = Math.max(a.w - 4, 10);
      const lh = a.fontSize * 1.2;
      const x0 = a.type === 'replace' && a.startX !== undefined ? a.startX : a.x + 2;
      lines.forEach((line, i) => {
        if (!line) return;
        const baseline =
          a.type === 'replace' && a.baseline !== undefined ? a.baseline + i * lh : a.y + 2 + i * lh + a.fontSize * 0.95;
        const spin = a.type === 'text' ? a.rotation || 0 : 0;
        // Keep the document's own word spacing (justified paragraphs): measure how much wider the
        // original run was than its natural width, and give every word gap that same extra space.
        // the original run's letter spacing / horizontal scale (0 and 100% for new text boxes)
        const tc = a.type === 'replace' ? a.charSpacing ?? 0 : 0;
        const hs = a.type === 'replace' ? a.hScale ?? 1 : 1;
        const runW = (s: string) => (font.widthOfTextAtSize(s, a.fontSize) + [...s].length * tc) * hs;
        // explicit text state, so nothing left over on the page can change how this looks
        page.pushOperators(
          pushGraphicsState(),
          setCharacterSpacing(tc),
          setWordSpacing(0),
          setCharacterSqueeze(hs * 100),
          setTextRise(0),
          setTextRenderingMode(TextRenderingMode.Fill),
        );
        // alignment inside the box (not for edits that sit on an original line of the page)
        let xl = x0;
        let justify = 0;
        if (a.align && a.align !== 'left' && !(a.type === 'replace' && a.startX !== undefined)) {
          const lw = runW(line);
          if (a.align === 'center') xl = x0 + (avail - lw) / 2;
          else if (a.align === 'right') xl = x0 + avail - lw;
          else if (a.align === 'justify' && i < lines.length - 1) {
            const sp = (line.match(/ /g) || []).length;
            if (sp) justify = (avail - lw) / sp;
          }
        }
        let extra = 0;
        if (a.type === 'replace' && a.origText && a.origWidth) {
          const spaces = (a.origText.match(/ /g) || []).length;
          if (spaces) {
            extra = (a.origWidth - runW(safe(a.origText))) / spaces;
            extra = Math.max(-a.fontSize * 0.15, Math.min(a.fontSize * 1.5, extra));
          }
        }
        if (justify > 0) extra = justify;
        if (Math.abs(extra) < 0.01) {
          const o = turn(P(xl, baseline), P(a.x + a.w / 2, a.y + a.h / 2), spin);
          page.drawText(line, { x: o.x, y: o.y, size: a.fontSize, font, color: col(a.color), rotate: degrees(rot - spin) });
        } else {
          // word by word, advancing by the measured width plus the document's spacing
          let cx = xl;
          for (const word of line.split(' ')) {
            if (word) {
              const o = P(cx, baseline);
              page.drawText(word, { x: o.x, y: o.y, size: a.fontSize, font, color: col(a.color), rotate: degrees(rot) });
              cx += runW(word);
            }
            cx += runW(' ') + extra;
          }
        }
        page.pushOperators(popGraphicsState());
      });
      break;
    }
    case 'image': {
      let img = c.imageCache.get(a.dataUrl);
      if (!img) {
        const bytes = dataUrlToBytes(a.dataUrl);
        img = a.dataUrl.startsWith('data:image/jpeg') ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
        c.imageCache.set(a.dataUrl, img);
      }
      const spin = a.rotation || 0;
      const o = turn(P(a.x, a.y + a.h), P(a.x + a.w / 2, a.y + a.h / 2), spin);
      page.drawImage(img, { x: o.x, y: o.y, width: a.w, height: a.h, rotate: degrees(rot - spin) });
      break;
    }
    case 'mark': {
      const color = col(a.color);
      if (a.kind === 'dot') {
        const cpt = P(a.x, a.y);
        page.drawCircle({ x: cpt.x, y: cpt.y, size: a.size * 0.28, color });
      } else {
        for (const pts of markStrokes(a.kind))
          for (let i = 1; i < pts.length; i++)
            page.drawLine({
              start: P(a.x + pts[i - 1][0] * a.size, a.y + pts[i - 1][1] * a.size),
              end: P(a.x + pts[i][0] * a.size, a.y + pts[i][1] * a.size),
              thickness: Math.max(0.8, a.size * 0.13),
              color,
              lineCap: LineCapStyle.Round,
            });
      }
      break;
    }
    case 'note': {
      // Real PDF sticky note so it stays a comment in every reader.
      const o = P(a.x, a.y + 22);
      const [r, g, b] = hexToRgb01(a.color);
      const dict = doc.context.obj({
        Type: 'Annot',
        Subtype: 'Text',
        Rect: [o.x, o.y, o.x + 22, o.y + 22],
        Contents: PDFHexString.fromText(a.text),
        T: PDFHexString.fromText(c.author || 'PweDeF'),
        M: PDFString.fromDate(new Date()),
        Name: PDFName.of('Comment'),
        C: [r, g, b],
        F: 4,
        Open: false,
      });
      page.node.addAnnot(doc.context.register(dict));
      break;
    }
  }
}
