// Copies pdf.js character maps + standard fonts into public/ so rendering works offline
// (needed for CJK text and PDFs that don't embed their fonts).
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'node_modules', 'pdfjs-dist');
const dst = path.join(root, 'public', 'pdfjs');

for (const dir of ['cmaps', 'standard_fonts']) {
  const from = path.join(src, dir);
  const to = path.join(dst, dir);
  if (!fs.existsSync(from)) continue;
  fs.mkdirSync(to, { recursive: true });
  fs.cpSync(from, to, { recursive: true });
}
console.log('pdf.js assets copied to public/pdfjs');

// OCR engine + English/Filipino models, bundled so text recognition works fully offline.
{
  const ocr = path.join(root, 'public', 'ocr');
  const pick = [
    [path.join(root, 'node_modules', 'tesseract.js', 'dist', 'worker.min.js'), 'worker.min.js'],
    ...['tesseract-core-lstm', 'tesseract-core-simd-lstm', 'tesseract-core-relaxedsimd-lstm'].map((n) => [
      path.join(root, 'node_modules', 'tesseract.js-core', n + '.wasm.js'),
      n + '.wasm.js',
    ]),
    ...['eng', 'fil'].map((l) => [path.join(root, 'node_modules', '@tesseract.js-data', l, '4.0.0_best_int', l + '.traineddata.gz'), path.join('lang', l + '.traineddata.gz')]),
  ];
  let n = 0;
  for (const [from, rel] of pick) {
    if (!fs.existsSync(from)) {
      console.warn('OCR asset missing (run npm install):', from);
      continue;
    }
    const to = path.join(ocr, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    n++;
  }
  console.log(`OCR assets copied to public/ocr (${n}/${pick.length})`);
}
