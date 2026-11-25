// Writes pending annotations + form values into the PDF bytes using pdf-lib.
import {
  PDFDocument,
  PDFFont,
  PDFPage,
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
} from 'pdf-lib';
import type { PageViewport } from './pdf';
import type { Annot, FormValues, MoveAnnot, TextAnnot } from '../types';
import { moveGraphicsInRect, removeTextInRects } from './textremove';
import { markStrokes } from './marks';
import { dataUrlToBytes, hexToRgb01, normRect, winAnsiSafe } from './util';

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

  const byPage = new Map<number, Annot[]>();
  for (const a of annots) {
    if (!byPage.has(a.page)) byPage.set(a.page, []);
    byPage.get(a.page)!.push({ ...a } as Annot); // copies: baking adjusts fields and must not touch editor state
  }

  for (const [pageIndex, list] of byPage) {
    const page = pages[pageIndex];
    if (!page) continue;
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
      let res = { removed: 0, unsafe: true };
      try {
        res = removeTextInRects(doc, page, replaces.map((a) => box(a.orig!.x, a.orig!.y, a.orig!.w, a.orig!.h)));
      } catch (e) {
        console.warn('text removal failed; covering instead', e);
      }
      const clean = res.removed > 0 && !res.unsafe;
      for (const a of replaces) a.bg = clean ? null : a.bg || '#ffffff';
    }

    // whiteouts & edit-text backgrounds go first so other markup draws above them
    const ordered = [...list].sort((a, b) => rank(a) - rank(b));
    for (const a of ordered)
      await drawAnnot(doc, page, a, { P, box, rot, helv, helvBold, font: getFont, systemFont: getSystemFont, imageCache, author: opts.author });
  }

  return doc.save({ useObjectStreams: true });
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
    case 'ink':
      for (let i = 1; i < a.points.length; i++) {
        page.drawLine({
          start: P(...a.points[i - 1]),
          end: P(...a.points[i]),
          thickness: a.width,
          color: col(a.color),
          lineCap: LineCapStyle.Round,
        });
      }
      break;
    case 'rect': {
      const r = box(a.x, a.y, a.w, a.h);
      page.drawRectangle({
        x: r.x,
        y: r.y,
        width: r.w,
        height: r.h,
        borderColor: col(a.color),
        borderWidth: a.width,
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
        color: a.fill ? col(a.fill) : undefined,
      });
      break;
    }
    case 'line':
    case 'arrow': {
      const s = P(a.x1, a.y1);
      const e = P(a.x2, a.y2);
      const color = col(a.color);
      page.drawLine({ start: s, end: e, thickness: a.width, color, lineCap: LineCapStyle.Round });
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
    case 'text':
    case 'replace': {
      const sys = a.family ? await c.systemFont(a.family, !!a.bold, !!a.italic) : null;
      const font = sys || (await c.font(a.font || 'sans', !!a.bold, !!a.italic));
      const safe = (s: string) => (sys ? s.replace(/\t/g, '    ') : winAnsiSafe(s));
      if (a.bg) {
        const r = a.orig ? box(a.orig.x, a.orig.y, a.orig.w, a.orig.h) : box(a.x, a.y, a.w, a.h);
        page.drawRectangle({ x: r.x, y: r.y, width: r.w, height: r.h, color: col(a.bg) });
      }
      // edited lines stay on one line at the original baseline; new text boxes wrap
      const lines = a.type === 'replace' ? safe(a.text).split('\n') : wrapText(font, safe(a.text), a.fontSize, Math.max(a.w - 4, 10));
      const lh = a.fontSize * 1.2;
      const x0 = a.type === 'replace' && a.startX !== undefined ? a.startX : a.x + 2;
      lines.forEach((line, i) => {
        if (!line) return;
        const baseline =
          a.type === 'replace' && a.baseline !== undefined ? a.baseline + i * lh : a.y + 2 + i * lh + a.fontSize * 0.95;
        const o = P(x0, baseline);
        page.drawText(line, { x: o.x, y: o.y, size: a.fontSize, font, color: col(a.color), rotate: degrees(rot) });
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
      const o = P(a.x, a.y + a.h);
      page.drawImage(img, { x: o.x, y: o.y, width: a.w, height: a.h, rotate: degrees(rot) });
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
        T: PDFHexString.fromText(c.author || 'Acrobatics'),
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
