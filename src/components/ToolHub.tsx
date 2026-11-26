import { Icon } from './Icon';

export type HubAction =
  // need no PDF
  | 'open' | 'merge' | 'compare' | 'batch' | 'wordToPdf' | 'excelToPdf' | 'pptToPdf' | 'imgToPdf' | 'webToPdf' | 'htmlToPdf' | 'txtToPdf'
  // open a PDF, then run inside the editor
  | 'split' | 'pages' | 'editText' | 'sign' | 'redact' | 'watermark' | 'numbers' | 'ocr' | 'compress' | 'flatten'
  | 'toWord' | 'toExcel' | 'toPpt' | 'exportImages' | 'toText' | 'properties' | 'certSign' | 'sigCheck' | 'formDesigner' | 'protect' | 'crop' | 'sheets' | 'headers' | 'pdfa';

interface Tool {
  a: HubAction;
  icon: string;
  title: string;
  desc: string;
  /** shown with a NEW stamp until people know where to find it */
  isNew?: boolean;
}

/** Each section is printed on its own copy stock, like a carbonless form set. */
const SECTIONS: { title: string; stock: 'white' | 'yellow' | 'blue' | 'pink' | 'green'; tools: Tool[] }[] = [
  {
    title: 'Edit & sign',
    stock: 'white',
    tools: [
      { a: 'editText', icon: 'filePen', title: 'Edit PDF', desc: 'Change text, add images & shapes' },
      { a: 'sign', icon: 'sign', title: 'Sign', desc: 'Signature, initials, stamps' },
      { a: 'formDesigner', icon: 'formInput', title: 'Form designer', desc: 'Add fillable fields to any PDF', isNew: true },
      { a: 'certSign', icon: 'shield', title: 'Digital signature', desc: 'Sign with a certificate (.pfx)', isNew: true },
      { a: 'sigCheck', icon: 'fileCheck', title: 'Check signatures', desc: 'Who signed, was it changed', isNew: true },
      { a: 'protect', icon: 'lock', title: 'Protect PDF', desc: 'Password and permissions (AES-256)', isNew: true },
      { a: 'redact', icon: 'redact', title: 'Redact', desc: 'Remove sensitive content for good' },
      { a: 'watermark', icon: 'water', title: 'Watermark', desc: 'Text across every page' },
      { a: 'numbers', icon: 'hash', title: 'Page numbers', desc: 'Page or Bates numbering' },
      { a: 'headers', icon: 'hash', title: 'Headers and footers', desc: 'Date, file name, page of total', isNew: true },
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
      { a: 'crop', icon: 'fit', title: 'Crop pages', desc: 'Trim the margins', isNew: true },
      { a: 'sheets', icon: 'copy', title: 'Booklet and n-up', desc: 'Several pages per sheet, or a folded booklet', isNew: true },
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
      { a: 'compress', icon: 'minimize', title: 'Optimize', desc: 'Clean up the file' },
      { a: 'ocr', icon: 'ocr', title: 'Recognize text (OCR)', desc: 'Make scans searchable' },
      { a: 'pdfa', icon: 'fileCheck', title: 'PDF/A archive copy', desc: 'For long-term keeping', isNew: true },
      { a: 'flatten', icon: 'layers2', title: 'Flatten', desc: 'Lock fields and markup in' },
      { a: 'compare', icon: 'columns', title: 'Compare PDFs', desc: 'Find what changed between two files', isNew: true },
      { a: 'batch', icon: 'batch', title: 'Batch process', desc: 'One action on many files' },
      { a: 'properties', icon: 'info', title: 'Properties', desc: 'Title, author, keywords' },
    ],
  },
];

/** The jobs people come for most, big and first. */
const QUICK: HubAction[] = ['editText', 'sign', 'merge', 'toWord'];

/** Left: working on a PDF. Right: converting into and out of PDF. */
const COLUMNS = [
  ['Edit & sign', 'Organize', 'Finish & batch'],
  ['Convert to PDF', 'Convert from PDF'],
];

export function ToolHub({ onAction, caps }: { onAction: (a: HubAction) => void; caps: { office: boolean; libreoffice: boolean } | null }) {
  const sections = SECTIONS;
  const all = SECTIONS.flatMap((s) => s.tools);
  const quick = QUICK.map((a) => all.find((t) => t.a === a)!).filter(Boolean);
  const officeMissing = caps && !caps.office && !caps.libreoffice;

  return (
    <div className="hub">
      <section className="start" aria-label="Start here">
        <h2 className="start-title">Start here</h2>
        <div className="start-cards">
          {quick.map((t, i) => (
            <button key={t.a} className="start-card" style={{ ['--tilt' as any]: `${[-0.7, 0.5, -0.4, 0.8][i % 4]}deg` }} onClick={() => onAction(t.a)}>
              <Icon name={t.icon} size={26} className="start-icon" />
              <span className="start-name">{t.title}</span>
              <span className="start-desc">{t.desc}</span>
            </button>
          ))}
        </div>
      </section>

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
                            <span className="form-line-name">
                              {t.title}
                              {t.isNew && <span className="new-stamp">New</span>}
                            </span>
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

      {officeMissing && (
        <p className="note-line">Word, Excel and PowerPoint to PDF need Microsoft Office or the free LibreOffice on this PC.</p>
      )}
    </div>
  );
}
