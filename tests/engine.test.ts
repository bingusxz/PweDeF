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
  const { pdfToXlsx, pdfToDocx } = await import('../src/lib/exporters');
  const t = await PDFDocument.create();
  const f = await t.embedFont(StandardFonts.Helvetica);
  const p = t.addPage([612, 792]);
  const rows = [['SKU', 'Item', 'Qty', 'Price'], ['MF-001', 'Sofa bed', '3', '12,500.00'], ['MF-002', 'Foam mattress', '7', '4,999.50']];
  rows.forEach((r, i) => r.forEach((cell, j) => p.drawText(cell, { x: 72 + j * 120, y: 700 - i * 20, size: 11, font: f })));
  p.drawText('Thank you for shopping.', { x: 72, y: 600, size: 11, font: f });
  const pdfBytes = await t.save();
  const doc = await pdfjs.getDocument({ data: pdfBytes.slice(), isEvalSupported: false }).promise;
  const xlsx = await pdfToXlsx(doc as any, () => {});
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xlsx as any);
  const ws = wb.worksheets[0];
  check(ws.getRow(1).getCell(2).value === 'Item' && ws.getRow(2).getCell(1).value === 'MF-001', 'PDF->Excel keeps rows/columns');
  check(ws.getRow(2).getCell(4).value === 12500 && ws.getRow(3).getCell(4).value === 4999.5, 'PDF->Excel converts numbers');
  const docx = await pdfToDocx(doc as any, 'text', () => {});
  const JSZip = (await import('jszip')).default;
  const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
  check(xml.includes('Thank you for shopping.') && xml.includes('Sofa bed'), 'PDF->Word contains the text');
  await doc.destroy();
}

console.log(failures ? `\n${failures} FAILED` : '\nAll engine tests passed');
process.exit(failures ? 1 : 0);
