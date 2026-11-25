// A copy of a PDF with all page text deleted (pictures, lines and colours stay). Used as the backdrop under real,
// editable text when converting to PowerPoint or Word, so the converted file looks like the page without doubling the words.
import { PDFDocument } from 'pdf-lib';
import { pageUsesFormText, removeTextInRects } from './textremove';

export interface TextFree {
  bytes: Uint8Array;
  /** per page: true when every word was removed cleanly (false = the page must stay a flat picture) */
  clean: boolean[];
}

export async function textFreePdf(bytes: Uint8Array): Promise<TextFree> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const clean: boolean[] = [];
  const everything = { x: -1e6, y: -1e6, w: 2e6, h: 2e6 };
  for (const page of doc.getPages()) {
    try {
      const r = removeTextInRects(doc, page, [everything], true);
      // text kept in reusable sub-blocks (Form XObjects) can't be reached this way, so such pages stay flat pictures
      clean.push(!r.unsafe && !pageUsesFormText(doc, page));
    } catch {
      clean.push(false);
    }
  }
  return { bytes: await doc.save({ useObjectStreams: false }), clean };
}

/** Black or white text, whichever reads better on the backdrop under this box (page units; `scale` = canvas pixels per unit). */
export function textColorOn(canvas: HTMLCanvasElement, box: { x: number; y: number; w: number; h: number }, scale: number): '000000' | 'FFFFFF' {
  const x = Math.max(0, Math.floor(box.x * scale)), y = Math.max(0, Math.floor(box.y * scale));
  const w = Math.min(canvas.width - x, Math.max(1, Math.ceil(box.w * scale))), h = Math.min(canvas.height - y, Math.max(1, Math.ceil(box.h * scale)));
  if (w <= 0 || h <= 0) return '000000';
  const d = canvas.getContext('2d')!.getImageData(x, y, w, h).data;
  let sum = 0, n = 0;
  const step = Math.max(1, Math.floor(d.length / 4 / 400));
  for (let i = 0; i < d.length; i += 4 * step) {
    sum += (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
    n++;
  }
  return sum / Math.max(1, n) < 110 ? 'FFFFFF' : '000000';
}
