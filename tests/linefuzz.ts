// Bug hunt: edit every text line of a PDF, one at a time, and check that nothing else changed.
// Run: FUZZ_PDF="path/to/file.pdf" npm run test:fuzz   (on Windows uses installed fonts like the app)
import fs from 'node:fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { bake } from '../src/lib/bake';

const file = process.env.FUZZ_PDF;
if (!file) {
  console.log('Set FUZZ_PDF to a PDF path');
  process.exit(0);
}
const src = new Uint8Array(fs.readFileSync(file));
const winFonts = `${process.env.WINDIR || 'C:\\Windows'}\\Fonts\\`;
const FONTS: Record<string, string> = {
  'tahoma|false|false': 'tahoma.ttf', 'tahoma|true|false': 'tahomabd.ttf',
  'arial|false|false': 'arial.ttf', 'arial|true|false': 'arialbd.ttf', 'arial|false|true': 'ariali.ttf', 'arial|true|true': 'arialbi.ttf',
  'times new roman|false|false': 'times.ttf', 'times new roman|true|false': 'timesbd.ttf', 'calibri|false|false': 'calibri.ttf', 'calibri|true|false': 'calibrib.ttf',
};
const loadSystemFont = async (fam: string, b: boolean, i: boolean) => {
  const f = FONTS[`${fam.toLowerCase()}|${b}|${i}`] || FONTS[`${fam.toLowerCase()}|${b}|false`];
  return f && fs.existsSync(winFonts + f) ? new Uint8Array(fs.readFileSync(winFonts + f)) : null;
};

type It = { str: string; font: string; size: number; x: number; base: number; w: number; vx: number; vy: number };
async function items(bytes: Uint8Array, pageNo = 1) {
  const d = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
  const p = await d.getPage(pageNo);
  await p.getOperatorList();
  const vp = p.getViewport({ scale: 1 });
  const tc = await p.getTextContent();
  const out: It[] = [];
  for (const it of tc.items as any[]) {
    if (!it.str || !it.str.trim()) continue;
    let font = '?';
    try { font = (p.commonObjs.get(it.fontName) as any).name; } catch {}
    const tx = pdfjs.Util.transform(vp.transform, it.transform);
    out.push({ str: it.str, font, size: Math.hypot(tx[2], tx[3]), x: it.transform[4], base: it.transform[5], w: it.width, vx: tx[4], vy: tx[5] });
  }
  const getVp = async (i: number) => (await d.getPage(i + 1)).getViewport({ scale: 1 }) as any;
  return { out, getVp, destroy: () => d.destroy() };
}

const before = await items(src);
// group into lines like the editor does: same baseline, same font+size (or punctuation), gaps < 0.45em
const used = new Set<number>();
const lines: number[][] = [];
const isPunct = (s: string) => /^[\s.,:;!?)\]'"\-–—]+$/.test(s);
before.out.forEach((it, i) => {
  if (used.has(i)) return;
  const same = before.out
    .map((q, k) => ({ q, k }))
    .filter(({ q, k }) => !used.has(k) && Math.abs(q.vy - it.vy) < 0.5 && Math.abs(q.size - it.size) < 0.2 && (q.font === it.font || isPunct(q.str) || k === i))
    .sort((a, b) => a.q.vx - b.q.vx);
  let pos = same.findIndex((s) => s.k === i);
  let lo = pos, hi = pos;
  const gap = it.size * 0.45;
  while (lo > 0 && same[lo].q.vx - (same[lo - 1].q.vx + same[lo - 1].q.w) < gap) lo--;
  while (hi < same.length - 1 && same[hi + 1].q.vx - (same[hi].q.vx + same[hi].q.w) < gap) hi++;
  const run = same.slice(lo, hi + 1).map((s) => s.k);
  run.forEach((k) => used.add(k));
  lines.push(run);
});

let bad = 0;
const key = (q: It) => `${q.str}|${q.font.replace(/^[A-Z]{6}\+/, '')}|${q.x.toFixed(1)}|${q.base.toFixed(1)}`;
for (const run of lines) {
  const qs = run.map((k) => before.out[k]);
  const first = qs[0];
  const left = Math.min(...qs.map((q) => q.vx));
  const right = Math.max(...qs.map((q) => q.vx + q.w));
  let text = '';
  let prevEnd = -1;
  qs.forEach((q, n) => {
    if (n > 0 && q.vx - prevEnd > first.size * 0.18 && !text.endsWith(' ') && !q.str.startsWith(' ')) text += ' ';
    text += q.str;
    prevEnd = q.vx + q.w;
  });
  const fam = first.font.replace(/^[A-Z]{6}\+/, '').split(/[-,]/)[0].replace(/(PSMT|PS|MT)$/, '').replace(/([a-z])([A-Z])/g, '$1 $2');
  const orig = { x: left - 1, y: first.vy - first.size * 0.95, w: right - left + 2, h: first.size * 1.25 };
  const annot: any = {
    id: 'f', page: 0, type: 'replace', ...orig, orig, text: text + ' X', origText: text, origWidth: right - left,
    fontSize: first.size, color: '#000000', bg: '#ffffff', family: fam, bold: /bold/i.test(first.font), italic: /italic|oblique/i.test(first.font),
    baseline: first.vy, startX: left,
  };
  const out = await bake(src, [annot], {}, before.getVp, { loadSystemFont });
  const after = await items(out);
  const lineKeys = new Set(run.map((k) => key(before.out[k])));
  const expect = before.out.filter((q) => !lineKeys.has(key(q))).map(key);
  const got = new Set(after.out.map(key));
  const missing = expect.filter((k) => !got.has(k));
  const added = after.out.filter((q) => Math.abs(q.base - first.base) < 0.6).map((q) => q.str).join(' ');
  const ok = !missing.length && added.replace(/\s+/g, ' ').includes('X');
  if (!ok) {
    bad++;
    console.log(`FAIL  line "${text.slice(0, 50)}"`);
    if (missing.length) console.log('      other text changed/lost:', missing.slice(0, 5));
    if (!added.includes('X')) console.log('      edit not present; line now:', added.slice(0, 80));
  }
  await after.destroy();
}
console.log(`\n${lines.length} lines edited one by one: ${lines.length - bad} clean, ${bad} with problems`);
await before.destroy();
process.exit(bad ? 1 : 0);
