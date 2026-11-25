// "All tools" dialogs: watermark, page numbers / Bates, split, properties, OCR, export.
import { useEffect, useState } from 'react';
import { Modal } from './Modal';
import type { NumberOpts, WatermarkOpts } from '../lib/ops';
import { getMetadata } from '../lib/ops';

export type ToolKind = 'watermark' | 'numbers' | 'split' | 'properties' | 'ocr' | 'exportImages' | 'toWord';

export interface ToolHandlers {
  watermark(o: WatermarkOpts): void;
  numbers(o: NumberOpts): void;
  split(spec: { everyN?: number; ranges?: string }): void;
  properties(meta: { title: string; author: string; subject: string; keywords: string }): void;
  ocr(o: { lang: string; scope: 'all' | 'current' }): void;
  exportImages(o: { format: 'png' | 'jpeg'; dpi: number }): void;
  toWord(mode: 'text' | 'exact'): void;
}

export function ToolDialog({
  kind,
  bytes,
  numPages,
  onClose,
  h,
}: {
  kind: ToolKind;
  bytes: Uint8Array;
  numPages: number;
  onClose: () => void;
  h: ToolHandlers;
}) {
  switch (kind) {
    case 'watermark':
      return <WatermarkDialog onClose={onClose} onRun={h.watermark} />;
    case 'numbers':
      return <NumbersDialog onClose={onClose} onRun={h.numbers} />;
    case 'split':
      return <SplitDialog onClose={onClose} onRun={h.split} numPages={numPages} />;
    case 'properties':
      return <PropsDialog onClose={onClose} onRun={h.properties} bytes={bytes} />;
    case 'ocr':
      return <OcrDialog onClose={onClose} onRun={h.ocr} />;
    case 'exportImages':
      return <ExportDialog onClose={onClose} onRun={h.exportImages} />;
    case 'toWord':
      return <WordDialog onClose={onClose} onRun={h.toWord} />;
  }
}

function WordDialog({ onClose, onRun }: { onClose: () => void; onRun: (m: 'text' | 'exact') => void }) {
  const [mode, setMode] = useState<'text' | 'exact'>('text');
  return (
    <Modal title="PDF to Word" onClose={onClose} footer={<Foot onClose={onClose} onRun={() => onRun(mode)} label="Convert & save .docx" />}>
      <label className="choice">
        <input type="radio" checked={mode === 'text'} onChange={() => setMode('text')} />
        <span>
          <b>Editable text</b>
          <span className="muted"> — paragraphs, sizes and bold are kept so you can edit in Word. Layout is simplified.</span>
        </span>
      </label>
      <label className="choice">
        <input type="radio" checked={mode === 'exact'} onChange={() => setMode('exact')} />
        <span>
          <b>Exact look</b>
          <span className="muted"> — each page placed as an image. Looks identical, but text isn't editable.</span>
        </span>
      </label>
      <p className="muted small-text">Scanned PDF? Run OCR first so there's text to convert.</p>
    </Modal>
  );
}

function Foot({ onClose, onRun, label }: { onClose: () => void; onRun: () => void; label: string }) {
  return (
    <>
      <button onClick={onClose}>Cancel</button>
      <button className="primary" onClick={onRun}>
        {label}
      </button>
    </>
  );
}

export function WatermarkFields({ o, set }: { o: WatermarkOpts; set: (o: WatermarkOpts) => void }) {
  return (
    <div className="form-grid">
      <label>Text</label>
      <input value={o.text} onChange={(e) => set({ ...o, text: e.target.value })} />
      <label>Size</label>
      <input type="number" min={8} max={200} value={o.size} onChange={(e) => set({ ...o, size: +e.target.value })} />
      <label>Color</label>
      <input type="color" value={o.color} onChange={(e) => set({ ...o, color: e.target.value })} />
      <label>Opacity</label>
      <input type="range" min={0.05} max={1} step={0.05} value={o.opacity} onChange={(e) => set({ ...o, opacity: +e.target.value })} />
      <label>Diagonal</label>
      <input type="checkbox" checked={o.diagonal} onChange={(e) => set({ ...o, diagonal: e.target.checked })} />
    </div>
  );
}

export const defaultWatermark: WatermarkOpts = { text: 'CONFIDENTIAL', size: 64, color: '#c62828', opacity: 0.18, diagonal: true };
export const defaultNumbers: NumberOpts = { format: 'Page {n} of {total}', position: 'bottom-center', size: 10, start: 1 };

function WatermarkDialog({ onClose, onRun }: { onClose: () => void; onRun: (o: WatermarkOpts) => void }) {
  const [o, set] = useState(defaultWatermark);
  return (
    <Modal title="Add watermark" onClose={onClose} footer={<Foot onClose={onClose} onRun={() => onRun(o)} label="Apply to all pages" />}>
      <WatermarkFields o={o} set={set} />
    </Modal>
  );
}

export function NumberFields({ o, set }: { o: NumberOpts; set: (o: NumberOpts) => void }) {
  return (
    <div className="form-grid">
      <label>Format</label>
      <div>
        <input value={o.format} onChange={(e) => set({ ...o, format: e.target.value })} />
        <div className="hint">
          {'{n}'} page · {'{total}'} count · {'{n:6}'} zero-padded (Bates, e.g. <code>MF-{'{n:6}'}</code>)
        </div>
      </div>
      <label>Position</label>
      <select value={o.position} onChange={(e) => set({ ...o, position: e.target.value as NumberOpts['position'] })}>
        {['bottom-center', 'bottom-right', 'bottom-left', 'top-center', 'top-right', 'top-left'].map((p) => (
          <option key={p}>{p}</option>
        ))}
      </select>
      <label>Start at</label>
      <input type="number" value={o.start} onChange={(e) => set({ ...o, start: +e.target.value })} />
      <label>Font size</label>
      <input type="number" value={o.size} min={6} max={36} onChange={(e) => set({ ...o, size: +e.target.value })} />
    </div>
  );
}

function NumbersDialog({ onClose, onRun }: { onClose: () => void; onRun: (o: NumberOpts) => void }) {
  const [o, set] = useState(defaultNumbers);
  return (
    <Modal title="Page numbers / Bates numbering" onClose={onClose} footer={<Foot onClose={onClose} onRun={() => onRun(o)} label="Apply" />}>
      <NumberFields o={o} set={set} />
    </Modal>
  );
}

function SplitDialog({ onClose, onRun, numPages }: { onClose: () => void; onRun: (s: { everyN?: number; ranges?: string }) => void; numPages: number }) {
  const [mode, setMode] = useState<'n' | 'ranges'>('n');
  const [n, setN] = useState(1);
  const [ranges, setRanges] = useState(`1-${Math.ceil(numPages / 2)}, ${Math.ceil(numPages / 2) + 1}-end`);
  return (
    <Modal
      title="Split PDF"
      onClose={onClose}
      footer={<Foot onClose={onClose} onRun={() => onRun(mode === 'n' ? { everyN: n } : { ranges })} label="Split & choose folder" />}
    >
      <div className="seg">
        <button className={mode === 'n' ? 'on' : ''} onClick={() => setMode('n')}>
          Every N pages
        </button>
        <button className={mode === 'ranges' ? 'on' : ''} onClick={() => setMode('ranges')}>
          Page ranges
        </button>
      </div>
      {mode === 'n' ? (
        <div className="form-grid">
          <label>Pages per file</label>
          <input type="number" min={1} max={numPages} value={n} onChange={(e) => setN(+e.target.value)} />
          <span />
          <div className="hint">Creates {Math.ceil(numPages / Math.max(1, n))} files.</div>
        </div>
      ) : (
        <div className="form-grid">
          <label>Ranges</label>
          <input value={ranges} onChange={(e) => setRanges(e.target.value)} />
          <span />
          <div className="hint">One output file per range, e.g. "1-3, 4, 5-end".</div>
        </div>
      )}
    </Modal>
  );
}

function PropsDialog({ onClose, onRun, bytes }: { onClose: () => void; onRun: (m: any) => void; bytes: Uint8Array }) {
  const [m, set] = useState<any>(null);
  useEffect(() => {
    getMetadata(bytes).then(set).catch(() => set({ title: '', author: '', subject: '', keywords: '', pages: '?' }));
  }, [bytes]);
  if (!m) return null;
  return (
    <Modal title="Document properties" onClose={onClose} footer={<Foot onClose={onClose} onRun={() => onRun(m)} label="Save properties" />}>
      <div className="form-grid">
        {(['title', 'author', 'subject', 'keywords'] as const).map((k) => (
          <FragmentField key={k} label={k} value={m[k]} onChange={(v) => set({ ...m, [k]: v })} />
        ))}
        <label>Pages</label>
        <div>{m.pages}</div>
        <label>Producer</label>
        <div className="muted">{m.producer || '—'}</div>
        <label>Creator</label>
        <div className="muted">{m.creator || '—'}</div>
      </div>
    </Modal>
  );
}

function FragmentField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <>
      <label style={{ textTransform: 'capitalize' }}>{label}</label>
      <input value={value} onChange={(e) => onChange(e.target.value)} />
    </>
  );
}

function OcrDialog({ onClose, onRun }: { onClose: () => void; onRun: (o: { lang: string; scope: 'all' | 'current' }) => void }) {
  const [lang, setLang] = useState('eng');
  const [scope, setScope] = useState<'all' | 'current'>('all');
  return (
    <Modal title="Recognize text (OCR)" onClose={onClose} footer={<Foot onClose={onClose} onRun={() => onRun({ lang, scope })} label="Run OCR" />}>
      <p className="muted">
        Makes scanned pages searchable and selectable by adding an invisible text layer. The page image stays untouched. The
        first run downloads the language model (internet needed once).
      </p>
      <div className="form-grid">
        <label>Language</label>
        <select value={lang} onChange={(e) => setLang(e.target.value)}>
          <option value="eng">English</option>
          <option value="fil">Filipino</option>
          <option value="eng+fil">English + Filipino</option>
          <option value="spa">Spanish</option>
          <option value="chi_sim">Chinese (Simplified)</option>
          <option value="jpn">Japanese</option>
        </select>
        <label>Pages</label>
        <select value={scope} onChange={(e) => setScope(e.target.value as 'all' | 'current')}>
          <option value="all">All pages</option>
          <option value="current">Current page</option>
        </select>
      </div>
    </Modal>
  );
}

function ExportDialog({ onClose, onRun }: { onClose: () => void; onRun: (o: { format: 'png' | 'jpeg'; dpi: number }) => void }) {
  const [format, setFormat] = useState<'png' | 'jpeg'>('png');
  const [dpi, setDpi] = useState(150);
  return (
    <Modal title="Export pages as images" onClose={onClose} footer={<Foot onClose={onClose} onRun={() => onRun({ format, dpi })} label="Export & choose folder" />}>
      <div className="form-grid">
        <label>Format</label>
        <select value={format} onChange={(e) => setFormat(e.target.value as 'png' | 'jpeg')}>
          <option value="png">PNG</option>
          <option value="jpeg">JPEG</option>
        </select>
        <label>Resolution</label>
        <select value={dpi} onChange={(e) => setDpi(+e.target.value)}>
          <option value={72}>72 dpi (screen)</option>
          <option value={150}>150 dpi</option>
          <option value={300}>300 dpi (print)</option>
        </select>
      </div>
    </Modal>
  );
}
