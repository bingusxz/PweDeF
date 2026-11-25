// "All tools" dialogs: watermark, page numbers / Bates, split, properties, OCR, export.
import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';
import type { NumberOpts, WatermarkOpts, WatermarkPosition } from '../lib/ops';
import { extractPages, getMetadata, watermark, type SplitSpec } from '../lib/ops';
import { NON_LATIN } from '../lib/util';
import { BUNDLED_LANGS, type OcrOptions } from '../lib/ocr';
import { CompareDialog } from './CompareDialog';
import { createSelfSigned, loadPfx, verifySignatures, type Credentials, type SigReport } from '../lib/digitalSign';
import type { WordMode } from '../lib/toWord';
import type { PptMode } from '../lib/toPowerPoint';
import { OPTIMIZE_PRESETS, type OptimizeOptions, type OptimizePreset } from '../lib/optimize';
import { loadPdf, renderToCanvas } from '../lib/pdf';
import { IMAGE_FILTERS } from '../lib/convert';

/** What the Split dialog asks for. Bookmarks are resolved by the editor, which has the open document. */
export type SplitRequest = SplitSpec & { bookmarks?: boolean };
export type ToolKind = 'watermark' | 'numbers' | 'split' | 'properties' | 'ocr' | 'exportImages' | 'toWord' | 'toPpt' | 'optimize' | 'certSign' | 'sigCheck' | 'compare';

export interface ToolHandlers {
  watermark(o: WatermarkOpts): void;
  numbers(o: NumberOpts): void;
  split(spec: SplitRequest): void;
  properties(meta: { title: string; author: string; subject: string; keywords: string }): void;
  ocr(o: OcrRequest): void;
  exportImages(o: { format: 'png' | 'jpeg'; dpi: number }): void;
  toWord(mode: WordMode): void;
  toPpt(mode: PptMode): void;
  certSign(o: CertSignRequest): void;
  optimize(o: OptimizeOptions): void;
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
    case 'toPpt':
      return <PptDialog onClose={onClose} onRun={h.toPpt} />;
    case 'certSign':
      return <CertSignDialog onClose={onClose} onRun={h.certSign} />;
    case 'sigCheck':
      return <SigCheckDialog onClose={onClose} bytes={bytes} />;
    case 'compare':
      return <CompareDialog onClose={onClose} initialA={{ name: 'This document', data: bytes }} />;
    case 'optimize':
      return <OptimizeDialog onClose={onClose} onRun={h.optimize} size={bytes.length} />;
  }
}

function OptimizeDialog({ onClose, onRun, size }: { onClose: () => void; onRun: (o: OptimizeOptions) => void; size: number }) {
  const [preset, setPreset] = useState<OptimizePreset>('balanced');
  const [stripMetadata, setStripMetadata] = useState(false);
  const [stripAttachments, setStripAttachments] = useState(false);
  const mb = size >= 1048576 ? `${(size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`;
  return (
    <Modal
      title="Optimize PDF"
      onClose={onClose}
      footer={<Foot onClose={onClose} onRun={() => onRun({ preset, stripMetadata, stripAttachments })} label="Optimize" />}
    >
      <p className="muted">Current size: {mb}. Pictures are scaled down and re-compressed, and unused data is removed. Text stays text, so search and copy keep working.</p>
      {(Object.keys(OPTIMIZE_PRESETS) as OptimizePreset[]).map((k) => (
        <label className="choice" key={k}>
          <input type="radio" checked={preset === k} onChange={() => setPreset(k)} />
          <span>
            <b>{OPTIMIZE_PRESETS[k].name}</b>
            <span className="muted">: {OPTIMIZE_PRESETS[k].hint}</span>
          </span>
        </label>
      ))}
      <label className="check">
        <input type="checkbox" checked={stripMetadata} onChange={(e) => setStripMetadata(e.target.checked)} /> Remove document info (title, author, keywords)
      </label>
      <label className="check">
        <input type="checkbox" checked={stripAttachments} onChange={(e) => setStripAttachments(e.target.checked)} /> Remove attached files
      </label>
      <p className="hint">If the file can't be made smaller, it is left as it is.</p>
    </Modal>
  );
}

export interface CertSignRequest {
  cred: Credentials;
  reason: string;
  location: string;
  contact: string;
  visible: boolean;
}

function CertSignDialog({ onClose, onRun }: { onClose: () => void; onRun: (o: CertSignRequest) => void }) {
  const [file, setFile] = useState<{ name: string; data: Uint8Array } | null>(null);
  const [password, setPassword] = useState('');
  const [reason, setReason] = useState('I approve this document');
  const [location, setLocation] = useState('');
  const [contact, setContact] = useState('');
  const [visible, setVisible] = useState(true);
  const [err, setErr] = useState('');
  const [make, setMake] = useState(false);
  const [mk, setMk] = useState({ name: '', org: '', pw: '' });
  const [working, setWorking] = useState(false);

  const choose = async () => {
    const f = await window.acro.openPdfs({ title: 'Choose your certificate file', filters: [{ name: 'Certificate', extensions: ['pfx', 'p12'] }] });
    if (f[0]) {
      setFile({ name: f[0].name, data: f[0].data });
      setErr('');
    }
  };
  const create = async () => {
    if (!mk.name.trim() || mk.pw.length < 4) return setErr('Enter your name and a password of at least 4 characters.');
    setWorking(true);
    setErr('');
    await new Promise((r) => setTimeout(r, 50)); // let the "working" state paint: making the key takes a few seconds
    try {
      const pfx = createSelfSigned({ name: mk.name.trim(), org: mk.org.trim() || undefined, password: mk.pw });
      const saved = await window.acro.saveFile(`${mk.name.trim().replace(/[^\w -]+/g, '')}-certificate.pfx`, pfx, [{ name: 'Certificate', extensions: ['pfx'] }]);
      if (saved) {
        setFile({ name: saved.split(/[\\/]/).pop() || 'certificate.pfx', data: pfx });
        setPassword(mk.pw);
        setMake(false);
      }
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setWorking(false);
    }
  };
  const go = () => {
    if (!file) return setErr('Choose your certificate file first.');
    try {
      onRun({ cred: loadPfx(file.data, password), reason: reason.trim(), location: location.trim(), contact: contact.trim(), visible });
    } catch (e: any) {
      setErr(String(e?.message || e));
    }
  };
  return (
    <Modal title="Sign with a certificate" onClose={onClose} width={560} footer={<Foot onClose={onClose} onRun={go} label={visible ? 'Draw signature box' : 'Sign & save a copy'} />}>
      <p className="muted">
        A digital signature proves who signed and that the file hasn't changed since. It's saved as a <b>new copy</b>. Sign last: any later edit breaks it.
      </p>
      <div className="form-grid">
        <label>Certificate</label>
        <span className="cert-pick">
          <button onClick={choose}>{file ? 'Change…' : 'Choose .pfx file…'}</button> <span className="muted">{file?.name || 'no file chosen'}</span>
        </span>
        <label>Password</label>
        <input type="password" value={password} autoComplete="off" onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} />
        <label>Reason</label>
        <input value={reason} onChange={(e) => setReason(e.target.value)} />
        <label>Location</label>
        <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="optional" />
        <label>Contact</label>
        <input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="optional" />
      </div>
      <label className="check">
        <input type="checkbox" checked={visible} onChange={(e) => setVisible(e.target.checked)} /> Show a signature box on the page (you draw where)
      </label>
      {err && <p className="merge-err">{err}</p>}
      <p className="hint">
        No certificate?{' '}
        <button className="link-btn" onClick={() => setMake((v) => !v)}>
          Make your own
        </button>
        . Readers like Adobe will say "identity not verified" for these, which is normal. A company certificate from a recognised authority shows as trusted.
      </p>
      {make && (
        <div className="form-grid">
          <label>Your name</label>
          <input value={mk.name} onChange={(e) => setMk({ ...mk, name: e.target.value })} />
          <label>Company</label>
          <input value={mk.org} onChange={(e) => setMk({ ...mk, org: e.target.value })} placeholder="optional" />
          <label>New password</label>
          <input type="password" value={mk.pw} autoComplete="new-password" onChange={(e) => setMk({ ...mk, pw: e.target.value })} />
          <span />
          <button disabled={working} onClick={create}>
            {working ? 'Making your certificate…' : 'Create & save .pfx'}
          </button>
        </div>
      )}
    </Modal>
  );
}

function SigCheckDialog({ onClose, bytes }: { onClose: () => void; bytes: Uint8Array }) {
  const [reports, setReports] = useState<SigReport[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    verifySignatures(bytes).then(setReports).catch((e) => setErr(String(e?.message || e)));
  }, [bytes]);
  const label = { valid: 'Valid', modified: 'Changed after signing', invalid: 'Not valid' } as const;
  return (
    <Modal title="Digital signatures" onClose={onClose} width={560}>
      {err && <p className="merge-err">{err}</p>}
      {!reports && !err && <p className="muted">Checking…</p>}
      {reports && !reports.length && <p className="muted">This PDF has no digital signatures.</p>}
      {reports?.map((r, i) => (
        <div key={i} className={`sig-card ${r.status}`}>
          <b>
            {label[r.status]} · {r.signer}
          </b>
          <small>
            {r.signedAt ? `Signed ${r.signedAt.toLocaleString()}` : 'Signing date unknown'}
            {r.reason ? ` · ${r.reason}` : ''}
            {r.location ? ` · ${r.location}` : ''}
          </small>
          {r.issuer && !r.selfSigned && <small>Issued by {r.issuer}</small>}
          {r.notes.map((n) => (
            <small key={n}>{n}</small>
          ))}
        </div>
      ))}
    </Modal>
  );
}

function WordDialog({ onClose, onRun }: { onClose: () => void; onRun: (m: WordMode) => void }) {
  const [mode, setMode] = useState<WordMode>('flow');
  const opt = (m: WordMode, title: string, text: string) => (
    <label className="choice">
      <input type="radio" checked={mode === m} onChange={() => setMode(m)} />
      <span>
        <b>{title}</b>
        <span className="muted">: {text}</span>
      </span>
    </label>
  );
  return (
    <Modal title="PDF to Word" onClose={onClose} footer={<Foot onClose={onClose} onRun={() => onRun(mode)} label="Convert & save .docx" />}>
      {opt('flow', 'Flowing text', 'real paragraphs, fonts, tables and pictures in reading order. Best for editing and reusing the content.')}
      {opt('layout', 'Retain page layout', 'looks like the PDF page. Every line is an editable text frame over the page background.')}
      {opt('exact', 'Exact picture', 'each page placed as an image. Identical look, text is not editable.')}
      <p className="muted small-text">Scanned PDF? Run OCR first so there's text to convert.</p>
    </Modal>
  );
}

function PptDialog({ onClose, onRun }: { onClose: () => void; onRun: (m: PptMode) => void }) {
  const [mode, setMode] = useState<PptMode>('editable');
  return (
    <Modal title="PDF to PowerPoint" onClose={onClose} footer={<Foot onClose={onClose} onRun={() => onRun(mode)} label="Convert & save .pptx" />}>
      <label className="choice">
        <input type="radio" checked={mode === 'editable'} onChange={() => setMode('editable')} />
        <span>
          <b>Editable slides</b>
          <span className="muted">: one slide per page with the page's pictures and lines as the background and the words as real text boxes you can edit.</span>
        </span>
      </label>
      <label className="choice">
        <input type="radio" checked={mode === 'exact'} onChange={() => setMode('exact')} />
        <span>
          <b>Exact picture</b>
          <span className="muted">: each page placed as one image. Identical look, nothing is editable.</span>
        </span>
      </label>
      <p className="muted small-text">Pages whose text can't be separated safely stay as pictures automatically.</p>
    </Modal>
  );
}

function Foot({ onClose, onRun, label }: { onClose: () => void; onRun: () => void; label: string }) {
  return (
    <>
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
  if (o.kind === 'image') return o;
  const wide = NON_LATIN.test(o.text || '');
  if (!o.family && !wide) return o;
  // chosen family first; for ₱, Cyrillic, CJK… fall back to wide-coverage fonts so the text can be drawn
  for (const family of [o.family, ...(wide ? WIDE_FONTS : [])]) {
    if (!family) continue;
    const f = await window.acro.loadFont({ family, bold: o.bold ?? true, italic: !!o.italic });
    if (f?.data) return { ...o, fontBytes: f.data };
  }
  return { ...o, fontBytes: null };
}

const WIDE_FONTS = ['Segoe UI', 'Arial', 'Nirmala UI', 'Microsoft YaHei', 'Yu Gothic', 'Malgun Gothic'];

/** Page numbers / Bates text with ₱ or non-Latin characters need an installed font that has them. */
export async function resolveNumbers(o: NumberOpts): Promise<NumberOpts> {
  if (!NON_LATIN.test(o.format)) return o;
  for (const family of WIDE_FONTS) {
    const f = await window.acro.loadFont({ family, bold: false, italic: false });
    if (f?.data) return { ...o, fontBytes: f.data };
  }
  return o;
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

function SplitDialog({ onClose, onRun, numPages }: { onClose: () => void; onRun: (s: SplitRequest) => void; numPages: number }) {
  type Mode = 'n' | 'ranges' | 'size' | 'bookmarks';
  const [mode, setMode] = useState<Mode>('n');
  const [n, setN] = useState(1);
  const [ranges, setRanges] = useState(`1-${Math.ceil(numPages / 2)}, ${Math.ceil(numPages / 2) + 1}-end`);
  const [single, setSingle] = useState(false);
  const [mb, setMb] = useState(5);
  const go = () => {
    if (mode === 'n') onRun({ everyN: Math.max(1, n) });
    else if (mode === 'ranges') onRun({ ranges, single });
    else if (mode === 'size') onRun({ maxMB: Math.max(0.1, mb) });
    else onRun({ bookmarks: true });
  };
  return (
    <Modal title="Split PDF" onClose={onClose} footer={<Foot onClose={onClose} onRun={go} label="Split & choose folder" />}>
      <div className="seg">
        <button className={mode === 'n' ? 'on' : ''} onClick={() => setMode('n')}>
          Every N pages
        </button>
        <button className={mode === 'ranges' ? 'on' : ''} onClick={() => setMode('ranges')}>
          Page ranges
        </button>
        <button className={mode === 'size' ? 'on' : ''} onClick={() => setMode('size')}>
          By file size
        </button>
        <button className={mode === 'bookmarks' ? 'on' : ''} onClick={() => setMode('bookmarks')}>
          By bookmarks
        </button>
      </div>
      {mode === 'n' && (
        <div className="form-grid">
          <label>Pages per file</label>
          <input type="number" min={1} max={numPages} value={n} onChange={(e) => setN(+e.target.value)} />
          <span />
          <div className="hint">
            Creates {Math.ceil(numPages / Math.max(1, n))} files.{' '}
            <button className="link-btn" onClick={() => setN(1)}>
              One file per page
            </button>
          </div>
        </div>
      )}
      {mode === 'ranges' && (
        <div className="form-grid">
          <label>Ranges</label>
          <input value={ranges} onChange={(e) => setRanges(e.target.value)} />
          <span />
          <div className="hint">{single ? 'All these pages go into one new PDF, in this order.' : 'One output file per range, e.g. "1-3, 4, 5-end".'}</div>
          <span />
          <label className="check">
            <input type="checkbox" checked={single} onChange={(e) => setSingle(e.target.checked)} /> Put all ranges in one file (extract pages)
          </label>
        </div>
      )}
      {mode === 'size' && (
        <div className="form-grid">
          <label>Largest file (MB)</label>
          <input type="number" min={0.1} step={0.5} value={mb} onChange={(e) => setMb(+e.target.value)} />
          <span />
          <div className="hint">Each file is measured and kept under this size, handy for email limits. A single page bigger than the limit gets its own file.</div>
        </div>
      )}
      {mode === 'bookmarks' && (
        <div className="form-grid">
          <span />
          <div className="hint">Starts a new file at each top-level bookmark, so a long PDF made of sections splits where its table of contents does.</div>
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
        <div className="muted">{m.producer || '-'}</div>
        <label>Creator</label>
        <div className="muted">{m.creator || '-'}</div>
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

type OcrRequest = Omit<OcrOptions, never> & { scope: 'all' | 'current' };

function OcrDialog({ onClose, onRun }: { onClose: () => void; onRun: (o: OcrRequest) => void }) {
  const [lang, setLang] = useState('eng');
  const [scope, setScope] = useState<'all' | 'current'>('all');
  const [quality, setQuality] = useState<'fast' | 'accurate'>('accurate');
  const [deskew, setDeskew] = useState(true);
  const [skipTextPages, setSkip] = useState(true);
  const offline = lang.split('+').every((l) => BUNDLED_LANGS.includes(l));
  return (
    <Modal title="Recognize text (OCR)" onClose={onClose} footer={<Foot onClose={onClose} onRun={() => onRun({ lang, scope, quality, deskew, skipTextPages })} label="Run OCR" />}>
      <p className="muted">
        Makes scanned pages searchable and selectable by adding an invisible text layer. The page picture stays untouched.{' '}
        {offline ? 'English and Filipino work fully offline.' : 'This language is downloaded the first time (internet needed once).'}
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
        <label>Quality</label>
        <select value={quality} onChange={(e) => setQuality(e.target.value as 'fast' | 'accurate')}>
          <option value="accurate">Accurate (300 dpi, slower, best for small print)</option>
          <option value="fast">Fast (200 dpi)</option>
        </select>
      </div>
      <label className="check">
        <input type="checkbox" checked={deskew} onChange={(e) => setDeskew(e.target.checked)} /> Straighten crooked scans first
      </label>
      <label className="check">
        <input type="checkbox" checked={skipTextPages} onChange={(e) => setSkip(e.target.checked)} /> Skip pages that already have real text
      </label>
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
