import {
  PDFDict,
  PDFDocument,
  PDFName,
  StandardFonts,
  TextRenderingMode,
  popGraphicsState,
  pushGraphicsState,
  setCharacterSqueeze,
  setTextRenderingMode,
} from 'pdf-lib';
import type { RedactAnnot } from '../types';
import { loadPdf, pdfjs, renderToCanvas } from './pdf';
import type { PDFPageProxy } from './pdf';
import { blobToBytes, winAnsiSafe } from './util';

const DPI = 250;
const MARGIN = 1.5; // page units kept clear around every box

export interface RedactReport {
  pages: number;
  boxes: number;
  /** pieces of text that sat under a box and were removed from the file */
  textRemoved: number;
  /** pieces of text kept (searchable and selectable) on the redacted pages */
  textKept: number;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
const hits = (a: Box, b: Box) => a.x < b.x + b.w + MARGIN && a.x + a.w > b.x - MARGIN && a.y < b.y + b.h + MARGIN && a.y + a.h > b.y - MARGIN;

/** Text pieces on a page with their boxes in page units (top-left origin), the same space the marked areas use. */
async function pageText(pg: PDFPageProxy) {
  const vp1 = pg.getViewport({ scale: 1 });
  const content = await pg.getTextContent();
  const out: { str: string; x: number; baseline: number; size: number; w: number; flat: boolean; box: Box }[] = [];
  for (const it of content.items as any[]) {
    if (typeof it.str !== 'string' || !it.str.trim()) continue;
    const tx = pdfjs.Util.transform(vp1.transform, it.transform);
    const size = Math.hypot(tx[2], tx[3]);
    const flat = Math.abs(tx[1]) < 0.01 && Math.abs(tx[2]) < 0.01;
    const box = flat
      ? { x: tx[4], y: tx[5] - size * 0.95, w: it.width, h: size * 1.25 }
      : // rotated text: use a generous square around its start so it can never slip past a box
        { x: tx[4] - size * 2, y: tx[5] - size * 2, w: Math.max(it.width, size) + size * 4, h: size * 4 };
    out.push({ str: it.str, x: tx[4], baseline: tx[5], size, w: it.width, flat, box });
  }
  return { vp1, items: out };
}

/**
 * Secure redaction. Every page that has a marked area is rebuilt as a picture with the areas painted black,
 * so no text, vectors or images survive underneath. The rest of the page stays searchable and selectable:
 * an invisible text layer is rebuilt from the text that is NOT near a box. Text that touches a box is dropped
 * whole, never trimmed, so a hidden word can't survive through a measuring mistake.
 * Hidden places that can carry the same words (metadata, bookmarks, attachments) are cleared, and the saved
 * file is re-read to prove nothing is left under the boxes.
 */
export async function applyRedactions(bytes: Uint8Array, redacts: RedactAnnot[], onReport?: (r: RedactReport) => void): Promise<Uint8Array> {
  if (!redacts.length) return bytes;
  const pdf = await loadPdf(bytes);
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const pages = [...new Set(redacts.map((r) => r.page))].sort((a, b) => a - b);
  const report: RedactReport = { pages: pages.length, boxes: redacts.length, textRemoved: 0, textKept: 0 };
  try {
    for (const i of pages) {
      const pg = await pdf.getPage(i + 1);
      const boxes: Box[] = redacts.filter((x) => x.page === i).map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h }));
      const { vp1, items } = await pageText(pg);
      const s = DPI / 72;
      const canvas = await renderToCanvas(pg, s);
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#000';
      for (const b of boxes) ctx.fillRect(b.x * s, b.y * s, b.w * s, b.h * s);
      const blob = await new Promise<Blob>((res) => canvas.toBlob((b) => res(b!), 'image/jpeg', 0.92));
      const img = await doc.embedJpg(await blobToBytes(blob));
      const np = doc.insertPage(i, [vp1.width, vp1.height]);
      np.drawImage(img, { x: 0, y: 0, width: vp1.width, height: vp1.height });

      // keep the untouched text findable: invisible, laid over the same spot as the picture's words
      for (const t of items) {
        if (boxes.some((b) => hits(t.box, b))) {
          report.textRemoved++;
          continue;
        }
        if (!t.flat) continue;
        const text = winAnsiSafe(t.str).replace(/\?/g, ' ');
        if (!text.trim()) continue;
        const natural = helv.widthOfTextAtSize(text, t.size);
        const squeeze = natural > 0 && t.w > 0 ? Math.max(20, Math.min(400, (t.w / natural) * 100)) : 100;
        np.pushOperators(pushGraphicsState(), setTextRenderingMode(TextRenderingMode.Invisible), setCharacterSqueeze(squeeze));
        np.drawText(text, { x: t.x, y: vp1.height - t.baseline, size: t.size, font: helv });
        np.pushOperators(popGraphicsState());
        report.textKept++;
      }
      doc.removePage(i + 1);
      canvas.width = canvas.height = 0;
    }
  } finally {
    pdf.destroy();
  }

  // Scrub places that can hold the redacted words: document info, XMP, bookmarks and attached files.
  doc.setTitle('');
  doc.setSubject('');
  doc.setKeywords([]);
  doc.setAuthor('');
  doc.setCreator('');
  doc.setProducer('PweDeF');
  doc.catalog.delete(PDFName.of('Metadata'));
  doc.catalog.delete(PDFName.of('Outlines'));
  const names = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
  names?.delete(PDFName.of('EmbeddedFiles'));
  const out = await doc.save({ useObjectStreams: true });

  // Prove it: re-read the saved file and make sure no text is left under any box.
  const check = await loadPdf(out);
  try {
    for (const i of pages) {
      const { items } = await pageText(await check.getPage(i + 1));
      const boxes = redacts.filter((x) => x.page === i);
      const left = items.filter((t) => boxes.some((b) => hits(t.box, b)));
      if (left.length) throw new Error(`Redaction check failed on page ${i + 1}: ${left.length} piece(s) of text were still under a box. The file was not saved.`);
    }
  } finally {
    check.destroy();
  }
  onReport?.(report);
  return out;
}
