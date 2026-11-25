// Layout analysis shared by PDF -> Word / Excel / PowerPoint. Pure functions, no browser APIs.
// Coordinates are page units with the origin at the top-left (y grows downward).

export interface Run {
  str: string;
  x: number;
  /** baseline */
  y: number;
  w: number;
  size: number;
  bold: boolean;
  italic: boolean;
  font: string;
}

/** A ruling line. For a horizontal line `at` is y and a..b is x; for a vertical line `at` is x and a..b is y. */
export interface Seg {
  at: number;
  a: number;
  b: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PageData {
  w: number;
  h: number;
  runs: Run[];
  hlines: Seg[];
  vlines: Seg[];
  images: Box[];
}

export interface Cell {
  r: number;
  c: number;
  rowSpan: number;
  colSpan: number;
  box: Box;
  runs: Run[];
}

export interface Table {
  box: Box;
  rows: number[]; // y edges, top to bottom
  cols: number[]; // x edges, left to right
  cells: Cell[];
}

export const median = (a: number[]) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// ---------------------------------------------------------------- lines and text

export function groupLines(runs: Run[]): Run[][] {
  const sorted = [...runs].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: Run[][] = [];
  for (const it of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last[0].y - it.y) < Math.max(2, it.size * 0.35)) last.push(it);
    else lines.push([it]);
  }
  return lines.map((l) => l.sort((a, b) => a.x - b.x));
}

export interface Piece {
  text: string;
  size: number;
  bold: boolean;
  italic: boolean;
  font: string;
  /** true when the gap before this piece is wide enough to be a tab */
  tabBefore?: boolean;
}

/** A line as styled pieces: neighbouring runs with the same look are merged, gaps become spaces or tabs. */
export function linePieces(line: Run[]): Piece[] {
  const out: Piece[] = [];
  let prevEnd = -1;
  for (const r of line) {
    let lead = '';
    let tab = false;
    if (prevEnd >= 0) {
      const gap = r.x - prevEnd;
      if (gap > r.size * 2.2) tab = true;
      else if (gap > r.size * 0.18) lead = ' ';
    }
    const last = out[out.length - 1];
    const same = last && !tab && last.bold === r.bold && last.italic === r.italic && last.font === r.font && Math.abs(last.size - r.size) < 0.6;
    if (same) last.text += lead + r.str;
    else out.push({ text: (lead && last && !tab ? lead : '') + r.str, size: r.size, bold: r.bold, italic: r.italic, font: r.font, tabBefore: tab });
    prevEnd = r.x + r.w;
  }
  return out;
}

export const lineText = (line: Run[]) => linePieces(line).map((p) => (p.tabBefore ? '\t' : '') + p.text).join('');

/** A line split wherever the gap is wide enough to be a column or tab stop, so each piece gets its own box. */
export function lineSegments(line: Run[]): Run[][] {
  const out: Run[][] = [];
  for (const r of line) {
    const seg = out[out.length - 1];
    const last = seg?.[seg.length - 1];
    if (seg && last && r.x - (last.x + last.w) <= r.size * 2.2) seg.push(r);
    else out.push([r]);
  }
  return out;
}

// ---------------------------------------------------------------- reading order (XY-cut)

function gapIn(items: { lo: number; hi: number }[], minGap: number): number | null {
  const s = [...items].sort((a, b) => a.lo - b.lo);
  let reach = s[0].hi;
  let best: { at: number; width: number } | null = null;
  for (let i = 1; i < s.length; i++) {
    if (s[i].lo - reach >= minGap && (!best || s[i].lo - reach > best.width)) best = { at: (reach + s[i].lo) / 2, width: s[i].lo - reach };
    reach = Math.max(reach, s[i].hi);
  }
  return best ? best.at : null;
}

/** Splits a page's text into blocks in reading order: headers first, then column by column. */
export function readingBlocks(runs: Run[], depth = 0): Run[][] {
  if (runs.length < 4 || depth > 8) return [runs];
  const sz = median(runs.map((r) => r.size)) || 10;
  // 1) a horizontal band with nothing in it separates stacked blocks
  const yAt = gapIn(runs.map((r) => ({ lo: r.y - r.size * 0.9, hi: r.y + r.size * 0.3 })), sz * 1.9);
  if (yAt !== null) {
    const top = runs.filter((r) => r.y < yAt);
    const bottom = runs.filter((r) => r.y >= yAt);
    if (top.length && bottom.length) return [...readingBlocks(top, depth + 1), ...readingBlocks(bottom, depth + 1)];
  }
  // 2) a vertical band that runs the whole height separates columns (needs several lines on both sides,
  //    so a label/value pair on one line is not mistaken for two columns)
  const xAt = gapIn(runs.map((r) => ({ lo: r.x, hi: r.x + r.w })), Math.max(sz * 2.2, 18));
  if (xAt !== null) {
    const left = runs.filter((r) => r.x + r.w / 2 < xAt);
    const right = runs.filter((r) => r.x + r.w / 2 >= xAt);
    const lines = (a: Run[]) => new Set(a.map((r) => Math.round(r.y / Math.max(2, sz * 0.4)))).size;
    if (lines(left) >= 3 && lines(right) >= 3) return [...readingBlocks(left, depth + 1), ...readingBlocks(right, depth + 1)];
  }
  return [runs];
}

// ---------------------------------------------------------------- paragraphs

export interface Para {
  lines: Run[][];
  /** left edge of the first line */
  x: number;
  y: number;
  right: number;
  size: number;
  bold: boolean;
  align: 'left' | 'center' | 'right';
  /** "•", "1." and so on when the paragraph starts like a list item */
  bullet?: string;
}

const BULLET = /^\s*([•●○▪■◦·\-–—*]|\(?\d{1,3}[.)]|\(?[a-zA-Z][.)])\s+/;

export function paragraphs(block: Run[]): Para[] {
  if (!block.length) return [];
  const lines = groupLines(block);
  const bl = Math.min(...block.map((r) => r.x));
  const br = Math.max(...block.map((r) => r.x + r.w));
  const width = Math.max(1, br - bl);
  const out: Para[] = [];
  let cur: Run[][] = [];
  const size = (l: Run[]) => Math.max(...l.map((r) => r.size));
  const close = () => {
    if (!cur.length) return;
    const first = cur[0];
    const x = first[0].x;
    const right = Math.max(...cur.map((l) => l[l.length - 1].x + l[l.length - 1].w));
    const sz = size(first);
    let align: Para['align'] = 'left';
    if (cur.length === 1) {
      const mid = (x + right) / 2;
      if (Math.abs(mid - (bl + br) / 2) < width * 0.04 && x - bl > width * 0.08) align = 'center';
      else if (br - right < width * 0.02 && x - bl > width * 0.3) align = 'right';
    }
    const t = lineText(first);
    const m = BULLET.exec(t);
    out.push({
      lines: cur,
      x,
      y: first[0].y,
      right,
      size: sz,
      bold: first.every((r) => r.bold),
      align,
      bullet: m && t.length > m[0].length ? m[1] : undefined,
    });
    cur = [];
  };
  for (const line of lines) {
    const prev = cur[cur.length - 1];
    if (prev) {
      const gap = line[0].y - prev[0].y;
      const sz = size(line);
      const startsBullet = BULLET.test(lineText(line));
      if (gap > sz * 1.55 || Math.abs(sz - size(prev)) > 1.2 || startsBullet || (line[0].x - prev[0].x > sz * 3 && gap > sz * 1.1)) close();
    }
    cur.push(line);
  }
  close();
  return out;
}

// ---------------------------------------------------------------- ruling lines -> tables

/** Joins ruling segments on the same line that touch or overlap. */
export function mergeSegs(segs: Seg[], tol = 1.6, gap = 3): Seg[] {
  const s = segs.filter((g) => g.b - g.a >= 3).sort((p, q) => p.at - q.at || p.a - q.a);
  const out: Seg[] = [];
  for (const g of s) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.at - g.at) <= tol && g.a <= last.b + gap) {
      last.at = (last.at + g.at) / 2;
      last.b = Math.max(last.b, g.b);
    } else out.push({ ...g });
  }
  return out;
}

const cluster = (vals: number[], tol: number) => {
  const s = [...vals].sort((a, b) => a - b);
  const out: number[][] = [];
  for (const v of s) {
    const last = out[out.length - 1];
    if (last && v - last[last.length - 1] <= tol) last.push(v);
    else out.push([v]);
  }
  return out.map((g) => g.reduce((a, b) => a + b, 0) / g.length);
};

/** Tables from lines: lines that cross each other form a grid; cells whose dividing line is missing are merged. */
export function detectTables(hlines: Seg[], vlines: Seg[]): Table[] {
  const H = mergeSegs(hlines);
  const V = mergeSegs(vlines);
  const tol = 2.5;
  const parent = [...H, ...V].map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  H.forEach((h, i) =>
    V.forEach((v, j) => {
      if (v.at >= h.a - tol && v.at <= h.b + tol && h.at >= v.a - tol && h.at <= v.b + tol) parent[find(i)] = find(H.length + j);
    }),
  );
  const groups = new Map<number, { h: Seg[]; v: Seg[] }>();
  H.forEach((h, i) => {
    const k = find(i);
    (groups.get(k) || groups.set(k, { h: [], v: [] }).get(k)!).h.push(h);
  });
  V.forEach((v, j) => {
    const k = find(H.length + j);
    (groups.get(k) || groups.set(k, { h: [], v: [] }).get(k)!).v.push(v);
  });

  const tables: Table[] = [];
  for (const { h, v } of groups.values()) {
    const rows = cluster(h.map((s) => s.at), 2.5);
    const cols = cluster(v.map((s) => s.at), 2.5);
    if (rows.length < 2 || cols.length < 2 || (rows.length === 2 && cols.length === 2)) continue;
    if (rows.length > 120 || cols.length > 40) continue;

    const covers = (segs: Seg[], at: number, lo: number, hi: number) => {
      // is there a line near `at` covering most of lo..hi?
      let cov = 0;
      for (const s of segs) if (Math.abs(s.at - at) <= 2.5) cov += Math.max(0, Math.min(hi, s.b + 2) - Math.max(lo, s.a - 2));
      return cov >= (hi - lo) * 0.7;
    };
    const used = rows.slice(1).map(() => cols.slice(1).map(() => false));
    const cells: Cell[] = [];
    for (let r = 0; r < rows.length - 1; r++)
      for (let c = 0; c < cols.length - 1; c++) {
        if (used[r][c]) continue;
        let cs = 1, rs = 1;
        while (c + cs < cols.length - 1 && !covers(v, cols[c + cs], rows[r] + 1, rows[r + 1] - 1)) cs++;
        while (r + rs < rows.length - 1 && !covers(h, rows[r + rs], cols[c] + 1, cols[c + 1] - 1)) rs++;
        for (let i = r; i < r + rs; i++) for (let j = c; j < c + cs; j++) used[i][j] = true;
        cells.push({ r, c, rowSpan: rs, colSpan: cs, box: { x: cols[c], y: rows[r], w: cols[c + cs] - cols[c], h: rows[r + rs] - rows[r] }, runs: [] });
      }
    tables.push({ box: { x: cols[0], y: rows[0], w: cols[cols.length - 1] - cols[0], h: rows[rows.length - 1] - rows[0] }, rows, cols, cells });
  }
  return tables.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
}

/** Puts each text run into the table cell it sits in. Returns the runs that belong to no table. */
export function fillTables(tables: Table[], runs: Run[]): Run[] {
  const rest: Run[] = [];
  for (const run of runs) {
    const cx = run.x + run.w / 2;
    const cy = run.y - run.size * 0.3;
    let hit: Cell | null = null;
    for (const t of tables) {
      if (cx < t.box.x || cx > t.box.x + t.box.w || cy < t.box.y || cy > t.box.y + t.box.h) continue;
      hit = t.cells.find((c) => cx >= c.box.x && cx <= c.box.x + c.box.w && cy >= c.box.y && cy <= c.box.y + c.box.h) || null;
      if (hit) break;
    }
    if (hit) hit.runs.push(run);
    else rest.push(run);
  }
  return rest;
}

/** Text of a table cell, lines joined with newlines. */
export const cellText = (c: Cell) => groupLines(c.runs).map(lineText).join('\n').trim();

// ---------------------------------------------------------------- spreadsheet values

export type CellValue = { kind: 'text'; v: string } | { kind: 'number'; v: number; fmt?: string } | { kind: 'date'; v: Date; fmt: string };

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Numbers, money, percentages and dates become real spreadsheet values; ids, phone numbers and codes stay text. */
export function parseCell(raw: string): CellValue {
  const s = raw.trim();
  if (!s) return { kind: 'text', v: '' };
  // money: ₱ $ € £ PHP USD, optional minus or (brackets)
  let m = /^(\(|-)?\s*(₱|\$|€|£|PHP|USD|P)?\s*(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s*(\))?$/i.exec(s);
  if (m && !(m[2] === 'P' && !m[4] && !m[3].includes(','))) {
    const digits = m[3].replace(/,/g, '') + (m[4] || '');
    // a long digit run, or one with a leading zero and no separators, is an identifier, not an amount
    const idLike = !m[2] && !m[3].includes(',') && !m[4] && (digits.length >= 10 || (digits.length > 1 && digits.startsWith('0')));
    if (!idLike && !(m[1] === '(' && m[5] !== ')')) {
      const n = Number(digits) * (m[1] ? -1 : 1);
      const money = !!m[2];
      const dec = (m[4] || '').length > 1 ? '.' + '0'.repeat(m[4]!.length - 1) : '';
      const symbols: Record<string, string> = { '₱': '₱', $: '$', '€': '€', '£': '£', PHP: '₱', P: '₱', USD: '$' };
      const sym = m[2] ? symbols[m[2].toUpperCase()] ?? m[2] : '';
      return { kind: 'number', v: n, fmt: money ? `"${sym}"#,##0${dec}` : m[3].includes(',') || dec ? `#,##0${dec}` : undefined };
    }
  }
  m = /^(-?\d+(?:\.\d+)?)\s*%$/.exec(s);
  if (m) return { kind: 'number', v: Number(m[1]) / 100, fmt: '0.##%' };
  // dates: 2026-11-25, 11/25/2026, 25 Nov 2026, Nov 25, 2026
  let d: Date | null = null;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) d = +m[1] > 12 ? new Date(Date.UTC(+m[3], +m[2] - 1, +m[1])) : new Date(Date.UTC(+m[3], +m[1] - 1, +m[2]));
  else if ((m = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(s)) && MONTHS.includes(m[2].slice(0, 3).toLowerCase())) d = new Date(Date.UTC(+m[3], MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()), +m[1]));
  else if ((m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s)) && MONTHS.includes(m[1].slice(0, 3).toLowerCase())) d = new Date(Date.UTC(+m[3], MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()), +m[2]));
  if (d && !Number.isNaN(d.getTime()) && d.getUTCFullYear() > 1899 && d.getUTCFullYear() < 2200) return { kind: 'date', v: d, fmt: 'yyyy-mm-dd' };
  return { kind: 'text', v: s };
}
