// PDF -> Word / Excel / PowerPoint, and text -> PDF. Runs fully offline in the app.
import type { PDFDocumentProxy } from './pdf';
const renderToCanvas = async (...args: Parameters<typeof import('./pdf').renderToCanvas>) => (await import('./pdf')).renderToCanvas(...args);
// m1 x m2 for 6-element PDF matrices
const mul = (m1: number[], m2: number[]) => [
  m1[0] * m2[0] + m1[2] * m2[1], m1[1] * m2[0] + m1[3] * m2[1],
  m1[0] * m2[2] + m1[2] * m2[3], m1[1] * m2[2] + m1[3] * m2[3],
  m1[0] * m2[4] + m1[2] * m2[5] + m1[4], m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
];
import { blobToBytes } from './util';

interface Item {
  str: string;
  x: number;
  y: number; // baseline, top-down
  w: number;
  size: number;
  bold: boolean;
}

async function pageItems(pdf: PDFDocumentProxy, i: number) {
  const page = await pdf.getPage(i);
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const items: Item[] = [];
  for (const it of tc.items as any[]) {
    if (!it.str || !it.str.trim()) continue;
    const tx = mul(vp.transform, it.transform);
    const style = (tc.styles as any)[it.fontName] || {};
    items.push({
      str: it.str,
      x: tx[4],
      y: tx[5],
      w: it.width,
      size: Math.hypot(tx[2], tx[3]),
      bold: /bold|black|heavy/i.test(`${it.fontName} ${style.fontFamily || ''}`),
    });
  }
  return { page, vp, items };
}

function groupLines(items: Item[]) {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: Item[][] = [];
  for (const it of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last[0].y - it.y) < Math.max(2, it.size * 0.35)) last.push(it);
    else lines.push([it]);
  }
  return lines.map((l) => l.sort((a, b) => a.x - b.x));
}

function lineText(line: Item[]) {
  let s = '';
  let prevEnd = -1;
  for (const it of line) {
    if (prevEnd >= 0 && it.x - prevEnd > it.size * 0.2 && !s.endsWith(' ')) s += it.x - prevEnd > it.size * 2 ? '\t' : ' ';
    s += it.str;
    prevEnd = it.x + it.w;
  }
  return s;
}

/** PDF -> .docx. mode 'text' = editable reflowed text; 'exact' = page images (looks identical). */
export async function pdfToDocx(pdf: PDFDocumentProxy, mode: 'text' | 'exact', onProgress: (i: number, n: number) => void) {
  const { Document, Packer, Paragraph, TextRun, ImageRun, PageBreak } = await import('docx');
  const first = (await pdf.getPage(1)).getViewport({ scale: 1 });
  const children: any[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    onProgress(i, pdf.numPages);
    if (mode === 'exact') {
      const page = await pdf.getPage(i);
      const canvas = await renderToCanvas(page, 2);
      const png = await blobToBytes(await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), 'image/png')));
      const vp = page.getViewport({ scale: 1 });
      const maxW = first.width - 72; // fit within margins (pt ≈ px at 72dpi here)
      const s = Math.min(1, maxW / vp.width);
      children.push(
        new Paragraph({
          children: [new ImageRun({ type: 'png', data: png, transformation: { width: vp.width * s * 1.333, height: vp.height * s * 1.333 } })],
          ...(i < pdf.numPages ? {} : {}),
        }),
      );
      canvas.width = canvas.height = 0;
    } else {
      const { items } = await pageItems(pdf, i);
      const lines = groupLines(items);
      let prev: Item[] | null = null;
      let buf: { text: string; size: number; bold: boolean }[] = [];
      const flush = () => {
        if (!buf.length) return;
        const size = Math.round(buf[0].size * 2) || 22;
        children.push(
          new Paragraph({
            spacing: { after: 120 },
            children: buf.map((b, k) => new TextRun({ text: (k ? ' ' : '') + b.text, size, bold: b.bold })),
          }),
        );
        buf = [];
      };
      for (const line of lines) {
        const gap = prev ? line[0].y - prev[0].y : 0;
        const size = Math.max(...line.map((x) => x.size));
        // new paragraph when there's extra vertical space, a size change, or an indent jump
        if (prev && (gap > size * 1.7 || Math.abs(size - Math.max(...prev.map((x) => x.size))) > 1 || Math.abs(line[0].x - prev[0].x) > 30)) flush();
        buf.push({ text: lineText(line), size, bold: line.every((x) => x.bold) });
        prev = line;
      }
      flush();
    }
    if (i < pdf.numPages) children.push(new Paragraph({ children: [new PageBreak()] }));
  }
  const doc = new Document({
    creator: 'Acrobatics',
    sections: [
      {
        properties: {
          page: {
            size: { width: Math.round(first.width * 20), height: Math.round(first.height * 20) },
            margin: { top: 720, bottom: 720, left: 720, right: 720 },
          },
        },
        children,
      },
    ],
  });
  return blobToBytes(await Packer.toBlob(doc));
}

/** PDF -> .xlsx — reconstructs table rows/columns from text positions (one sheet per page). */
export async function pdfToXlsx(pdf: PDFDocumentProxy, onProgress: (i: number, n: number) => void) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Acrobatics';
  for (let i = 1; i <= pdf.numPages; i++) {
    onProgress(i, pdf.numPages);
    const { items } = await pageItems(pdf, i);
    const ws = wb.addWorksheet(`Page ${i}`);
    if (!items.length) continue;
    // column anchors = clustered left edges
    const xs = [...new Set(items.map((it) => Math.round(it.x)))].sort((a, b) => a - b);
    const anchors: number[] = [];
    for (const x of xs) if (!anchors.length || x - anchors[anchors.length - 1] > 12) anchors.push(x);
    const colOf = (x: number) => {
      let c = 0;
      for (let k = 0; k < anchors.length; k++) if (anchors[k] <= x + 4) c = k;
      return c;
    };
    groupLines(items).forEach((line, r) => {
      const cells: string[] = [];
      for (const it of line) {
        const c = colOf(it.x);
        cells[c] = cells[c] ? `${cells[c]} ${it.str}`.trim() : it.str.trim();
      }
      const row = ws.getRow(r + 1);
      cells.forEach((v, c) => {
        if (v === undefined) return;
        const num = /^-?[\d,]+(\.\d+)?$/.test(v) && /\d/.test(v) ? Number(v.replace(/,/g, '')) : NaN;
        row.getCell(c + 1).value = Number.isFinite(num) ? num : v;
        if (line.every((x) => x.bold)) row.getCell(c + 1).font = { bold: true };
      });
    });
    ws.columns.forEach((col) => {
      let max = 8;
      col.eachCell?.({ includeEmpty: false }, (cell) => (max = Math.max(max, String(cell.value ?? '').length + 2)));
      col.width = Math.min(60, max);
    });
  }
  return new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}

/** PDF -> .pptx — each page becomes a full-bleed slide. */
export async function pdfToPptx(pdf: PDFDocumentProxy, onProgress: (i: number, n: number) => void) {
  const PptxGenJS = (await import('pptxgenjs')).default;
  const pres = new PptxGenJS();
  const first = (await pdf.getPage(1)).getViewport({ scale: 1 });
  const W = 10;
  const H = (first.height / first.width) * W;
  pres.defineLayout({ name: 'PDF', width: W, height: H });
  pres.layout = 'PDF';
  for (let i = 1; i <= pdf.numPages; i++) {
    onProgress(i, pdf.numPages);
    const canvas = await renderToCanvas(await pdf.getPage(i), 2);
    pres.addSlide().addImage({ data: canvas.toDataURL('image/jpeg', 0.9), x: 0, y: 0, w: W, h: H });
    canvas.width = canvas.height = 0;
  }
  return (await pres.write({ outputType: 'uint8array' })) as Uint8Array;
}

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

/** Plain text / Markdown-ish -> PDF via Chromium printing. */
export async function textToPdf(text: string, name: string) {
  const body = text
    .split(/\n{2,}/)
    .map((block) => {
      const h = block.match(/^(#{1,3})\s+(.*)$/);
      if (h) return `<h${h[1].length}>${esc(h[2])}</h${h[1].length}>`;
      return `<p>${esc(block).replace(/\n/g, '<br>')}</p>`;
    })
    .join('\n');
  const html = `<!doctype html><meta charset="utf-8"><style>
    body{font:11pt/1.5 'Segoe UI',Arial,sans-serif;color:#111;margin:0}
    h1{font-size:20pt}h2{font-size:16pt}h3{font-size:13pt}p{margin:0 0 10pt;white-space:pre-wrap}
  </style>${body}`;
  return window.acro.htmlToPdf(html, name);
}
