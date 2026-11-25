// PDF -> .pptx.
//  editable: each slide is the page WITHOUT its text (pictures, lines, colours) with the words laid back on top as
//            real text boxes, so the slide looks like the page and the text can be edited.
//  exact:    each slide is a picture of the page.
import type { PDFDocumentProxy } from './pdf';
import { loadPdf, renderToCanvas } from './pdf';
import { extractPage, type PdfJsLib } from './pdfExtract';
import { groupLines, lineSegments, linePieces } from './pdfLayout';
import { textColorOn, textFreePdf } from './textFree';

export type PptMode = 'editable' | 'exact';

export async function pdfToPptx(pdf: PDFDocumentProxy, pdfjs: PdfJsLib, mode: PptMode, onProgress: (i: number, n: number) => void) {
  const PptxGenJS = (await import('pptxgenjs')).default;
  const pres = new PptxGenJS();
  const first = (await pdf.getPage(1)).getViewport({ scale: 1 });
  const W = 10;
  const H = (first.height / first.width) * W;
  pres.defineLayout({ name: 'PDF', width: W, height: H });
  pres.layout = 'PDF';

  const tf = mode === 'editable' ? await textFreePdf(await pdf.getData()) : null;
  const bgPdf = tf ? await loadPdf(tf.bytes) : null;
  const S = 2; // backdrop resolution: 144 dpi
  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      onProgress(i, pdf.numPages);
      const slide = pres.addSlide();
      const editable = !!tf && tf.clean[i - 1];
      const canvas = await renderToCanvas(editable ? await bgPdf!.getPage(i) : await pdf.getPage(i), S);
      const pw = canvas.width / S, ph = canvas.height / S;
      // each page may differ in size: scale to this slide's width (the slide itself keeps the first page's shape)
      const k = W / pw;
      const yOff = Math.max(0, (H - ph * k) / 2);
      slide.addImage({ data: canvas.toDataURL('image/jpeg', 0.9), x: 0, y: yOff, w: W, h: ph * k });

      if (editable) {
        const data = await extractPage(pdf, i, pdfjs);
        for (const line of groupLines(data.runs))
          for (const seg of lineSegments(line)) {
            const size = Math.max(...seg.map((r) => r.size));
            const x0 = seg[0].x;
            const x1 = seg[seg.length - 1].x + seg[seg.length - 1].w;
            const top = seg[0].y - size * 0.92;
            const color = textColorOn(canvas, { x: x0, y: top, w: x1 - x0, h: size * 1.2 }, S);
            const pieces = linePieces(seg);
            slide.addText(
              pieces.map((p) => ({
                text: p.text,
                options: { bold: p.bold, italic: p.italic, fontFace: p.font, fontSize: Math.max(4, Math.round(p.size * k * 72 * 10) / 10), color },
              })),
              { x: x0 * k, y: top * k + yOff, w: (x1 - x0) * k * 1.06 + 0.05, h: size * 1.25 * k, margin: 0, valign: 'top', wrap: false, fit: 'none' },
            );
          }
      }
      canvas.width = canvas.height = 0;
    }
  } finally {
    bgPdf?.destroy();
  }
  return (await pres.write({ outputType: 'uint8array' })) as Uint8Array;
}
