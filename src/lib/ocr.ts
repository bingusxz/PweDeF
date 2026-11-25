// OCR: turn scanned pages into searchable/selectable text by adding an invisible text layer.
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import { createWorker } from 'tesseract.js';
import type { PDFDocumentProxy } from './pdf';
import { renderToCanvas } from './pdf';
import { winAnsiSafe } from './util';

const SCALE = 2.5; // ~180 dpi; good accuracy/speed trade-off

export async function ocrDocument(
  bytes: Uint8Array,
  pdf: PDFDocumentProxy,
  pages: number[],
  lang: string,
  onProgress: (msg: string, frac: number) => void,
): Promise<{ bytes: Uint8Array; words: number }> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  onProgress('Loading OCR engine (first run downloads language data)…', 0);
  const worker = await createWorker(lang);
  let total = 0;
  try {
    for (let k = 0; k < pages.length; k++) {
      const i = pages[k];
      onProgress(`Recognizing page ${i + 1} (${k + 1}/${pages.length})…`, k / pages.length);
      const pg = await pdf.getPage(i + 1);
      const vp = pg.getViewport({ scale: 1 });
      const canvas = await renderToCanvas(pg, SCALE);
      const { data } = await worker.recognize(canvas, {}, { blocks: true });
      const page = doc.getPage(i);
      for (const block of data.blocks || [])
        for (const para of block.paragraphs)
          for (const line of para.lines)
            for (const word of line.words) {
              const text = winAnsiSafe(word.text).trim();
              if (!text || word.confidence < 30) continue;
              const { x0, y0, x1, y1 } = word.bbox;
              const w = (x1 - x0) / SCALE;
              const h = (y1 - y0) / SCALE;
              const unit = font.widthOfTextAtSize(text, 1) || 1;
              const size = Math.max(2, Math.min(w / unit, h * 1.3));
              const [px, py] = vp.convertToPdfPoint(x0 / SCALE, y1 / SCALE - h * 0.15);
              page.drawText(text, { x: px, y: py, size, font, opacity: 0, rotate: degrees(vp.rotation) });
              total++;
            }
    }
  } finally {
    await worker.terminate();
  }
  onProgress('Saving…', 1);
  return { bytes: await doc.save({ useObjectStreams: true }), words: total };
}
