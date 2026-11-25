// Pictures that are already on a PDF page (a scanned signature, a logo...): find them, and lift one out as an image.
import { pdfjs } from './pdf';
import type { PDFPageProxy } from './pdf';

export interface PagePicture {
  name: string;
  /** where it sits on the page, page units, origin top-left */
  x: number;
  y: number;
  w: number;
  h: number;
}

export async function listPictures(page: PDFPageProxy): Promise<PagePicture[]> {
  const { OPS, Util } = pdfjs as any;
  const vp = page.getViewport({ scale: 1 });
  const ol = await page.getOperatorList();
  const out: PagePicture[] = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack: number[][] = [];
  for (let k = 0; k < ol.fnArray.length; k++) {
    const fn = ol.fnArray[k];
    const a: any = ol.argsArray[k];
    if (fn === OPS.save) stack.push(ctm.slice());
    else if (fn === OPS.restore) ctm = stack.pop() || ctm;
    else if (fn === OPS.transform) ctm = Util.transform(ctm, a);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm.slice());
      if (a?.[0]) ctm = Util.transform(ctm, a[0]);
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || ctm;
    else if (fn === OPS.paintImageXObject && typeof a?.[0] === 'string') {
      const m = Util.transform(vp.transform, ctm);
      const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      const box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
      if (box.w >= 6 && box.h >= 6) out.push({ name: a[0], ...box });
    }
  }
  return out;
}

/** The smallest picture under a point (so a signature wins over a page-size scan behind it). */
export const pictureAt = (list: PagePicture[], x: number, y: number) =>
  list.filter((p) => x >= p.x && x <= p.x + p.w && y >= p.y && y <= p.y + p.h).sort((a, b) => a.w * a.h - b.w * b.h)[0] || null;

const getObj = (page: PDFPageProxy, name: string) =>
  new Promise<any>((res) => {
    const store: any = name.startsWith('g_') ? page.commonObjs : page.objs;
    const t = setTimeout(() => res(null), 4000);
    store.get(name, (o: any) => {
      clearTimeout(t);
      res(o);
    });
  });

/** The picture's own pixels as a PNG data URL (with its transparency), or null if it can't be read. */
export async function pictureImage(page: PDFPageProxy, name: string): Promise<{ dataUrl: string; w: number; h: number; hasAlpha: boolean } | null> {
  const img = await getObj(page, name);
  if (!img) return null;
  const c = document.createElement('canvas');
  let w = 0, h = 0;
  if (img.bitmap) {
    w = img.bitmap.width;
    h = img.bitmap.height;
    c.width = w;
    c.height = h;
    c.getContext('2d')!.drawImage(img.bitmap, 0, 0);
  } else if (img.data && img.width && img.height) {
    w = img.width;
    h = img.height;
    c.width = w;
    c.height = h;
    const n = w * h;
    const rgba = new Uint8ClampedArray(n * 4);
    const d: Uint8ClampedArray = img.data;
    const comps = Math.round(d.length / n);
    for (let i = 0; i < n; i++) {
      if (comps >= 3) {
        rgba[i * 4] = d[i * comps];
        rgba[i * 4 + 1] = d[i * comps + 1];
        rgba[i * 4 + 2] = d[i * comps + 2];
        rgba[i * 4 + 3] = comps === 4 ? d[i * comps + 3] : 255;
      } else {
        rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = d[i];
        rgba[i * 4 + 3] = 255;
      }
    }
    c.getContext('2d')!.putImageData(new ImageData(rgba, w, h), 0, 0);
  } else return null;
  // does it already have see-through parts?
  const px = c.getContext('2d')!.getImageData(0, 0, w, h).data;
  let hasAlpha = false;
  for (let i = 3; i < px.length; i += 4 * 17) if (px[i] < 250) { hasAlpha = true; break; }
  const url = c.toDataURL('image/png');
  c.width = c.height = 0;
  return { dataUrl: url, w, h, hasAlpha };
}

/** A scanned signature is dark ink on white paper: turn the white into transparency so it can sit on any page. */
export async function whiteToTransparent(dataUrl: string): Promise<string> {
  const im = new Image();
  im.src = dataUrl;
  await im.decode();
  const c = document.createElement('canvas');
  c.width = im.naturalWidth;
  c.height = im.naturalHeight;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(im, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height);
  // the paper colour: the bright end of the picture (scans are often light grey, not pure white)
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.data.length; i += 4) hist[((d.data[i] * 299 + d.data[i + 1] * 587 + d.data[i + 2] * 114) / 1000) | 0]++;
  let acc = 0, paper = 255;
  for (let v = 255; v >= 0; v--) {
    acc += hist[v];
    if (acc >= (d.data.length / 4) * 0.25) {
      paper = Math.max(200, v);
      break;
    }
  }
  for (let i = 0; i < d.data.length; i += 4) {
    const lum = (d.data[i] * 299 + d.data[i + 1] * 587 + d.data[i + 2] * 114) / 1000;
    const a = lum >= paper - 10 ? 0 : lum <= paper - 85 ? 255 : Math.round(((paper - 10 - lum) / 75) * 255);
    d.data[i + 3] = Math.min(d.data[i + 3], a);
  }
  ctx.putImageData(d, 0, 0);
  const out = c.toDataURL('image/png');
  c.width = c.height = 0;
  return out;
}
