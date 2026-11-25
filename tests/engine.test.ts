// Headless engine test: builds a sample PDF (with a form), then runs bake + page ops
// and verifies the results with pdf-lib and pdf.js text extraction.
// Run: npm run test:engine
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { bake } from '../src/lib/bake';
import * as ops from '../src/lib/ops';
import type { Annot } from '../src/types';

let failures = 0;
const check = (cond: unknown, msg: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
};

async function sample() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 3; i++) {
    const p = doc.addPage([612, 792]);
    p.drawText(`Original page ${i + 1} invoice total 1000`, { x: 72, y: 700, size: 14, font });
  }
  const form = doc.getForm();
  const tf = form.createTextField('customer');
  tf.addToPage(doc.getPage(0), { x: 72, y: 600, width: 200, height: 20 });
  const cb = form.createCheckBox('agree');
  cb.addToPage(doc.getPage(0), { x: 72, y: 560, width: 14, height: 14 });
  return doc.save();
}

async function text(bytes: Uint8Array) {
  const d = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
  const out: string[] = [];
  for (let i = 1; i <= d.numPages; i++) {
    const tc = await (await d.getPage(i)).getTextContent();
    out.push(tc.items.map((it: any) => it.str).join(' '));
  }
  await d.destroy();
  return out;
}

async function viewportGetter(bytes: Uint8Array) {
  const d = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
  return (i: number) => d.getPage(i + 1).then((p) => p.getViewport({ scale: 1 }) as any);
}

const base = await sample();
check((await text(base))[0].includes('Original page 1'), 'sample PDF renders text');

// ---- bake: edit text, add text, signature-like image, note, form fill ----
const png1x1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const annots: Annot[] = [
  { id: 'r', page: 0, type: 'replace', x: 70, y: 80, w: 300, h: 20, text: 'EDITED invoice total 2500', fontSize: 14, color: '#000000', bg: '#ffffff' },
  { id: 't', page: 1, type: 'text', x: 72, y: 300, w: 300, h: 20, text: 'Added note “smart quotes” – ok', fontSize: 12, color: '#c62828' },
  { id: 'i', page: 0, type: 'image', x: 300, y: 500, w: 120, h: 40, dataUrl: png1x1 },
  { id: 'h', page: 0, type: 'highlight', rects: [{ x: 70, y: 80, w: 100, h: 18 }], color: '#ffe14d' },
  { id: 'k', page: 2, type: 'ink', points: [[10, 10], [50, 60], [90, 20]], color: '#1d5fbf', width: 2 },
  { id: 'a', page: 2, type: 'arrow', x1: 100, y1: 100, x2: 200, y2: 150, color: '#000000', width: 2 },
  { id: 'e', page: 2, type: 'ellipse', x: 300, y: 300, w: 80, h: 40, color: '#000000', width: 1, fill: '#fff3b0' },
  { id: 'n', page: 1, type: 'note', x: 500, y: 50, text: 'Please review', color: '#f5b800' },
];
const baked = await bake(base, annots, { customer: 'Mandaue Foam', agree: true }, await viewportGetter(base));
const t = await text(baked);
check(t[0].includes('EDITED invoice total 2500'), 'edit-text replacement written to page 1');
check(t[1].includes('Added note "smart quotes" - ok'), 'added text written (unicode quotes sanitized)');
const bd = await PDFDocument.load(baked);
check(bd.getForm().getTextField('customer').getText() === 'Mandaue Foam', 'form text field filled');
check(bd.getForm().getCheckBox('agree').isChecked(), 'form checkbox checked');
const annotsP2 = bd.getPage(1).node.Annots();
check(annotsP2 && annotsP2.size() === 1, 'sticky note saved as real PDF annotation');

// ---- flatten ----
const flat = await bake(base, [], { customer: 'Flat Co' }, await viewportGetter(base), { flattenForms: true });
const fd = await PDFDocument.load(flat);
check(fd.getForm().getFields().length === 0, 'flatten removes form fields');

// ---- page ops ----
check((await ops.pageCount(await ops.deletePages(base, [1]))) === 2, 'delete page');
const reordered = await ops.reorderPages(base, [2, 0, 1]);
check((await text(reordered))[0].includes('Original page 3'), 'reorder pages');
const rot = await PDFDocument.load(await ops.rotatePages(base, [0], 90));
check(rot.getPage(0).getRotation().angle === 90, 'rotate page');
check((await ops.pageCount(await ops.merge([base, base]))) === 6, 'merge');
const parts = await ops.split(base, { ranges: '1-2, 3' });
check(parts.length === 2 && (await ops.pageCount(parts[0])) === 2, 'split by ranges');
{
  // merge with page selection + rotation
  const m = await ops.mergeParts([{ bytes: base, pages: [2, 0] }, { bytes: base, pages: [1], rotate: 90 }]);
  const mt = await text(m);
  check(mt.length === 3 && mt[0].includes('page 3') && mt[1].includes('page 1') && mt[2].includes('page 2'), 'merge: picks pages in the chosen order');
  const md = await PDFDocument.load(m);
  check(md.getPage(2).getRotation().angle === 90 && md.getPage(0).getRotation().angle === 0, 'merge: rotates only the chosen file');
  check((await ops.pageCount(await ops.mergeParts([{ bytes: base }, { bytes: base }]))) === 6, 'merge: no selection keeps every page');
  let empty = false;
  try {
    await ops.mergeParts([{ bytes: base, pages: [99] }]);
  } catch {
    empty = true;
  }
  check(empty, 'merge: empty selection reports an error');
  // split modes
  check(JSON.stringify(ops.splitGroups(3, { everyN: 1 })) === '[[0],[1],[2]]', 'split: one file per page');
  check(JSON.stringify(ops.splitGroups(7, { starts: [3, 5] })) === '[[0,1,2],[3,4],[5,6]]', 'split: sections from bookmarks');
  check(JSON.stringify(ops.splitGroups(5, { ranges: '1-2, 5', single: true })) === '[[0,1,4]]', 'split: chosen ranges into one file');
  // split by size: build a heavier document so the limit actually matters
  const big = await PDFDocument.create();
  const f = await big.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 40; i++) {
    const p = big.addPage([612, 792]);
    for (let l = 0; l < 60; l++) p.drawText(`Line ${l} of page ${i} ${'lorem ipsum '.repeat(6)}`, { x: 20, y: 760 - l * 12, size: 8, font: f });
  }
  const bigBytes = await big.save({ useObjectStreams: false });
  const limit = Math.floor(bigBytes.length / 4);
  const sized = await ops.splitBySize(bigBytes, limit);
  let total = 0;
  for (const s of sized.files) total += await ops.pageCount(s);
  check(sized.files.length >= 4 && sized.files.every((s) => s.length <= limit) && total === 40, `split by size: ${sized.files.length} files, all under the limit, no page lost`);
}
check((await ops.pageCount(await ops.insertBlank(base, 1))) === 4, 'insert blank page');
check((await ops.pageCount(await ops.insertPdf(base, base, 3))) === 6, 'insert PDF');
const wm = await text(await ops.watermark(base, { text: 'CONFIDENTIAL', size: 60, color: '#ff0000', opacity: 0.2, diagonal: true }));
check(wm.every((p) => p.includes('CONFIDENTIAL')), 'watermark on every page');
const nums = await text(await ops.pageNumbers(base, { format: 'MF-{n:6}', position: 'bottom-right', size: 9, start: 1 }));
check(nums[2].includes('MF-000003'), 'Bates numbering');
const meta = await ops.getMetadata(await ops.setMetadata(base, { title: 'Invoice', author: 'MF' }));
check(meta.title === 'Invoice' && meta.author === 'MF', 'metadata');
check(JSON.stringify(ops.parseRanges('1-3, 5, 7-end', 8)) === JSON.stringify([[0, 1, 2], [4], [6, 7]]), 'range parsing');

// ---- rotated page: edit text still lands upright on the rotated page ----
const rotBase = await ops.rotatePages(base, [0], 90);
const rotBaked = await bake(
  rotBase,
  [{ id: 'x', page: 0, type: 'text', x: 50, y: 50, w: 300, h: 20, text: 'ROTATED OK', fontSize: 12, color: '#000000' }],
  {},
  await viewportGetter(rotBase),
);
check((await text(rotBaked))[0].includes('ROTATED OK'), 'text on rotated page');

// ---- exporters: PDF -> Excel / Word (text mode) ----
{
  const { pdfToXlsx } = await import('../src/lib/toExcel');
  const { pdfToDocx } = await import('../src/lib/toWord');
  const t = await PDFDocument.create();
  const f = await t.embedFont(StandardFonts.Helvetica);
  const p = t.addPage([612, 792]);
  const rows = [['SKU', 'Item', 'Qty', 'Price'], ['MF-001', 'Sofa bed', '3', '12,500.00'], ['MF-002', 'Foam mattress', '7', '4,999.50']];
  rows.forEach((r, i) => r.forEach((cell, j) => p.drawText(cell, { x: 72 + j * 120, y: 700 - i * 20, size: 11, font: f })));
  p.drawText('Thank you for shopping.', { x: 72, y: 600, size: 11, font: f });
  const pdfBytes = await t.save();
  const doc = await pdfjs.getDocument({ data: pdfBytes.slice(), isEvalSupported: false }).promise;
  const xlsx = await pdfToXlsx(doc as any, pdfjs as any, () => {});
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xlsx as any);
  const ws = wb.worksheets[0];
  check(ws.getRow(1).getCell(2).value === 'Item' && ws.getRow(2).getCell(1).value === 'MF-001', 'PDF->Excel keeps rows/columns');
  check(ws.getRow(2).getCell(4).value === 12500 && ws.getRow(3).getCell(4).value === 4999.5, 'PDF->Excel converts numbers');
  const docx = await pdfToDocx(doc as any, pdfjs as any, 'flow', () => {});
  const JSZip = (await import('jszip')).default;
  const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
  check(xml.includes('Thank you for shopping.') && xml.includes('Sofa bed'), 'PDF->Word contains the text');
  await doc.destroy();
}

// ---- true Edit Text: original removed, same typeface/size/baseline ----
{
  const fsMod = await import('node:fs');
  const fontkit = (await import('@pdf-lib/fontkit')).default;
  const F = (f: string) => `${process.env.WINDIR || 'C:\\Windows'}\\Fonts\\${f}`;
  const fontFiles: Record<string, string> = { 'Tahoma|true': 'tahomabd.ttf', 'Tahoma|false': 'tahoma.ttf', 'Arial|false': 'arial.ttf' };
  if (fsMod.existsSync(F('tahomabd.ttf')) && fsMod.existsSync(F('arial.ttf'))) {
    const d = await PDFDocument.create();
    d.registerFontkit(fontkit);
    const tb = await d.embedFont(fsMod.readFileSync(F('tahomabd.ttf')), { subset: true });
    const ar = await d.embedFont(fsMod.readFileSync(F('arial.ttf')), { subset: true });
    const p = d.addPage([612, 792]);
    p.drawText('Type of Request:', { x: 40, y: 700, size: 11, font: tb });
    p.drawRectangle({ x: 150, y: 698, width: 12, height: 12, borderWidth: 1.5 });
    p.drawText('Refund', { x: 165, y: 700, size: 11, font: tb });
    p.drawRectangle({ x: 230, y: 698, width: 12, height: 12, borderWidth: 1.5 });
    p.drawText('Charge', { x: 245, y: 700, size: 11, font: tb });
    p.drawText('Installment: ____ months', { x: 300, y: 700, size: 10, font: ar });
    const src = await d.save();

    // find "Charge" exactly like the editor does (pdf.js text item geometry)
    const doc = await pdfjs.getDocument({ data: src.slice(), isEvalSupported: false }).promise;
    const pg = await doc.getPage(1);
    const vp = pg.getViewport({ scale: 1 });
    const tc = await pg.getTextContent();
    const item = (tc.items as any[]).find((it) => it.str === 'Charge');
    const tx = pdfjs.Util.transform(vp.transform, item.transform);
    const size = Math.hypot(tx[2], tx[3]);
    const orig = { x: tx[4] - 1, y: tx[5] - size * 0.95, w: item.width + 2, h: size * 1.25 };
    await doc.destroy();

    const out = await bake(
      src,
      [{ id: 'r', page: 0, type: 'replace', ...orig, orig, text: 'Charge Back', fontSize: size, color: '#000000', bg: '#ffffff',
         family: 'Tahoma', bold: true, italic: false, baseline: tx[5], startX: tx[4] } as any],
      {},
      await viewportGetter(src),
      { loadSystemFont: async (fam, b) => { const f = fontFiles[`${fam}|${b}`]; return f ? new Uint8Array(fsMod.readFileSync(F(f))) : null; } },
    );
    const d2 = await pdfjs.getDocument({ data: out.slice(), isEvalSupported: false }).promise;
    const pg2 = await d2.getPage(1);
    const tc2 = await pg2.getTextContent();
    const strs = (tc2.items as any[]).map((i) => i.str).filter((s) => s.trim());
    check(!strs.includes('Charge'), 'edit text: original "Charge" removed from the page (not just covered)');
    check(strs.includes('Charge Back') && strs.includes('Refund') && strs.includes('Type of Request:'), 'edit text: new text present, neighbours untouched');
    const newItem = (tc2.items as any[]).find((i) => i.str === 'Charge Back');
    const refund = (tc2.items as any[]).find((i) => i.str === 'Refund');
    check(Math.abs(newItem.transform[5] - refund.transform[5]) < 0.01, 'edit text: same baseline as the original line');
    check(Math.abs(Math.hypot(newItem.transform[2], newItem.transform[3]) - 11) < 0.05, 'edit text: same font size');
    await pg2.getOperatorList();
    const fontObj: any = pg2.commonObjs.get(newItem.fontName);
    check(/Tahoma/i.test(fontObj?.name || '') && /bold/i.test(fontObj?.name || ''), `edit text: same typeface (${fontObj?.name})`);
    const ops = await pg2.getOperatorList();
    check(ops.fnArray.filter((f: number) => f === pdfjs.OPS.constructPath).length >= 2, 'edit text: checkbox drawings left intact (no white cover)');
    await d2.destroy();
  } else console.log('SKIP  edit-text font test (Windows fonts not found)');
}

// ---- Move tool: a box + its label really move in the content stream ----
{
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  const p = d.addPage([612, 792]);
  p.drawRectangle({ x: 100, y: 600, width: 40, height: 40, borderWidth: 2 }); // inside the area
  p.drawRectangle({ x: 400, y: 600, width: 40, height: 40, borderWidth: 2 }); // outside
  p.drawText('Stay', { x: 400, y: 560, size: 12, font: f });
  const src = await d.save();
  // area (page units, y down): x 90..150, top 792-650=142 .. 792-590=202
  const out = await bake(
    src,
    [{ id: 'mv', page: 0, type: 'move', from: { x: 90, y: 142, w: 60, h: 60 }, dx: 200, dy: 100, snapshot: '', texts: [] } as any],
    {},
    await viewportGetter(src),
  );
  const doc = await pdfjs.getDocument({ data: out.slice(), isEvalSupported: false }).promise;
  const pg = await doc.getPage(1);
  const ops = await pg.getOperatorList();
  // collect transforms applied right before path painting: the moved box gets an extra cm translate(200,-100)
  const cms = ops.fnArray.map((fn: number, i: number) => (fn === pdfjs.OPS.transform ? ops.argsArray[i] : null)).filter(Boolean);
  check(cms.some((m: number[]) => Math.abs(m[4] - 200) < 0.01 && Math.abs(m[5] + 100) < 0.01), 'move: box inside the area shifted by (+200, -100) pt');
  const tc = await pg.getTextContent();
  check((tc.items as any[]).some((i) => i.str === 'Stay' && Math.abs(i.transform[4] - 400) < 0.01), 'move: content outside the area untouched');
  await doc.destroy();
}

// ---- watermark options: pages, behind content, tiling, image ----
{
  const wmBehind = await ops.watermark(base, { text: 'DRAFT', size: 40, color: '#ff0000', opacity: 0.2, diagonal: false, angle: 30, pages: '2', behind: true });
  const t = await text(wmBehind);
  check(!t[0].includes('DRAFT') && t[1].includes('DRAFT') && !t[2].includes('DRAFT'), 'watermark: only the chosen page (2)');
  const wd = await PDFDocument.load(wmBehind);
  const contents = wd.getPage(1).node.Contents() as any;
  const firstStream = wd.context.lookup(contents.get(0)) as any;
  const { decodePDFRawStream } = await import('pdf-lib');
  const firstOps = new TextDecoder().decode(decodePDFRawStream(firstStream).decode());
  check(/Tj/.test(firstOps) && firstOps.includes('BT'), 'watermark: "behind" paints before the page content');
  const tiled = await text(await ops.watermark(base, { text: 'MF', size: 30, color: '#000000', opacity: 0.1, diagonal: false, angle: 45, position: 'tile' }));
  check((tiled[0].match(/MF/g) || []).length >= 6, 'watermark: tile repeats across the page');
  const png1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const withImg = await ops.watermark(base, { kind: 'image', image: png1, imageScale: 30, text: '', size: 10, color: '#000', opacity: 0.3, diagonal: false, angle: 0 });
  const imgDoc = await pdfjs.getDocument({ data: withImg.slice(), isEvalSupported: false }).promise;
  const ol = await (await imgDoc.getPage(1)).getOperatorList();
  check(ol.fnArray.includes(pdfjs.OPS.paintImageXObject), 'watermark: image/logo watermark drawn');
  await imgDoc.destroy();
}

{
  // ---- optimizer ----
  const { optimize } = await import('../src/lib/optimize');
  const { PDFName, PDFRawStream } = await import('pdf-lib');
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  const page = d.addPage([612, 792]);
  page.drawText('Quarterly report keep this text', { x: 50, y: 700, size: 14, font });
  // an uncompressed 600x500 RGB picture
  const w = 600, h = 500;
  const raw = new Uint8Array(w * h * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 7) % 251;
  const imgRef = d.context.register(d.context.stream(raw, { Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 }));
  page.node.Resources()!.set(PDFName.of('XObject'), d.context.obj({ Im1: imgRef }));
  // an object that nothing refers to, and a padded content stream
  d.context.register(d.context.stream(new Uint8Array(40_000).fill(65), { Type: 'XObject', Subtype: 'Image', Width: 200, Height: 200, ColorSpace: 'DeviceGray', BitsPerComponent: 8 }));
  d.setTitle('Secret title');
  const src = await d.save({ useObjectStreams: false });

  // 1) cleanup alone (no picture shrinker): orphan dropped, raw streams compressed, text intact
  const plain = await optimize(src, { preset: 'balanced' });
  check(plain.report.changed && plain.bytes.length < src.length, `optimize: ${src.length} → ${plain.bytes.length} bytes without touching pictures`);
  check(plain.report.objectsDropped >= 1, 'optimize: drops objects nothing refers to');
  check(plain.report.streamsCompressed >= 1, 'optimize: compresses raw streams');
  check((await text(plain.bytes))[0].includes('keep this text'), 'optimize: text survives');
  check((await ops.pageCount(plain.bytes)) === 1, 'optimize: page count unchanged');

  // 2) with a (fake) picture shrinker: the 600x500 raw picture becomes a small JPEG-tagged stream
  let calls = 0;
  const shrunk = await optimize(src, { preset: 'small', stripMetadata: true }, {
    shrinkImage: async (job) => {
      calls++;
      return { jpeg: new Uint8Array(1500).fill(1), width: Math.round(job.width / 2), height: Math.round(job.height / 2) };
    },
  });
  check(calls === 1 && shrunk.report.imagesShrunk === 1, 'optimize: hands each large picture to the shrinker once');
  const sd = await PDFDocument.load(shrunk.bytes);
  const stream = [...sd.context.enumerateIndirectObjects()].map(([, o]) => o).find((o) => o instanceof PDFRawStream && o.dict.get(PDFName.of('Width'))?.toString() === '300');
  check(!!stream && stream.dict.get(PDFName.of('Filter'))?.toString() === '/DCTDecode', 'optimize: picture replaced with the shrunk JPEG');
  check((sd.getTitle() || '') === '', 'optimize: can strip the document title');
  check(shrunk.bytes.length < plain.bytes.length, 'optimize: shrinking pictures saves more than cleanup alone');

  // 3) already-tight file: returned as is
  const again = await optimize(shrunk.bytes, { preset: 'balanced' });
  check(again.bytes.length <= shrunk.bytes.length, 'optimize: never makes a file bigger');
}

{
  // ---- OCR geometry ----
  const { estimateSkew, rotatePoint, unrotatePoint } = await import('../src/lib/ocrGeom');
  // a page of 12 text lines, each a run of dark pixels, then tilted by +2° (clockwise in image space)
  const tilt = (deg: number) => {
    const xs: number[] = [], ys: number[] = [];
    const th = (deg * Math.PI) / 180;
    for (let line = 0; line < 12; line++)
      for (let x = 60; x < 740; x += 2)
        for (let dy = 0; dy < 6; dy++) {
          const [rx, ry] = rotatePoint(x, 80 + line * 40 + dy, 400, 300, th);
          xs.push(rx + 200);
          ys.push(ry + 200);
        }
    return { xs, ys };
  };
  for (const deg of [0, 2, -3.5]) {
    const { xs, ys } = tilt(deg);
    const sk = estimateSkew(xs, ys);
    const got = (sk.theta * 180) / Math.PI;
    check(deg === 0 ? Math.abs(got) < 0.35 && sk.gain < 0.05 : Math.abs(got + deg) < 0.35 && sk.gain > 0.1, `ocr: ${deg}° tilt measured as ${got.toFixed(2)}° (levelling turn is the opposite way)`);
  }
  const [qx, qy] = rotatePoint(500, 120, 400, 300, 0.07);
  const [bx, by] = unrotatePoint(qx, qy, 400, 300, 0.07);
  check(Math.abs(bx - 500) < 1e-9 && Math.abs(by - 120) < 1e-9, 'ocr: mapping a word back to the original scan is exact');
  check(estimateSkew([1, 2, 3], [1, 2, 3]).theta === 0, 'ocr: a nearly blank page is not rotated');
}

{
  // ---- layout analysis (PDF -> Word / Excel / PowerPoint) ----
  const L = await import('../src/lib/pdfLayout');
  const run = (str: string, x: number, y: number, size = 12, w = str.length * size * 0.5): import('../src/lib/pdfLayout').Run => ({ str, x, y, w, size, bold: false, italic: false, font: 'Arial' });

  // a 2-column x 3-row ruled table with one merged cell on the last row
  const hl = [100, 130, 160, 190].map((y) => ({ at: y, a: 50, b: 350 }));
  const vl = [{ at: 50, a: 100, b: 190 }, { at: 200, a: 100, b: 160 }, { at: 350, a: 100, b: 190 }];
  const tables = L.detectTables(hl, vl);
  check(tables.length === 1 && tables[0].rows.length === 4 && tables[0].cols.length === 3, 'layout: finds a ruled table (3 rows x 2 columns)');
  const merged = tables[0].cells.find((c) => c.colSpan === 2);
  check(tables[0].cells.length === 5 && !!merged && merged.r === 2, 'layout: merges the cell whose dividing line is missing');
  check(L.detectTables([{ at: 10, a: 0, b: 100 }, { at: 50, a: 0, b: 100 }], [{ at: 0, a: 10, b: 50 }, { at: 100, a: 10, b: 50 }]).length === 0, 'layout: a single boxed area is not a table');
  const runs = [run('Item', 60, 120), run('Amount', 210, 120), run('Desk', 60, 150), run('1,250.00', 210, 150), run('Total (merged)', 60, 180), run('Outside the table', 60, 260)];
  const rest = L.fillTables(tables, runs);
  const find = (r: number, c: number) => tables[0].cells.find((x) => x.r === r && x.c === c)!;
  check(L.cellText(find(0, 1)) === 'Amount' && L.cellText(find(1, 0)) === 'Desk' && L.cellText(find(2, 0)) === 'Total (merged)', 'layout: text lands in the right cells');
  check(rest.length === 1 && rest[0].str === 'Outside the table', 'layout: text outside the table stays outside');

  // two columns of text read left column first
  const col = (x: number, tag: string) => Array.from({ length: 5 }, (_, i) => run(`${tag}${i}`, x, 100 + i * 16, 12, 150));
  const blocks = L.readingBlocks([...col(300, 'R'), ...col(50, 'L')]);
  const order = blocks.flatMap((b) => L.groupLines(b).map((l) => l[0].str)).join(',');
  check(order === 'L0,L1,L2,L3,L4,R0,R1,R2,R3,R4', `layout: reads two columns left then right (${order})`);
  // a label/value pair on one line is NOT split into columns
  const form = L.readingBlocks([run('Name:', 50, 100), run('Dean', 300, 100), run('Date:', 50, 120), run('today', 300, 120)]);
  check(form.length === 1, 'layout: a short form row stays together');

  // paragraphs: gap starts a new one, bullets are recognised, a lone centred line is centred
  const para = L.paragraphs([run('First line of text', 50, 100, 12, 300), run('second line of it', 50, 114, 12, 300), run('A new paragraph', 50, 150, 12, 300), run('• a bullet item', 50, 166, 12, 300), run('Centred', 150, 200, 12, 100)]);
  check(para.length === 4 && para[0].lines.length === 2, 'layout: groups lines into paragraphs');
  check(para[2].bullet === '•' && para[3].align === 'center', 'layout: spots bullets and centred lines');

  // the same thing on a real PDF read by pdf.js: a ruled table, a boxed note and body text
  {
    const { extractPage } = await import('../src/lib/pdfExtract');
    const { rgb } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    const f = await doc.embedFont(StandardFonts.Helvetica);
    const fb = await doc.embedFont(StandardFonts.HelveticaBold);
    const p = doc.addPage([612, 792]);
    for (const y of [700, 670, 640, 610]) p.drawLine({ start: { x: 50, y }, end: { x: 350, y }, thickness: 1, color: rgb(0, 0, 0) });
    for (const x of [50, 200, 350]) p.drawLine({ start: { x, y: 700 }, end: { x, y: 610 }, thickness: 1, color: rgb(0, 0, 0) });
    p.drawText('Item', { x: 60, y: 680, size: 12, font: fb });
    p.drawText('Amount', { x: 210, y: 680, size: 12, font: fb });
    p.drawText('Desk', { x: 60, y: 650, size: 12, font: f });
    p.drawText('1,250.00', { x: 210, y: 650, size: 12, font: f });
    p.drawText('Chair', { x: 60, y: 620, size: 12, font: f });
    p.drawText('800.00', { x: 210, y: 620, size: 12, font: f });
    p.drawText('Invoice notes below the table', { x: 50, y: 560, size: 12, font: f });
    p.drawRectangle({ x: 400, y: 600, width: 100, height: 40, borderWidth: 1, borderColor: rgb(0, 0, 0) });
    const d = await pdfjs.getDocument({ data: new Uint8Array(await doc.save()), isEvalSupported: false }).promise;
    const pd = await extractPage(d as any, 1, pdfjs as any);
    check(pd.w === 612 && pd.runs.length >= 7, `extract: reads ${pd.runs.length} text runs from the page`);
    check(pd.runs.find((r) => r.str === 'Item')?.bold === true && pd.runs.find((r) => r.str === 'Desk')?.bold === false, 'extract: tells bold from regular text');
    check(pd.hlines.length >= 4 && pd.vlines.length >= 3, `extract: finds ${pd.hlines.length} horizontal and ${pd.vlines.length} vertical ruling lines`);
    const tb = L.detectTables(pd.hlines, pd.vlines);
    check(tb.length === 1 && tb[0].rows.length === 4 && tb[0].cols.length === 3, 'extract: the ruled lines make one 3x2 table (the lone box is not a table)');
    const out = L.fillTables(tb, pd.runs);
    const cell = (r: number, c: number) => L.cellText(tb[0].cells.find((x) => x.r === r && x.c === c)!);
    check(cell(0, 0) === 'Item' && cell(1, 1) === '1,250.00' && cell(2, 0) === 'Chair', 'extract: table cells hold the right words');
    check(out.length === 1 && out[0].str.startsWith('Invoice notes'), 'extract: text outside the table is left for the body');

    // Excel: the table becomes cells with real numbers, the note goes below it
    const { pdfToXlsx } = await import('../src/lib/toExcel');
    const xl = await pdfToXlsx(d as any, pdfjs as any, () => {});
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xl as any);
    const ws = wb.getWorksheet('Page 1')!;
    check(ws.getCell('A1').value === 'Item' && ws.getCell('B2').value === 1250 && ws.getCell('B3').value === 800, 'excel: table words and amounts land in the right cells as real numbers');
    check(String(ws.getCell('B2').numFmt).includes('#,##0'), 'excel: amounts keep a thousands format');
    check(ws.getCell('A1').font?.bold === true, 'excel: bold headers stay bold');
    const noteRow = [...Array(8).keys()].map((k) => String(ws.getCell(k + 1, 1).value ?? '')).findIndex((t) => t.startsWith('Invoice notes'));
    check(noteRow >= 4, 'excel: the note sits below the table');
    await d.destroy();

    // PowerPoint / Word backdrop: the page with every word deleted but the lines kept
    const { textFreePdf } = await import('../src/lib/textFree');
    const tfree = await textFreePdf(new Uint8Array(await doc.save()));
    const td = await pdfjs.getDocument({ data: tfree.bytes.slice(), isEvalSupported: false }).promise;
    const ttext = (await (await td.getPage(1)).getTextContent()).items.map((it: any) => it.str).join('').trim();
    const tpd = await extractPage(td as any, 1, pdfjs as any);
    check(tfree.clean[0] && ttext === '', 'backdrop: every word is removed from the page');
    check(tpd.hlines.length >= 4 && tpd.vlines.length >= 3, 'backdrop: the table lines are still there');
    await td.destroy();

    // Word, flowing text: a real table, the note after it, fonts and bold kept
    const { pdfToDocx } = await import('../src/lib/toWord');
    const d2 = await pdfjs.getDocument({ data: new Uint8Array(await doc.save()), isEvalSupported: false }).promise;
    const docx = await pdfToDocx(d2 as any, pdfjs as any, 'flow', () => {});
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    check(xml.includes('<w:tbl>') && xml.includes('Item') && xml.includes('1,250.00') && xml.includes('Chair'), 'word: the ruled table becomes a real Word table with its words');
    check(xml.indexOf('<w:tbl>') < xml.indexOf('Invoice notes'), 'word: the note comes after the table, as on the page');
    check(/<w:b\/>|<w:b /.test(xml) && /w:ascii="Helvetica"/.test(xml), 'word: bold and the real font name are kept');
    check((xml.match(/<w:tc>/g) || []).length >= 6, 'word: every table cell is there');
    await d2.destroy();
    const segs =L.lineSegments([run('Name:', 50, 100, 12, 30), run('Dean', 60, 100, 12, 25), run('Date', 300, 100, 12, 25)]);
    check(segs.length === 2 && segs[0].length === 2, 'powerpoint: a line splits into one box per column');
  }

  // spreadsheet values
  const v = (s: string) => L.parseCell(s);
  check(v('1,250.50').kind === 'number' && (v('1,250.50') as any).v === 1250.5, 'cells: thousands separator becomes a number');
  check((v('₱ 3,400') as any).v === 3400 && String((v('₱ 3,400') as any).fmt).includes('₱'), 'cells: peso amounts become money');
  check((v('(500.00)') as any).v === -500, 'cells: brackets mean negative');
  check((v('12.5%') as any).v === 0.125, 'cells: percentages become fractions');
  check(v('0917123456').kind === 'text' && v('2026110512345678').kind === 'text', 'cells: phone numbers and long ids stay text');
  check(v('Nov 25, 2026').kind === 'date' && v('2026-11-25').kind === 'date' && v('25/11/2026').kind === 'date', 'cells: dates become dates');
  check(v('Invoice 1001').kind === 'text', 'cells: ordinary words stay text');
}

{
  // ---- text boxes added by other editors (PDFgear etc. use FreeText annotations) ----
  const { PDFName: N } = await import('pdf-lib');
  const d = await PDFDocument.create();
  const pgx = d.addPage([612, 792]);
  const ft = d.context.register(d.context.obj({ Type: 'Annot', Subtype: 'FreeText', Rect: [100, 600, 260, 620], Contents: 'OLD NAME', DA: '/Helv 12 Tf 0 g', F: 4 }));
  pgx.node.addAnnot(ft);
  const ftBytes = await d.save();
  const num = ft.objectNumber;
  const box = { x: 100, y: 172, w: 160, h: 20 };
  const imported: any = { id: 'f1', page: 0, type: 'replace', ...box, orig: { ...box }, text: 'OLD NAME', origText: 'OLD NAME', fontSize: 12, color: '#000000', family: 'Arial', srcAnnot: { num, gen: 0 } };
  const annotCount = async (b: Uint8Array) => (await PDFDocument.load(b)).getPage(0).node.Annots()?.size() ?? 0;
  const edited = await bake(ftBytes, [{ ...imported, text: 'NEW NAME' }], {}, await viewportGetter(ftBytes));
  check((await annotCount(edited)) === 0 && (await text(edited))[0].includes('NEW NAME'), 'freetext: editing an imported text box removes the old box and draws the new text');
  const untouched = await bake(ftBytes, [imported], {}, await viewportGetter(ftBytes));
  check((await annotCount(untouched)) === 1, 'freetext: an untouched imported text box is left exactly as it was');
  const blanked = await bake(ftBytes, [{ ...imported, text: '' }], {}, await viewportGetter(ftBytes));
  check((await annotCount(blanked)) === 0 && !(await text(blanked))[0].includes('OLD NAME'), 'freetext: deleting an imported text box removes it');
  void N;
}

{
  // ---- text alignment and wrapping ----
  const blankA = await PDFDocument.create();
  blankA.addPage([612, 792]);
  const blankBytes2 = await blankA.save();
  const mk = (extra: object, txt = 'Hello world') => ({ id: 'al', page: 0, type: 'text', x: 100, y: 100, w: 300, h: 40, text: txt, fontSize: 12, color: '#000000', ...extra }) as any;
  const firstX = async (extra: object, txt?: string) => {
    const out = await bake(blankBytes2, [mk(extra, txt)], {}, await viewportGetter(blankBytes2));
    const dd = await pdfjs.getDocument({ data: out.slice(), isEvalSupported: false }).promise;
    const items = (await (await dd.getPage(1)).getTextContent()).items as any[];
    await dd.destroy();
    return { x: items[0].transform[4] as number, n: items.filter((i) => i.str.trim()).length, w: items[0].width as number };
  };
  const L2 = await firstX({ align: 'left' });
  const C2 = await firstX({ align: 'center' });
  const R2 = await firstX({ align: 'right' });
  check(L2.x < C2.x && C2.x < R2.x, `text: left, centre and right put the text at ${L2.x.toFixed(0)}, ${C2.x.toFixed(0)}, ${R2.x.toFixed(0)}`);
  check(Math.abs(R2.x + R2.w - (100 + 300 - 2)) < 2, 'text: right alignment ends at the box edge');
  const long = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu';
  const wrapped = await firstX({}, long);
  const unwrapped = await firstX({ wrap: false }, long);
  check(unwrapped.n === 1 && wrapped.n > 1 || unwrapped.n < wrapped.n, 'text: wrap off keeps a long line on one line');
}

{
  // ---- form designer: designed boxes become real fillable fields ----
  const { PDFName, PDFCheckBox, PDFDropdown, PDFOptionList, PDFRadioGroup, PDFTextField } = await import('pdf-lib');
  const F = await import('../src/lib/formFields');
  const blank = await PDFDocument.create();
  blank.addPage([612, 792]);
  const blankBytes = await blank.save();
  const designed: Annot[] = [];
  const add = (kind: any, x: number, y: number, w = 150, h = 22) => {
    const f = F.newField(kind, designed, 0, x, y, w, h);
    designed.push(f);
    return f;
  };
  const t1 = add('text', 72, 100);
  const t2 = add('text', 72, 140);
  (t2 as any).required = true;
  (t2 as any).multiline = true;
  (t2 as any).tooltip = 'Describe the issue';
  (t2 as any).value = 'Start here';
  const cb = add('checkbox', 72, 190, 16, 16);
  (cb as any).checked = true;
  const r1 = add('radio', 72, 230, 16, 16);
  const r2 = add('radio', 72, 260, 16, 16);
  const dd = add('dropdown', 72, 300);
  (dd as any).options = ['Cash', 'Check', 'Card'];
  (dd as any).value = 'Check';
  const sg = add('signature', 72, 350, 190, 52);
  check(t1.name === 'Text1' && t2.name === 'Text2' && r1.name === r2.name && r1.exportValue === 'Choice1' && r2.exportValue === 'Choice2', 'form: new fields get unique names; consecutive radio buttons share a group');
  check(sg.name === 'Signature1' && F.nextFieldName('text', designed as any) === 'Text3', 'form: the next name is the next free number');
  const formPdf = await bake(blankBytes, designed, {}, await viewportGetter(blankBytes));
  const fd = await PDFDocument.load(formPdf);
  const form = fd.getForm();
  const names = form.getFields().map((x) => x.getName()).sort();
  check(JSON.stringify(names) === JSON.stringify(['Check1', 'Dropdown1', 'Group1', 'Signature1', 'Text1', 'Text2']), `form: all fields exist in the saved PDF (${names.join(', ')})`);
  const text2 = form.getField('Text2') as InstanceType<typeof PDFTextField>;
  check(text2 instanceof PDFTextField && text2.isRequired() && text2.isMultiline() && text2.getText() === 'Start here', 'form: required / several lines / starting text are kept');
  check(form.getCheckBox('Check1').isChecked(), 'form: a check box can start ticked');
  const grp = form.getRadioGroup('Group1');
  check(grp.getOptions().length === 2 && grp.getOptions().includes('Choice1') && grp.getOptions().includes('Choice2'), 'form: two radio buttons form one group');
  const dd2 = form.getDropdown('Dropdown1');
  check(JSON.stringify(dd2.getOptions()) === '["Cash","Check","Card"]' && dd2.getSelected()[0] === 'Check', 'form: dropdown keeps its choices and starting choice');
  const sig = form.getField('Signature1').acroField.dict;
  check(String(sig.get(PDFName.of('FT'))) === '/Sig', 'form: the signature field is a real signature field');
  const tipDict = (form.getField('Text2').acroField.dict.get(PDFName.of('TU')) as any)?.decodeText?.();
  check(tipDict === 'Describe the issue', 'form: tooltips are kept');
  void PDFCheckBox, PDFDropdown, PDFOptionList, PDFRadioGroup;
  // a real reader sees them as form fields
  const pd = await pdfjs.getDocument({ data: formPdf.slice(), isEvalSupported: false }).promise;
  const widgets = (await (await pd.getPage(1)).getAnnotations()).filter((x: any) => x.subtype === 'Widget');
  check(widgets.length === 7, `form: a PDF reader sees ${widgets.length} fillable widgets (6 fields, 2 radio buttons share one)`);
  await pd.destroy();
  // names already in the document are not overwritten
  const twice = await bake(formPdf, [F.newField('text', [], 0, 72, 500, 150, 22)], {}, await viewportGetter(formPdf));
  const f2 = (await PDFDocument.load(twice)).getForm().getFields().map((x) => x.getName());
  check(f2.includes('Text1') && f2.includes('Text1_2'), 'form: adding a field with a taken name keeps both (Text1_2)');
}

{
  // ---- compare PDFs ----
  const C = await import('../src/lib/compare');
  const { extractPage } = await import('../src/lib/pdfExtract');
  // the diff itself
  const ops = C.myers('abcabba'.split(''), 'cbabac'.split(''))!;
  check(ops.filter((o) => o.op === '-').length + ops.filter((o) => o.op === '+').length === 5, 'compare: finds the shortest edit script (5 edits)');
  check(C.myers([], ['x'])!.length === 1 && C.myers(['x'], [])!.length === 1 && C.myers<string>([], [])!.length === 0, 'compare: empty sequences are handled');

  const make = async (lines: string[]) => {
    const d = await PDFDocument.create();
    const f = await d.embedFont(StandardFonts.Helvetica);
    const p = d.addPage([612, 792]);
    lines.forEach((l, i) => p.drawText(l, { x: 72, y: 700 - i * 20, size: 12, font: f }));
    return d.save();
  };
  const load = async (bytes: Uint8Array) => {
    const d = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
    const pg = await extractPage(d as any, 1, pdfjs as any);
    await d.destroy();
    return C.docLines([pg]);
  };
  const A = await load(await make(['Invoice 1001', 'Total amount: 1,250.00 pesos', 'Payment within 30 days', 'Thank you for your business']));
  const B = await load(await make(['Invoice 1001', 'Total amount: 1,520.00 pesos', 'Payment within 30 days', 'Delivery in 5 days', 'Thank you for your business']));
  const res = C.compareText(A, B);
  const kinds = res.changes.map((c) => c.kind).join(',');
  check(res.changes.length === 2 && kinds === 'changed,added', `compare: one changed number and one added line (${kinds})`);
  const chg = res.changes[0];
  check(chg.a.map((w) => w.text).join(' ') === '1,250.00' && chg.b.map((w) => w.text).join(' ') === '1,520.00', 'compare: pinpoints the exact words that changed');
  check(res.changes[1].b.map((w) => w.text).join(' ') === 'Delivery in 5 days', 'compare: the added line is reported whole');
  const same = C.compareText(A, A);
  check(same.changes.length === 0, 'compare: identical documents have no changes');
  const gone = C.compareText(B, A);
  check(gone.changes.map((c) => c.kind).join(',') === 'changed,removed', 'compare: swapping the files turns additions into removals');
  const boxes = C.highlightBoxes(chg.b);
  check(boxes.length === 1 && boxes[0].w > 10 && boxes[0].page === 0, 'compare: changed words get a highlight box on the page');
}

{
  // ---- digital signatures ----
  const S = await import('../src/lib/digitalSign');
  const pfx = S.createSelfSigned({ name: 'Test Signer', org: 'Mandaue Foam', password: 'pw123' });
  let badPw = '';
  try {
    S.loadPfx(pfx, 'wrong');
  } catch (e: any) {
    badPw = e.message;
  }
  check(/password/i.test(badPw), 'sign: a wrong certificate password is reported plainly');
  const cred = S.loadPfx(pfx, 'pw123');
  check(cred.name === 'Test Signer', 'sign: opens the .pfx certificate');

  const invisible = await S.signPdf(base, cred, { reason: 'Approved', location: 'Cebu' });
  const r1 = await S.verifySignatures(invisible);
  check(r1.length === 1 && r1[0].status === 'valid' && r1[0].signer === 'Test Signer', 'sign: an invisible signature verifies as valid');
  check(r1[0].reason === 'Approved' && r1[0].location === 'Cebu' && r1[0].selfSigned && r1[0].signedAt !== null, 'sign: reason, place, date and self-signed status are read back');
  check((await ops.pageCount(invisible)) === 3 && (await text(invisible))[0].includes('Original page 1'), 'sign: the signed file still opens and keeps its content');

  const visible = await S.signPdf(base, cred, { reason: 'Reviewed', visible: { page: 0, x: 300, y: 650, w: 220, h: 70 } });
  const r2 = await S.verifySignatures(visible);
  check(r2[0]?.status === 'valid', 'sign: a visible signature box verifies as valid');

  // tamper: change one byte inside the signed area
  const tampered = visible.slice();
  // flip a bit in the header's binary-marker comment: harmless to a PDF reader, but it is inside the signed bytes
  tampered[10] = tampered[10] ^ 1;
  const r3 = await S.verifySignatures(tampered);
  check(r3.length === 1 && r3[0].status === 'invalid', 'sign: changing the document breaks the signature (detected)');
  // content appended after signing
  const appended = new Uint8Array(invisible.length + 20);
  appended.set(invisible);
  appended.set(new TextEncoder().encode('\n%% added later %%\n'), invisible.length);
  const r4 = await S.verifySignatures(appended);
  check(r4[0]?.status === 'modified', 'sign: data added after signing is reported as modified');

  let blocked = false;
  try {
    await S.signPdf(invisible, cred);
  } catch {
    blocked = true;
  }
  check(blocked, 'sign: signing an already signed PDF is refused (it would break the first signature)');
  check((await S.verifySignatures(base)).length === 0, 'sign: an unsigned PDF has no signatures');
}

console.log(failures ? `\n${failures} FAILED` : '\nAll engine tests passed');
process.exit(failures ? 1 : 0);
