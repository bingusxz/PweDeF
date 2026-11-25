// PDF -> .docx in three flavours, like Acrobat's:
//  flow:   editable reflowed document: paragraphs with their fonts, real Word tables, pictures, columns in reading order
//  layout: the page without its text as a backdrop, with every line of text on top as an editable text frame,
//          so it looks like the PDF and the words can still be edited
//  exact:  each page as a picture (identical look, not editable)
import type { PDFDocumentProxy } from './pdf';
import { extractPage, type PdfJsLib } from './pdfExtract';
import {
  detectTables,
  fillTables,
  groupLines,
  lineSegments,
  linePieces,
  median,
  paragraphs,
  readingBlocks,
  type Box,
  type Para,
  type Piece,
  type Run,
  type Table,
} from './pdfLayout';
import { textColorOn, textFreePdf } from './textFree';
import { blobToBytes } from './util';

export type WordMode = 'flow' | 'layout' | 'exact';

const TW = 20; // twips per point
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const canvasBytes = async (c: HTMLCanvasElement, type: 'png' | 'jpeg', q = 0.9) => blobToBytes(await new Promise<Blob>((r) => c.toBlob((b) => r(b!), `image/${type}`, q)));

export async function pdfToDocx(pdf: PDFDocumentProxy, pdfjs: PdfJsLib, mode: WordMode, onProgress: (i: number, n: number) => void) {
  const D = await import('docx');
  // browser-only helpers load on demand, so plain flowing text can be built (and tested) without them
  const lazy = () => import('./pdf');
  const renderToCanvas = async (...a: Parameters<Awaited<ReturnType<typeof lazy>>['renderToCanvas']>) => (await lazy()).renderToCanvas(...a);
  const loadPdf = async (...a: Parameters<Awaited<ReturnType<typeof lazy>>['loadPdf']>) => (await lazy()).loadPdf(...a);
  const first = (await pdf.getPage(1)).getViewport({ scale: 1 });

  const runsOf = (pieces: Piece[], color?: string) =>
    pieces.map(
      (p) =>
        new D.TextRun({
          ...(p.tabBefore ? { children: [new D.Tab(), p.text] } : { text: p.text }),
          font: p.font,
          size: Math.max(2, Math.round(p.size * 2)),
          bold: p.bold,
          italics: p.italic,
          ...(color ? { color } : {}),
        }),
    );

  // ---------------------------------------------------------------- exact: a picture per page
  if (mode === 'exact') {
    const children: any[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      onProgress(i, pdf.numPages);
      const page = await pdf.getPage(i);
      const canvas = await renderToCanvas(page, 2);
      const vp = page.getViewport({ scale: 1 });
      const s = Math.min(1, (first.width - 72) / vp.width);
      children.push(new D.Paragraph({ children: [new D.ImageRun({ type: 'png', data: await canvasBytes(canvas, 'png'), transformation: { width: vp.width * s * 1.333, height: vp.height * s * 1.333 } })] }));
      if (i < pdf.numPages) children.push(new D.Paragraph({ children: [new D.PageBreak()] }));
      canvas.width = canvas.height = 0;
    }
    return blobToBytes(await D.Packer.toBlob(new D.Document({ creator: 'PweDeF', sections: [{ properties: { page: { size: { width: Math.round(first.width * TW), height: Math.round(first.height * TW) }, margin: { top: 720, bottom: 720, left: 720, right: 720 } } }, children }] })));
  }

  // ---------------------------------------------------------------- layout: backdrop + text frames
  if (mode === 'layout') {
    const tf = await textFreePdf(await pdf.getData());
    const bg = await loadPdf(tf.bytes);
    const sections: any[] = [];
    const S = 2;
    try {
      for (let i = 1; i <= pdf.numPages; i++) {
        onProgress(i, pdf.numPages);
        const clean = tf.clean[i - 1];
        const data = await extractPage(pdf, i, pdfjs);
        const canvas = await renderToCanvas(clean ? await bg.getPage(i) : await pdf.getPage(i), S);
        const children: any[] = [
          new D.Paragraph({
            spacing: { before: 0, after: 0 },
            children: [
              new D.ImageRun({
                type: 'jpg',
                data: await canvasBytes(canvas, 'jpeg', 0.88),
                transformation: { width: data.w * 1.333, height: data.h * 1.333 },
                floating: {
                  horizontalPosition: { relative: D.HorizontalPositionRelativeFrom.PAGE, offset: 0 },
                  verticalPosition: { relative: D.VerticalPositionRelativeFrom.PAGE, offset: 0 },
                  behindDocument: true,
                  allowOverlap: true,
                  wrap: { type: D.TextWrappingType.NONE },
                },
              }),
            ],
          }),
        ];
        if (clean)
          for (const line of groupLines(data.runs))
            for (const seg of lineSegments(line)) {
              const size = Math.max(...seg.map((r) => r.size));
              const x0 = seg[0].x, x1 = seg[seg.length - 1].x + seg[seg.length - 1].w;
              const top = seg[0].y - size * 0.92;
              const color = textColorOn(canvas, { x: x0, y: top, w: x1 - x0, h: size * 1.2 }, S);
              children.push(
                new D.Paragraph({
                  spacing: { before: 0, after: 0, line: Math.round(size * 1.2 * TW), lineRule: D.LineRuleType.EXACT },
                  frame: {
                    type: 'absolute',
                    position: { x: Math.max(0, Math.round(x0 * TW)), y: Math.max(0, Math.round(top * TW)) },
                    width: Math.round((x1 - x0) * TW * 1.1) + 60,
                    height: Math.round(size * 1.3 * TW),
                    anchor: { horizontal: D.FrameAnchorType.PAGE, vertical: D.FrameAnchorType.PAGE },
                  },
                  children: runsOf(linePieces(seg), color === 'FFFFFF' ? 'FFFFFF' : undefined),
                }),
              );
            }
        sections.push({
          properties: { page: { size: { width: Math.round(data.w * TW), height: Math.round(data.h * TW) }, margin: { top: 0, bottom: 0, left: 0, right: 0, header: 0, footer: 0 } } },
          children,
        });
        canvas.width = canvas.height = 0;
      }
    } finally {
      bg.destroy();
    }
    return blobToBytes(await D.Packer.toBlob(new D.Document({ creator: 'PweDeF', sections })));
  }

  // ---------------------------------------------------------------- flow: paragraphs, tables, pictures
  type Flow = { y: number; make: () => any[] };
  const pages: { w: number; h: number; items: Flow[]; edges: number[] }[] = [];

  const paraNode = (p: Para, bl: number, br: number, pageLeft: number) => {
    const kids: any[] = [];
    const width = Math.max(1, br - bl);
    p.lines.forEach((line, li) => {
      if (li > 0) {
        const prev = p.lines[li - 1];
        const prevRight = prev[prev.length - 1].x + prev[prev.length - 1].w;
        // a line that stops well short of the right edge is a real line break; otherwise the text just wraps
        if (prevRight < br - width * 0.1) kids.push(new D.TextRun({ break: 1 }));
        else kids.push(new D.TextRun({ text: ' ' }));
      }
      kids.push(...runsOf(linePieces(line)));
    });
    return new D.Paragraph({
      children: kids,
      alignment: p.align === 'center' ? D.AlignmentType.CENTER : p.align === 'right' ? D.AlignmentType.RIGHT : D.AlignmentType.LEFT,
      indent: p.align === 'left' ? { left: Math.max(0, Math.round((p.x - pageLeft) * TW)) } : undefined,
      spacing: { after: Math.round(p.size * 0.55 * TW) },
    });
  };

  const tableNode = (t: Table) => {
    const widths = t.cols.slice(1).map((x, i) => Math.round((x - t.cols[i]) * TW));
    const rows: any[] = [];
    for (let r = 0; r < t.rows.length - 1; r++) {
      const cells: any[] = [];
      for (let c = 0; c < t.cols.length - 1; c++) {
        const own = t.cells.find((x) => x.r === r && x.c === c);
        const below = t.cells.find((x) => x.c === c && r > x.r && r < x.r + x.rowSpan);
        const covered = t.cells.find((x) => x.r === r && c > x.c && c < x.c + x.colSpan);
        if (covered) continue;
        const cell = own || below;
        if (!cell) {
          cells.push(new D.TableCell({ width: { size: widths[c], type: D.WidthType.DXA }, children: [new D.Paragraph({})] }));
          continue;
        }
        const lines = own ? groupLines(own.runs) : [];
        cells.push(
          new D.TableCell({
            width: { size: widths.slice(c, c + cell.colSpan).reduce((a, b) => a + b, 0), type: D.WidthType.DXA },
            columnSpan: cell.colSpan > 1 ? cell.colSpan : undefined,
            verticalMerge: cell.rowSpan > 1 ? (own ? D.VerticalMergeType.RESTART : D.VerticalMergeType.CONTINUE) : undefined,
            margins: { top: 40, bottom: 40, left: 80, right: 80 },
            children: lines.length ? lines.map((l) => new D.Paragraph({ children: runsOf(linePieces(l)), spacing: { after: 0 } })) : [new D.Paragraph({})],
          }),
        );
      }
      rows.push(new D.TableRow({ children: cells }));
    }
    return new D.Table({ rows, columnWidths: widths, width: { size: widths.reduce((a, b) => a + b, 0), type: D.WidthType.DXA } });
  };

  for (let i = 1; i <= pdf.numPages; i++) {
    onProgress(i, pdf.numPages);
    const data = await extractPage(pdf, i, pdfjs);
    const tables = detectTables(data.hlines, data.vlines);
    const rest = fillTables(tables, data.runs);
    const blocks = readingBlocks(rest);
    const pageLeft = Math.min(...[...rest.map((r) => r.x), ...tables.map((t) => t.box.x)], data.w);
    const items: Flow[] = [];
    for (const b of blocks) {
      if (!b.length) continue;
      const bl = Math.min(...b.map((r) => r.x)), br = Math.max(...b.map((r) => r.x + r.w));
      for (const p of paragraphs(b)) items.push({ y: p.y, make: () => [paraNode(p, bl, br, pageLeft)] });
    }
    // pictures: crop them out of a rendering of the page. A picture that is the whole page behind real text is skipped.
    const area = data.w * data.h;
    const pics = data.images.filter((b) => !(b.w * b.h > area * 0.8 && data.runs.length > 5));
    const extra: Flow[] = tables.map((t) => ({ y: t.box.y, make: () => [tableNode(t), new D.Paragraph({ spacing: { after: 120 } })] }));
    if (pics.length) {
      const S = 2;
      const canvas = await renderToCanvas(await pdf.getPage(i), S);
      for (const b of pics) {
        const crop = document.createElement('canvas');
        crop.width = Math.max(1, Math.round(b.w * S));
        crop.height = Math.max(1, Math.round(b.h * S));
        crop.getContext('2d')!.drawImage(canvas, Math.round(b.x * S), Math.round(b.y * S), crop.width, crop.height, 0, 0, crop.width, crop.height);
        const bytes = await canvasBytes(crop, 'png');
        const maxW = data.w - 72;
        const sc = Math.min(1, maxW / b.w);
        extra.push({ y: b.y, make: () => [new D.Paragraph({ children: [new D.ImageRun({ type: 'png', data: bytes, transformation: { width: b.w * sc * 1.333, height: b.h * sc * 1.333 } })], spacing: { after: 120 } })] });
        crop.width = crop.height = 0;
      }
      canvas.width = canvas.height = 0;
    }
    // tables and pictures slot in before the first paragraph that starts below them
    for (const e of extra.sort((a, b) => a.y - b.y)) {
      const at = items.findIndex((it) => it.y > e.y);
      items.splice(at < 0 ? items.length : at, 0, e);
    }
    const xs = [...rest.map((r) => r.x), ...tables.map((t) => t.box.x), ...pics.map((b: Box) => b.x)];
    const rights = [...rest.map((r) => r.x + r.w), ...tables.map((t) => t.box.x + t.box.w)];
    const ys = [...rest.map((r) => r.y - r.size), ...tables.map((t) => t.box.y)];
    const bottoms = [...rest.map((r) => r.y), ...tables.map((t) => t.box.y + t.box.h)];
    pages.push({ w: data.w, h: data.h, items, edges: [xs.length ? Math.min(...xs) : 54, rights.length ? data.w - Math.max(...rights) : 54, ys.length ? Math.min(...ys) : 54, bottoms.length ? data.h - Math.max(...bottoms) : 54] });
  }

  const margin = (k: number) => Math.round(clamp(median(pages.map((p) => p.edges[k])), 36, 108) * TW);
  const children: any[] = [];
  pages.forEach((p, pi) => {
    if (pi > 0) children.push(new D.Paragraph({ children: [new D.PageBreak()] }));
    for (const it of p.items) children.push(...it.make());
    if (!p.items.length) children.push(new D.Paragraph({}));
  });
  return blobToBytes(
    await D.Packer.toBlob(
      new D.Document({
        creator: 'PweDeF',
        sections: [{ properties: { page: { size: { width: Math.round(first.width * TW), height: Math.round(first.height * TW) }, margin: { left: margin(0), right: margin(1), top: margin(2), bottom: margin(3) } } }, children }],
      }),
    ),
  );
}

