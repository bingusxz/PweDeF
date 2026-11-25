// Gets a page picture ready for text recognition: grey, well-contrasted and level.
import { estimateSkew } from './ocrGeom';

/** Greyscale and stretch the contrast so faint or yellowed scans read as dark text on a light page. */
export function enhance(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
    d[i] = d[i + 1] = d[i + 2] = g;
    hist[g | 0]++;
  }
  const total = d.length / 4;
  let acc = 0, lo = 0, hi = 255;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= total * 0.01) {
      lo = v;
      break;
    }
  }
  acc = 0;
  for (let v = 255; v >= 0; v--) {
    acc += hist[v];
    if (acc >= total * 0.2) {
      hi = v; // the paper: the brightest fifth of the page
      break;
    }
  }
  if (hi - lo > 40) {
    const k = 255 / (hi - lo);
    for (let i = 0; i < d.length; i += 4) {
      const v = Math.max(0, Math.min(255, (d[i] - lo) * k));
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** Tilt of the (already enhanced) page: finds the dark pixels on a small copy and measures their rows. */
export function measureSkew(canvas: HTMLCanvasElement) {
  const w = Math.min(900, canvas.width);
  const h = Math.max(1, Math.round((canvas.height * w) / canvas.width));
  const small = document.createElement('canvas');
  small.width = w;
  small.height = h;
  const sctx = small.getContext('2d', { willReadFrequently: true })!;
  sctx.drawImage(canvas, 0, 0, w, h);
  const d = sctx.getImageData(0, 0, w, h).data;
  // Otsu threshold: the grey level that best splits ink from paper
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) hist[d[i]]++;
  const total = w * h;
  let sumAll = 0;
  for (let t = 0; t < 256; t++) sumAll += t * hist[t];
  let wB = 0, sumB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const between = wB * wF * (sumB / wB - (sumAll - sumB) / wF) ** 2;
    if (between > best) {
      best = between;
      thr = t;
    }
  }
  const xs: number[] = [];
  const ys: number[] = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) if (d[(y * w + x) * 4] < thr) {
      xs.push(x);
      ys.push(y);
    }
  small.width = small.height = 0;
  // thin out very dense pages: the estimate only needs a few tens of thousands of points
  const step = Math.max(1, Math.floor(xs.length / 60000));
  if (step > 1) {
    const sx: number[] = [], sy: number[] = [];
    for (let i = 0; i < xs.length; i += step) {
      sx.push(xs[i]);
      sy.push(ys[i]);
    }
    return estimateSkew(sx, sy);
  }
  return estimateSkew(xs, ys);
}

/** A copy of the page turned by `theta` radians about its centre, on a white background. */
export function rotated(canvas: HTMLCanvasElement, theta: number) {
  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height;
  const ctx = out.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate(theta);
  ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  return out;
}
