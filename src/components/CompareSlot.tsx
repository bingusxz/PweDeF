import { useState } from 'react';
import { Icon } from './Icon';
import { loadPdf, renderToCanvas } from '../lib/pdf';

export type Side = { name: string; data: Uint8Array; pages?: number; thumb?: string };

const kb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Page count and a first-page preview, so the slot shows what was chosen. */
export async function describeFile(name: string, data: Uint8Array): Promise<Side> {
  const out: Side = { name, data };
  try {
    const pdf = await loadPdf(data.slice());
    try {
      out.pages = pdf.numPages;
      const c = await renderToCanvas(await pdf.getPage(1), 0.35);
      out.thumb = c.toDataURL('image/jpeg', 0.75);
      c.width = c.height = 0;
    } finally {
      pdf.destroy();
    }
  } catch {
    /* the compare step reports unreadable files */
  }
  return out;
}

export const readDropped = async (list: FileList) =>
  Promise.all(
    [...list]
      .filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf')
      .map(async (f) => describeFile(f.name, new Uint8Array(await f.arrayBuffer()))),
  );

/** A big drop target: drag a PDF onto it or click to choose one. */
export function Slot({ label, hint, side, onFiles, onPick }: { label: string; hint: string; side: Side | null; onFiles: (f: Side[]) => void; onPick: () => void }) {
  const [over, setOver] = useState(false);
  return (
    <div
      className={`cmp-slot ${side ? 'filled' : ''} ${over ? 'over' : ''}`}
      role="button"
      tabIndex={0}
      onClick={onPick}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onPick()}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          e.stopPropagation();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={async (e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        e.stopPropagation(); // keep the app from also opening these as tabs
        setOver(false);
        onFiles(await readDropped(e.dataTransfer.files));
      }}
    >
      <span className="cmp-slot-label">{label}</span>
      {side ? (
        <>
          <span className="cmp-slot-thumb">{side.thumb ? <img src={side.thumb} alt="" /> : <span>PDF</span>}</span>
          <b className="cmp-slot-name" title={side.name}>
            {side.name}
          </b>
          <small>
            {side.pages ? `${side.pages} page${side.pages === 1 ? '' : 's'} · ` : ''}
            {kb(side.data.length)} · click or drop to replace
          </small>
        </>
      ) : (
        <>
          <Icon name="open" size={30} className="cmp-slot-icon" />
          <b>Drop a PDF here</b>
          <small>{hint}</small>
          <span className="cmp-slot-btn">or choose a file…</span>
        </>
      )}
    </div>
  );
}
