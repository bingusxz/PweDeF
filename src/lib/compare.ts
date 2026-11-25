// Compare two PDFs: which words were added, removed or changed, and where on the pages.
// Lines are matched first (fast, keeps the order), then the words inside lines that differ.
import { groupLines, type PageData } from './pdfLayout';

export interface Word {
  text: string;
  page: number; // 0-based
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DocLine {
  text: string;
  words: Word[];
}

/** Splits every text run into words with an estimated box (letters are assumed evenly wide inside a run). */
export function docLines(pages: PageData[]): DocLine[] {
  const out: DocLine[] = [];
  pages.forEach((pg, page) => {
    for (const line of groupLines(pg.runs)) {
      const words: Word[] = [];
      for (const r of line) {
        const per = r.w / Math.max(1, r.str.length);
        for (const m of r.str.matchAll(/\S+/g)) {
          words.push({ text: m[0], page, x: r.x + m.index! * per, y: r.y - r.size * 0.9, w: m[0].length * per, h: r.size * 1.2 });
        }
      }
      if (words.length) out.push({ text: words.map((w) => w.text).join(' '), words });
    }
  });
  return out;
}

export type Op = { op: '=' | '-' | '+'; ai: number; bi: number };

/** Shortest edit script between two sequences (Myers O(ND)). Returns null when the sequences differ by more than maxD edits. */
export function myers<T>(a: T[], b: T[], eq: (x: T, y: T) => boolean = (x, y) => x === y, maxD = 3000): Op[] | null {
  const n = a.length, m = b.length;
  const max = Math.min(n + m, maxD);
  const trace: Int32Array[] = [];
  let v = new Int32Array(2 * max + 3);
  const off = max + 1;
  let found = -1;
  for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && eq(a[x], b[y])) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    trace.push(v.slice());
    if (found >= 0) break;
  }
  if (found < 0) return null;
  const ops: Op[] = [];
  let x = n, y = m;
  for (let d = found; d > 0; d--) {
    const vv = trace[d - 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && vv[off + k - 1] < vv[off + k + 1]) ? k + 1 : k - 1;
    const px = vv[off + prevK], py = px - prevK;
    while (x > px && y > py) {
      x--;
      y--;
      ops.push({ op: '=', ai: x, bi: y });
    }
    if (x === px) {
      y--;
      ops.push({ op: '+', ai: x, bi: y });
    } else {
      x--;
      ops.push({ op: '-', ai: x, bi: y });
    }
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    ops.push({ op: '=', ai: x, bi: y });
  }
  return ops.reverse();
}

export interface Change {
  kind: 'added' | 'removed' | 'changed';
  /** the words that were in the first document (empty for 'added') */
  a: Word[];
  /** the words that are in the second document (empty for 'removed') */
  b: Word[];
}

export interface CompareResult {
  changes: Change[];
  wordsA: number;
  wordsB: number;
  /** true when the documents were too different to compare line by line */
  tooDifferent: boolean;
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

export function compareText(a: DocLine[], b: DocLine[]): CompareResult {
  const wordsA = a.reduce((n, l) => n + l.words.length, 0);
  const wordsB = b.reduce((n, l) => n + l.words.length, 0);
  const changes: Change[] = [];
  const push = (aw: Word[], bw: Word[]) => {
    if (!aw.length && !bw.length) return;
    changes.push({ kind: !aw.length ? 'added' : !bw.length ? 'removed' : 'changed', a: aw, b: bw });
  };

  const lineOps = myers(a.map((l) => norm(l.text)), b.map((l) => norm(l.text)), undefined, 4000);
  if (!lineOps) {
    // nothing in common worth lining up: report everything on each side
    push(a.flatMap((l) => l.words), b.flatMap((l) => l.words));
    return { changes, wordsA, wordsB, tooDifferent: true };
  }

  // walk the script; every run of '-' / '+' between matches is a hunk whose words are compared one by one
  let i = 0;
  while (i < lineOps.length) {
    if (lineOps[i].op === '=') {
      i++;
      continue;
    }
    const removed: DocLine[] = [], added: DocLine[] = [];
    while (i < lineOps.length && lineOps[i].op !== '=') {
      if (lineOps[i].op === '-') removed.push(a[lineOps[i].ai]);
      else added.push(b[lineOps[i].bi]);
      i++;
    }
    const wa = removed.flatMap((l) => l.words), wb = added.flatMap((l) => l.words);
    const wordOps = myers(wa.map((w) => w.text), wb.map((w) => w.text), undefined, 6000);
    if (!wordOps) {
      push(wa, wb);
      continue;
    }
    let ra: Word[] = [], rb: Word[] = [];
    for (const o of wordOps) {
      if (o.op === '=') {
        push(ra, rb);
        ra = [];
        rb = [];
      } else if (o.op === '-') ra.push(wa[o.ai]);
      else rb.push(wb[o.bi]);
    }
    push(ra, rb);
  }
  return { changes, wordsA, wordsB, tooDifferent: false };
}

/** One-line summary of a change, for lists and the exported report. */
export const describe = (c: Change) => {
  const t = (w: Word[]) => w.map((x) => x.text).join(' ');
  const clip = (s: string) => (s.length > 140 ? s.slice(0, 137) + '…' : s);
  return c.kind === 'added' ? `Added: ${clip(t(c.b))}` : c.kind === 'removed' ? `Removed: ${clip(t(c.a))}` : `Changed: ${clip(t(c.a))}  →  ${clip(t(c.b))}`;
};

/** Merges the boxes of consecutive words on a page into line-sized highlight boxes. */
export function highlightBoxes(words: Word[]): { page: number; x: number; y: number; w: number; h: number }[] {
  const out: { page: number; x: number; y: number; w: number; h: number }[] = [];
  for (const w of words) {
    const last = out[out.length - 1];
    if (last && last.page === w.page && Math.abs(last.y - w.y) < w.h * 0.5 && w.x - (last.x + last.w) < w.h * 1.2) {
      const right = Math.max(last.x + last.w, w.x + w.w);
      last.x = Math.min(last.x, w.x);
      last.w = right - last.x;
      last.h = Math.max(last.h, w.h);
    } else out.push({ page: w.page, x: w.x, y: w.y, w: w.w, h: w.h });
  }
  return out;
}
