// Page-level operations (Acrobat "Organize Pages", "Combine", "Split", watermark, numbering...).
import { PDFDocument, StandardFonts, rgb, degrees, PageSizes } from 'pdf-lib';
import { hexToRgb01, winAnsiSafe } from './util';

const load = (b: Uint8Array) => PDFDocument.load(b, { updateMetadata: false });
const save = (d: PDFDocument) => d.save({ useObjectStreams: true });

export async function pageCount(bytes: Uint8Array) {
  return (await load(bytes)).getPageCount();
}

export async function rotatePages(bytes: Uint8Array, indices: number[], delta: number) {
  const doc = await load(bytes);
  for (const i of indices) {
    const p = doc.getPage(i);
    p.setRotation(degrees((((p.getRotation().angle + delta) % 360) + 360) % 360));
  }
  return save(doc);
}

export async function deletePages(bytes: Uint8Array, indices: number[]) {
  const doc = await load(bytes);
  if (indices.length >= doc.getPageCount()) throw new Error('A PDF must keep at least one page.');
  [...indices].sort((a, b) => b - a).forEach((i) => doc.removePage(i));
  return save(doc);
}

/** order = new sequence of old page indices (may contain duplicates for "duplicate page") */
export async function reorderPages(bytes: Uint8Array, order: number[]) {
  const src = await load(bytes);
  const unique = new Set(order).size === order.length && order.length === src.getPageCount();
  if (unique) {
    // Keep the same document (preserves forms, outlines, metadata).
    const pages = src.getPages();
    for (let i = pages.length - 1; i >= 0; i--) src.removePage(i);
    order.forEach((oi) => src.addPage(pages[oi]));
    return save(src);
  }
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, order);
  copied.forEach((p) => out.addPage(p));
  return save(out);
}

export async function extractPages(bytes: Uint8Array, indices: number[]) {
  const src = await load(bytes);
  const out = await PDFDocument.create();
  (await out.copyPages(src, indices)).forEach((p) => out.addPage(p));
  return save(out);
}

export async function insertPdf(bytes: Uint8Array, other: Uint8Array, at: number) {
  const doc = await load(bytes);
  const o = await load(other);
  const copied = await doc.copyPages(o, o.getPageIndices());
  copied.forEach((p, k) => doc.insertPage(at + k, p));
  return save(doc);
}

export async function insertBlank(bytes: Uint8Array, at: number) {
  const doc = await load(bytes);
  const ref = doc.getPage(Math.max(0, Math.min(at - 1, doc.getPageCount() - 1)));
  const { width, height } = ref ? ref.getSize() : { width: PageSizes.A4[0], height: PageSizes.A4[1] };
  doc.insertPage(at, [width, height]);
  return save(doc);
}

export async function merge(files: Uint8Array[]) {
  const out = await PDFDocument.create();
  for (const f of files) {
    const src = await load(f);
    (await out.copyPages(src, src.getPageIndices())).forEach((p) => out.addPage(p));
  }
  return save(out);
}

/** Split into chunks of N pages, or at explicit ranges like "1-3, 4, 5-9". */
export async function split(bytes: Uint8Array, spec: { everyN?: number; ranges?: string }) {
  const src = await load(bytes);
  const n = src.getPageCount();
  let groups: number[][] = [];
  if (spec.ranges) groups = parseRanges(spec.ranges, n);
  else {
    const k = Math.max(1, spec.everyN || 1);
    for (let i = 0; i < n; i += k) groups.push(Array.from({ length: Math.min(k, n - i) }, (_, j) => i + j));
  }
  const outs: Uint8Array[] = [];
  for (const g of groups) outs.push(await extractPages(bytes, g));
  return outs;
}

export function parseRanges(s: string, n: number): number[][] {
  return s
    .split(/[,;]/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const m = p.match(/^(\d+)\s*-\s*(\d+|end)$/i);
      if (m) {
        const a = Math.max(1, +m[1]);
        const b = m[2].toLowerCase() === 'end' ? n : Math.min(n, +m[2]);
        return Array.from({ length: Math.max(0, b - a + 1) }, (_, i) => a - 1 + i);
      }
      const k = +p;
      return k >= 1 && k <= n ? [k - 1] : [];
    })
    .filter((g) => g.length);
}

export interface WatermarkOpts {
  text: string;
  color: string;
  opacity: number;
  size: number;
  diagonal: boolean;
}

export async function watermark(bytes: Uint8Array, o: WatermarkOpts) {
  const doc = await load(bytes);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const text = winAnsiSafe(o.text);
  for (const page of doc.getPages()) {
    const { width, height } = page.getSize();
    const tw = font.widthOfTextAtSize(text, o.size);
    const ang = o.diagonal ? Math.atan2(height, width) : 0;
    const cx = width / 2;
    const cy = height / 2;
    const x = cx - (Math.cos(ang) * tw) / 2 + (Math.sin(ang) * o.size) / 3;
    const y = cy - (Math.sin(ang) * tw) / 2 - (Math.cos(ang) * o.size) / 3;
    page.drawText(text, {
      x,
      y,
      size: o.size,
      font,
      color: rgb(...hexToRgb01(o.color)),
      opacity: o.opacity,
      rotate: degrees((ang * 180) / Math.PI),
    });
  }
  return save(doc);
}

export interface NumberOpts {
  format: string; // e.g. "Page {n} of {total}" or "MF-{n:6}" (Bates)
  position: 'bottom-center' | 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left' | 'top-center';
  size: number;
  start: number;
}

export async function pageNumbers(bytes: Uint8Array, o: NumberOpts) {
  const doc = await load(bytes);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  pages.forEach((page, i) => {
    const n = o.start + i;
    const label = winAnsiSafe(
      o.format
        .replace(/\{n:(\d+)\}/g, (_, d) => String(n).padStart(+d, '0'))
        .replace(/\{n\}/g, String(n))
        .replace(/\{total\}/g, String(pages.length + o.start - 1)),
    );
    const { width, height } = page.getSize();
    const tw = font.widthOfTextAtSize(label, o.size);
    const m = 28;
    const x = o.position.endsWith('left') ? m : o.position.endsWith('right') ? width - m - tw : (width - tw) / 2;
    const y = o.position.startsWith('top') ? height - m : m - o.size / 2;
    page.drawText(label, { x, y, size: o.size, font, color: rgb(0.15, 0.15, 0.15) });
  });
  return save(doc);
}

export async function flattenForms(bytes: Uint8Array) {
  const doc = await load(bytes);
  try {
    doc.getForm().flatten();
  } catch {
    /* no form */
  }
  return save(doc);
}

export async function setMetadata(bytes: Uint8Array, meta: { title?: string; author?: string; subject?: string; keywords?: string }) {
  const doc = await load(bytes);
  if (meta.title !== undefined) doc.setTitle(meta.title);
  if (meta.author !== undefined) doc.setAuthor(meta.author);
  if (meta.subject !== undefined) doc.setSubject(meta.subject);
  if (meta.keywords !== undefined) doc.setKeywords(meta.keywords.split(',').map((k) => k.trim()).filter(Boolean));
  doc.setModificationDate(new Date());
  doc.setProducer('Acrobatics');
  return save(doc);
}

export async function getMetadata(bytes: Uint8Array) {
  const doc = await load(bytes);
  return {
    title: doc.getTitle() || '',
    author: doc.getAuthor() || '',
    subject: doc.getSubject() || '',
    keywords: doc.getKeywords() || '',
    pages: doc.getPageCount(),
    producer: doc.getProducer() || '',
    creator: doc.getCreator() || '',
  };
}

/** Lossless re-save (object streams, dedupe). Real image downsampling is on the roadmap. */
export async function compress(bytes: Uint8Array) {
  const doc = await load(bytes);
  return save(doc);
}

export async function imagesToPdf(images: { bytes: Uint8Array; mime: string }[]) {
  const doc = await PDFDocument.create();
  for (const im of images) {
    const img = im.mime.includes('png') ? await doc.embedPng(im.bytes) : await doc.embedJpg(im.bytes);
    // Fit to A4 portrait/landscape keeping aspect.
    const landscape = img.width > img.height;
    const [pw, ph] = landscape ? [PageSizes.A4[1], PageSizes.A4[0]] : PageSizes.A4;
    const s = Math.min((pw - 36) / img.width, (ph - 36) / img.height, 1);
    const w = img.width * s;
    const h = img.height * s;
    const page = doc.addPage([pw, ph]);
    page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
  }
  return save(doc);
}
