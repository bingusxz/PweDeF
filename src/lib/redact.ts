import { PDFDocument } from 'pdf-lib';
import type { RedactAnnot } from '../types';
import { loadPdf, renderToCanvas } from './pdf';
import { blobToBytes } from './util';

const DPI = 200;

/**
 * Secure redaction: each affected page is replaced by a rasterized copy with the
 * marked regions painted black, so no text, vectors or images survive underneath.
 * (Run OCR afterwards if you need the rest of the page searchable again.)
 */
export async function applyRedactions(bytes: Uint8Array, redacts: RedactAnnot[]): Promise<Uint8Array> {
  if (!redacts.length) return bytes;
  const pdf = await loadPdf(bytes);
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const pages = [...new Set(redacts.map((r) => r.page))].sort((a, b) => a - b);
  try {
    for (const i of pages) {
      const pg = await pdf.getPage(i + 1);
      const vp1 = pg.getViewport({ scale: 1 });
      const s = DPI / 72;
      const canvas = await renderToCanvas(pg, s);
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#000';
      for (const r of redacts.filter((x) => x.page === i)) ctx.fillRect(r.x * s, r.y * s, r.w * s, r.h * s);
      const blob = await new Promise<Blob>((res) => canvas.toBlob((b) => res(b!), 'image/jpeg', 0.9));
      const img = await doc.embedJpg(await blobToBytes(blob));
      const np = doc.insertPage(i, [vp1.width, vp1.height]);
      np.drawImage(img, { x: 0, y: 0, width: vp1.width, height: vp1.height });
      doc.removePage(i + 1);
      canvas.width = canvas.height = 0;
    }
  } finally {
    pdf.destroy();
  }
  // Scrub document metadata that could leak redacted content.
  doc.setTitle('');
  doc.setSubject('');
  doc.setKeywords([]);
  return doc.save({ useObjectStreams: true });
}
