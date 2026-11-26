// Text / Markdown -> PDF. (PDF -> Word, Excel and PowerPoint live in toWord.ts, toExcel.ts and toPowerPoint.ts.)

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

/** Plain text / Markdown-ish -> PDF via Chromium printing. */
export async function textToPdf(text: string, name: string, landscape = false) {
  const body = text
    .split(/\n{2,}/)
    .map((block) => {
      const h = block.match(/^(#{1,3})\s+(.*)$/);
      if (h) return `<h${h[1].length}>${esc(h[2])}</h${h[1].length}>`;
      return `<p>${esc(block).replace(/\n/g, '<br>')}</p>`;
    })
    .join('\n');
  const html = `<!doctype html><meta charset="utf-8"><style>
    body{font:11pt/1.5 'Segoe UI',Arial,sans-serif;color:#111;margin:0}
    h1{font-size:20pt}h2{font-size:16pt}h3{font-size:13pt}p{margin:0 0 10pt;white-space:pre-wrap}
  </style>${body}`;
  return window.acro.htmlToPdf(html, name, landscape);
}
