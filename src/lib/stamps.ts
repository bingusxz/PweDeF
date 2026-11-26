// Generates signature / stamp images as transparent PNG data URLs.

export function trimCanvas(src: HTMLCanvasElement, pad = 6): HTMLCanvasElement {
  const ctx = src.getContext('2d')!;
  const { width, height } = src;
  const data = ctx.getImageData(0, 0, width, height).data;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return src;
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  x1 = Math.min(width - 1, x1 + pad);
  y1 = Math.min(height - 1, y1 + pad);
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext('2d')!.drawImage(src, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

export const SIGNATURE_FONTS = ['Segoe Script', 'Brush Script MT', 'Lucida Handwriting', 'Ink Free', 'Gabriola'];

export function typedSignature(text: string, font: string, color: string) {
  const c = document.createElement('canvas');
  c.width = 1400;
  c.height = 300;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = color;
  // long names shrink to fit the picture instead of running off the edge
  let px = 120;
  ctx.font = `${px}px "${font}", cursive`;
  const room = c.width - 80;
  const w = ctx.measureText(text).width;
  if (w > room) {
    px = Math.max(30, Math.floor((px * room) / w));
    ctx.font = `${px}px "${font}", cursive`;
  }
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 30, 150);
  return trimCanvas(c).toDataURL('image/png');
}

export interface StampDef {
  label: string;
  color: string;
}

export const STAMPS: StampDef[] = [
  { label: 'APPROVED', color: '#1f8a3b' },
  { label: 'RECEIVED', color: '#1d5fbf' },
  { label: 'PAID', color: '#1f8a3b' },
  { label: 'REVIEWED', color: '#6b3fbf' },
  { label: 'REJECTED', color: '#c62828' },
  { label: 'CONFIDENTIAL', color: '#c62828' },
  { label: 'DRAFT', color: '#7a7a7a' },
  { label: 'FOR SIGNATURE', color: '#d97706' },
];

export type StampShape = 'box' | 'double' | 'oval' | 'plain';
export const STAMP_SHAPES: { shape: StampShape; name: string }[] = [
  { shape: 'box', name: 'Box' },
  { shape: 'double', name: 'Double box' },
  { shape: 'oval', name: 'Oval' },
  { shape: 'plain', name: 'Text only' },
];

export function stampImage(label: string, color: string, sub?: string, shape: StampShape = 'box') {
  const scale = 3;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  ctx.font = `bold ${36 * scale}px Arial, sans-serif`;
  let tw = ctx.measureText(label).width;
  if (sub) {
    // the name/date line must fit inside the border too
    ctx.font = `${16 * scale}px Arial, sans-serif`;
    tw = Math.max(tw, ctx.measureText(sub).width);
  }
  // an oval needs more room round the corners of the text than a box does
  const padX = (shape === 'oval' ? 80 : shape === 'double' ? 56 : 48) * scale;
  const w = tw + padX;
  const h = (sub ? 84 : 64) * scale + (shape === 'oval' ? 22 * scale : 0);
  c.width = w;
  c.height = h;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 4 * scale;
  const lw = ctx.lineWidth;
  const r = 10 * scale;
  if (shape === 'box' || shape === 'double') {
    ctx.beginPath();
    ctx.roundRect(lw, lw, w - 2 * lw, h - 2 * lw, r);
    ctx.stroke();
    if (shape === 'double') {
      ctx.lineWidth = 2 * scale;
      ctx.beginPath();
      ctx.roundRect(lw + 7 * scale, lw + 7 * scale, w - 2 * lw - 14 * scale, h - 2 * lw - 14 * scale, r * 0.6);
      ctx.stroke();
      ctx.lineWidth = lw;
    }
  } else if (shape === 'oval') {
    ctx.beginPath();
    ctx.ellipse(w / 2, h / 2, w / 2 - lw, h / 2 - lw, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.font = `bold ${36 * scale}px Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const dy = shape === 'oval' ? 11 * scale : 0;
  ctx.fillText(label, w / 2, (sub ? 34 : 33) * scale + dy);
  if (sub) {
    ctx.font = `${16 * scale}px Arial, sans-serif`;
    ctx.fillText(sub, w / 2, 66 * scale + dy);
  }
  inkTexture(ctx, c.width, c.height, label.length);
  return { dataUrl: c.toDataURL('image/png'), w: w / scale, h: h / scale };
}

/** Ready-made stamp sets. People can also keep their own under "My stamps". */
export const STAMP_SETS: { name: string; stamps: StampDef[] }[] = [
  { name: 'General', stamps: STAMPS },
  {
    name: 'Accounting',
    stamps: [
      { label: 'PAID', color: '#1f8a3b' },
      { label: 'CHECKED', color: '#1d5fbf' },
      { label: 'VERIFIED', color: '#6b3fbf' },
      { label: 'FOR PAYMENT', color: '#d97706' },
      { label: 'POSTED', color: '#1f8a3b' },
      { label: 'ON HOLD', color: '#c62828' },
      { label: 'VOID', color: '#c62828' },
      { label: 'DUPLICATE', color: '#7a7a7a' },
    ],
  },
  {
    name: 'Purchasing & Logistics',
    stamps: [
      { label: 'RECEIVED', color: '#1d5fbf' },
      { label: 'INSPECTED', color: '#6b3fbf' },
      { label: 'FOR DELIVERY', color: '#d97706' },
      { label: 'DELIVERED', color: '#1f8a3b' },
      { label: 'PARTIAL', color: '#d97706' },
      { label: 'BACK ORDER', color: '#c62828' },
      { label: 'RETURNED', color: '#c62828' },
      { label: 'URGENT', color: '#c62828' },
    ],
  },
  {
    name: 'HR & Admin',
    stamps: [
      { label: 'CONFIDENTIAL', color: '#c62828' },
      { label: 'NOTED', color: '#1d5fbf' },
      { label: 'FOR REVIEW', color: '#d97706' },
      { label: 'APPROVED', color: '#1f8a3b' },
      { label: 'DISAPPROVED', color: '#c62828' },
      { label: 'FILED', color: '#7a7a7a' },
      { label: 'COPY', color: '#7a7a7a' },
      { label: 'ORIGINAL', color: '#1f8a3b' },
    ],
  },
];

// ---- the user's own stamps (per machine) ----
const STAMP_KEY = 'acro.stamps.v1';
export interface SavedStamp {
  id: string;
  label: string;
  color: string;
  shape: StampShape;
}
export function loadStamps(): SavedStamp[] {
  try {
    return JSON.parse(localStorage.getItem(STAMP_KEY) || '[]');
  } catch {
    return [];
  }
}
export function saveStamps(s: SavedStamp[]) {
  try {
    localStorage.setItem(STAMP_KEY, JSON.stringify(s.slice(0, 40)));
  } catch {
    /* storage full / unavailable */
  }
}

/** Uneven rubber-stamp ink: deterministic per stamp so the same stamp always looks the same. */
function inkTexture(ctx: CanvasRenderingContext2D, w: number, h: number, seed: number) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  let s = 9301 + seed * 49297;
  const rnd = () => ((s = (s * 233280 + 49297) % 2147483647) / 2147483647);
  for (let y = 0; y < h; y += 2)
    for (let x = 0; x < w; x += 2) {
      const r = rnd();
      // a few bare specks and a soft overall unevenness
      const f = r < 0.035 ? 0.15 : 0.78 + r * 0.22;
      for (let dy = 0; dy < 2 && y + dy < h; dy++)
        for (let dx = 0; dx < 2 && x + dx < w; dx++) {
          const i = ((y + dy) * w + (x + dx)) * 4 + 3;
          d[i] = d[i] * f;
        }
    }
  ctx.putImageData(img, 0, 0);
}

// ---- saved signatures (per machine) ----
const KEY = 'acro.signatures.v1';
export interface SavedSig {
  id: string;
  dataUrl: string;
  kind: 'signature' | 'initials';
}
export function loadSigs(): SavedSig[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '[]');
  } catch {
    return [];
  }
}
export function saveSigs(s: SavedSig[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s.slice(0, 12)));
  } catch {
    /* storage full / unavailable */
  }
}

export async function imageSize(dataUrl: string): Promise<{ w: number; h: number }> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  return { w: img.naturalWidth, h: img.naturalHeight };
}
