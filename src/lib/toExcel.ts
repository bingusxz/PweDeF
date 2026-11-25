// PDF -> .xlsx. Ruled tables become real tables (merged cells kept), numbers and dates become real values,
// and text outside tables is laid out into columns by where it lines up. One sheet per page.
import type { PDFDocumentProxy } from './pdf';
import { extractPage, type PdfJsLib } from './pdfExtract';
import { cellText, detectTables, fillTables, groupLines, parseCell, type CellValue, type Run, type Table } from './pdfLayout';

type Sheet = import('exceljs').Worksheet;

function put(ws: Sheet, row: number, col: number, text: string, bold: boolean) {
  const cell = ws.getRow(row).getCell(col);
  const v: CellValue = parseCell(text);
  if (v.kind === 'number') {
    cell.value = v.v;
    if (v.fmt) cell.numFmt = v.fmt;
    cell.alignment = { horizontal: 'right', vertical: 'top' };
  } else if (v.kind === 'date') {
    cell.value = v.v;
    cell.numFmt = v.fmt;
    cell.alignment = { horizontal: 'right', vertical: 'top' };
  } else {
    cell.value = v.v;
    cell.alignment = { vertical: 'top', wrapText: v.v.includes('\n') };
  }
  if (bold) cell.font = { bold: true };
  return cell;
}

/** Text lines outside tables: neighbouring words share a cell, and left edges that line up become columns. */
function textRows(ws: Sheet, runs: Run[], startRow: number): number {
  if (!runs.length) return startRow;
  const xs = [...new Set(runs.map((r) => Math.round(r.x)))].sort((a, b) => a - b);
  const anchors: number[] = [];
  for (const x of xs) if (!anchors.length || x - anchors[anchors.length - 1] > 12) anchors.push(x);
  const colOf = (x: number) => {
    let c = 0;
    for (let k = 0; k < anchors.length; k++) if (anchors[k] <= x + 4) c = k;
    return c;
  };
  let row = startRow;
  for (const line of groupLines(runs)) {
    const cells: { text: string; bold: boolean }[] = [];
    for (const r of line) {
      const c = colOf(r.x);
      cells[c] = cells[c] ? { text: `${cells[c].text} ${r.str}`.trim(), bold: cells[c].bold && r.bold } : { text: r.str.trim(), bold: r.bold };
    }
    cells.forEach((v, c) => v && put(ws, row, c + 1, v.text, v.bold));
    row++;
  }
  return row;
}

function tableRows(ws: Sheet, t: Table, startRow: number): number {
  const lastRow = startRow + t.rows.length - 2;
  for (const c of t.cells) {
    const r0 = startRow + c.r, c0 = c.c + 1;
    const text = cellText(c);
    const bold = c.runs.length > 0 && c.runs.every((r) => r.bold);
    put(ws, r0, c0, text, bold);
    if (c.rowSpan > 1 || c.colSpan > 1) ws.mergeCells(r0, c0, r0 + c.rowSpan - 1, c0 + c.colSpan - 1);
    for (let i = r0; i < r0 + c.rowSpan; i++)
      for (let j = c0; j < c0 + c.colSpan; j++) ws.getRow(i).getCell(j).border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
  }
  return lastRow + 1;
}

export async function pdfToXlsx(pdf: PDFDocumentProxy, pdfjs: PdfJsLib, onProgress: (i: number, n: number) => void) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'PweDeF';
  for (let i = 1; i <= pdf.numPages; i++) {
    onProgress(i, pdf.numPages);
    const data = await extractPage(pdf, i, pdfjs);
    const ws = wb.addWorksheet(`Page ${i}`);
    const tables = detectTables(data.hlines, data.vlines);
    const rest = fillTables(tables, data.runs);

    // body text and tables go down the sheet in the order they appear on the page
    let row = 1;
    let used = 0;
    const bodySorted = [...rest].sort((a, b) => a.y - b.y);
    for (const t of tables) {
      const before = bodySorted.filter((r) => r.y < t.box.y).slice(used);
      used += before.length;
      row = textRows(ws, before, row);
      if (before.length) row++;
      row = tableRows(ws, t, row) + 1;
    }
    row = textRows(ws, bodySorted.slice(used), row);

    (ws.columns || []).forEach((col) => {
      let max = 8;
      col.eachCell?.({ includeEmpty: false }, (cell) => {
        const longest = String(cell.value instanceof Date ? 'yyyy-mm-dd' : cell.value ?? '').split('\n').reduce((n, l) => Math.max(n, l.length), 0);
        max = Math.max(max, longest + 2);
      });
      col.width = Math.min(60, max);
    });
  }
  return new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}
