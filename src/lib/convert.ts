// Conversions: PDF -> images / text, images -> PDF.
import type { PDFDocumentProxy } from './pdf';
import { renderToCanvas } from './pdf';
import { blobToBytes, baseName } from './util';
import { imagesToPdf } from './ops';

export async function exportImages(
  pdf: PDFDocumentProxy,
  name: string,
  format: 'png' | 'jpeg',
  dpi: number,
  onProgress: (i: number, n: number) => void,
) {
  const folder = await window.acro.chooseFolder();
  if (!folder) return null;
  const n = pdf.numPages;
  for (let i = 1; i <= n; i++) {
    onProgress(i, n);
    const page = await pdf.getPage(i);
    const canvas = await renderToCanvas(page, dpi / 72);
    const blob = await new Promise<Blob>((res) => canvas.toBlob((b) => res(b!), `image/${format}`, 0.92));
    const ext = format === 'jpeg' ? 'jpg' : 'png';
    await window.acro.writeInFolder(folder, `${baseName(name)}-p${String(i).padStart(3, '0')}.${ext}`, await blobToBytes(blob));
    canvas.width = canvas.height = 0;
  }
  return folder;
}

export async function extractText(pdf: PDFDocumentProxy) {
  const parts: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const tc = await (await pdf.getPage(i)).getTextContent();
    let line = '';
    const lines: string[] = [];
    for (const it of tc.items as any[]) {
      line += it.str;
      if (it.hasEOL) {
        lines.push(line);
        line = '';
      }
    }
    if (line) lines.push(line);
    parts.push(`--- Page ${i} ---\n${lines.join('\n')}`);
  }
  return parts.join('\n\n');
}

/** Any browser-decodable image -> PNG/JPEG bytes suitable for pdf-lib. */
async function normalizeImage(bytes: Uint8Array, name: string): Promise<{ bytes: Uint8Array; mime: string }> {
  if (/\.(jpe?g)$/i.test(name)) return { bytes, mime: 'image/jpeg' };
  if (/\.png$/i.test(name)) return { bytes, mime: 'image/png' };
  const bmp = await createImageBitmap(new Blob([bytes as BlobPart]));
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext('2d')!.drawImage(bmp, 0, 0);
  const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'));
  return { bytes: await blobToBytes(blob), mime: 'image/png' };
}

export async function imagesFilesToPdf(files: { name: string; data: Uint8Array }[], orientation: 'auto' | 'portrait' | 'landscape' = 'auto') {
  const imgs = [];
  for (const f of files) imgs.push(await normalizeImage(f.data, f.name));
  return imagesToPdf(imgs, orientation);
}

export const IMAGE_FILTERS = [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }];
