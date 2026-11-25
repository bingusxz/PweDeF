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
