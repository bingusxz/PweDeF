// Geometry helpers for OCR. No browser APIs, so they can be tested headless.

/**
 * How much a scan is tilted. Looks at the dark pixels (x, y in image pixels, y down) and finds the turn that
 * makes the text lines most level: the rows of a straight page have sharply uneven ink counts.
 * Returns `theta`, the canvas rotation in radians (canvas.rotate(theta), clockwise positive) that levels the page,
 * and `gain`, how much sharper the row pattern becomes (0.1 = 10%). A clean page returns a gain near 0.
 */
export function estimateSkew(xs: ArrayLike<number>, ys: ArrayLike<number>, maxDeg = 6): { theta: number; gain: number } {
  const n = Math.min(xs.length, ys.length);
  if (n < 200) return { theta: 0, gain: 0 };
  let maxX = 0, maxY = 0;
  for (let i = 0; i < n; i++) {
    if (xs[i] > maxX) maxX = xs[i];
    if (ys[i] > maxY) maxY = ys[i];
  }
  const size = Math.ceil(maxX + maxY) + 8;
  const hist = new Int32Array(size);
  const score = (deg: number) => {
    const a = (deg * Math.PI) / 180;
    const c = Math.cos(a), s = Math.sin(a);
    hist.fill(0);
    const off = Math.ceil(maxX) + 2;
    for (let i = 0; i < n; i++) hist[Math.round(ys[i] * c - xs[i] * s) + off]++;
    let sum = 0;
    for (let i = 0; i < size; i++) sum += hist[i] * hist[i];
    return sum;
  };
  const base = score(0);
  let best = 0, bestScore = base;
  for (let d = -maxDeg; d <= maxDeg + 1e-9; d += 0.5) {
    const sc = score(d);
    if (sc > bestScore) {
      bestScore = sc;
      best = d;
    }
  }
  for (let d = best - 0.5; d <= best + 0.5 + 1e-9; d += 0.1) {
    const sc = score(d);
    if (sc > bestScore) {
      bestScore = sc;
      best = d;
    }
  }
  // a = the angle used in score(); points move (x, y) → (x cos a + y sin a, −x sin a + y cos a), which is canvas.rotate(−a)
  return { theta: (-best * Math.PI) / 180, gain: bestScore / base - 1 };
}

/** Where a point of the levelled image sat in the original scan (undo canvas.rotate(theta) about the centre). */
export function unrotatePoint(x: number, y: number, cx: number, cy: number, theta: number): [number, number] {
  const u = x - cx, v = y - cy;
  const c = Math.cos(theta), s = Math.sin(theta);
  return [cx + u * c + v * s, cy - u * s + v * c];
}

/** The same point after canvas.rotate(theta) about the centre. */
export function rotatePoint(x: number, y: number, cx: number, cy: number, theta: number): [number, number] {
  const u = x - cx, v = y - cy;
  const c = Math.cos(theta), s = Math.sin(theta);
  return [cx + u * c - v * s, cy + u * s + v * c];
}
