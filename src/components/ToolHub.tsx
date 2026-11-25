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
  color: string;
}

const CATS: { title: string; tools: Tool[] }[] = [
  {
    title: 'Edit & sign',
    tools: [
      { a: 'editText', icon: 'editText', title: 'Edit PDF', desc: 'Change existing text, add text, images & shapes', color: '#e5484d' },
      { a: 'sign', icon: 'sign', title: 'Sign PDF', desc: 'Draw, type or upload a signature; stamps', color: '#e5484d' },
      { a: 'redact', icon: 'redact', title: 'Redact', desc: 'Permanently remove sensitive info', color: '#e5484d' },
      { a: 'watermark', icon: 'water', title: 'Watermark', desc: 'Stamp text across every page', color: '#e5484d' },
      { a: 'numbers', icon: 'hash', title: 'Page numbers', desc: 'Page numbers or Bates numbering', color: '#e5484d' },
    ],
  },
  {
    title: 'Organize',
    tools: [
      { a: 'merge', icon: 'merge', title: 'Merge PDF', desc: 'Combine PDFs in the order you want', color: '#f08c00' },
      { a: 'split', icon: 'split', title: 'Split PDF', desc: 'Split by page ranges or every N pages', color: '#f08c00' },
      { a: 'pages', icon: 'organize', title: 'Organize pages', desc: 'Reorder, rotate, delete, insert, extract', color: '#f08c00' },
    ],
  },
  {
    title: 'Convert to PDF',
    tools: [
      { a: 'wordToPdf', icon: 'word', title: 'Word to PDF', desc: 'DOC, DOCX, RTF, ODT, TXT', color: '#2b6cd4' },
      { a: 'excelToPdf', icon: 'excel', title: 'Excel to PDF', desc: 'XLS, XLSX, CSV, ODS', color: '#1f8a3b' },
      { a: 'pptToPdf', icon: 'ppt', title: 'PowerPoint to PDF', desc: 'PPT, PPTX, ODP', color: '#d9480f' },
      { a: 'imgToPdf', icon: 'jpg', title: 'JPG to PDF', desc: 'Photos & scans: JPG, PNG, WEBP…', color: '#c2255c' },
      { a: 'webToPdf', icon: 'web', title: 'Web page to PDF', desc: 'Save any URL as a PDF', color: '#6741d9' },
      { a: 'htmlToPdf', icon: 'txt', title: 'HTML / Text to PDF', desc: 'HTML, TXT and Markdown files', color: '#6741d9' },
    ],
  },
  {
    title: 'Convert from PDF',
    tools: [
      { a: 'toWord', icon: 'word', title: 'PDF to Word', desc: 'Editable DOCX', color: '#2b6cd4' },
      { a: 'toExcel', icon: 'excel', title: 'PDF to Excel', desc: 'Tables to XLSX rows & columns', color: '#1f8a3b' },
      { a: 'toPpt', icon: 'ppt', title: 'PDF to PowerPoint', desc: 'One slide per page', color: '#d9480f' },
      { a: 'exportImages', icon: 'jpg', title: 'PDF to JPG / PNG', desc: 'Every page as an image', color: '#c2255c' },
      { a: 'toText', icon: 'txt', title: 'PDF to Text', desc: 'Extract all text', color: '#6741d9' },
    ],
  },
  {
    title: 'Optimize & more',
    tools: [
      { a: 'compress', icon: 'compress', title: 'Optimize PDF', desc: 'Clean up and shrink the file', color: '#0c8599' },
      { a: 'ocr', icon: 'ocr', title: 'OCR', desc: 'Make scanned PDFs searchable', color: '#0c8599' },
      { a: 'flatten', icon: 'form', title: 'Flatten', desc: 'Lock form fields & markup into the page', color: '#0c8599' },
      { a: 'batch', icon: 'batch', title: 'Batch process', desc: 'Run actions on many PDFs at once', color: '#0c8599' },
      { a: 'properties', icon: 'info', title: 'Properties', desc: 'Title, author, keywords', color: '#0c8599' },
    ],
  },
];

export function ToolHub({ onAction, caps }: { onAction: (a: HubAction) => void; caps: { office: boolean; libreoffice: boolean } | null }) {
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const cats = CATS.map((c) => ({
    ...c,
    tools: c.tools.filter((t) => !needle || `${t.title} ${t.desc}`.toLowerCase().includes(needle)),
  })).filter((c) => c.tools.length);
  const officeMissing = caps && !caps.office && !caps.libreoffice;

  return (
    <div className="hub">
      <div className="hub-head">
        <input className="hub-search" placeholder="Search tools… (e.g. merge, word, sign)" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {cats.map((c) => (
        <section key={c.title}>
          <h3>{c.title}</h3>
          <div className="hub-grid">
            {c.tools.map((t) => (
              <button key={t.a} className="hub-tool" onClick={() => onAction(t.a)}>
                <span className="hub-icon" style={{ background: t.color }}>
                  <Icon name={t.icon} size={20} />
                </span>
                <span className="hub-text">
                  <b>{t.title}</b>
                  <span>{t.desc}</span>
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}
      {officeMissing && (
        <p className="muted small-text">
          Word/Excel/PowerPoint → PDF needs Microsoft Office or the free LibreOffice installed on this PC.
        </p>
      )}
    </div>
  );
}
