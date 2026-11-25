import type { Annot, Rect } from '../types';

let counter = 0;
export const uid = () => `${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function hexToRgb01(hex: string): [number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function normRect(x1: number, y1: number, x2: number, y2: number): Rect {
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const b64 = dataUrl.split(',')[1];
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function blobToBytes(b: Blob) {
  return new Uint8Array(await b.arrayBuffer());
}

export function baseName(name: string) {
  return name.replace(/\.pdf$/i, '');
}

/** Map characters the standard PDF fonts can't encode to safe equivalents. */
export function winAnsiSafe(s: string) {
  return s
    .replace(/[‘’‚]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/₱/g, 'PHP ')
    .replace(/\t/g, '    ')
    .replace(/[^\n\x20-\x7E\xA0-\xFF€]/g, '?');
}

export function annotBounds(a: Annot): Rect {
  switch (a.type) {
    case 'highlight':
    case 'underline':
    case 'strike': {
      const xs = a.rects.flatMap((r) => [r.x, r.x + r.w]);
      const ys = a.rects.flatMap((r) => [r.y, r.y + r.h]);
      return normRect(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
    }
    case 'ink': {
      const xs = a.points.map((p) => p[0]);
      const ys = a.points.map((p) => p[1]);
      const pad = a.width / 2;
      return normRect(Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad);
    }
    case 'line':
    case 'arrow':
      return normRect(a.x1, a.y1, a.x2, a.y2);
    case 'note':
      return { x: a.x, y: a.y, w: 22, h: 22 };
    case 'mark':
      return { x: a.x - a.size / 2, y: a.y - a.size / 2, w: a.size, h: a.size };
    case 'move':
      return { x: a.from.x + a.dx, y: a.from.y + a.dy, w: a.from.w, h: a.from.h };
    default:
      return { x: a.x, y: a.y, w: a.w, h: a.h };
  }
}

export function moveAnnot<T extends Annot>(a: T, dx: number, dy: number): T {
  switch (a.type) {
    case 'highlight':
    case 'underline':
    case 'strike':
      return { ...a, rects: a.rects.map((r) => ({ ...r, x: r.x + dx, y: r.y + dy })) };
    case 'ink':
      return { ...a, points: a.points.map(([x, y]) => [x + dx, y + dy] as [number, number]) };
    case 'line':
    case 'arrow':
      return { ...a, x1: a.x1 + dx, y1: a.y1 + dy, x2: a.x2 + dx, y2: a.y2 + dy };
    case 'move':
      return { ...a, dx: a.dx + dx, dy: a.dy + dy };
    default:
      return { ...a, x: (a as any).x + dx, y: (a as any).y + dy };
  }
}

export const isBoxAnnot = (a: Annot) =>
  a.type === 'rect' ||
  a.type === 'ellipse' ||
  a.type === 'text' ||
  a.type === 'replace' ||
  a.type === 'whiteout' ||
  a.type === 'redact' ||
  a.type === 'image';

export function downloadName(name: string, suffix: string, ext = 'pdf') {
  return `${baseName(name)}${suffix}.${ext}`;
}
