// True text replacement: delete the original text-showing operators from a page's
// content stream (like Acrobat's Edit Text), instead of only painting over them.
//
// We tokenize the page content, track the graphics + text state (CTM, Tm, font,
// size, spacing), compute where each Tj/TJ/'/" starts and ends in user space, and
// remove the operator when its whole run lies inside one of the target rects.
// A run we can't measure (unknown widths, text inside Form XObjects) is reported
// as "unsafe" so the caller keeps a white cover as a fallback.
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFPage, PDFRawStream, PDFRef, PDFStream, decodePDFRawStream } from 'pdf-lib';

export interface PdfRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type M = [number, number, number, number, number, number];
const I: M = [1, 0, 0, 1, 0, 0];
const mul = (a: M, b: M): M => [
  a[0] * b[0] + a[1] * b[2],
  a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2],
  a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4],
  a[4] * b[1] + a[5] * b[3] + b[5],
];
const apply = (m: M, x: number, y: number) => ({ x: x * m[0] + y * m[2] + m[4], y: x * m[1] + y * m[3] + m[5] });

// ---------------- tokenizer ----------------
type Tok =
  | { t: 'num'; v: number; s: number }
  | { t: 'name'; v: string; s: number }
  | { t: 'str'; v: number[]; s: number } // raw byte codes
  | { t: 'arr'; v: Tok[]; s: number }
  | { t: 'op'; v: string; s: number; e: number }
  | { t: 'other'; s: number };

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set('()<>[]{}/%'.split('').map((c) => c.charCodeAt(0)));

function tokenize(b: Uint8Array): Tok[] {
  const out: Tok[] = [];
  const stack: { s: number; items: Tok[] }[] = [];
  const push = (tok: Tok) => (stack.length ? stack[stack.length - 1].items.push(tok) : out.push(tok));
  let i = 0;
  const n = b.length;
  while (i < n) {
    const c = b[i];
    if (WS.has(c)) {
      i++;
      continue;
    }
    if (c === 37 /* % */) {
      while (i < n && b[i] !== 10 && b[i] !== 13) i++;
      continue;
    }
    const s = i;
    if (c === 40 /* ( */) {
      const bytes: number[] = [];
      let depth = 1;
      i++;
      while (i < n && depth > 0) {
        const ch = b[i];
        if (ch === 92 /* \ */) {
          const nx = b[i + 1];
          const map: Record<number, number> = { 110: 10, 114: 13, 116: 9, 98: 8, 102: 12, 40: 40, 41: 41, 92: 92 };
          if (nx in map) {
            bytes.push(map[nx]);
            i += 2;
          } else if (nx >= 48 && nx <= 55) {
            let oct = 0;
            let k = 0;
            i++;
            while (k < 3 && b[i] >= 48 && b[i] <= 55) {
              oct = oct * 8 + (b[i] - 48);
              i++;
              k++;
            }
            bytes.push(oct & 255);
          } else if (nx === 13 || nx === 10) {
            i += 2;
            if (nx === 13 && b[i] === 10) i++;
          } else {
            i++;
          }
          continue;
        }
        if (ch === 40) depth++;
        if (ch === 41) {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
        bytes.push(ch);
        i++;
      }
      push({ t: 'str', v: bytes, s });
      continue;
    }
    if (c === 60 /* < */) {
      if (b[i + 1] === 60) {
        // dictionary: skip to matching >> (only appears as BDC/DP operands or inline image dicts)
        let depth = 0;
        while (i < n) {
          if (b[i] === 60 && b[i + 1] === 60) {
            depth++;
            i += 2;
          } else if (b[i] === 62 && b[i + 1] === 62) {
            depth--;
            i += 2;
            if (depth === 0) break;
          } else i++;
        }
        push({ t: 'other', s });
        continue;
      }
      i++;
      let hex = '';
      while (i < n && b[i] !== 62) {
        if (!WS.has(b[i])) hex += String.fromCharCode(b[i]);
        i++;
      }
      i++;
      if (hex.length % 2) hex += '0';
      const bytes: number[] = [];
      for (let k = 0; k < hex.length; k += 2) bytes.push(parseInt(hex.slice(k, k + 2), 16));
      push({ t: 'str', v: bytes, s });
      continue;
    }
    if (c === 91 /* [ */) {
      stack.push({ s, items: [] });
      i++;
      continue;
    }
    if (c === 93 /* ] */) {
      i++;
      const fr = stack.pop();
      if (fr) push({ t: 'arr', v: fr.items, s: fr.s });
      continue;
    }
    if (c === 47 /* / */) {
      i++;
      let name = '';
      while (i < n && !WS.has(b[i]) && !DELIM.has(b[i])) name += String.fromCharCode(b[i++]);
      push({ t: 'name', v: name, s });
      continue;
    }
    // number or operator keyword
    let word = '';
    while (i < n && !WS.has(b[i]) && !DELIM.has(b[i])) word += String.fromCharCode(b[i++]);
    if (!word) {
      i++;
      continue;
    }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) push({ t: 'num', v: parseFloat(word), s });
    else {
      push({ t: 'op', v: word, s, e: i });
      if (word === 'ID') {
        // inline image data: skip to EI
        while (i < n && !(WS.has(b[i - 1]) && b[i] === 69 && b[i + 1] === 73 && (i + 2 >= n || WS.has(b[i + 2])))) i++;
        i += 2;
        push({ t: 'op', v: 'EI', s: i - 2, e: i });
      }
    }
  }
  return out;
}

// ---------------- fonts ----------------
interface FontInfo {
  twoByte: boolean;
  width: (code: number) => number | undefined; // glyph units (1/1000)
}

function lookup<T>(doc: PDFDocument, o: unknown): T | undefined {
  if (o instanceof PDFRef) return doc.context.lookup(o) as T;
  return o as T;
}

function fontInfo(doc: PDFDocument, fontDict: PDFDict | undefined): FontInfo | null {
  if (!fontDict) return null;
  const subtype = fontDict.get(PDFName.of('Subtype'))?.toString();
  if (subtype === '/Type0') {
    const desc = lookup<PDFArray>(doc, fontDict.get(PDFName.of('DescendantFonts')));
    const cid = desc ? lookup<PDFDict>(doc, desc.get(0)) : undefined;
    if (!cid) return null;
    const dw = (lookup<PDFNumber>(doc, cid.get(PDFName.of('DW')))?.asNumber?.() as number) ?? 1000;
    const W = lookup<PDFArray>(doc, cid.get(PDFName.of('W')));
    const map = new Map<number, number>();
    if (W) {
      const arr = W.asArray().map((x) => lookup<any>(doc, x));
      for (let k = 0; k < arr.length; ) {
        const first = arr[k].asNumber();
        const next = arr[k + 1];
        if (next instanceof PDFArray) {
          next.asArray().forEach((w, j) => map.set(first + j, lookup<PDFNumber>(doc, w)!.asNumber()));
          k += 2;
        } else {
          const last = next.asNumber();
          const w = arr[k + 2].asNumber();
          for (let c = first; c <= last; c++) map.set(c, w);
          k += 3;
        }
      }
    }
    return { twoByte: true, width: (c) => map.get(c) ?? dw };
  }
  const firstChar = lookup<PDFNumber>(doc, fontDict.get(PDFName.of('FirstChar')))?.asNumber();
  const widths = lookup<PDFArray>(doc, fontDict.get(PDFName.of('Widths')));
  if (firstChar === undefined || !widths) return null; // standard-14 fonts without /Widths: can't measure
  const desc = lookup<PDFDict>(doc, fontDict.get(PDFName.of('FontDescriptor')));
  const missing = desc ? (lookup<PDFNumber>(doc, desc.get(PDFName.of('MissingWidth')))?.asNumber() ?? 0) : 0;
  const ws = widths.asArray().map((w) => lookup<PDFNumber>(doc, w)?.asNumber() ?? missing);
  return { twoByte: false, width: (c) => (c >= firstChar && c < firstChar + ws.length ? ws[c - firstChar] : missing) };
}

// ---------------- content streams ----------------
function pageContent(doc: PDFDocument, page: PDFPage): Uint8Array {
  const contents = page.node.Contents();
  const streams: PDFStream[] = [];
  if (contents instanceof PDFArray) contents.asArray().forEach((r) => streams.push(lookup<PDFStream>(doc, r)!));
  else if (contents) streams.push(contents as unknown as PDFStream);
  const parts = streams.map((st) => (st instanceof PDFRawStream ? decodePDFRawStream(st).decode() : (st as any).getContents()));
  const total = parts.reduce((n, p) => n + p.length + 1, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
    out[off++] = 10;
  }
  return out;
}

const SHOW_OPS = new Set(['Tj', 'TJ', "'", '"']);

/**
 * Removes text runs fully inside any of `rects` (PDF user space).
 * Returns how many runs were removed and whether any run that starts inside a rect
 * could not be measured (caller should keep a cover in that case).
 */
export function removeTextInRects(doc: PDFDocument, page: PDFPage, rects: PdfRect[]): { removed: number; unsafe: boolean } {
  if (!rects.length) return { removed: 0, unsafe: false };
  const bytes = pageContent(doc, page);
  const toks = tokenize(bytes);
  const fontsDict = page.node.Resources()?.lookupMaybe(PDFName.of('Font'), PDFDict);
  const fontCache = new Map<string, FontInfo | null>();
  const getFont = (name: string) => {
    if (!fontCache.has(name)) fontCache.set(name, fontInfo(doc, fontsDict ? lookup<PDFDict>(doc, fontsDict.get(PDFName.of(name))) : undefined));
    return fontCache.get(name)!;
  };

  let ctm: M = [...I] as M;
  const gstack: M[] = [];
  let tm: M = [...I] as M;
  let tlm: M = [...I] as M;
  let font: FontInfo | null = null;
  let fs = 0, tc = 0, tw = 0, th = 1, tl = 0;
  const cuts: [number, number][] = [];
  let unsafe = false;
  let removed = 0;

  const inside = (p: { x: number; y: number }, slack: number) =>
    rects.some((r) => p.x >= r.x - slack && p.x <= r.x + r.w + slack && p.y >= r.y - slack && p.y <= r.y + r.h + slack);

  const showAdvance = (items: Tok[]): number | null => {
    if (!font) return null;
    let tx = 0;
    for (const it of items) {
      if (it.t === 'num') tx -= (it.v / 1000) * fs * th;
      else if (it.t === 'str') {
        const codes: number[] = [];
        if (font.twoByte) for (let k = 0; k + 1 < it.v.length; k += 2) codes.push((it.v[k] << 8) | it.v[k + 1]);
        else codes.push(...it.v);
        for (const code of codes) {
          const w = font.width(code);
          if (w === undefined) return null;
          tx += ((w / 1000) * fs + tc + (!font.twoByte && code === 32 ? tw : 0)) * th;
        }
      }
    }
    return tx;
  };

  let operands: Tok[] = [];
  let opStart = -1;
  for (const tok of toks) {
    if (tok.t !== 'op') {
      if (opStart < 0) opStart = tok.s;
      operands.push(tok);
      continue;
    }
    const start = opStart < 0 ? tok.s : opStart;
    const num = (k: number) => (operands[k] && operands[k].t === 'num' ? (operands[k] as any).v : 0);
    switch (tok.v) {
      case 'q':
        gstack.push(ctm);
        break;
      case 'Q':
        ctm = gstack.pop() || ([...I] as M);
        break;
      case 'cm':
        ctm = mul([num(0), num(1), num(2), num(3), num(4), num(5)], ctm);
        break;
      case 'BT':
        tm = [...I] as M;
        tlm = [...I] as M;
        break;
      case 'Tf': {
        const nm = operands[0];
        font = nm && nm.t === 'name' ? getFont(nm.v) : null;
        fs = num(1);
        break;
      }
      case 'Tc':
        tc = num(0);
        break;
      case 'Tw':
        tw = num(0);
        break;
      case 'Tz':
        th = num(0) / 100;
        break;
      case 'TL':
        tl = num(0);
        break;
      case 'Td':
        tlm = mul([1, 0, 0, 1, num(0), num(1)], tlm);
        tm = tlm;
        break;
      case 'TD':
        tl = -num(1);
        tlm = mul([1, 0, 0, 1, num(0), num(1)], tlm);
        tm = tlm;
        break;
      case 'Tm':
        tlm = [num(0), num(1), num(2), num(3), num(4), num(5)];
        tm = tlm;
        break;
      case 'T*':
        tlm = mul([1, 0, 0, 1, 0, -tl], tlm);
        tm = tlm;
        break;
      default:
        if (SHOW_OPS.has(tok.v)) {
          if (tok.v === "'" || tok.v === '"') {
            if (tok.v === '"') {
              tw = num(0);
              tc = num(1);
            }
            tlm = mul([1, 0, 0, 1, 0, -tl], tlm);
            tm = tlm;
          }
          const strTok = operands[operands.length - 1];
          const items = strTok?.t === 'arr' ? strTok.v : strTok ? [strTok] : [];
          const trm = mul(tm, ctm);
          const p0 = apply(trm, 0, 0);
          const adv = showAdvance(items);
          const size = Math.abs(fs * Math.hypot(trm[0], trm[1]) || fs);
          const slack = Math.max(1.5, size * 0.35);
          if (inside(p0, slack)) {
            if (adv === null) unsafe = true;
            else {
              const p1 = apply(trm, adv / (Math.hypot(tm[0], tm[1]) ? 1 : 1), 0);
              if (inside(p1, slack)) {
                cuts.push([start, tok.e]);
                removed++;
              } else unsafe = true;
            }
          }
          if (adv !== null) tm = mul([1, 0, 0, 1, adv, 0], tm);
        }
    }
    operands = [];
    opStart = -1;
  }

  if (cuts.length) {
    // rebuild the stream without the cut ranges (each replaced by a space)
    const parts: Uint8Array[] = [];
    let last = 0;
    for (const [s, e] of cuts.sort((a, b) => a[0] - b[0])) {
      parts.push(bytes.subarray(last, s), new Uint8Array([32]));
      last = e;
    }
    parts.push(bytes.subarray(last));
    const len = parts.reduce((n, p) => n + p.length, 0);
    const next = new Uint8Array(len);
    let off = 0;
    for (const p of parts) {
      next.set(p, off);
      off += p.length;
    }
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(next)));
  }
  return { removed, unsafe };
}

// ---------------- moving graphics (Acrobat "Edit object") ----------------
const PATH_BUILD = new Set(['m', 'l', 'c', 'v', 'y', 'h', 're']);
const PATH_PAINT = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n']);

const inv = (m: M): M => {
  const det = m[0] * m[3] - m[1] * m[2] || 1e-9;
  const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det;
  return [a, b, c, d, -(m[4] * a + m[5] * c), -(m[4] * b + m[5] * d)];
};

/**
 * Moves vector paths and images whose bounds lie fully inside `rect` (PDF user space)
 * by (dx, dy) by wrapping their operators in `q <M> cm … Q`. Text is handled by the
 * caller (removed + redrawn in its original font). Returns how many objects moved.
 */
export function moveGraphicsInRect(doc: PDFDocument, page: PDFPage, rect: PdfRect, dx: number, dy: number): number {
  if (!dx && !dy) return 0;
  const bytes = pageContent(doc, page);
  const toks = tokenize(bytes);
  const T: M = [1, 0, 0, 1, dx, dy];
  const slack = 1;
  const inRect = (p: { x: number; y: number }) =>
    p.x >= rect.x - slack && p.x <= rect.x + rect.w + slack && p.y >= rect.y - slack && p.y <= rect.y + rect.h + slack;
  const inserts: { at: number; text: string }[] = [];
  const wrap = (s: number, e: number, ctm: M) => {
    const m = mul(mul(ctm, T), inv(ctm));
    inserts.push({ at: s, text: ` q ${m.map((v) => +v.toFixed(6)).join(' ')} cm ` }, { at: e, text: ' Q ' });
  };

  let ctm: M = [...I] as M;
  const gstack: M[] = [];
  let inText = false;
  let pathStart = -1;
  let pathPts: { x: number; y: number }[] = [];
  let clip = false;
  let operands: Tok[] = [];
  let opStart = -1;
  let moved = 0;

  for (const tok of toks) {
    if (tok.t !== 'op') {
      if (opStart < 0) opStart = tok.s;
      operands.push(tok);
      continue;
    }
    const start = opStart < 0 ? tok.s : opStart;
    const nums = operands.filter((o) => o.t === 'num').map((o) => (o as any).v as number);
    const op = tok.v;
    if (op === 'q') gstack.push(ctm);
    else if (op === 'Q') ctm = gstack.pop() || ([...I] as M);
    else if (op === 'cm' && nums.length === 6) ctm = mul(nums as M, ctm);
    else if (op === 'BT') inText = true;
    else if (op === 'ET') inText = false;
    else if (!inText && PATH_BUILD.has(op)) {
      if (pathStart < 0) {
        pathStart = start;
        pathPts = [];
        clip = false;
      }
      if (op === 're' && nums.length === 4) {
        const [x, y, w, h] = nums;
        pathPts.push(apply(ctm, x, y), apply(ctm, x + w, y), apply(ctm, x, y + h), apply(ctm, x + w, y + h));
      } else for (let k = 0; k + 1 < nums.length; k += 2) pathPts.push(apply(ctm, nums[k], nums[k + 1]));
    } else if (!inText && (op === 'W' || op === 'W*')) clip = true;
    else if (!inText && PATH_PAINT.has(op)) {
      if (pathStart >= 0 && !clip && op !== 'n' && pathPts.length && pathPts.every(inRect)) {
        wrap(pathStart, tok.e, ctm);
        moved++;
      }
      pathStart = -1;
      pathPts = [];
    } else if (op === 'Do' && !inText) {
      const corners = [apply(ctm, 0, 0), apply(ctm, 1, 0), apply(ctm, 0, 1), apply(ctm, 1, 1)];
      if (corners.every(inRect)) {
        wrap(start, tok.e, ctm);
        moved++;
      }
    }
    operands = [];
    opStart = -1;
  }
  if (!inserts.length) return 0;
  inserts.sort((a, b) => a.at - b.at);
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  let last = 0;
  for (const ins of inserts) {
    parts.push(bytes.subarray(last, ins.at), enc.encode(ins.text));
    last = ins.at;
  }
  parts.push(bytes.subarray(last));
  const next = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    next.set(p, off);
    off += p.length;
  }
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(next)));
  return moved;
}

/** Text that lives in Form XObjects can't be edited this way; detect it so the caller can warn/cover. */
export function pageUsesFormText(doc: PDFDocument, page: PDFPage) {
  const xo = page.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict);
  if (!xo) return false;
  return xo.keys().some((k) => lookup<PDFStream>(doc, xo.get(k))?.dict.get(PDFName.of('Subtype'))?.toString() === '/Form');
}
