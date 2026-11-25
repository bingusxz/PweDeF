import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export { pdfjs };
export type { PDFDocumentProxy, PDFPageProxy, PageViewport };

const ASSETS = new URL('./pdfjs/', document.baseURI).toString();

/** Load bytes into pdf.js. pdf.js transfers the buffer to its worker, so always pass a copy. */
export function loadPdf(bytes: Uint8Array, password?: string): Promise<PDFDocumentProxy> {
  return pdfjs.getDocument({
    data: bytes.slice(),
    password,
    isEvalSupported: false,
    cMapUrl: ASSETS + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: ASSETS + 'standard_fonts/',
  }).promise;
}

/** Render a page to a canvas at a given scale (used by thumbnails, export, OCR). */
export async function renderToCanvas(page: PDFPageProxy, scale: number, canvas = document.createElement('canvas')) {
  const vp = page.getViewport({ scale });
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return canvas;
}
