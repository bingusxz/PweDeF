// Page-level operations (Acrobat "Organize Pages", "Combine", "Split", watermark, numbering...).
import { PDFArray, PDFDocument, StandardFonts, rgb, degrees, PageSizes } from 'pdf-lib';
import { hexToRgb01, winAnsiSafe } from './util';
import { pruneUnreachable } from './prune';

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
  // a removed page's content would otherwise stay inside the saved file
  await doc.flush();
  pruneUnreachable(doc);
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

/** One piece of a merge: which pages of a file (all when empty) and how much to turn them. */
export interface MergePart {
  bytes: Uint8Array;
  /** zero-based page numbers to take, in this order; empty or missing = every page */
  pages?: number[];
  /** extra clockwise rotation for every page taken from this file (0, 90, 180, 270) */
  rotate?: number;
}

/** Merge with per-file page selection and rotation. */
export async function mergeParts(parts: MergePart[]) {
  const out = await PDFDocument.create();
  for (const p of parts) {
    const src = await load(p.bytes);
    const idx = p.pages?.length ? p.pages.filter((i) => i >= 0 && i < src.getPageCount()) : src.getPageIndices();
    for (const page of await out.copyPages(src, idx)) {
      if (p.rotate) page.setRotation(degrees((((page.getRotation().angle + p.rotate) % 360) + 360) % 360));
      out.addPage(page);
    }
  }
  if (!out.getPageCount()) throw new Error('Nothing to merge: every file had an empty page selection.');
  return save(out);
}

export interface SplitSpec {
  everyN?: number;
  ranges?: string;
  /** zero-based first page of each section (e.g. from the bookmarks); a section runs to the next start */
  starts?: number[];
  /** keep every output file under about this many megabytes */
  maxMB?: number;
  /** put all the chosen ranges in ONE file instead of one file per range */
  single?: boolean;
}

/** Page groups for a split spec, without building any files. */
export function splitGroups(n: number, spec: SplitSpec): number[][] {
  if (spec.starts?.length) {
    const s = [...new Set([0, ...spec.starts.filter((x) => x > 0 && x < n)])].sort((a, b) => a - b);
    return s.map((a, i) => {
      const b = i + 1 < s.length ? s[i + 1] : n;
      return Array.from({ length: b - a }, (_, k) => a + k);
    });
  }
  if (spec.ranges) {
    const groups = parseRanges(spec.ranges, n).filter((g) => g.length);
    return spec.single ? [groups.flat()] : groups;
  }
  const k = Math.max(1, spec.everyN || 1);
  const groups: number[][] = [];
  for (let i = 0; i < n; i += k) groups.push(Array.from({ length: Math.min(k, n - i) }, (_, j) => i + j));
  return groups;
}

/**
 * Cut into files that stay under `maxBytes`. Page sizes aren't known up front (fonts and images are shared),
 * so each file is measured for real and shortened until it fits. A single page bigger than the limit goes alone.
 */
export async function splitBySize(bytes: Uint8Array, maxBytes: number, onProgress?: (frac: number) => void): Promise<{ files: Uint8Array[]; tooBig: number }> {
  const n = (await load(bytes)).getPageCount();
  const files: Uint8Array[] = [];
  let tooBig = 0;
  const avg = Math.max(1, bytes.length / n);
  let start = 0;
  while (start < n) {
    let k = Math.max(1, Math.min(n - start, Math.floor(maxBytes / avg)));
    let out = await extractPages(bytes, Array.from({ length: k }, (_, j) => start + j));
    for (let tries = 0; out.length > maxBytes && k > 1 && tries < 12; tries++) {
      k = Math.max(1, Math.floor(k * Math.min(0.9, (maxBytes / out.length) * 0.97)));
      out = await extractPages(bytes, Array.from({ length: k }, (_, j) => start + j));
    }
    if (out.length > maxBytes) tooBig++;
    files.push(out);
    start += k;
    onProgress?.(start / n);
  }
  return { files, tooBig };
}

/** Split into chunks of N pages, at explicit ranges like "1-3, 4, 5-9", or at section starts. */
export async function split(bytes: Uint8Array, spec: SplitSpec) {
  const src = await load(bytes);
  const groups = splitGroups(src.getPageCount(), spec);
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

export type WatermarkPosition = 'center' | 'tile' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'top' | 'bottom';

export interface WatermarkOpts {
  kind?: 'text' | 'image';
  text: string;
  color: string;
  opacity: number;
  size: number;
  /** legacy: diagonal = corner-to-corner angle */
  diagonal: boolean;
  /** degrees counter-clockwise; overrides `diagonal` when set */
  angle?: number;
  family?: string;
  bold?: boolean;
  italic?: boolean;
  /** installed font bytes for `family` (filled in by the caller) */
  fontBytes?: Uint8Array | null;
  /** image watermark as data URL (PNG/JPEG) */
  image?: string;
  /** image width as % of page width */
  imageScale?: number;
  position?: WatermarkPosition;
  /** "" = all pages, or ranges like "1-3, 5" */
  pages?: string;
  /** behind the page content instead of on top */
  behind?: boolean;
}

export async function watermark(bytes: Uint8Array, o: WatermarkOpts) {
  const doc = await load(bytes);
  const kind = o.kind || 'text';
  const pos: WatermarkPosition = o.position || 'center';
  const total = doc.getPageCount();
  const targets = o.pages?.trim() ? [...new Set(parseRanges(o.pages, total).flat())] : doc.getPageIndices();

  // text resources
  let font = null as Awaited<ReturnType<PDFDocument['embedFont']>> | null;
  let text = o.text;
  if (kind === 'text') {
    if (o.fontBytes) {
      doc.registerFontkit((await import('@pdf-lib/fontkit')).default);
      font = await doc.embedFont(o.fontBytes, { subset: true });
      const have = new Set(font.getCharacterSet());
      text = [...text].map((ch) => (ch === '\n' || have.has(ch.codePointAt(0)!) ? ch : '?')).join('');
    } else {
      font = await doc.embedFont(o.italic ? (o.bold ? StandardFonts.HelveticaBoldOblique : StandardFonts.HelveticaOblique) : o.bold === false ? StandardFonts.Helvetica : StandardFonts.HelveticaBold);
      text = winAnsiSafe(text);
    }
  }
  // image resources
  let img = null as Awaited<ReturnType<PDFDocument['embedPng']>> | null;
  if (kind === 'image' && o.image) {
    const b = Uint8Array.from(atob(o.image.split(',')[1]), (ch) => ch.charCodeAt(0));
    img = o.image.startsWith('data:image/jpeg') ? await doc.embedJpg(b) : await doc.embedPng(b);
  }
  if (kind === 'text' && !text.trim()) return save(doc);
  if (kind === 'image' && !img) return save(doc);

  for (const i of targets) {
    const page = doc.getPage(i);
    const { width: pw, height: ph } = page.getSize();
    const angDeg = o.angle ?? (o.diagonal ? (Math.atan2(ph, pw) * 180) / Math.PI : 0);
    const t = (angDeg * Math.PI) / 180;
    // object size (unrotated)
    let w: number, h: number;
    if (kind === 'text') {
      w = font!.widthOfTextAtSize(text, o.size);
      h = o.size;
    } else {
      w = (pw * (o.imageScale ?? 40)) / 100;
      h = (w * img!.height) / img!.width;
    }
    // rotated bounding box half-extents, to keep corner placements on the page
    const ex = (Math.abs(Math.cos(t)) * w + Math.abs(Math.sin(t)) * h) / 2;
    const ey = (Math.abs(Math.sin(t)) * w + Math.abs(Math.cos(t)) * h) / 2;
    const m = 28;
    const centres: { x: number; y: number }[] = [];
    if (pos === 'tile') {
      const sx = ex * 2 + Math.max(40, h * 1.5);
      const sy = ey * 2 + Math.max(40, h * 2);
      for (let row = 0, y = sy / 2; y < ph + sy; y += sy, row++)
        for (let x = (row % 2 ? sx : sx / 2) - sx / 2; x < pw + sx; x += sx) centres.push({ x, y });
    } else {
      const x = pos.endsWith('left') ? m + ex : pos.endsWith('right') ? pw - m - ex : pw / 2;
      const y = pos.startsWith('top') ? ph - m - ey : pos.startsWith('bottom') ? m + ey : ph / 2;
      centres.push({ x, y });
    }
    for (const c of centres) {
      // origin = centre minus the rotated half-size vector
      const ox = c.x - (Math.cos(t) * w) / 2 + (Math.sin(t) * h) / 2;
      const oy = c.y - (Math.sin(t) * w) / 2 - (Math.cos(t) * h) / 2;
      if (kind === 'text') {
        // drawText's y is the baseline: lift by the descent (~0.22em) so the glyphs sit centred
        const bx = ox - Math.sin(t) * h * 0.22; // along the rotated "up" vector (-sin t, cos t)
        const by = oy + Math.cos(t) * h * 0.22;
        page.drawText(text, { x: bx, y: by, size: o.size, font: font!, color: rgb(...hexToRgb01(o.color)), opacity: o.opacity, rotate: degrees(angDeg) });
      } else {
        page.drawImage(img!, { x: ox, y: oy, width: w, height: h, opacity: o.opacity, rotate: degrees(angDeg) });
      }
    }
    if (o.behind) sendLastStreamToBack(page);
  }
  return save(doc);
}

/** Moves the content stream pdf-lib just appended to the front, so it paints under the page. */
function sendLastStreamToBack(page: ReturnType<PDFDocument['getPage']>) {
  const contents = page.node.Contents();
  if (!(contents instanceof PDFArray) || contents.size() < 2) return;
  const last = contents.get(contents.size() - 1);
  contents.remove(contents.size() - 1);
  contents.insert(0, last);
}

export interface NumberOpts {
  format: string; // e.g. "Page {n} of {total}" or "DOC-{n:6}" (Bates)
  position: 'bottom-center' | 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left' | 'top-center';
  size: number;
  start: number;
  /** an installed font that covers the characters in `format` (see resolveNumbers) */
  fontBytes?: Uint8Array | null;
}

export async function pageNumbers(bytes: Uint8Array, o: NumberOpts) {
  const doc = await load(bytes);
  let font: Awaited<ReturnType<PDFDocument['embedFont']>>;
  let have: Set<number> | null = null;
  if (o.fontBytes) {
    doc.registerFontkit((await import('@pdf-lib/fontkit')).default);
    font = await doc.embedFont(o.fontBytes, { subset: true });
    have = new Set(font.getCharacterSet());
  } else font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  pages.forEach((page, i) => {
    const n = o.start + i;
    const raw = o.format
      .replace(/\{n:(\d+)\}/g, (_, d) => String(n).padStart(+d, '0'))
      .replace(/\{n\}/g, String(n))
      .replace(/\{total\}/g, String(pages.length + o.start - 1));
    const label = have ? [...raw].map((ch) => (have!.has(ch.codePointAt(0)!) ? ch : '?')).join('') : winAnsiSafe(raw);
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
  doc.setProducer('PweDeF');
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

export async function imagesToPdf(images: { bytes: Uint8Array; mime: string }[], orientation: 'auto' | 'portrait' | 'landscape' = 'auto') {
  const doc = await PDFDocument.create();
  for (const im of images) {
    const img = im.mime.includes('png') ? await doc.embedPng(im.bytes) : await doc.embedJpg(im.bytes);
    // Fit to A4 portrait/landscape keeping aspect.
    const landscape = orientation === 'auto' ? img.width > img.height : orientation === 'landscape';
    const [pw, ph] = landscape ? [PageSizes.A4[1], PageSizes.A4[0]] : PageSizes.A4;
    const s = Math.min((pw - 36) / img.width, (ph - 36) / img.height, 1);
    const w = img.width * s;
    const h = img.height * s;
    const page = doc.addPage([pw, ph]);
    page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
  }
  return save(doc);
}
