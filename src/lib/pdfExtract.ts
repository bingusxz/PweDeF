// Reads what the layout analysis needs from a page: text runs (with real font names), ruling lines and pictures.
import type { PDFDocumentProxy } from './pdf';
import type { Box, PageData, Run, Seg } from './pdfLayout';

type M = number[];

/** "ABCDEF+TimesNewRomanPS-BoldMT" -> "Times New Roman" */
export function cleanFontName(raw: string): string {
  let n = raw.replace(/^[A-Z]{6}\+/, '');
  n = n.split(/[-,]/)[0];
  n = n.replace(/(PS|MT)$/g, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim();
  return n || 'Arial';
}

const isBold = (s: string) => /bold|black|heavy|semibold|demi/i.test(s);
const isItalic = (s: string) => /italic|oblique/i.test(s);

/** The bits of pdf.js this needs, passed in so the same code runs in the app and in headless tests. */
export interface PdfJsLib {
  OPS: Record<string, number>;
  Util: { transform(a: number[], b: number[]): number[]; applyTransform(p: number[], m: number[]): number[] };
}

export async function extractPage(pdf: PDFDocumentProxy, index: number, pdfjs: PdfJsLib): Promise<PageData> {
  const page = await pdf.getPage(index);
  const vp = page.getViewport({ scale: 1 });
  const [tc, ol] = await Promise.all([page.getTextContent(), page.getOperatorList()]); // the operator list also loads the fonts
  const { OPS, Util } = pdfjs;

  // ---- text ----
  const runs: Run[] = [];
  const nameCache = new Map<string, string>();
  const fontName = (id: string) => {
    if (nameCache.has(id)) return nameCache.get(id)!;
    let n = '';
    try {
      n = (page.commonObjs.has(id) && (page.commonObjs.get(id) as any)?.name) || '';
    } catch {
      /* font not resolved */
    }
    if (!n) n = ((tc.styles as any)[id]?.fontFamily as string) || '';
    nameCache.set(id, n);
    return n;
  };
  for (const it of tc.items as any[]) {
    if (typeof it.str !== 'string' || !it.str.trim()) continue;
    const tx = Util.transform(vp.transform, it.transform);
    if (Math.abs(tx[1]) > 0.01 || Math.abs(tx[2]) > 0.01) continue; // rotated or vertical text is left out of the flow
    const raw = fontName(it.fontName);
    runs.push({
      str: it.str,
      x: tx[4],
      y: tx[5],
      w: it.width,
      size: Math.hypot(tx[2], tx[3]),
      bold: isBold(raw),
      italic: isItalic(raw),
      font: cleanFontName(raw),
    });
  }

  // ---- lines and pictures from the drawing instructions ----
  const hlines: Seg[] = [];
  const vlines: Seg[] = [];
  const images: Box[] = [];
  let ctm: M = [1, 0, 0, 1, 0, 0];
  const stack: M[] = [];
  let pending: { segs: [number, number, number, number][]; rects: [number, number, number, number][] } | null = null;
  const page2 = (m: M) => Util.transform(vp.transform, m);
  const pt = (m: M, x: number, y: number): [number, number] => {
    const p = Util.applyTransform([x, y], page2(m));
    return [p[0], p[1]];
  };

  const addSeg = (x1: number, y1: number, x2: number, y2: number) => {
    const dx = Math.abs(x2 - x1), dy = Math.abs(y2 - y1);
    if (dy <= 0.8 && dx >= 3) hlines.push({ at: (y1 + y2) / 2, a: Math.min(x1, x2), b: Math.max(x1, x2) });
    else if (dx <= 0.8 && dy >= 3) vlines.push({ at: (x1 + x2) / 2, a: Math.min(y1, y2), b: Math.max(y1, y2) });
  };
  const paint = (stroke: boolean) => {
    if (!pending || hlines.length + vlines.length > 6000) return;
    if (stroke) for (const s of pending.segs) addSeg(...s);
    for (const [x, y, w, h] of pending.rects) {
      if (stroke && w >= 3 && h >= 3) {
        addSeg(x, y, x + w, y);
        addSeg(x, y + h, x + w, y + h);
        addSeg(x, y, x, y + h);
        addSeg(x + w, y, x + w, y + h);
      } else if (h <= 2.6 && w >= 4) hlines.push({ at: y + h / 2, a: x, b: x + w }); // a filled sliver is a drawn line
      else if (w <= 2.6 && h >= 4) vlines.push({ at: x + w / 2, a: y, b: y + h });
    }
  };

  for (let k = 0; k < ol.fnArray.length; k++) {
    const fn = ol.fnArray[k];
    const args = ol.argsArray[k] as any;
    switch (fn) {
      case OPS.save:
        stack.push(ctm.slice());
        break;
      case OPS.restore:
        ctm = stack.pop() || ctm;
        break;
      case OPS.transform:
        ctm = Util.transform(ctm, args);
        break;
      case OPS.paintFormXObjectBegin:
        stack.push(ctm.slice());
        if (args?.[0]) ctm = Util.transform(ctm, args[0]);
        break;
      case OPS.paintFormXObjectEnd:
        ctm = stack.pop() || ctm;
        break;
      case OPS.constructPath: {
        const ops: number[] = args[0];
        const c: number[] = args[1];
        const p = { segs: [] as [number, number, number, number][], rects: [] as [number, number, number, number][] };
        let i = 0;
        let cur: [number, number] = [0, 0];
        let start: [number, number] = [0, 0];
        for (const op of ops) {
          if (op === OPS.moveTo) {
            cur = pt(ctm, c[i], c[i + 1]);
            start = cur;
            i += 2;
          } else if (op === OPS.lineTo) {
            const n = pt(ctm, c[i], c[i + 1]);
            p.segs.push([cur[0], cur[1], n[0], n[1]]);
            cur = n;
            i += 2;
          } else if (op === OPS.curveTo) {
            cur = pt(ctm, c[i + 4], c[i + 5]);
            i += 6;
          } else if (op === OPS.curveTo2 || op === OPS.curveTo3) {
            cur = pt(ctm, c[i + 2], c[i + 3]);
            i += 4;
          } else if (op === OPS.closePath) {
            p.segs.push([cur[0], cur[1], start[0], start[1]]);
            cur = start;
          } else if (op === OPS.rectangle) {
            const a = pt(ctm, c[i], c[i + 1]);
            const b = pt(ctm, c[i] + c[i + 2], c[i + 1] + c[i + 3]);
            p.rects.push([Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])]);
            i += 4;
          }
        }
        pending = p;
        break;
      }
      case OPS.stroke:
      case OPS.closeStroke:
      case OPS.fillStroke:
      case OPS.eoFillStroke:
      case OPS.closeFillStroke:
        paint(true);
        pending = null;
        break;
      case OPS.fill:
      case OPS.eoFill:
        paint(false);
        pending = null;
        break;
      case OPS.endPath:
        pending = null;
        break;
      case OPS.paintImageXObject:
      case OPS.paintInlineImageXObject:
      case OPS.paintImageMaskXObject: {
        const pts = [pt(ctm, 0, 0), pt(ctm, 1, 0), pt(ctm, 0, 1), pt(ctm, 1, 1)];
        const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
        const b = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
        if (b.w >= 8 && b.h >= 8) images.push(b);
        break;
      }
    }
  }
  return { w: vp.width, h: vp.height, runs, hlines, vlines, images };
}
