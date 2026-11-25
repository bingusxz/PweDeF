import { useState } from 'react';
import { Modal } from './Modal';
import { Icon } from './Icon';
import type { OpenedFile } from '../global';
import * as ops from '../lib/ops';
import { NumberFields, WatermarkFields, defaultNumbers, defaultWatermark, resolveWatermark } from './ToolDialogs';
import { baseName } from '../lib/util';
import { errText } from '../lib/toast';

type Step =
  | { kind: 'watermark'; o: ops.WatermarkOpts }
  | { kind: 'numbers'; o: ops.NumberOpts }
  | { kind: 'rotate'; deg: number }
  | { kind: 'flatten' }
  | { kind: 'compress' }
  | { kind: 'metadata'; author: string };

const STEP_LABEL: Record<Step['kind'], string> = {
  watermark: 'Add watermark',
  numbers: 'Page numbers / Bates',
  rotate: 'Rotate all pages',
  flatten: 'Flatten forms',
  compress: 'Optimize file size',
  metadata: 'Set author',
};

export function BatchDialog({ onClose }: { onClose: () => void }) {
  const [files, setFiles] = useState<OpenedFile[]>([]);
  const [steps, setSteps] = useState<Step[]>([{ kind: 'watermark', o: defaultWatermark }]);
  const [mergeAll, setMergeAll] = useState(false);
  const [suffix, setSuffix] = useState('_processed');
  const [log, setLog] = useState<{ name: string; status: 'ok' | 'err' | 'run'; msg?: string }[]>([]);
  const [running, setRunning] = useState(false);

  const add = async () => {
    const f = await window.acro.openPdfs({ title: 'Add PDFs to batch' });
    setFiles((cur) => [...cur, ...f.filter((x) => !cur.some((c) => c.path === x.path))]);
  };

  const apply = async (bytes: Uint8Array) => {
    let b = bytes;
    for (const s of steps) {
      if (s.kind === 'watermark') b = await ops.watermark(b, await resolveWatermark(s.o));
      else if (s.kind === 'numbers') b = await ops.pageNumbers(b, s.o);
      else if (s.kind === 'rotate') {
        const n = await ops.pageCount(b);
        b = await ops.rotatePages(b, Array.from({ length: n }, (_, i) => i), s.deg);
      } else if (s.kind === 'flatten') b = await ops.flattenForms(b);
      else if (s.kind === 'compress') b = await ops.compress(b);
      else if (s.kind === 'metadata') b = await ops.setMetadata(b, { author: s.author });
    }
    return b;
  };

  const runBatch = async () => {
    const folder = await window.acro.chooseFolder();
    if (!folder) return;
    setRunning(true);
    const results: Uint8Array[] = [];
    const lg: typeof log = files.map((f) => ({ name: f.name, status: 'run' as const }));
    setLog([...lg]);
    for (let i = 0; i < files.length; i++) {
      try {
        const out = await apply(files[i].data);
        if (mergeAll) results.push(out);
        else await window.acro.writeInFolder(folder, `${baseName(files[i].name)}${suffix}.pdf`, out);
        lg[i] = { name: files[i].name, status: 'ok' };
      } catch (e) {
        lg[i] = { name: files[i].name, status: 'err', msg: errText(e) };
      }
      setLog([...lg]);
    }
    if (mergeAll && results.length) {
      try {
        await window.acro.writeInFolder(folder, `Combined${suffix}.pdf`, await ops.merge(results));
      } catch (e) {
        lg.push({ name: 'Combined', status: 'err', msg: errText(e) });
        setLog([...lg]);
      }
    }
    setRunning(false);
    window.acro.showItem(folder);
  };

  const addStep = (kind: Step['kind']) => {
    const s: Step =
      kind === 'watermark' ? { kind, o: defaultWatermark }
      : kind === 'numbers' ? { kind, o: defaultNumbers }
      : kind === 'rotate' ? { kind, deg: 90 }
      : kind === 'metadata' ? { kind, author: localStorage.getItem('acro.user') || '' }
      : { kind };
    setSteps([...steps, s]);
  };

  return (
    <Modal
      title="Batch process PDFs"
      onClose={onClose}
      width={760}
      footer={
        <>
          <span className="muted">{files.length} file(s) · {steps.length} action(s)</span>
          <span className="tb-spacer" />
          <button onClick={onClose}>Close</button>
          <button className="primary" disabled={!files.length || (!steps.length && !mergeAll) || running} onClick={runBatch}>
            {running ? 'Running…' : 'Run & choose output folder'}
          </button>
        </>
      }
    >
      <div className="batch">
        <section>
          <div className="row gap">
            <h3>1. Files</h3>
            <span className="tb-spacer" />
            <button className="small" onClick={add}>
              <Icon name="plus" size={14} /> Add PDFs
            </button>
            {files.length > 0 && (
              <button className="small" onClick={() => setFiles([])}>
                Clear
              </button>
            )}
          </div>
          <div className="file-list">
            {files.map((f, i) => {
              const l = log.find((x) => x.name === f.name);
              return (
                <div key={f.path} className="file-row">
                  <Icon name="file" size={14} />
                  <span className="grow">{f.name}</span>
                  {l?.status === 'ok' && <span className="ok">✓ done</span>}
                  {l?.status === 'err' && <span className="err" title={l.msg}>✕ {l.msg}</span>}
                  {l?.status === 'run' && <span className="muted">…</span>}
                  {!running && (
                    <button className="icon-btn tiny" onClick={() => setFiles(files.filter((_, j) => j !== i))}>
                      <Icon name="close" size={12} />
                    </button>
                  )}
                </div>
              );
            })}
            {!files.length && <p className="muted">Add the PDFs you want to process — e.g. a month of invoices.</p>}
          </div>
        </section>
        <section>
          <h3>2. Actions (run in order)</h3>
          {steps.map((s, i) => (
            <div key={i} className="step">
              <div className="row gap">
                <b>{STEP_LABEL[s.kind]}</b>
                <span className="tb-spacer" />
                <button className="icon-btn tiny" onClick={() => setSteps(steps.filter((_, j) => j !== i))}>
                  <Icon name="close" size={12} />
                </button>
              </div>
              {s.kind === 'watermark' && <WatermarkFields batch o={s.o} set={(o) => setSteps(steps.map((x, j) => (j === i ? { ...s, o } : x)))} />}
              {s.kind === 'numbers' && <NumberFields o={s.o} set={(o) => setSteps(steps.map((x, j) => (j === i ? { ...s, o } : x)))} />}
              {s.kind === 'rotate' && (
                <select value={s.deg} onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...s, deg: +e.target.value } : x)))}>
                  <option value={90}>90° clockwise</option>
                  <option value={180}>180°</option>
                  <option value={-90}>90° counter-clockwise</option>
                </select>
              )}
              {s.kind === 'metadata' && (
                <input placeholder="Author" value={s.author} onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...s, author: e.target.value } : x)))} />
              )}
            </div>
          ))}
          <div className="row gap wrap">
            {(Object.keys(STEP_LABEL) as Step['kind'][]).map((k) => (
              <button key={k} className="small" onClick={() => addStep(k)}>
                + {STEP_LABEL[k]}
              </button>
            ))}
          </div>
        </section>
        <section>
          <h3>3. Output</h3>
          <div className="form-grid">
            <label>File suffix</label>
            <input value={suffix} onChange={(e) => setSuffix(e.target.value)} />
            <label>Combine</label>
            <label className="check">
              <input type="checkbox" checked={mergeAll} onChange={(e) => setMergeAll(e.target.checked)} /> Merge all results into one PDF
            </label>
          </div>
        </section>
      </div>
    </Modal>
  );
}
