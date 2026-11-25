import { useState } from 'react';
import { Icon } from './Icon';

export type HubAction =
  // need no PDF
  | 'open' | 'merge' | 'batch' | 'wordToPdf' | 'excelToPdf' | 'pptToPdf' | 'imgToPdf' | 'webToPdf' | 'htmlToPdf' | 'txtToPdf'
  // open a PDF, then run inside the editor
  | 'split' | 'pages' | 'editText' | 'sign' | 'redact' | 'watermark' | 'numbers' | 'ocr' | 'compress' | 'flatten'
  | 'toWord' | 'toExcel' | 'toPpt' | 'exportImages' | 'toText' | 'properties';

interface Tool {
  a: HubAction;
  icon: string;
  title: string;
  desc: string;
}

/** Each section is printed on its own copy stock, like a carbonless form set. */
const SECTIONS: { title: string; stock: 'white' | 'yellow' | 'blue' | 'pink' | 'green'; tools: Tool[] }[] = [
  {
    title: 'Edit & sign',
    stock: 'white',
    tools: [
      { a: 'editText', icon: 'editText', title: 'Edit PDF', desc: 'Change text, add images & shapes' },
      { a: 'sign', icon: 'sign', title: 'Sign', desc: 'Signature, initials, stamps' },
      { a: 'redact', icon: 'redact', title: 'Redact', desc: 'Remove sensitive content for good' },
      { a: 'watermark', icon: 'water', title: 'Watermark', desc: 'Text across every page' },
      { a: 'numbers', icon: 'hash', title: 'Page numbers', desc: 'Page or Bates numbering' },
    ],
  },
  {
    title: 'Convert to PDF',
    stock: 'blue',
    tools: [
      { a: 'wordToPdf', icon: 'word', title: 'Word to PDF', desc: 'DOC, DOCX, RTF, ODT, TXT' },
      { a: 'excelToPdf', icon: 'excel', title: 'Excel to PDF', desc: 'XLS, XLSX, CSV, ODS' },
      { a: 'pptToPdf', icon: 'ppt', title: 'PowerPoint to PDF', desc: 'PPT, PPTX, ODP' },
      { a: 'imgToPdf', icon: 'jpg', title: 'Images to PDF', desc: 'JPG, PNG, WEBP, scans' },
      { a: 'webToPdf', icon: 'web', title: 'Web page to PDF', desc: 'Any web address' },
      { a: 'htmlToPdf', icon: 'txt', title: 'HTML or text to PDF', desc: 'HTML, TXT, Markdown' },
    ],
  },
  {
    title: 'Organize',
    stock: 'yellow',
    tools: [
      { a: 'merge', icon: 'merge', title: 'Merge', desc: 'Combine PDFs in your order' },
      { a: 'split', icon: 'split', title: 'Split', desc: 'By page ranges or every N pages' },
      { a: 'pages', icon: 'organize', title: 'Organize pages', desc: 'Reorder, rotate, delete pages' },
    ],
  },
  {
    title: 'Convert from PDF',
    stock: 'pink',
    tools: [
      { a: 'toWord', icon: 'word', title: 'PDF to Word', desc: 'Editable DOCX' },
      { a: 'toExcel', icon: 'excel', title: 'PDF to Excel', desc: 'Tables as rows and columns' },
      { a: 'toPpt', icon: 'ppt', title: 'PDF to PowerPoint', desc: 'One slide per page' },
      { a: 'exportImages', icon: 'jpg', title: 'PDF to images', desc: 'JPG or PNG per page' },
      { a: 'toText', icon: 'txt', title: 'PDF to text', desc: 'All text as .txt' },
    ],
  },
  {
    title: 'Finish & batch',
    stock: 'green',
    tools: [
      { a: 'compress', icon: 'compress', title: 'Optimize', desc: 'Clean up the file' },
      { a: 'ocr', icon: 'ocr', title: 'Recognize text (OCR)', desc: 'Make scans searchable' },
      { a: 'flatten', icon: 'form', title: 'Flatten', desc: 'Lock fields and markup in' },
      { a: 'batch', icon: 'batch', title: 'Batch process', desc: 'One action on many files' },
      { a: 'properties', icon: 'info', title: 'Properties', desc: 'Title, author, keywords' },
    ],
  },
];

/** Left: working on a PDF. Right: converting into and out of PDF. */
const COLUMNS = [
  ['Edit & sign', 'Organize', 'Finish & batch'],
  ['Convert to PDF', 'Convert from PDF'],
];

export function ToolHub({ onAction, caps }: { onAction: (a: HubAction) => void; caps: { office: boolean; libreoffice: boolean } | null }) {
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const sections = SECTIONS.map((s) => ({
    ...s,
    tools: s.tools.filter((t) => !needle || `${t.title} ${t.desc} ${s.title}`.toLowerCase().includes(needle)),
  })).filter((s) => s.tools.length);
  const officeMissing = caps && !caps.office && !caps.libreoffice;

  return (
    <div className="hub">
      <label className="find-field">
        <Icon name="search" size={16} />
        <input
          placeholder="Find a tool: merge, word, sign…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && sections[0]?.tools[0]) onAction(sections[0].tools[0].a);
            if (e.key === 'Escape') setQ('');
          }}
          aria-label="Find a tool"
        />
        {needle && <span className="find-count">{sections.reduce((n, s) => n + s.tools.length, 0)} found · Enter opens the first</span>}
      </label>

      {sections.length ? (
        <div className="form-set">
          {COLUMNS.map((col, ci) => (
            <div className="form-col" key={ci}>
              {sections
                .filter((s) => col.includes(s.title))
                .map((s) => (
                  <section key={s.title} className={`form-section stock-${s.stock}`}>
                    <h2 className="form-section-title">{s.title}</h2>
                    <ul className="form-lines">
                      {s.tools.map((t) => (
                        <li key={t.a}>
                          <button className="form-line" onClick={() => onAction(t.a)}>
                            <Icon name={t.icon} size={18} className="form-line-icon" />
                            <span className="form-line-name">{t.title}</span>
                            <span className="form-line-desc">{t.desc}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
            </div>
          ))}
        </div>
      ) : (
        <p className="empty-line">No tool matches “{q}”. Try “merge”, “word” or “sign”.</p>
      )}

      {officeMissing && (
        <p className="note-line">Word, Excel and PowerPoint to PDF need Microsoft Office or the free LibreOffice on this PC.</p>
      )}
    </div>
  );
}
