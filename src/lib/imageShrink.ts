// Browser side of the optimizer: scale a picture down and re-encode it as JPEG using a canvas.
import type { ImageJob, ImageResult } from './optimize';

export async function shrinkImage(job: ImageJob): Promise<ImageResult | null> {
  let bmp: ImageBitmap;
  if (job.kind === 'jpeg') {
    // EXIF "rotate me" flags are ignored by PDF, so they must be ignored here too
    bmp = await createImageBitmap(new Blob([job.data as unknown as BlobPart], { type: 'image/jpeg' }), { imageOrientation: 'none' });
  } else {
    const n = job.width * job.height;
    const rgba = new Uint8ClampedArray(n * 4);
    const s = job.data;
    if (job.comps === 3) {
      for (let i = 0, j = 0, k = 0; i < n; i++, j += 3, k += 4) {
        rgba[k] = s[j];
        rgba[k + 1] = s[j + 1];
        rgba[k + 2] = s[j + 2];
        rgba[k + 3] = 255;
      }
    } else {
      for (let i = 0, k = 0; i < n; i++, k += 4) {
        rgba[k] = rgba[k + 1] = rgba[k + 2] = s[i];
        rgba[k + 3] = 255;
      }
    }
    bmp = await createImageBitmap(new ImageData(rgba, job.width, job.height));
  }

  try {
    const scale = Math.min(1, job.maxPx / Math.max(bmp.width, bmp.height));
    const tw = Math.max(1, Math.round(bmp.width * scale));
    const th = Math.max(1, Math.round(bmp.height * scale));

    // shrink in halving steps: one big jump looks jagged
    let src: CanvasImageSource = bmp;
    let sw = bmp.width, sh = bmp.height;
    const made: HTMLCanvasElement[] = [];
    while (sw / 2 > tw && sh / 2 > th) {
      const c = document.createElement('canvas');
      c.width = Math.round(sw / 2);
      c.height = Math.round(sh / 2);
      const cx = c.getContext('2d')!;
      cx.imageSmoothingQuality = 'high';
      cx.drawImage(src, 0, 0, c.width, c.height);
      made.push(c);
      src = c;
      sw = c.width;
      sh = c.height;
    }
    const out = document.createElement('canvas');
    out.width = tw;
    out.height = th;
    const ctx = out.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, tw, th);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, tw, th);
    const blob = await new Promise<Blob | null>((res) => out.toBlob(res, 'image/jpeg', job.quality));
    for (const c of [...made, out]) c.width = c.height = 0;
    if (!blob) return null;
    return { jpeg: new Uint8Array(await blob.arrayBuffer()), width: tw, height: th };
  } finally {
    bmp.close();
  }
}
