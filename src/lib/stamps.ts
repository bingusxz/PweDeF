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
  ctx.font = `120px "${font}", cursive`;
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

export function stampImage(label: string, color: string, sub?: string) {
  const scale = 3;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  ctx.font = `bold ${36 * scale}px Arial, sans-serif`;
  const tw = ctx.measureText(label).width;
  const w = tw + 48 * scale;
  const h = (sub ? 84 : 64) * scale;
  c.width = w;
  c.height = h;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 4 * scale;
  const r = 10 * scale;
  ctx.beginPath();
  ctx.roundRect(ctx.lineWidth, ctx.lineWidth, w - 2 * ctx.lineWidth, h - 2 * ctx.lineWidth, r);
  ctx.stroke();
  ctx.font = `bold ${36 * scale}px Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, w / 2, (sub ? 34 : 33) * scale);
  if (sub) {
    ctx.font = `${16 * scale}px Arial, sans-serif`;
    ctx.fillText(sub, w / 2, 66 * scale);
  }
  return { dataUrl: c.toDataURL('image/png'), w: w / scale, h: h / scale };
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
