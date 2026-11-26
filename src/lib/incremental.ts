// Incremental saving: add a new revision to the END of a file instead of rewriting it.
// Everything already in the file, including earlier digital signatures, stays byte for byte the same.
import { PDFDocument, PDFName, PDFObject, PDFRef } from 'pdf-lib';

const enc = (s: string) => {
  const o = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) o[i] = s.charCodeAt(i) & 255;
  return o;
};
const pad = (n: number, w: number) => String(n).padStart(w, '0');

/** Byte offset of the file's current cross-reference section, from its last "startxref". */
export function lastStartXref(bytes: Uint8Array): number {
  const tail = new TextDecoder('latin1').decode(bytes.subarray(Math.max(0, bytes.length - 2048)));
  const m = [...tail.matchAll(/startxref\s+(\d+)/g)].pop();
  if (!m) throw new Error('This PDF has no cross-reference table, so it cannot be extended safely.');
  return +m[1];
}

/** True when the file's newest cross-reference section is a stream (PDF 1.5 style) rather than a classic table. */
function usesXrefStream(bytes: Uint8Array, at: number): boolean {
  return !new TextDecoder('latin1').decode(bytes.subarray(at, at + 8)).trimStart().startsWith('xref');
}

/**
 * The file's own /Size: pdf-lib drops the old object streams and cross-reference streams when it reads a file,
 * but their object numbers are still taken. Call this and raise `context.largestObjectNumber` to it before adding objects.
 */
export function originalSize(bytes: Uint8Array): number {
  const at = lastStartXref(bytes);
  const m = /\/Size\s+(\d+)/.exec(new TextDecoder('latin1').decode(bytes.subarray(at, Math.min(bytes.length, at + 8 * 1024 * 1024))));
  return m ? +m[1] : 0;
}

const objectBytes = (ref: PDFRef, obj: PDFObject): Uint8Array => {
  const head = enc(`${ref.objectNumber} ${ref.generationNumber} obj\n`);
  const tail = enc('\nendobj\n\n');
  const out = new Uint8Array(head.length + obj.sizeInBytes() + tail.length);
  out.set(head, 0);
  const n = obj.copyBytesInto(out, head.length);
  out.set(tail, head.length + n);
  return out.subarray(0, head.length + n + tail.length);
};

/**
 * Appends a revision holding `changed` (new objects and edited existing ones, as they now are in `doc`).
 * `doc` must have been loaded from `original` and edited through pdf-lib. Returns original + the update.
 */
export async function appendRevision(original: Uint8Array, doc: PDFDocument, changed: PDFRef[]): Promise<Uint8Array> {
  await doc.flush(); // fonts and images added with embed… are only created when asked for here
  const ctx = doc.context;
  const prev = lastStartXref(original);
  const stream = usesXrefStream(original, prev);

  const refs = [...new Map(changed.map((r) => [r.objectNumber, r])).values()].sort((a, b) => a.objectNumber - b.objectNumber);
  const pieces: Uint8Array[] = [enc('\n')];
  let at = original.length + 1;
  const offsets = new Map<number, number>();
  for (const ref of refs) {
    const obj = ctx.lookup(ref);
    if (!obj) continue;
    const b = objectBytes(ref, obj);
    offsets.set(ref.objectNumber, at);
    pieces.push(b);
    at += b.length;
  }

  const size = Math.max(originalSize(original), ctx.largestObjectNumber + 1, ...refs.map((r) => r.objectNumber + 1));
  const t = ctx.trailerInfo;
  const root = t.Root as PDFRef;
  const common = `/Size ${size} /Root ${root.objectNumber} ${root.generationNumber} R` + (t.Info instanceof PDFRef ? ` /Info ${t.Info.objectNumber} ${t.Info.generationNumber} R` : '') + ` /Prev ${prev}`;
  const idText = t.ID ? ` /ID ${t.ID.toString()}` : '';

  const nums = [...offsets.keys()].sort((a, b) => a - b);
  // consecutive object numbers share one subsection
  const runs: number[][] = [];
  for (const n of nums) {
    const last = runs[runs.length - 1];
    if (last && last[last.length - 1] === n - 1) last.push(n);
    else runs.push([n]);
  }

  if (!stream) {
    let x = 'xref\n';
    for (const run of runs) {
      x += `${run[0]} ${run.length}\n`;
      for (const n of run) x += `${pad(offsets.get(n)!, 10)} 00000 n \n`;
    }
    const xrefAt = at;
    pieces.push(enc(x + `trailer\n<< ${common}${idText} >>\nstartxref\n${xrefAt}\n%%EOF\n`));
  } else {
    // the update's own cross-reference stream is one more object, listed in itself
    const selfNum = size;
    const rows: number[] = [];
    const index: number[] = [];
    for (const run of runs) {
      index.push(run[0], run.length);
      for (const n of run) rows.push(1, offsets.get(n)!, 0);
    }
    index.push(selfNum, 1);
    rows.push(1, at, 0);
    const data = new Uint8Array(rows.length / 3 * 7);
    for (let i = 0; i < rows.length; i += 3) {
      const o = (i / 3) * 7;
      data[o] = rows[i];
      data[o + 1] = (rows[i + 1] >>> 24) & 255;
      data[o + 2] = (rows[i + 1] >>> 16) & 255;
      data[o + 3] = (rows[i + 1] >>> 8) & 255;
      data[o + 4] = rows[i + 1] & 255;
      data[o + 5] = (rows[i + 2] >>> 8) & 255;
      data[o + 6] = rows[i + 2] & 255;
    }
    const head = enc(`${selfNum} 0 obj\n<< /Type /XRef ${common.replace(/\/Size \d+/, `/Size ${selfNum + 1}`)}${idText} /W [1 4 2] /Index [${index.join(' ')}] /Length ${data.length} >>\nstream\n`);
    const tail = enc(`\nendstream\nendobj\nstartxref\n${at}\n%%EOF\n`);
    pieces.push(head, data, tail);
  }

  const total = original.length + pieces.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  out.set(original, 0);
  let k = original.length;
  for (const p of pieces) (out.set(p, k), (k += p.length));
  return out;
}

/** Refs that a normal edit of the catalog, a page and its annotation list would have touched. */
export function touchedRefs(doc: PDFDocument, pageIndex: number): PDFRef[] {
  const refs: PDFRef[] = [doc.context.trailerInfo.Root as PDFRef];
  const page = doc.getPage(pageIndex);
  refs.push(page.ref);
  const annots = page.node.get(PDFName.of('Annots'));
  if (annots instanceof PDFRef) refs.push(annots);
  const acro = doc.catalog.get(PDFName.of('AcroForm'));
  if (acro instanceof PDFRef) {
    refs.push(acro);
    const a = doc.context.lookup(acro) as any;
    const fields = a?.get?.(PDFName.of('Fields'));
    if (fields instanceof PDFRef) refs.push(fields);
  } else if (acro) {
    const fields = (acro as any).get?.(PDFName.of('Fields'));
    if (fields instanceof PDFRef) refs.push(fields);
  }
  return refs;
}
