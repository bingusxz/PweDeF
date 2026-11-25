import { PDFArray, PDFDict, PDFDocument, PDFName, PDFPage, PDFRawStream, decodePDFRawStream } from 'pdf-lib';

export function embeddedFace(page: PDFPage, name: string) {
  const fonts = page.node.Resources()?.lookupMaybe(PDFName.of('Font'), PDFDict);
  for (const [, ref] of fonts?.entries() ?? []) {
    const face = page.doc.context.lookup(ref);
    if (!(face instanceof PDFDict) || face.lookupMaybe(PDFName.of('BaseFont'), PDFName)?.decodeText() !== name) continue;
    const child = face.lookupMaybe(PDFName.of('DescendantFonts'), PDFArray)?.lookup(0);
    const descriptor = (child instanceof PDFDict ? child : face).lookupMaybe(PDFName.of('FontDescriptor'), PDFDict);
    for (const key of ['FontFile2', 'FontFile3']) {
      const stream = descriptor?.lookup(PDFName.of(key));
      if (stream instanceof PDFRawStream) return decodePDFRawStream(stream).decode();
    }
  }
}

const documents = new WeakMap<object, Promise<PDFDocument>>();
const previews = new WeakMap<object, Map<string, Promise<string | undefined>>>();
export function previewFace(pdf: { getData(): Promise<Uint8Array> }, page: number, name: string) {
  let cache = previews.get(pdf);
  if (!cache) previews.set(pdf, cache = new Map());
  const key = JSON.stringify([page, name]);
  if (!cache.has(key)) cache.set(key, (async () => {
    let doc = documents.get(pdf);
    if (!doc) documents.set(pdf, doc = pdf.getData().then(bytes => PDFDocument.load(bytes)));
    const bytes = embeddedFace((await doc).getPage(page), name);
    if (!bytes) return;
    const family = 'DocumentFace-' + crypto.randomUUID();
    const face = await new FontFace(family, Uint8Array.from(bytes)).load();
    document.fonts.add(face);
    return family;
  })().catch(() => undefined));
  return cache.get(key)!;
}

