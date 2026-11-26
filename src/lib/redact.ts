import {
  PDFDict,
  PDFDocument,
  PDFName,
  StandardFonts,
  TextRenderingMode,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  setCharacterSqueeze,
  setTextRenderingMode,
} from 'pdf-lib';
import type { RedactAnnot } from '../types';
import { loadPdf, pdfjs, renderToCanvas } from './pdf';
import type { PDFPageProxy } from './pdf';
import { blobToBytes, winAnsiSafe } from './util';
import { pruneUnreachable } from './prune';
import { removeTextInRects } from './textremove';

const DPI = 250;
const MARGIN = 1.5; // page units kept clear around every box

export interface RedactReport {
  pages: number;
  boxes: number;
  /** pieces of text that sat under a box and were removed from the file */
  textRemoved: number;
  /** pieces of text kept (searchable and selectable) on the redacted pages */
  textKept: number;
  /** pages where only the words under the boxes were removed, so the rest of the page is still editable text */
  keptEditable: number;
  /** pages that had to be rebuilt as a picture (something other than text sat under a box, or the text could not be cut out safely) */
  asPicture: number;
  /** pages done the careful way (zero-based), checked with the "covered by more than a third" rule */
  carefulPages: Set<number>;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
const hits = (a: Box, b: Box) => a.x < b.x + b.w + MARGIN && a.x + a.w > b.x - MARGIN && a.y < b.y + b.h + MARGIN && a.y + a.h > b.y - MARGIN;

/** A piece of text counts as under a box when the box covers more than a third of it; one that only touches an edge does not. */
const under = (t: Box, b: Box) => {
  const w = Math.min(t.x + t.w, b.x + b.w) - Math.max(t.x, b.x);
  const h = Math.min(t.y + t.h, b.y + b.h) - Math.max(t.y, b.y);
  return w > 0 && h > 0 && (w * h) / Math.max(1e-6, t.w * t.h) > 0.33;
};

/** Text pieces on a page with their boxes in page units (top-left origin), the same space the marked areas use. */
async function pageText(pg: PDFPageProxy) {
  const vp1 = pg.getViewport({ scale: 1 });
  const content = await pg.getTextContent();
  const out: { str: string; x: number; baseline: number; size: number; w: number; flat: boolean; box: Box }[] = [];
  for (const it of content.items as any[]) {
    if (typeof it.str !== 'string' || !it.str.trim()) continue;
    const tx = pdfjs.Util.transform(vp1.transform, it.transform);
    const size = Math.hypot(tx[2], tx[3]);
    const flat = Math.abs(tx[1]) < 0.01 && Math.abs(tx[2]) < 0.01;
    const box = flat
      ? { x: tx[4], y: tx[5] - size * 0.95, w: it.width, h: size * 1.25 }
      : // rotated text: use a generous square around its start so it can never slip past a box
        { x: tx[4] - size * 2, y: tx[5] - size * 2, w: Math.max(it.width, size) + size * 4, h: size * 4 };
    out.push({ str: it.str, x: tx[4], baseline: tx[5], size, w: it.width, flat, box });
  }
  return { vp1, items: out };
}


/**
 * What the page draws under the boxes, other than text: pictures and shadings (which would stay recoverable under a
 * black box) and the number of drawn shapes (a few are just table lines; many could be letters turned into outlines).
 */
async function graphicsUnder(pg: PDFPageProxy, boxes: Box[]) {
  const OPS = (pdfjs as any).OPS;
  const U = (pdfjs as any).Util;
  const list = await pg.getOperatorList();
  const vp = pg.getViewport({ scale: 1 });
  const pageW = vp.width;
  const pageH = vp.height;
  let ctm: number[] = vp.transform;
  const stack: number[][] = [];
  const touches = (pts: number[][]) => {
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const r = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    return boxes.some((b) => r.x < b.x + b.w && r.x + r.w > b.x && r.y < b.y + b.h && r.y + r.h > b.y);
  };
  let images = 0;
  let shapes = 0;
  for (let i = 0; i < list.fnArray.length; i++) {
    const fn = list.fnArray[i];
    const args: any = list.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || ctm;
    else if (fn === OPS.transform) ctm = U.transform(ctm, args);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      if (Array.isArray(args?.[0])) ctm = U.transform(ctm, args[0]);
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || ctm;
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject || fn === OPS.paintImageXObjectRepeat || fn === OPS.paintJpegXObject) {
      if (touches([[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]]))) images++;
    } else if (fn === OPS.shadingFill || fn === OPS.paintShading) images++;
    else if (fn === OPS.constructPath) {
      const next = list.fnArray[i + 1];
      if (next === OPS.clip || next === OPS.eoClip || next === OPS.endPath) continue; // a clipping rectangle draws nothing
      const mm = args?.[2];
      if (Array.isArray(mm) && mm.length === 4) {
        const pts = [[mm[0], mm[1]], [mm[2], mm[1]], [mm[0], mm[3]], [mm[2], mm[3]]].map(([x, y]) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]]);
        const pw = Math.max(...pts.map((p) => p[0])) - Math.min(...pts.map((p) => p[0]));
        const ph = Math.max(...pts.map((p) => p[1])) - Math.min(...pts.map((p) => p[1]));
        if (pw > pageW * 0.6 && ph > pageH * 0.6) continue; // a page-sized background, not content
        if (touches(pts)) shapes++;
      } else shapes++; // unknown extent: count it, to stay on the safe side
    }
  }
  return { images, shapes };
}

/**
 * Careful way, for pages where only text sits under the boxes: cut just those words out of the page's content,
 * paint the black boxes, and keep everything else as real, editable text. Nothing is trusted: the result is
 * re-read to prove no text is left under a box and that the area under each box is one flat colour (so no picture
 * or drawing hides there). Returns the new file, or null when any check fails and the page needs the picture way.
 */
/** Says why the careful way was not used, for the console, and returns null. */
const why = (reason: string): null => {
  console.info('[redact] picture method used for a page:', reason);
  return null;
};

async function redactTextOnly(bytes: Uint8Array, pageIndex: number, boxes: Box[], report: RedactReport): Promise<Uint8Array | null> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const page = doc.getPage(pageIndex);
  const src = await loadPdf(bytes);
  let pdfRects: { x: number; y: number; w: number; h: number }[];
  let removedPieces = 0;
  try {
    const pg = await src.getPage(pageIndex + 1);
    const vp = pg.getViewport({ scale: 1 });
    // page units (top-left origin, as seen) to the page's own space (bottom-left origin, unrotated)
    pdfRects = boxes.map((b) => {
      const p1 = vp.convertToPdfPoint(b.x, b.y);
      const p2 = vp.convertToPdfPoint(b.x + b.w, b.y + b.h);
      return { x: Math.min(p1[0], p2[0]), y: Math.min(p1[1], p2[1]), w: Math.abs(p2[0] - p1[0]), h: Math.abs(p2[1] - p1[1]) };
    });
    // notes, stamps and form fields sit above the page content and cannot be cut out this way: use the picture way
    for (const a of (await pg.getAnnotations()) as any[]) {
      if (!a.rect || a.subtype === 'Link' || a.subtype === 'Popup') continue;
      const [x1, y1, x2, y2] = vp.convertToViewportRectangle(a.rect);
      const ab = { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
      if (boxes.some((b) => hits(ab, b))) return why('an annotation or form field sits under a box');
    }
    removedPieces = (await pageText(pg)).items.filter((t) => boxes.some((b) => under(t.box, b))).length;
  } finally {
    src.destroy();
  }
  let res: ReturnType<typeof removeTextInRects>;
  try {
    res = removeTextInRects(doc, page, pdfRects);
  } catch (e) {
    return why('cutting the text out failed: ' + e);
  }
  if (res.unsafe) return why('text that could not be measured or reached (e.g. inside a form XObject)'); // text it could not measure or reach
  for (const r of pdfRects) page.drawRectangle({ x: r.x, y: r.y, width: r.w, height: r.h, color: rgb(0, 0, 0) });
  const trial = await doc.save({ useObjectStreams: true });

  const check = await loadPdf(trial);
  try {
    const pg = await check.getPage(pageIndex + 1);
    // 1. no text may remain under any box
    const { items } = await pageText(pg);
    const left = items.filter((t) => boxes.some((b) => under(t.box, b)));
    if (left.length) return why('text still under a box after cutting: ' + left.map((t) => JSON.stringify(t.str)).join(', '));
    // 2. with the words cut out, what else does the page draw under a box? A picture or shading would stay
    //    recoverable under the black box; a handful of shapes is just a table line. Many shapes could be letters
    //    turned into outlines, which are as sensitive as text.
    const bare = await PDFDocument.load(bytes, { updateMetadata: false });
    removeTextInRects(bare, bare.getPage(pageIndex), pdfRects);
    const bareDoc = await loadPdf(await bare.save({ useObjectStreams: true }));
    try {
      const g = await graphicsUnder(await bareDoc.getPage(pageIndex + 1), boxes);
      if (g.images) return why(`${g.images} picture(s) or shading under a box`);
      if (g.shapes > 6) return why(`${g.shapes} drawn shapes under a box (could be text turned into outlines)`);
    } finally {
      bareDoc.destroy();
    }
  } finally {
    check.destroy();
  }
  report.textRemoved += removedPieces;
  report.keptEditable++;
  report.carefulPages.add(pageIndex);
  return trial;
}

/** The sure way: the page becomes a picture with the boxes painted black, and an invisible text layer is rebuilt from the untouched words. */
async function redactAsPicture(bytes: Uint8Array, pageIndex: number, boxes: Box[], report: RedactReport): Promise<Uint8Array> {
  const pdf = await loadPdf(bytes);
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  try {
    const pg = await pdf.getPage(pageIndex + 1);
    const { vp1, items } = await pageText(pg);
    const s = DPI / 72;
    const canvas = await renderToCanvas(pg, s);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#000';
    for (const b of boxes) ctx.fillRect(b.x * s, b.y * s, b.w * s, b.h * s);
    const blob = await new Promise<Blob>((res) => canvas.toBlob((b) => res(b!), 'image/jpeg', 0.92));
    const img = await doc.embedJpg(await blobToBytes(blob));
    const np = doc.insertPage(pageIndex, [vp1.width, vp1.height]);
    np.drawImage(img, { x: 0, y: 0, width: vp1.width, height: vp1.height });

    // keep the untouched text findable: invisible, laid over the same spot as the picture's words
    for (const t of items) {
      if (boxes.some((b) => hits(t.box, b))) {
        report.textRemoved++;
        continue;
      }
      if (!t.flat) continue;
      const text = winAnsiSafe(t.str).replace(/\?/g, ' ');
      if (!text.trim()) continue;
      const natural = helv.widthOfTextAtSize(text, t.size);
      const squeeze = natural > 0 && t.w > 0 ? Math.max(20, Math.min(400, (t.w / natural) * 100)) : 100;
      np.pushOperators(pushGraphicsState(), setTextRenderingMode(TextRenderingMode.Invisible), setCharacterSqueeze(squeeze));
      np.drawText(text, { x: t.x, y: vp1.height - t.baseline, size: t.size, font: helv });
      np.pushOperators(popGraphicsState());
      report.textKept++;
    }
    doc.removePage(pageIndex + 1);
    canvas.width = canvas.height = 0;
  } finally {
    pdf.destroy();
  }
  await doc.flush();
  pruneUnreachable(doc); // the old page's content must not stay behind in the file
  report.asPicture++;
  return doc.save({ useObjectStreams: true });
}

/**
 * Secure redaction. For each marked page, first the careful way (only the words under the boxes are cut out,
 * the page stays editable); if anything other than plain text sits under a box, or a check fails, the page is
 * rebuilt as a picture instead so no text, vectors or images survive underneath.
 * Hidden places that can carry the same words (metadata, bookmarks, attachments) are cleared, deleted content is
 * removed from the file itself, and the saved file is re-read to prove nothing is left under the boxes.
 */
export async function applyRedactions(bytes: Uint8Array, redacts: RedactAnnot[], onReport?: (r: RedactReport) => void): Promise<Uint8Array> {
  if (!redacts.length) return bytes;
  const pages = [...new Set(redacts.map((r) => r.page))].sort((a, b) => a - b);
  const report: RedactReport = { pages: pages.length, boxes: redacts.length, textRemoved: 0, textKept: 0, keptEditable: 0, asPicture: 0, carefulPages: new Set() };
  let cur = bytes;
  for (const i of pages) {
    const boxes: Box[] = redacts.filter((x) => x.page === i).map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h }));
    const careful = await redactTextOnly(cur, i, boxes, report).catch(() => null);
    cur = careful ?? (await redactAsPicture(cur, i, boxes, report));
  }

  // Scrub places that can hold the redacted words: document info, XMP, bookmarks and attached files.
  const doc = await PDFDocument.load(cur, { updateMetadata: false });
  doc.setTitle('');
  doc.setSubject('');
  doc.setKeywords([]);
  doc.setAuthor('');
  doc.setCreator('');
  doc.setProducer('PweDeF');
  doc.catalog.delete(PDFName.of('Metadata'));
  doc.catalog.delete(PDFName.of('Outlines'));
  const names = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
  names?.delete(PDFName.of('EmbeddedFiles'));
  // cut-out content and replaced pages leave their old objects behind in the file: remove them for good
  await doc.flush();
  pruneUnreachable(doc);
  const out = await doc.save({ useObjectStreams: true });

  // Prove it: re-read the saved file and make sure no text is left under any box.
  const check = await loadPdf(out);
  try {
    for (const i of pages) {
      const { items } = await pageText(await check.getPage(i + 1));
      const boxes = redacts.filter((x) => x.page === i);
      const covered = report.carefulPages.has(i) ? under : hits; // picture pages drop anything near a box, careful pages anything under one
      const left = items.filter((t) => boxes.some((b) => covered(t.box, b)));
      if (left.length) throw new Error(`Redaction check failed on page ${i + 1}: ${left.length} piece(s) of text were still under a box. The file was not saved.`);
    }
  } finally {
    check.destroy();
  }
  onReport?.(report);
  return out;
}
