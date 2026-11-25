// Real PDF size reduction, in three layers:
//   1. images: big pictures are scaled down and re-encoded as JPEG (needs a browser canvas, see imageShrink.ts)
//   2. streams: anything stored uncompressed is Flate-compressed (lossless)
//   3. objects: whatever nothing points to any more (old versions, orphaned pictures, page thumbnails) is dropped
// The smallest result wins: if nothing got smaller, the original file is returned untouched.
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFObject, PDFRawStream, PDFRef, PDFStream, decodePDFRawStream } from 'pdf-lib';

export type OptimizePreset = 'light' | 'balanced' | 'small';

export const OPTIMIZE_PRESETS: Record<OptimizePreset, { name: string; hint: string; maxPx: number; quality: number }> = {
  light: { name: 'High quality', hint: 'Looks the same on screen and in print. Modest savings.', maxPx: 2600, quality: 0.88 },
  balanced: { name: 'Balanced', hint: 'Sharp on screen, fine for normal printing. Good savings.', maxPx: 1700, quality: 0.76 },
  small: { name: 'Smallest', hint: 'Best for email and sharing. Pictures soften a little.', maxPx: 1100, quality: 0.6 },
};

export interface OptimizeOptions {
  preset: OptimizePreset;
  /** remove the document title, author, keywords and hidden XMP data */
  stripMetadata?: boolean;
  /** remove embedded attachments (files carried inside the PDF) */
  stripAttachments?: boolean;
}

export interface ImageJob {
  /** JPEG file bytes ('jpeg') or decoded 8-bit samples ('raw') */
  kind: 'jpeg' | 'raw';
  data: Uint8Array;
  width: number;
  height: number;
  /** colour components: 1 = grey, 3 = RGB */
  comps: 1 | 3;
  maxPx: number;
  quality: number;
}
export interface ImageResult {
  jpeg: Uint8Array;
  width: number;
  height: number;
}

export interface OptimizeReport {
  before: number;
  after: number;
  images: number;
  imagesShrunk: number;
  streamsCompressed: number;
  objectsDropped: number;
  /** false when nothing could be made smaller and the original was kept */
  changed: boolean;
}

const N = (s: string) => PDFName.of(s);

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate'); // zlib wrapper = what PDF's FlateDecode expects
  const w = cs.writable.getWriter();
  void w.write(data as unknown as BufferSource);
  void w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

function nameOf(o: PDFObject | undefined): string | null {
  return o instanceof PDFName ? o.decodeText() : null;
}

/** The single filter name of a stream, '' when unfiltered, null when stacked or unusual. */
function filterOf(dict: PDFDict): string | null {
  const f = dict.lookup(N('Filter'));
  if (!f) return '';
  if (f instanceof PDFName) return f.decodeText();
  if (f instanceof PDFArray && f.size() === 1) return nameOf(f.lookup(0));
  return null;
}

/** 1 or 3 for plain grey / RGB images we can safely turn into JPEG, otherwise 0 (leave the image alone). */
function simpleComps(dict: PDFDict): 0 | 1 | 3 {
  const cs = dict.lookup(N('ColorSpace'));
  const n = nameOf(cs);
  if (n === 'DeviceGray') return 1;
  if (n === 'DeviceRGB') return 3;
  if (cs instanceof PDFArray && nameOf(cs.lookup(0)) === 'ICCBased') {
    const prof = cs.lookup(1);
    const c = prof instanceof PDFStream ? prof.dict.lookup(N('N')) : null;
    const k = c instanceof PDFNumber ? c.asNumber() : 0;
    return k === 1 ? 1 : k === 3 ? 3 : 0;
  }
  return 0;
}

const num = (d: PDFDict, k: string) => {
  const v = d.lookup(N(k));
  return v instanceof PDFNumber ? v.asNumber() : 0;
};

function reachable(doc: PDFDocument): Set<PDFRef> {
  const ctx = doc.context;
  const seen = new Set<PDFRef>();
  const stack: PDFObject[] = [];
  const t = ctx.trailerInfo;
  for (const r of [t.Root, t.Info, t.Encrypt, t.ID]) if (r) stack.push(r);
  while (stack.length) {
    const o = stack.pop()!;
    if (o instanceof PDFRef) {
      if (seen.has(o)) continue;
      seen.add(o);
      const target = ctx.lookup(o);
      if (target) stack.push(target);
    } else if (o instanceof PDFStream) {
      for (const [, v] of o.dict.entries()) stack.push(v);
    } else if (o instanceof PDFDict) {
      for (const [, v] of o.entries()) stack.push(v);
    } else if (o instanceof PDFArray) {
      for (let i = 0; i < o.size(); i++) stack.push(o.get(i));
    }
  }
  return seen;
}

export async function optimize(
  bytes: Uint8Array,
  o: OptimizeOptions,
  hooks: { shrinkImage?: (job: ImageJob) => Promise<ImageResult | null>; onProgress?: (frac: number, msg: string) => void } = {},
): Promise<{ bytes: Uint8Array; report: OptimizeReport }> {
  const preset = OPTIMIZE_PRESETS[o.preset];
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = doc.context;
  const report: OptimizeReport = { before: bytes.length, after: bytes.length, images: 0, imagesShrunk: 0, streamsCompressed: 0, objectsDropped: 0, changed: false };

  // page thumbnails are small pictures of pages that readers rebuild anyway
  for (const page of doc.getPages()) page.node.delete(N('Thumb'));
  if (o.stripMetadata) {
    doc.setTitle('');
    doc.setAuthor('');
    doc.setSubject('');
    doc.setKeywords([]);
    doc.setCreator('');
    doc.catalog.delete(N('Metadata'));
  }
  if (o.stripAttachments) doc.catalog.lookupMaybe(N('Names'), PDFDict)?.delete(N('EmbeddedFiles'));

  const objects = ctx.enumerateIndirectObjects();

  // ---- 1. images ----
  if (hooks.shrinkImage) {
    const imgs = objects.filter(([, obj]) => obj instanceof PDFRawStream && nameOf(obj.dict.lookup(N('Subtype'))) === 'Image') as [PDFRef, PDFRawStream][];
    report.images = imgs.length;
    let k = 0;
    for (const [ref, st] of imgs) {
      hooks.onProgress?.(0.05 + 0.8 * (k++ / Math.max(1, imgs.length)), `Shrinking picture ${k} of ${imgs.length}…`);
      const d = st.dict;
      // leave masks, transparency, stencils, decode tricks, palette and CMYK pictures exactly as they are
      if (d.has(N('SMask')) || d.has(N('Mask')) || d.has(N('Decode')) || d.has(N('SMaskInData')) || d.lookup(N('ImageMask'))?.toString() === 'true') continue;
      const comps = simpleComps(d);
      const w = num(d, 'Width'), h = num(d, 'Height');
      if (!comps || !w || !h || num(d, 'BitsPerComponent') !== 8) continue;
      const filter = filterOf(d);
      let job: ImageJob | null = null;
      try {
        if (filter === 'DCTDecode') {
          // a JPEG with the wrong number of components (e.g. CMYK mislabelled) is skipped by the decoder
          job = { kind: 'jpeg', data: st.getContents(), width: w, height: h, comps, maxPx: preset.maxPx, quality: preset.quality };
        } else if (filter === 'FlateDecode' || filter === '') {
          if (w * h < 250_000) continue; // small graphics: not worth the quality risk
          const raw = filter === '' ? st.getContents() : decodePDFRawStream(st).decode();
          if (raw.length !== w * h * comps) continue;
          job = { kind: 'raw', data: raw, width: w, height: h, comps, maxPx: preset.maxPx, quality: preset.quality };
        }
        if (!job) continue;
        const res = await hooks.shrinkImage(job);
        // keep the new picture only when it is clearly smaller than what was there
        if (!res || res.jpeg.length > st.contents.length * 0.9) continue;
        const nd = ctx.obj({
          Type: 'XObject',
          Subtype: 'Image',
          Width: res.width,
          Height: res.height,
          ColorSpace: comps === 1 ? 'DeviceGray' : 'DeviceRGB',
          BitsPerComponent: 8,
          Filter: 'DCTDecode',
          Length: res.jpeg.length,
        });
        ctx.assign(ref, PDFRawStream.of(nd, res.jpeg));
        report.imagesShrunk++;
      } catch {
        /* a picture the browser can't read stays as it was */
      }
    }
  }

  // ---- 2. uncompressed streams ----
  hooks.onProgress?.(0.88, 'Compressing the rest…');
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const d = obj.dict;
    if (d.has(N('Filter')) || obj.contents.length < 512) continue;
    if (nameOf(d.lookup(N('Type'))) === 'Metadata') continue; // XMP must stay readable as plain text
    try {
      const packed = await deflate(obj.contents);
      if (packed.length >= obj.contents.length * 0.95) continue;
      d.set(N('Filter'), N('FlateDecode'));
      d.set(N('Length'), PDFNumber.of(packed.length));
      ctx.assign(ref, PDFRawStream.of(d, packed));
      report.streamsCompressed++;
    } catch {
      /* leave it */
    }
  }

  // ---- 3. objects nothing points to ----
  hooks.onProgress?.(0.94, 'Removing unused data…');
  const keep = reachable(doc);
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (!keep.has(ref)) {
      ctx.delete(ref);
      report.objectsDropped++;
    }
  }

  const out = await doc.save({ useObjectStreams: true });
  if (out.length >= bytes.length) {
    report.after = bytes.length;
    return { bytes, report };
  }
  report.after = out.length;
  report.changed = true;
  return { bytes: out, report };
}
