// Page layout tools: crop, several pages per sheet (n-up), booklet, headers and footers.
import { PDFDocument, PDFName, PDFPage, StandardFonts, degrees, rgb } from 'pdf-lib';
import { hexToRgb01, winAnsiSafe } from './util';
import { parseRanges } from './ops';

const load = (b: Uint8Array) => PDFDocument.load(b, { updateMetadata: false });
const save = (d: PDFDocument) => d.save({ useObjectStreams: true });

/** Which pages (zero-based) a "pages" box means: empty = all, or ranges like "1-3, 7", or "odd" / "even". */
export function pickPages(spec: string | undefined, n: number): number[] {
  const s = (spec || '').trim().toLowerCase();
  const all = Array.from({ length: n }, (_, i) => i);
  if (!s || s === 'all') return all;
  if (s === 'odd') return all.filter((i) => i % 2 === 0);
  if (s === 'even') return all.filter((i) => i % 2 === 1);
  return [...new Set(parseRanges(s, n).flat())].sort((a, b) => a - b);
}

// ---------------------------------------------------------------- crop
export interface CropMargins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Margins as the reader sees the page (rotation included) turned into the page's own, unrotated edges. */
function toPageEdges(m: CropMargins, rot: number): CropMargins {
  switch (((rot % 360) + 360) % 360) {
    case 90: return { top: m.right, right: m.bottom, bottom: m.left, left: m.top };
    case 180: return { top: m.bottom, right: m.left, bottom: m.top, left: m.right };
    case 270: return { top: m.left, right: m.top, bottom: m.right, left: m.bottom };
    default: return m;
  }
}

/**
 * Cuts margins off the visible page by setting its crop box. Nothing is deleted from the file, so a later
 * "Reset" brings the page back; use Redact for anything that has to be gone for good.
 */
export async function cropPages(bytes: Uint8Array, pages: number[], m: CropMargins) {
  const doc = await load(bytes);
  for (const i of pages) {
    const p = doc.getPage(i);
    const media = p.getMediaBox();
    const cur = p.getCropBox();
    const e = toPageEdges(m, p.getRotation().angle);
    const x = cur.x + e.left;
    const y = cur.y + e.bottom;
    const w = cur.width - e.left - e.right;
    const h = cur.height - e.top - e.bottom;
    if (w < 20 || h < 20) throw new Error(`Page ${i + 1}: those margins would leave almost nothing of the page.`);
    p.setCropBox(Math.max(media.x, x), Math.max(media.y, y), w, h);
  }
  return save(doc);
}

/** Puts every chosen page back to its full size. */
export async function resetCrop(bytes: Uint8Array, pages: number[]) {
  const doc = await load(bytes);
  for (const i of pages) {
    const p = doc.getPage(i);
    const m = p.getMediaBox();
    p.setCropBox(m.x, m.y, m.width, m.height);
  }
  return save(doc);
}

// ---------------------------------------------------------------- imposition
export interface SheetOpts {
  /** sheet size in points, portrait; swapped when `landscape` */
  size: [number, number] | 'first';
  landscape: boolean;
  margin: number;
  gap: number;
  border: boolean;
}

/**
 * Lays source pages out on new sheets. `sheets[k][c]` is the source page (zero-based) for cell c of sheet k,
 * or null for an empty cell. Cells fill left to right, top to bottom.
 */
export async function imposePages(bytes: Uint8Array, sheets: (number | null)[][], cols: number, rows: number, o: SheetOpts) {
  const src = await load(bytes);
  const out = await PDFDocument.create();
  const first = src.getPage(0);
  const base: [number, number] = o.size === 'first' ? [first.getWidth(), first.getHeight()] : o.size;
  const [sw, sh] = o.landscape ? [Math.max(...base), Math.min(...base)] : [Math.min(...base), Math.max(...base)];
  const used = [...new Set(sheets.flat().filter((x): x is number => x !== null))];
  const emb = new Map<number, Awaited<ReturnType<PDFDocument['embedPage']>>>();
  // a page with no content at all (an inserted blank page) cannot be embedded: give it an empty one
  for (const i of used) {
    const node = src.getPage(i).node;
    if (!node.Contents()) node.set(PDFName.of('Contents'), src.context.register(src.context.stream('')));
  }
  const boxes = used.map((i) => {
    const b = src.getPage(i).getCropBox();
    return { left: b.x, bottom: b.y, right: b.x + b.width, top: b.y + b.height };
  });
  const embedded = await out.embedPages(used.map((i) => src.getPage(i)), boxes);
  used.forEach((i, k) => emb.set(i, embedded[k]));

  const cw = (sw - 2 * o.margin - (cols - 1) * o.gap) / cols;
  const ch = (sh - 2 * o.margin - (rows - 1) * o.gap) / rows;
  for (const cells of sheets) {
    const page = out.addPage([sw, sh]);
    cells.forEach((idx, c) => {
      if (idx === null) return;
      const ep = emb.get(idx)!;
      const rot = ((src.getPage(idx).getRotation().angle % 360) + 360) % 360;
      const vw = rot % 180 ? ep.height : ep.width; // size as the reader sees it
      const vh = rot % 180 ? ep.width : ep.height;
      const s = Math.min(cw / vw, ch / vh);
      const col = c % cols;
      const row = Math.floor(c / cols);
      const X = o.margin + col * (cw + o.gap) + (cw - vw * s) / 2;
      const Y = sh - o.margin - (row + 1) * ch - row * o.gap + (ch - vh * s) / 2;
      // pdf-lib turns counter-clockwise around the embedded page's own origin; shift so the turned page sits at (X, Y)
      const origin = rot === 90 ? { x: X, y: Y + ep.width * s } : rot === 180 ? { x: X + ep.width * s, y: Y + ep.height * s } : rot === 270 ? { x: X + ep.height * s, y: Y } : { x: X, y: Y };
      page.drawPage(ep, { x: origin.x, y: origin.y, xScale: s, yScale: s, rotate: degrees(-rot) });
      if (o.border) page.drawRectangle({ x: X, y: Y, width: vw * s, height: vh * s, borderColor: rgb(0.55, 0.55, 0.55), borderWidth: 0.5 });
    });
  }
  return save(out);
}

/** Sheet plan for "N pages per sheet", reading across then down. */
export function nUpPlan(pageCount: number, perSheet: number): (number | null)[][] {
  const sheets: (number | null)[][] = [];
  for (let i = 0; i < pageCount; i += perSheet) sheets.push(Array.from({ length: perSheet }, (_, k) => (i + k < pageCount ? i + k : null)));
  return sheets;
}

/**
 * Sheet plan for a saddle-stitched booklet: print double-sided, fold the stack in half and staple the fold.
 * Sheet sides alternate front, back; each side holds two pages. Missing pages at the end are left blank.
 */
export function bookletPlan(pageCount: number, rightToLeft = false): (number | null)[][] {
  const n = Math.ceil(pageCount / 4) * 4;
  const real = (i: number) => (i < pageCount ? i : null);
  const sides: (number | null)[][] = [];
  for (let k = 0; k < n / 4; k++) {
    sides.push([real(n - 1 - 2 * k), real(2 * k)]); // front: last page left, first page right
    sides.push([real(2 * k + 1), real(n - 2 - 2 * k)]); // back
  }
  return rightToLeft ? sides.map((s) => [s[1], s[0]]) : sides;
}

export const PAPER: Record<string, [number, number]> = { A4: [595.28, 841.89], A3: [841.89, 1190.55], Letter: [612, 792], Legal: [612, 1008] };

// ---------------------------------------------------------------- headers and footers
export interface HFRow {
  left: string;
  center: string;
  right: string;
}
export interface HFOpts {
  header: HFRow;
  footer: HFRow;
  size: number;
  color: string;
  bold?: boolean;
  /** distance from the page edge to the text, in points */
  margin: number;
  /** first number to use for {n} */
  start: number;
  /** "" = all pages, or ranges / odd / even */
  pages?: string;
  skipFirst?: boolean;
  /** values for {file}, {title}, {date}, {time} */
  context: { file: string; title: string; date: string; time: string };
  /** an installed font that covers the characters used (see resolveNumbers) */
  fontBytes?: Uint8Array | null;
}

export function fillTokens(t: string, n: number, total: number, c: HFOpts['context']): string {
  return t
    .replace(/\{n:(\d+)\}/g, (_, d) => String(n).padStart(+d, '0'))
    .replace(/\{n\}/g, String(n))
    .replace(/\{total\}/g, String(total))
    .replace(/\{date\}/g, c.date)
    .replace(/\{time\}/g, c.time)
    .replace(/\{file\}/g, c.file)
    .replace(/\{title\}/g, c.title);
}

export async function headersFooters(bytes: Uint8Array, o: HFOpts) {
  const doc = await load(bytes);
  let font: Awaited<ReturnType<PDFDocument['embedFont']>>;
  let have: Set<number> | null = null;
  if (o.fontBytes) {
    doc.registerFontkit((await import('@pdf-lib/fontkit')).default);
    font = await doc.embedFont(o.fontBytes, { subset: true });
    have = new Set(font.getCharacterSet());
  } else font = await doc.embedFont(o.bold ? StandardFonts.HelveticaBold : StandardFonts.Helvetica);
  const pages = doc.getPages();
  const targets = new Set(pickPages(o.pages, pages.length));
  const color = rgb(...hexToRgb01(o.color));
  const total = pages.length + o.start - 1;
  pages.forEach((page: PDFPage, i) => {
    if (!targets.has(i) || (o.skipFirst && i === 0)) return;
    const n = o.start + i;
    const box = page.getCropBox();
    const rot = ((page.getRotation().angle % 360) + 360) % 360;
    const vw = rot % 180 ? box.height : box.width; // the page as the reader sees it
    // visual coordinates (origin bottom-left of what is shown) back to the page's own, unrotated ones
    const place = (vx: number, vy: number) =>
      rot === 90 ? { x: box.x + box.width - vy, y: box.y + vx }
      : rot === 180 ? { x: box.x + box.width - vx, y: box.y + box.height - vy }
      : rot === 270 ? { x: box.x + vy, y: box.y + box.height - vx }
      : { x: box.x + vx, y: box.y + vy };
    const vh = rot % 180 ? box.width : box.height;
    const draw = (row: HFRow, top: boolean) => {
      for (const side of ['left', 'center', 'right'] as const) {
        const raw = fillTokens(row[side], n, total, o.context);
        if (!raw.trim()) continue;
        const text = have ? [...raw].map((ch) => (have!.has(ch.codePointAt(0)!) ? ch : '?')).join('') : winAnsiSafe(raw);
        const tw = font.widthOfTextAtSize(text, o.size);
        const vx = side === 'left' ? o.margin : side === 'right' ? vw - o.margin - tw : (vw - tw) / 2;
        const vy = top ? vh - o.margin - o.size * 0.8 : o.margin;
        const at = place(vx, vy);
        page.drawText(text, { x: at.x, y: at.y, size: o.size, font, color, rotate: degrees(rot) });
      }
    };
    draw(o.header, true);
    draw(o.footer, false);
  });
  return save(doc);
}
