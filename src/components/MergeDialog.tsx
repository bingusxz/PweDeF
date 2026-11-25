import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';
import { Icon } from './Icon';
import { loadPdf, renderToCanvas } from '../lib/pdf';
import { mergeParts, parseRanges } from '../lib/ops';
import { errText } from '../lib/toast';
import { uid } from '../lib/util';

interface Item {
  id: string;
  name: string;
  data: Uint8Array;
  pages: number;
  /** first-page picture, filled in after the file is read */
  thumb?: string;
  rotate: number;
  /** pages to take, e.g. "1-3, 7"; empty means every page */
  range: string;
  error?: string;
}

const size = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const byName = (a: Item, b: Item) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

/** How many pages an item contributes, given its range text. null = the range is not understood. */
function pagesTaken(it: Item): number | null {
  if (!it.range.trim()) return it.pages;
  const groups = parseRanges(it.range, it.pages);
  const count = groups.reduce((n, g) => n + g.length, 0);
  return count > 0 ? count : null;
}

async function readItem(name: string, data: Uint8Array): Promise<Item> {
  const base: Item = { id: uid(), name, data, pages: 0, rotate: 0, range: '' };
  try {
    const pdf = await loadPdf(data.slice());
    try {
      base.pages = pdf.numPages;
      const page = await pdf.getPage(1);
      const canvas = await renderToCanvas(page, 0.28);
      base.thumb = canvas.toDataURL('image/jpeg', 0.7);
      canvas.width = canvas.height = 0;
    } finally {
      pdf.destroy();
    }
  } catch (e) {
    base.error = /password/i.test(errText(e)) ? 'Password protected' : 'Could not read this file';
  }
  return base;
}

/** Merge window: choose files, put them in order, pick pages, turn them, then combine. */
export function MergeDialog({
  initial,
  onClose,
  onDone,
}: {
  initial: { name: string; data: Uint8Array }[];
  onClose: () => void;
  onDone: (bytes: Uint8Array, name: string) => void;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [fileDrag, setFileDrag] = useState(false);
  const started = useRef(false);

  const add = async (files: { name: string; data: Uint8Array }[]) => {
    const read = await Promise.all(files.map((f) => readItem(f.name, f.data)));
    setItems((cur) => [...cur, ...read]);
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (initial.length) add(initial);
    else pick(); // opened empty: go straight to choosing files
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pick = async () => {
    const files = await window.acro.openPdfs({ title: 'Add PDFs to merge' });
    if (files.length) add(files);
  };

  const dropFiles = async (list: FileList) => {
    const pdfs = [...list].filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
    if (pdfs.length) add(await Promise.all(pdfs.map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) }))));
  };

  const update = (id: string, patch: Partial<Item>) => setItems((cur) => cur.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const remove = (id: string) => setItems((cur) => cur.filter((x) => x.id !== id));
  const move = (id: string, delta: number) =>
    setItems((cur) => {
      const i = cur.findIndex((x) => x.id === id);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= cur.length) return cur;
      const next = [...cur];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  const dropOn = (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    setItems((cur) => {
      const from = cur.findIndex((x) => x.id === dragId);
      const to = cur.findIndex((x) => x.id === targetId);
      if (from < 0 || to < 0) return cur;
      const next = [...cur];
      const [m] = next.splice(from, 1);
      next.splice(to, 0, m);
      return next;
    });
  };

  const usable = items.filter((x) => !x.error);
  const badRange = usable.some((x) => pagesTaken(x) === null);
  const total = usable.reduce((n, x) => n + (pagesTaken(x) || 0), 0);
  const bytes = usable.reduce((n, x) => n + x.data.length, 0);

  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      const out = await mergeParts(
        usable.map((x) => ({
          bytes: x.data,
          pages: x.range.trim() ? parseRanges(x.range, x.pages).flat() : undefined,
          rotate: x.rotate,
        })),
      );
      onDone(out, 'Combined.pdf');
    } catch (e) {
      setErr(errText(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Merge PDFs"
      width={720}
      onClose={onClose}
      footer={
        <>
          <span className="merge-total">
            {usable.length} file{usable.length === 1 ? '' : 's'} · {total} page{total === 1 ? '' : 's'} · about {size(bytes)}
          </span>
          <button className="primary" disabled={busy || usable.length < 1 || badRange} onClick={run}>
            {busy ? 'Merging…' : usable.length < 2 ? 'Open as PDF' : 'Merge'}
          </button>
        </>
      }
    >
      <div
        className={`merge-drop ${fileDrag ? 'over' : ''}`}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault();
            e.stopPropagation();
            setFileDrag(true);
          }
        }}
        onDragLeave={() => setFileDrag(false)}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          e.stopPropagation(); // don't let the app also open these files as tabs
          setFileDrag(false);
          dropFiles(e.dataTransfer.files);
        }}
      >
        <div className="merge-tools">
          <button onClick={pick}>
            <Icon name="plus" /> Add files…
          </button>
          <button disabled={items.length < 2} onClick={() => setItems((c) => [...c].sort(byName))} title="Sort by file name, A to Z">
            Sort A–Z
          </button>
          <button disabled={items.length < 2} onClick={() => setItems((c) => [...c].sort(byName).reverse())} title="Sort by file name, Z to A">
            Z–A
          </button>
          <span className="hint">Drag to reorder. Drop more PDFs here to add them.</span>
        </div>

        {!items.length && <p className="empty-line">No files yet. Use “Add files…” or drop PDFs here.</p>}

        <ol className="merge-list">
          {items.map((it, i) => {
            const taken = pagesTaken(it);
            return (
              <li
                key={it.id}
                className={`merge-row ${overId === it.id ? 'over' : ''} ${it.error ? 'bad' : ''}`}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/acro-merge', it.id);
                  setDragId(it.id);
                }}
                onDragEnd={() => {
                  setDragId(null);
                  setOverId(null);
                }}
                onDragOver={(e) => {
                  if (dragId) {
                    e.preventDefault();
                    setOverId(it.id);
                  }
                }}
                onDrop={(e) => {
                  if (dragId) {
                    e.preventDefault();
                    e.stopPropagation();
                    dropOn(it.id);
                    setOverId(null);
                  }
                }}
              >
                <span className="merge-n">{i + 1}</span>
                <span className="merge-thumb">
                  {it.thumb ? <img src={it.thumb} alt="" style={{ transform: `rotate(${it.rotate}deg)` }} /> : <span className="merge-wait">{it.error ? '!' : '…'}</span>}
                </span>
                <span className="merge-info">
                  <b title={it.name}>{it.name}</b>
                  <small>{it.error ? it.error : `${it.pages} page${it.pages === 1 ? '' : 's'} · ${size(it.data.length)}`}</small>
                </span>
                {!it.error && (
                  <label className="merge-range">
                    <span>Pages</span>
                    <input
                      value={it.range}
                      placeholder={`all (1-${it.pages})`}
                      aria-invalid={taken === null}
                      onChange={(e) => update(it.id, { range: e.target.value })}
                    />
                  </label>
                )}
                <span className="merge-btns">
                  {!it.error && (
                    <button className="icon-btn" title="Turn 90° clockwise" aria-label="Rotate" onClick={() => update(it.id, { rotate: (it.rotate + 90) % 360 })}>
                      <Icon name="rotR" />
                    </button>
                  )}
                  <button className="icon-btn" title="Move up" aria-label="Move up" disabled={i === 0} onClick={() => move(it.id, -1)}>
                    ↑
                  </button>
                  <button className="icon-btn" title="Move down" aria-label="Move down" disabled={i === items.length - 1} onClick={() => move(it.id, 1)}>
                    ↓
                  </button>
                  <button className="icon-btn danger" title="Remove" aria-label="Remove" onClick={() => remove(it.id)}>
                    <Icon name="trash" />
                  </button>
                </span>
              </li>
            );
          })}
        </ol>
        {badRange && <p className="merge-err">One of the page ranges doesn't match any page. Use numbers like “1-3, 7”, or clear it to take every page.</p>}
        {err && <p className="merge-err">{err}</p>}
      </div>
    </Modal>
  );
}
