// Dialogs for the page-layout tools: crop, pages per sheet / booklet, headers and footers.
import { useState } from 'react';
import { Modal } from './Modal';

// ---------------------------------------------------------------- crop
export interface CropRequest {
  /** points, as the reader sees the page */
  margins: { top: number; right: number; bottom: number; left: number };
  /** "" = all pages, or ranges / odd / even */
  pages: string;
  reset: boolean;
}
const MM = 72 / 25.4;

export function CropDialog({ numPages, currentPage, onClose, onRun }: { numPages: number; currentPage: number; onClose: () => void; onRun: (r: CropRequest) => void }) {
  const [m, setM] = useState({ top: 10, right: 10, bottom: 10, left: 10 });
  const [scope, setScope] = useState<'all' | 'current' | 'range' | 'odd' | 'even'>('all');
  const [range, setRange] = useState(`1-${numPages}`);
  const [err, setErr] = useState('');
  const pages = scope === 'all' ? '' : scope === 'current' ? String(currentPage + 1) : scope === 'range' ? range : scope;
  const run = (reset: boolean) => {
    if (scope === 'range' && !range.trim()) return setErr('Type the pages to crop, like 1-3, 6.');
    onRun({ margins: { top: m.top * MM, right: m.right * MM, bottom: m.bottom * MM, left: m.left * MM }, pages, reset });
  };
  const field = (k: keyof typeof m, label: string) => (
    <>
      <label>{label}</label>
      <input type="number" min={0} step={1} value={m[k]} onChange={(e) => setM({ ...m, [k]: Math.max(0, +e.target.value || 0) })} />
    </>
  );
  return (
    <Modal
      title="Crop pages"
      onClose={onClose}
      width={480}
      footer={
        <>
          <button onClick={() => run(true)} title="Show the full page again">
            Reset to full size
          </button>
          <button className="primary" onClick={() => run(false)}>
            Crop
          </button>
        </>
      }
    >
      <p className="muted">Cut this much off each edge, in millimetres. The page is trimmed on screen and in print, but the cut-off part stays in the file. Use Redact to remove something for good.</p>
      <div className="form-grid">
        {field('top', 'Top')}
        {field('bottom', 'Bottom')}
        {field('left', 'Left')}
        {field('right', 'Right')}
        <label>Pages</label>
        <select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
          <option value="all">All pages</option>
          <option value="current">This page only (page {currentPage + 1})</option>
          <option value="odd">Odd pages</option>
          <option value="even">Even pages</option>
          <option value="range">A range…</option>
        </select>
        {scope === 'range' && (
          <>
            <label>Range</label>
            <input value={range} onChange={(e) => setRange(e.target.value)} placeholder="1-3, 6" />
          </>
        )}
      </div>
      {err && <p className="merge-err">{err}</p>}
    </Modal>
  );
}

// ---------------------------------------------------------------- several pages per sheet / booklet
export interface SheetsRequest {
  mode: 'nup' | 'booklet';
  cols: number;
  rows: number;
  paper: 'A4' | 'A3' | 'Letter' | 'Legal' | 'first';
  landscape: boolean;
  border: boolean;
  rightToLeft: boolean;
}

const NUP: { label: string; cols: number; rows: number; landscape: boolean }[] = [
  { label: '2 per sheet', cols: 2, rows: 1, landscape: true },
  { label: '4 per sheet', cols: 2, rows: 2, landscape: false },
  { label: '6 per sheet', cols: 2, rows: 3, landscape: false },
  { label: '9 per sheet', cols: 3, rows: 3, landscape: false },
];

export function SheetsDialog({ numPages, onClose, onRun }: { numPages: number; onClose: () => void; onRun: (r: SheetsRequest) => void }) {
  const [mode, setMode] = useState<'nup' | 'booklet'>('nup');
  const [pick, setPick] = useState(1);
  const [paper, setPaper] = useState<SheetsRequest['paper']>('A4');
  const [border, setBorder] = useState(true);
  const [rtl, setRtl] = useState(false);
  const n = NUP[pick];
  const sheets = mode === 'booklet' ? Math.ceil(numPages / 4) : Math.ceil(numPages / (n.cols * n.rows));
  return (
    <Modal
      title="Pages per sheet and booklet"
      onClose={onClose}
      width={500}
      footer={
        <button
          className="primary"
          onClick={() => onRun(mode === 'booklet' ? { mode, cols: 2, rows: 1, paper, landscape: true, border: false, rightToLeft: rtl } : { mode, cols: n.cols, rows: n.rows, paper, landscape: n.landscape, border, rightToLeft: false })}
        >
          Make a new PDF
        </button>
      }
    >
      <p className="muted">Builds a new PDF ready to print. Your open file is not changed.</p>
      <div className="seg">
        <button className={mode === 'nup' ? 'on' : ''} onClick={() => setMode('nup')}>
          Several pages on one sheet
        </button>
        <button className={mode === 'booklet' ? 'on' : ''} onClick={() => setMode('booklet')}>
          Booklet
        </button>
      </div>
      <div className="form-grid">
        {mode === 'nup' && (
          <>
            <label>Layout</label>
            <select value={pick} onChange={(e) => setPick(+e.target.value)}>
              {NUP.map((x, i) => (
                <option key={x.label} value={i}>
                  {x.label}
                </option>
              ))}
            </select>
          </>
        )}
        <label>Paper</label>
        <select value={paper} onChange={(e) => setPaper(e.target.value as SheetsRequest['paper'])}>
          <option value="A4">A4</option>
          <option value="Letter">Letter</option>
          <option value="Legal">Legal</option>
          <option value="A3">A3</option>
          <option value="first">Same as page 1</option>
        </select>
      </div>
      {mode === 'nup' ? (
        <label className="check">
          <input type="checkbox" checked={border} onChange={(e) => setBorder(e.target.checked)} /> Thin border around each page
        </label>
      ) : (
        <label className="check">
          <input type="checkbox" checked={rtl} onChange={(e) => setRtl(e.target.checked)} /> Right-to-left language (flip the spread)
        </label>
      )}
      <p className="hint">
        {mode === 'booklet'
          ? `Makes ${sheets * 2} sides on ${sheets} sheet${sheets === 1 ? '' : 's'}. Print double-sided, flip on the short edge, fold the stack in half. Blank pages are added at the end to fill the last sheet.`
          : `Makes ${sheets} sheet${sheets === 1 ? '' : 's'} from ${numPages} page${numPages === 1 ? '' : 's'}.`}
      </p>
    </Modal>
  );
}

// ---------------------------------------------------------------- headers and footers
export interface HeaderFooterRequest {
  header: { left: string; center: string; right: string };
  footer: { left: string; center: string; right: string };
  size: number;
  color: string;
  bold: boolean;
  /** millimetres from the page edge */
  marginMm: number;
  start: number;
  pages: string;
  skipFirst: boolean;
}

const HF_KEY = 'acro.headerfooter.v1';
const HF_DEFAULT: HeaderFooterRequest = {
  header: { left: '{file}', center: '', right: '{date}' },
  footer: { left: '', center: 'Page {n} of {total}', right: '' },
  size: 9,
  color: '#333333',
  bold: false,
  marginMm: 10,
  start: 1,
  pages: '',
  skipFirst: false,
};

export function HeaderFooterDialog({ onClose, onRun }: { onClose: () => void; onRun: (r: HeaderFooterRequest) => void }) {
  const [o, setO] = useState<HeaderFooterRequest>(() => {
    try {
      return { ...HF_DEFAULT, ...JSON.parse(localStorage.getItem(HF_KEY) || '{}') };
    } catch {
      return HF_DEFAULT;
    }
  });
  const row = (which: 'header' | 'footer', label: string) => (
    <>
      <label>{label}</label>
      <div className="hf-row">
        {(['left', 'center', 'right'] as const).map((side) => (
          <input key={side} placeholder={side} value={o[which][side]} onChange={(e) => setO({ ...o, [which]: { ...o[which], [side]: e.target.value } })} />
        ))}
      </div>
    </>
  );
  const go = () => {
    try {
      localStorage.setItem(HF_KEY, JSON.stringify(o));
    } catch {
      /* ignore */
    }
    onRun(o);
  };
  return (
    <Modal
      title="Headers and footers"
      onClose={onClose}
      width={700}
      footer={
        <button className="primary" onClick={go}>
          Apply
        </button>
      }
    >
      <div className="form-grid">
        {row('header', 'Header')}
        {row('footer', 'Footer')}
        <span />
        <div className="hint">
          {'{n}'} page number · {'{total}'} page count · {'{n:6}'} zero-padded · {'{date}'} today · {'{time}'} now · {'{file}'} file name · {'{title}'} document title
        </div>
        <label>Font size</label>
        <input type="number" min={6} max={36} value={o.size} onChange={(e) => setO({ ...o, size: +e.target.value || 9 })} />
        <label>Colour</label>
        <input type="color" value={o.color} onChange={(e) => setO({ ...o, color: e.target.value })} />
        <label>Distance from edge (mm)</label>
        <input type="number" min={3} max={50} value={o.marginMm} onChange={(e) => setO({ ...o, marginMm: +e.target.value || 10 })} />
        <label>First page number</label>
        <input type="number" value={o.start} onChange={(e) => setO({ ...o, start: +e.target.value })} />
        <label>Pages</label>
        <input value={o.pages} placeholder="All pages, or 2-5, odd, even" onChange={(e) => setO({ ...o, pages: e.target.value })} />
      </div>
      <label className="check">
        <input type="checkbox" checked={o.bold} onChange={(e) => setO({ ...o, bold: e.target.checked })} /> Bold
      </label>
      <label className="check">
        <input type="checkbox" checked={o.skipFirst} onChange={(e) => setO({ ...o, skipFirst: e.target.checked })} /> Leave the first page blank (cover page)
      </label>
    </Modal>
  );
}

// ---------------------------------------------------------------- PDF/A
export function PdfaDialog({ onClose, onRun }: { onClose: () => void; onRun: () => void }) {
  return (
    <Modal
      title="Save as PDF/A (archive copy)"
      onClose={onClose}
      width={500}
      footer={
        <button className="primary" onClick={onRun}>
          Make the archive copy
        </button>
      }
    >
      <p className="muted">PDF/A is the format for keeping documents for years. It adds identifying information and a colour profile, and takes out things that can change or break later: scripts, launch actions, attached files and hidden notes.</p>
      <p className="muted">Your open file is not changed. A new file is saved, and you will see what was done.</p>
      <p className="hint">One thing this cannot do: put a missing font into the file. If the report lists fonts that are not stored, the copy is a good attempt but is not a guaranteed PDF/A. Check important files with a PDF/A validator.</p>
    </Modal>
  );
}

export function PdfaReportDialog({ report, saved, onClose }: { report: { fixed: string[]; problems: string[]; likelyCompliant: boolean }; saved: string; onClose: () => void }) {
  return (
    <Modal title={report.likelyCompliant ? 'Archive copy saved' : 'Archive copy saved, with a warning'} onClose={onClose} width={540} footer={<button className="primary" onClick={onClose}>Done</button>}>
      <p className="muted">Saved as {saved}.</p>
      {report.problems.map((p, i) => (
        <p key={i} className="merge-err">
          {p}
        </p>
      ))}
      <label>What was done</label>
      <ul className="plain-list">
        {report.fixed.map((f, i) => (
          <li key={i}>{f}</li>
        ))}
      </ul>
    </Modal>
  );
}
