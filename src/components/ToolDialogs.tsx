// "All tools" dialogs: watermark, page numbers / Bates, split, properties, OCR, export.
import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';
import type { NumberOpts, WatermarkOpts, WatermarkPosition } from '../lib/ops';
import { extractPages, getMetadata, watermark } from '../lib/ops';
import { loadPdf, renderToCanvas } from '../lib/pdf';
import { IMAGE_FILTERS } from '../lib/convert';

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
      return <WatermarkDialog onClose={onClose} onRun={h.watermark} bytes={bytes} />;
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

const WM_POSITIONS: { v: WatermarkPosition; label: string }[] = [
  { v: 'top-left', label: '↖' },
  { v: 'top', label: '↑' },
  { v: 'top-right', label: '↗' },
  { v: 'bottom-left', label: '↙' },
  { v: 'center', label: '●' },
  { v: 'bottom-right', label: '↘' },
];
const WM_COLORS = ['#c62828', '#1c2340', '#7a7f93', '#1d4fbf', '#1f7a3b'];

/** Loads the installed font for a text watermark (call before ops.watermark). */
export async function resolveWatermark(o: WatermarkOpts): Promise<WatermarkOpts> {
  if (o.kind === 'image' || !o.family) return o;
  const f = await window.acro.loadFont({ family: o.family, bold: o.bold ?? true, italic: !!o.italic });
  return { ...o, fontBytes: f?.data ?? null };
}

export function WatermarkFields({ o, set, fonts, batch }: { o: WatermarkOpts; set: (o: WatermarkOpts) => void; fonts?: string[]; batch?: boolean }) {
  const kind = o.kind || 'text';
  const pickImage = async () => {
    const [f] = await window.acro.openPdfs({ multi: false, title: 'Choose a logo or image', filters: IMAGE_FILTERS });
    if (!f) return;
    const bmp = await createImageBitmap(new Blob([f.data as BlobPart]));
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext('2d')!.drawImage(bmp, 0, 0);
    set({ ...o, kind: 'image', image: c.toDataURL('image/png') });
  };
  return (
    <div className="wm-fields">
      <div className="seg">
        <button className={kind === 'text' ? 'on' : ''} onClick={() => set({ ...o, kind: 'text' })}>
          Text
        </button>
        <button className={kind === 'image' ? 'on' : ''} onClick={() => set({ ...o, kind: 'image' })}>
          Image or logo
        </button>
      </div>
      <div className="form-grid">
        {kind === 'text' ? (
          <>
            <label>Text</label>
            <input value={o.text} onChange={(e) => set({ ...o, text: e.target.value })} placeholder="CONFIDENTIAL" />
            <label>Font</label>
            <div className="row gap">
              <select value={o.family || 'Arial'} onChange={(e) => set({ ...o, family: e.target.value })} style={{ flex: 1, fontFamily: `"${o.family || 'Arial'}"` }}>
                {(fonts?.length ? fonts : ['Arial']).map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
              <button className={`small style-btn ${o.bold !== false ? 'on' : ''}`} aria-label="Bold" onClick={() => set({ ...o, bold: o.bold === false })}>
                <b>B</b>
              </button>
              <button className={`small style-btn ${o.italic ? 'on' : ''}`} aria-label="Italic" onClick={() => set({ ...o, italic: !o.italic })}>
                <i>I</i>
              </button>
            </div>
            <label>Size</label>
            <div className="row gap">
              <input type="range" min={10} max={160} value={o.size} onChange={(e) => set({ ...o, size: +e.target.value })} style={{ flex: 1 }} />
              <input type="number" className="num" min={6} max={300} value={o.size} onChange={(e) => set({ ...o, size: +e.target.value })} />
            </div>
            <label>Colour</label>
            <div className="swatches">
              {WM_COLORS.map((c) => (
                <button key={c} className={`swatch ${o.color === c ? 'on' : ''}`} style={{ background: c }} aria-label={`Colour ${c}`} onClick={() => set({ ...o, color: c })} />
              ))}
              <input type="color" value={o.color} onChange={(e) => set({ ...o, color: e.target.value })} title="Custom colour" />
            </div>
          </>
        ) : (
          <>
            <label>Image</label>
            <div className="row gap">
              {o.image && <img src={o.image} alt="" className="wm-thumb" />}
              <button onClick={pickImage}>{o.image ? 'Change…' : 'Choose image…'}</button>
            </div>
            <label>Width</label>
            <div className="row gap">
              <input type="range" min={5} max={100} value={o.imageScale ?? 40} onChange={(e) => set({ ...o, imageScale: +e.target.value })} style={{ flex: 1 }} />
              <span className="typed">{o.imageScale ?? 40}% of page</span>
            </div>
          </>
        )}
        <label>Opacity</label>
        <div className="row gap">
          <input type="range" min={0.05} max={1} step={0.05} value={o.opacity} onChange={(e) => set({ ...o, opacity: +e.target.value })} style={{ flex: 1 }} />
          <span className="typed">{Math.round(o.opacity * 100)}%</span>
        </div>
        <label>Angle</label>
        <div className="row gap">
          {[0, 45, 90, -45].map((a) => (
            <button key={a} className={`small ${(o.angle ?? (o.diagonal ? 45 : 0)) === a ? 'on' : ''}`} onClick={() => set({ ...o, angle: a, diagonal: false })}>
              {a}°
            </button>
          ))}
          <input type="number" className="num" min={-180} max={180} value={o.angle ?? (o.diagonal ? 45 : 0)} onChange={(e) => set({ ...o, angle: +e.target.value, diagonal: false })} />
        </div>
        <label>Position</label>
        <div className="row gap">
          <div className="pos-grid" role="radiogroup" aria-label="Position">
            {WM_POSITIONS.map((p) => (
              <button
                key={p.v}
                role="radio"
                aria-checked={(o.position || 'center') === p.v}
                className={(o.position || 'center') === p.v ? 'on' : ''}
                onClick={() => set({ ...o, position: p.v })}
                title={p.v}
              >
                {p.label}
              </button>
            ))}
          </div>
          <button className={`small ${o.position === 'tile' ? 'on' : ''}`} onClick={() => set({ ...o, position: 'tile' })}>
            Tile across page
          </button>
        </div>
        <label>Layer</label>
        <div className="seg small">
          <button className={!o.behind ? 'on' : ''} onClick={() => set({ ...o, behind: false })}>
            On top
          </button>
          <button className={o.behind ? 'on' : ''} onClick={() => set({ ...o, behind: true })}>
            Behind content
          </button>
        </div>
        {!batch && (
          <>
            <label>Pages</label>
            <input value={o.pages || ''} placeholder="All pages (or e.g. 1-3, 5)" onChange={(e) => set({ ...o, pages: e.target.value })} />
          </>
        )}
      </div>
    </div>
  );
}

export const defaultWatermark: WatermarkOpts = {
  kind: 'text',
  text: 'CONFIDENTIAL',
  size: 64,
  color: '#c62828',
  opacity: 0.18,
  diagonal: false,
  angle: 45,
  family: 'Arial',
  bold: true,
  position: 'center',
  imageScale: 40,
};
export const defaultNumbers: NumberOpts = { format: 'Page {n} of {total}', position: 'bottom-center', size: 10, start: 1 };

function WatermarkDialog({ onClose, onRun, bytes }: { onClose: () => void; onRun: (o: WatermarkOpts) => void; bytes: Uint8Array }) {
  const [o, set] = useState(defaultWatermark);
  const [fonts, setFonts] = useState<string[]>([]);
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    window.acro.listFonts().then(setFonts).catch(() => {});
  }, []);
  // live preview of page 1 with the watermark applied
  useEffect(() => {
    let alive = true;
    const t = setTimeout(async () => {
      try {
        const first = await extractPages(bytes, [0]);
        const out = await watermark(first, await resolveWatermark({ ...o, pages: '' }));
        const doc = await loadPdf(out);
        const page = await doc.getPage(1);
        const base = page.getViewport({ scale: 1 });
        if (alive && canvas.current) await renderToCanvas(page, 300 / base.width, canvas.current);
        doc.destroy();
      } catch {
        /* preview only */
      }
    }, 220);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [o, bytes]);
  return (
    <Modal
      title="Watermark"
      onClose={onClose}
      width={820}
      footer={<Foot onClose={onClose} onRun={() => onRun(o)} label={o.pages?.trim() ? `Apply to pages ${o.pages}` : 'Apply to all pages'} />}
    >
      <div className="wm-layout">
        <WatermarkFields o={o} set={set} fonts={fonts} />
        <figure className="wm-preview">
          <canvas ref={canvas} />
          <figcaption>Preview: page 1</figcaption>
        </figure>
      </div>
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
