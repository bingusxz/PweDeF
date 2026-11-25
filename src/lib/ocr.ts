// OCR: turn scanned pages into searchable/selectable text by adding an invisible text layer.
// The engine and the English / Filipino models ship inside the app, so it works offline.
import { PDFDocument, StandardFonts, TextRenderingMode, degrees, popGraphicsState, pushGraphicsState, setCharacterSqueeze, setTextRenderingMode } from 'pdf-lib';
import { createWorker } from 'tesseract.js';
import type { PDFDocumentProxy } from './pdf';
import { renderToCanvas } from './pdf';
import { winAnsiSafe } from './util';
import { enhance, measureSkew, rotated } from './ocrPrep';
import { unrotatePoint } from './ocrGeom';

export interface OcrOptions {
  /** tesseract language codes joined with "+", e.g. "eng+fil" */
  lang: string;
  /** fast = 200 dpi, accurate = 300 dpi (slower, better on small print) */
  quality: 'fast' | 'accurate';
  /** straighten crooked scans before reading */
  deskew: boolean;
  /** leave pages alone that already have real text */
  skipTextPages: boolean;
}

export interface OcrResult {
  bytes: Uint8Array;
  words: number;
  pagesDone: number;
  pagesSkipped: number;
  /** average confidence of the kept words, 0 to 100 */
  confidence: number;
}

/** Languages whose models are bundled in the installer. Others are fetched on first use (needs internet). */
export const BUNDLED_LANGS = ['eng', 'fil'];

const MAX_SIDE = 5200; // pixels: keeps big sheets (A2 plans) from exhausting memory on small PCs
const MIN_CONF = 25;

export async function ocrDocument(
  bytes: Uint8Array,
  pdf: PDFDocumentProxy,
  pages: number[],
  o: OcrOptions,
  onProgress: (msg: string, frac: number) => void,
): Promise<OcrResult> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  onProgress('Starting the OCR engine…', 0);

  const base = new URL('./ocr/', document.baseURI).href;
  const local = o.lang.split('+').every((l) => BUNDLED_LANGS.includes(l));
  const worker = await createWorker(o.lang, 1 /* LSTM only */, {
    workerPath: base + 'worker.min.js',
    corePath: base,
    workerBlobURL: false,
    cacheMethod: 'none',
    ...(local ? { langPath: base + 'lang' } : {}), // other languages come from the internet the first time
  });
  const result: OcrResult = { bytes, words: 0, pagesDone: 0, pagesSkipped: 0, confidence: 0 };
  let confSum = 0;
  try {
    const dpi = o.quality === 'accurate' ? 300 : 200;
    for (let k = 0; k < pages.length; k++) {
      const i = pages[k];
      const frac = k / pages.length;
      const pg = await pdf.getPage(i + 1);

      if (o.skipTextPages) {
        const tc = await pg.getTextContent();
        const chars = (tc.items as any[]).reduce((n, it) => n + (typeof it.str === 'string' ? it.str.trim().length : 0), 0);
        if (chars >= 25) {
          result.pagesSkipped++;
          continue;
        }
      }

      onProgress(`Reading page ${i + 1} (${k + 1} of ${pages.length})…`, frac);
      const vp = pg.getViewport({ scale: 1 });
      const scale = Math.min(dpi / 72, MAX_SIDE / Math.max(vp.width, vp.height));
      let canvas = await renderToCanvas(pg, scale);
      enhance(canvas);

      let theta = 0;
      if (o.deskew) {
        const sk = measureSkew(canvas);
        // only turn the page when the tilt is real: more than a third of a degree and a clearly sharper row pattern
        if (Math.abs(sk.theta) > (0.3 * Math.PI) / 180 && sk.gain > 0.02) {
          theta = sk.theta;
          const turned = rotated(canvas, theta);
          canvas.width = canvas.height = 0;
          canvas = turned;
        }
      }
      const cx = canvas.width / 2, cy = canvas.height / 2;

      await worker.setParameters({ preserve_interword_spaces: '1', user_defined_dpi: String(Math.round(scale * 72)) });
      const { data } = await worker.recognize(canvas, {}, { blocks: true });
      canvas.width = canvas.height = 0;

      const page = doc.getPage(i);
      for (const block of data.blocks || [])
        for (const para of block.paragraphs)
          for (const line of para.lines)
            for (const word of line.words) {
              const text = winAnsiSafe(word.text).trim();
              if (!text || word.confidence < MIN_CONF) continue;
              const { x0, y1 } = word.bbox;
              const w = (word.bbox.x1 - x0) / scale;
              const h = (y1 - word.bbox.y0) / scale;
              if (w < 1 || h < 1) continue;
              // the word's bottom-left corner, mapped back to where it sits on the original (untilted) scan
              const [ox, oy] = unrotatePoint(x0, y1 - (y1 - word.bbox.y0) * 0.15, cx, cy, theta);
              const [px, py] = vp.convertToPdfPoint(ox / scale, oy / scale);
              // size from the word's height, then squeeze the width so the invisible text covers the visible word exactly
              const size = Math.max(2, h * 0.95);
              const natural = font.widthOfTextAtSize(text, size) || 1;
              const squeeze = Math.max(15, Math.min(400, (w / natural) * 100));
              page.pushOperators(pushGraphicsState(), setTextRenderingMode(TextRenderingMode.Invisible), setCharacterSqueeze(squeeze));
              page.drawText(text, { x: px, y: py, size, font, rotate: degrees(vp.rotation + (theta * 180) / Math.PI) });
              page.pushOperators(popGraphicsState());
              result.words++;
              confSum += word.confidence;
            }
      result.pagesDone++;
    }
  } finally {
    await worker.terminate();
  }
  onProgress('Saving…', 1);
  result.confidence = result.words ? confSum / result.words : 0;
  result.bytes = result.pagesDone ? await doc.save({ useObjectStreams: true }) : bytes;
  return result;
}

/** Reads the text in a single picture (for example a signature or stamp lifted from a page). Handwriting is often misread. */
export async function ocrImage(dataUrl: string, lang = 'eng'): Promise<{ text: string; confidence: number }> {
  const base = new URL('./ocr/', document.baseURI).href;
  const worker = await createWorker(lang, 1, { workerPath: base + 'worker.min.js', corePath: base, workerBlobURL: false, cacheMethod: 'none', langPath: base + 'lang' });
  try {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    // flatten see-through parts onto white, and enlarge small pictures: both help a lot
    const k = Math.max(1, Math.min(4, 1400 / Math.max(1, img.naturalWidth)));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k) + 40;
    c.height = Math.round(img.naturalHeight * k) + 40;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 20, 20, c.width - 40, c.height - 40);
    let best = { text: '', confidence: 0 };
    for (const psm of ['7', '6']) {
      await worker.setParameters({ tessedit_pageseg_mode: psm as any });
      const { data } = await worker.recognize(c);
      const t = data.text.trim();
      if (t && data.confidence >= best.confidence) best = { text: t, confidence: data.confidence };
      if (best.confidence >= 80) break;
    }
    c.width = c.height = 0;
    return best;
  } finally {
    await worker.terminate();
  }
}
