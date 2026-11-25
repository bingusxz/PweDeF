import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from './Modal';
import { Icon } from './Icon';
import { loadPdf, pdfjs, renderToCanvas } from '../lib/pdf';
import type { PDFDocumentProxy } from '../lib/pdf';
import { extractPage } from '../lib/pdfExtract';
import { compareText, describe, docLines, highlightBoxes, type Change, type CompareResult } from '../lib/compare';
import { errText } from '../lib/toast';
import { Slot, describeFile, type Side } from './CompareSlot';


/** One page drawn to a canvas, with highlight boxes laid over it. */
function PageView({ pdf, page, color, boxes, width, focus }: { pdf: PDFDocumentProxy | null; page: number; color: string; boxes: { x: number; y: number; w: number; h: number; on?: boolean }[]; width: number; focus: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    let live = true;
    if (!pdf || page < 0 || page >= pdf.numPages) return;
    (async () => {
      const pg = await pdf.getPage(page + 1);
      const vp = pg.getViewport({ scale: 1 });
      const s = width / vp.width;
      if (!live || !ref.current) return;
      await renderToCanvas(pg, s, ref.current);
      if (live) setScale(s);
    })().catch(() => {});
    return () => {
      live = false;
    };
  }, [pdf, page, width]);
  if (!pdf || page >= pdf.numPages) return <div className="cmp-empty">No page {page + 1} in this file</div>;
  return (
    <div className="cmp-page">
      <canvas ref={ref} />
      {boxes.map((b, i) => (
        <span key={i} className={`cmp-box ${b.on ? 'on' : ''}`} style={{ left: b.x * scale - 2, top: b.y * scale - 1, width: b.w * scale + 4, height: b.h * scale + 2, background: color, outlineColor: focus }} />
      ))}
    </div>
  );
}

/** Pixel difference of the two pages: changed pixels in red over a faded copy of the second page. */
async function overlay(a: PDFDocumentProxy, b: PDFDocumentProxy, page: number, width: number): Promise<string | null> {
  if (page >= a.numPages || page >= b.numPages) return null;
  const [pa, pb] = await Promise.all([a.getPage(page + 1), b.getPage(page + 1)]);
  const s = width / pb.getViewport({ scale: 1 }).width;
  const ca = await renderToCanvas(pa, (width / pa.getViewport({ scale: 1 }).width));
  const cb = await renderToCanvas(pb, s);
  const w = cb.width, h = cb.height;
  const tmp = document.createElement('canvas');
  tmp.width = w;
  tmp.height = h;
  const tc = tmp.getContext('2d', { willReadFrequently: true })!;
  tc.fillStyle = '#fff';
  tc.fillRect(0, 0, w, h);
  tc.drawImage(ca, 0, 0, w, Math.round((ca.height * w) / ca.width));
  const da = tc.getImageData(0, 0, w, h).data;
  const bc = cb.getContext('2d', { willReadFrequently: true })!;
  const db = bc.getImageData(0, 0, w, h).data;
  const out = bc.createImageData(w, h);
  for (let i = 0; i < db.length; i += 4) {
    const la = (da[i] * 299 + da[i + 1] * 587 + da[i + 2] * 114) / 1000;
    const lb = (db[i] * 299 + db[i + 1] * 587 + db[i + 2] * 114) / 1000;
    if (Math.abs(la - lb) > 45) {
      // darker in the new file = added (green), lighter = removed (red)
      const added = lb < la;
      out.data[i] = added ? 20 : 220;
      out.data[i + 1] = added ? 160 : 30;
      out.data[i + 2] = added ? 60 : 30;
      out.data[i + 3] = 255;
    } else {
      const g = 255 - (255 - lb) * 0.25;
      out.data[i] = out.data[i + 1] = out.data[i + 2] = g;
      out.data[i + 3] = 255;
    }
  }
  bc.putImageData(out, 0, 0);
  const url = cb.toDataURL('image/png');
  ca.width = ca.height = cb.width = cb.height = tmp.width = 0;
  return url;
}

export function CompareDialog({ initialA, onClose }: { initialA?: Side; onClose: () => void }) {
  const [a, setA] = useState<Side | null>(initialA || null);
  const [b, setB] = useState<Side | null>(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [res, setRes] = useState<CompareResult | null>(null);
  const [pdfs, setPdfs] = useState<{ a: PDFDocumentProxy; b: PDFDocumentProxy } | null>(null);
  const [page, setPage] = useState(0);
  const [sel, setSel] = useState(-1);
  const [mode, setMode] = useState<'side' | 'overlay'>('side');
  const [ov, setOv] = useState<string | null>(null);
  // the document opened in the editor arrives without a preview: add one
  useEffect(() => {
    if (initialA) describeFile(initialA.name, initialA.data).then(setA);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const pdfsRef = useRef(pdfs);
  pdfsRef.current = pdfs;
  useEffect(() => () => {
    pdfsRef.current?.a.destroy();
    pdfsRef.current?.b.destroy();
  }, []);

  const pick = async (set: (s: Side) => void, title: string) => {
    const f = await window.acro.openPdfs({ title });
    if (f[0]) set(await describeFile(f[0].name, f[0].data));
  };
  // files dropped on a slot: two at once fill both slots, one replaces that slot
  const drop = (which: 'a' | 'b') => (files: Side[]) => {
    if (!files.length) return;
    if (files.length >= 2) {
      setA(files[0]);
      setB(files[1]);
    } else (which === 'a' ? setA : setB)(files[0]);
  };

  const run = async () => {
    if (!a || !b) return;
    setErr('');
    setRes(null);
    pdfs?.a.destroy();
    pdfs?.b.destroy();
    setPdfs(null);
    try {
      setBusy('Opening the files…');
      const [pa, pb] = await Promise.all([loadPdf(a.data.slice()), loadPdf(b.data.slice())]);
      const read = async (p: PDFDocumentProxy, label: string) => {
        const pages = [];
        for (let i = 1; i <= p.numPages; i++) {
          setBusy(`Reading ${label}, page ${i} of ${p.numPages}…`);
          pages.push(await extractPage(p, i, pdfjs as any));
        }
        return docLines(pages);
      };
      const la = await read(pa, 'the first file');
      const lb = await read(pb, 'the second file');
      setBusy('Comparing…');
      await new Promise((r) => setTimeout(r, 0));
      const r = compareText(la, lb);
      setPdfs({ a: pa, b: pb });
      setRes(r);
      setPage(Math.max(0, r.changes[0] ? Math.min(...[...r.changes[0].a, ...r.changes[0].b].map((w) => w.page)) : 0));
      setSel(r.changes.length ? 0 : -1);
    } catch (e) {
      setErr(/password/i.test(errText(e)) ? 'One of the files is password protected.' : errText(e));
    } finally {
      setBusy('');
    }
  };

  const pagesTotal = pdfs ? Math.max(pdfs.a.numPages, pdfs.b.numPages) : 0;
  const firstPage = (c: Change) => Math.min(...[...c.a, ...c.b].map((w) => w.page));
  useEffect(() => {
    if (mode !== 'overlay' || !pdfs) return;
    let live = true;
    setOv(null);
    overlay(pdfs.a, pdfs.b, page, 520).then((u) => live && setOv(u)).catch(() => live && setOv(null));
    return () => {
      live = false;
    };
  }, [mode, pdfs, page]);

  const boxesFor = (side: 'a' | 'b') =>
    (res?.changes || []).flatMap((c, i) => highlightBoxes(side === 'a' ? c.a : c.b).filter((x) => x.page === page).map((x) => ({ ...x, on: i === sel })));

  const counts = useMemo(() => {
    const c = { added: 0, removed: 0, changed: 0 };
    res?.changes.forEach((x) => c[x.kind]++);
    return c;
  }, [res]);

  const report = async () => {
    if (!res || !a || !b) return;
    const lines = [`Comparison of "${a.name}" and "${b.name}"`, `${res.changes.length} changes: ${counts.changed} changed, ${counts.added} added, ${counts.removed} removed`, ''];
    res.changes.forEach((c, i) => lines.push(`${i + 1}. [page ${firstPage(c) + 1}] ${describe(c)}`));
    await window.acro.saveFile('comparison.txt', new TextEncoder().encode(lines.join('\r\n')), [{ name: 'Text', extensions: ['txt'] }]);
  };

  return (
    <Modal
      title="Compare PDFs"
      width={1100}
      onClose={onClose}
      footer={
        res ? (
          <button onClick={report} title="Save the list of changes as a text file">
            Save list of changes
          </button>
        ) : undefined
      }
    >
      {!res ? (
        <>
          <div className="cmp-slots">
            <Slot label="Original" hint="the older or first version" side={a} onFiles={drop('a')} onPick={() => pick(setA, 'Choose the original PDF')} />
            <button
              className="cmp-swap"
              title="Swap the two files"
              aria-label="Swap original and revised"
              onClick={() => {
                setA(b);
                setB(a);
              }}
            >
              <Icon name="convert" size={20} />
              <span>Swap</span>
            </button>
            <Slot label="Revised" hint="the newer or changed version" side={b} onFiles={drop('b')} onPick={() => pick(setB, 'Choose the revised PDF')} />
          </div>
          <div className="cmp-go">
            <button className="primary big" disabled={!a || !b || !!busy} onClick={run}>
              {busy ? 'Working…' : 'Compare'}
            </button>
            <span className="muted">{!a || !b ? 'Add both files to start. Tip: drop two PDFs at once.' : 'Finds changed, added and removed words, and shows them page by page.'}</span>
          </div>
        </>
      ) : (
        <div className="cmp-pick">
          <span className="cmp-file">
            <b>Original</b> {a?.name}
            <button onClick={() => pick(setA, 'Choose the original PDF')}>Change…</button>
          </span>
          <span className="cmp-file">
            <b>Revised</b> {b?.name}
            <button onClick={() => pick(setB, 'Choose the revised PDF')}>Change…</button>
          </span>
          <button
            className="primary"
            disabled={!a || !b || !!busy}
            onClick={() => {
              setRes(null);
              setTimeout(run, 0);
            }}
          >
            Compare again
          </button>
        </div>
      )}
      {busy && <p className="muted">{busy}</p>}
      {err && <p className="merge-err">{err}</p>}

      {res && pdfs && (
        <>
          <p className="cmp-sum">
            {res.changes.length === 0 ? (
              <b>No differences in the text.</b>
            ) : (
              <>
                <b>{res.changes.length} difference{res.changes.length === 1 ? '' : 's'}</b>: {counts.changed} changed · {counts.added} added · {counts.removed} removed
              </>
            )}
            <span className="muted">
              {' '}
              · {pdfs.a.numPages} vs {pdfs.b.numPages} pages
              {res.tooDifferent ? ' · the files are very different, so everything is listed as changed' : ''}
            </span>
          </p>
          <div className="seg small">
            <button className={mode === 'side' ? 'on' : ''} onClick={() => setMode('side')}>
              Side by side
            </button>
            <button className={mode === 'overlay' ? 'on' : ''} onClick={() => setMode('overlay')}>
              Visual overlay
            </button>
          </div>
          <div className="cmp-body">
            <ol className="cmp-list">
              {res.changes.map((c, i) => (
                <li key={i}>
                  <button
                    className={`cmp-item ${c.kind} ${i === sel ? 'on' : ''}`}
                    onClick={() => {
                      setSel(i);
                      setPage(firstPage(c));
                    }}
                  >
                    <small>Page {firstPage(c) + 1}</small>
                    <span>{describe(c)}</span>
                  </button>
                </li>
              ))}
              {!res.changes.length && <li className="muted">The words and numbers are identical. Switch to “Visual overlay” to check layout, colours and pictures.</li>}
            </ol>
            <div className="cmp-view">
              <div className="cmp-nav">
                <button className="icon-btn" disabled={page <= 0} onClick={() => setPage(page - 1)} aria-label="Previous page">
                  <Icon name="chevL" />
                </button>
                <span>
                  Page {page + 1} of {pagesTotal}
                </span>
                <button className="icon-btn" disabled={page >= pagesTotal - 1} onClick={() => setPage(page + 1)} aria-label="Next page">
                  <Icon name="chevR" />
                </button>
              </div>
              {mode === 'side' ? (
                <div className="cmp-pair">
                  <div>
                    <div className="cmp-cap">Original</div>
                    <PageView pdf={pdfs.a} page={page} color="rgba(220,40,40,.28)" boxes={boxesFor('a')} width={380} focus="#c62828" />
                  </div>
                  <div>
                    <div className="cmp-cap">Revised</div>
                    <PageView pdf={pdfs.b} page={page} color="rgba(30,150,70,.28)" boxes={boxesFor('b')} width={380} focus="#1f7a3b" />
                  </div>
                </div>
              ) : (
                <div className="cmp-overlay">
                  {ov ? <img src={ov} alt="Visual differences" /> : <p className="muted">{page >= Math.min(pdfs.a.numPages, pdfs.b.numPages) ? 'This page exists in only one of the files.' : 'Drawing…'}</p>}
                  <p className="hint">
                    <span className="cmp-key add" /> darker in the revised file · <span className="cmp-key rem" /> lighter or missing
                  </p>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </Modal>
  );
}
