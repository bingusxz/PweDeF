import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from './Modal';
import { Icon } from './Icon';
import {
  SIGNATURE_FONTS,
  STAMP_SETS,
  STAMP_SHAPES,
  imageSize,
  loadSigs,
  loadStamps,
  saveSigs,
  saveStamps,
  stampImage,
  trimCanvas,
  typedSignature,
  type SavedSig,
  type SavedStamp,
  type StampDef,
  type StampShape,
} from '../lib/stamps';
import { uid } from '../lib/util';
import { whiteToTransparent } from '../lib/pagePictures';
import type { PendingImage } from './EditorContext';
import { IMAGE_FILTERS } from '../lib/convert';

type TabKey = 'saved' | 'draw' | 'type' | 'upload' | 'stamp';

const INKS = [
  { name: 'Red', color: '#c62828' },
  { name: 'Blue', color: '#1d4fbf' },
  { name: 'Green', color: '#1f7a3b' },
  { name: 'Violet', color: '#5b3fa8' },
  { name: 'Black', color: '#1c2340' },
];
const TILT = [-2.5, 1.5, -1, 2.2, -1.8, 1, -2.2, 1.8];

type StampShow = { name: boolean; date: boolean; time: boolean };

/** The stamp pad: every stamp shown as the real impression it will leave on the page. */
function StampPad({
  onPick,
  show,
  setShow,
  userName,
  setUserName,
}: {
  onPick: (img: PendingImage) => void;
  show: StampShow;
  setShow: (v: StampShow) => void;
  userName: string;
  setUserName: (v: string) => void;
}) {
  const [custom, setCustom] = useState('');
  const [ink, setInk] = useState(INKS[0].color);
  const [shape, setShape] = useState<StampShape>('box');
  const [setName, setSetName] = useState(STAMP_SETS[0].name);
  const [mine, setMine] = useState<SavedStamp[]>(loadStamps);
  const MINE = 'My stamps';
  const baseSet: StampDef[] =
    setName === MINE ? mine.map((m) => ({ label: m.label, color: m.color })) : (STAMP_SETS.find((s) => s.name === setName) || STAMP_SETS[0]).stamps;
  const shapeOf = (i: number): StampShape => (setName === MINE ? mine[i]?.shape || 'box' : 'box');
  const saveMine = () => {
    const label = custom.trim().toUpperCase();
    if (!label) return;
    const next = [{ id: uid(), label, color: ink, shape }, ...mine.filter((m) => !(m.label === label && m.color === ink && m.shape === shape))];
    setMine(next);
    saveStamps(next);
    setSetName(MINE);
  };
  const removeMine = (i: number) => {
    const next = mine.filter((_, k) => k !== i);
    setMine(next);
    saveStamps(next);
  };
  // the line under the stamp is built from whichever of name / date / time are switched on
  const now = new Date();
  const parts = [
    show.name && userName.trim() ? userName.trim() : '',
    show.date ? now.toLocaleDateString() : '',
    show.time ? now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '',
  ].filter(Boolean);
  const sub = parts.length ? parts.join(' · ') : undefined;
  const impressions = useMemo(
    () => baseSet.map((s, i) => ({ ...s, ...stampImage(s.label, s.color, sub, shapeOf(i)) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sub, setName, mine],
  );
  const customImg = useMemo(() => (custom.trim() ? stampImage(custom.trim().toUpperCase(), ink, sub, shape) : null), [custom, ink, sub, shape]);
  const use = (st: { dataUrl: string; w: number; h: number }) => onPick({ dataUrl: st.dataUrl, w: st.w, h: st.h, label: 'stamp' });

  return (
    <>
      <div className="stamp-opts">
        <span className="ctx-cap">Print under the stamp</span>
        <label className="check">
          <input type="checkbox" checked={show.name} onChange={(e) => setShow({ ...show, name: e.target.checked })} /> Name
        </label>
        <label className="check">
          <input type="checkbox" checked={show.date} onChange={(e) => setShow({ ...show, date: e.target.checked })} /> Date
        </label>
        <label className="check">
          <input type="checkbox" checked={show.time} onChange={(e) => setShow({ ...show, time: e.target.checked })} /> Time
        </label>
        {show.name && (
          <input
            placeholder="Name to print"
            value={userName}
            onChange={(e) => {
              setUserName(e.target.value);
              localStorage.setItem('acro.user', e.target.value);
            }}
          />
        )}
      </div>
      <div className="stamp-sets" role="tablist" aria-label="Stamp sets">
        {[...STAMP_SETS.map((s) => s.name), MINE].map((n) => (
          <button key={n} role="tab" aria-selected={setName === n} className={`set-tab ${setName === n ? 'on' : ''}`} onClick={() => setSetName(n)}>
            {n}
            {n === MINE && mine.length ? ` (${mine.length})` : ''}
          </button>
        ))}
      </div>
      <div className="stamp-sheet">
        {impressions.map((s, i) => (
          <div key={`${s.label}-${i}`} className="impression-wrap">
            <button className="impression" onClick={() => use(s)} title={`Place "${s.label}"`}>
              <img src={s.dataUrl} alt={s.label} style={{ transform: `rotate(${TILT[i % TILT.length]}deg)` }} />
            </button>
            {setName === MINE && (
              <button className="impression-x" title="Remove from My stamps" aria-label={`Remove ${s.label}`} onClick={() => removeMine(i)}>
                ×
              </button>
            )}
          </div>
        ))}
        {!impressions.length && <p className="note-line">Nothing here yet. Design a stamp below and press "Save to My stamps".</p>}
      </div>
      <div className="stamp-custom">
        <span className="ctx-cap">Your own stamp</span>
        <input placeholder="e.g. CHECKED BY ACCOUNTING" value={custom} maxLength={28} onChange={(e) => setCustom(e.target.value)} />
        <div className="ink-row" role="radiogroup" aria-label="Ink colour">
          {INKS.map((k) => (
            <button
              key={k.color}
              role="radio"
              aria-checked={ink === k.color}
              aria-label={`${k.name} ink`}
              className={`swatch ${ink === k.color ? 'on' : ''}`}
              style={{ background: k.color }}
              onClick={() => setInk(k.color)}
            />
          ))}
          <input type="color" className="ink-pick" value={ink} onChange={(e) => setInk(e.target.value)} title="Any colour" aria-label="Pick any ink colour" />
        </div>
        <select className="shape-pick" value={shape} onChange={(e) => setShape(e.target.value as StampShape)} aria-label="Stamp shape">
          {STAMP_SHAPES.map((s) => (
            <option key={s.shape} value={s.shape}>
              {s.name}
            </option>
          ))}
        </select>
        <button disabled={!customImg} onClick={saveMine} title="Keep this stamp for next time">
          Save to My stamps
        </button>
        <button className="primary" disabled={!customImg} onClick={() => customImg && use(customImg)}>
          Place stamp
        </button>
      </div>
      {customImg && (
        <div className="stamp-proof">
          <img src={customImg.dataUrl} alt="Preview of your stamp" />
        </div>
      )}
    </>
  );
}

export function SignatureDialog({
  initialTab,
  onPick,
  onClose,
}: {
  initialTab?: TabKey;
  onPick: (img: PendingImage) => void;
  onClose: () => void;
}) {
  const [sigs, setSigs] = useState<SavedSig[]>(loadSigs);
  const [tab, setTab] = useState<TabKey>(initialTab || (loadSigs().length ? 'saved' : 'draw'));
  const [color, setColor] = useState('#0b1f66');
  const [kind, setKind] = useState<'signature' | 'initials'>('signature');
  const [typed, setTyped] = useState('');
  const [font, setFont] = useState(SIGNATURE_FONTS[0]);
  const [remember, setRemember] = useState(true);
  const [show, setShow] = useState<StampShow>({ name: true, date: true, time: true });
  const [userName, setUserName] = useState(() => localStorage.getItem('acro.user') || '');
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawn = useRef(false);

  const finish = async (dataUrl: string, label: string, store: boolean) => {
    if (store && remember) {
      const next = [{ id: uid(), dataUrl, kind }, ...sigs];
      saveSigs(next);
      setSigs(next);
    }
    const { w, h } = await imageSize(dataUrl);
    const targetW = label === 'stamp' ? w / 3 : kind === 'initials' ? 70 : 160;
    onPick({ dataUrl, w: targetW, h: (h / w) * targetW, label });
  };

  // drawing pad
  useEffect(() => {
    if (tab !== 'draw') return;
    const c = canvas.current!;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, c.width, c.height);
    drawn.current = false;
    let drawing = false;
    let last: [number, number] = [0, 0];
    const pos = (e: PointerEvent): [number, number] => {
      const r = c.getBoundingClientRect();
      return [((e.clientX - r.left) * c.width) / r.width, ((e.clientY - r.top) * c.height) / r.height];
    };
    const down = (e: PointerEvent) => {
      drawing = true;
      last = pos(e);
      c.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!drawing) return;
      const p = pos(e);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2 + (e.pressure || 0.5) * 4;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(...last);
      ctx.lineTo(...p);
      ctx.stroke();
      last = p;
      drawn.current = true;
    };
    const up = () => (drawing = false);
    c.addEventListener('pointerdown', down);
    c.addEventListener('pointermove', move);
    c.addEventListener('pointerup', up);
    return () => {
      c.removeEventListener('pointerdown', down);
      c.removeEventListener('pointermove', move);
      c.removeEventListener('pointerup', up);
    };
  }, [tab, color]);

  const upload = async () => {
    const [f] = await window.acro.openPdfs({ multi: false, title: 'Choose image', filters: IMAGE_FILTERS });
    if (!f) return;
    const blob = new Blob([f.data as BlobPart]);
    const bmp = await createImageBitmap(blob);
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext('2d')!.drawImage(bmp, 0, 0);
    // an uploaded e-signature is usually ink on white paper: make the paper see-through before saving it
    await finish(await whiteToTransparent(c.toDataURL('image/png')), kind, true);
  };

  const tabs: [TabKey, string][] = [
    ['saved', 'Saved'],
    ['draw', 'Draw'],
    ['type', 'Type'],
    ['upload', 'Image'],
    ['stamp', 'Stamps'],
  ];

  return (
    <Modal title="Sign & stamp" onClose={onClose} width={640}>
      <div className="seg">
        {tabs.map(([k, l]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </div>

      {(tab === 'draw' || tab === 'type' || tab === 'upload') && (
        <div className="row gap">
          <div className="seg small">
            <button className={kind === 'signature' ? 'on' : ''} onClick={() => setKind('signature')}>
              Signature
            </button>
            <button className={kind === 'initials' ? 'on' : ''} onClick={() => setKind('initials')}>
              Initials
            </button>
          </div>
          {tab !== 'upload' && (
            <div className="swatches">
              {['#0b1f66', '#000000', '#1d5fbf', '#c62828'].map((c) => (
                <button key={c} className={`swatch ${color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => setColor(c)} aria-label={c} />
              ))}
            </div>
          )}
          <label className="check">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Save for next time
          </label>
        </div>
      )}

      {tab === 'saved' &&
        (sigs.length ? (
          <div className="sig-grid">
            {sigs.map((s) => (
              <div key={s.id} className="sig-item">
                <button onClick={() => onPick && imageSize(s.dataUrl).then(({ w, h }) => {
                  const tw = s.kind === 'initials' ? 70 : 160;
                  onPick({ dataUrl: s.dataUrl, w: tw, h: (h / w) * tw, label: s.kind });
                })}>
                  <img src={s.dataUrl} alt={s.kind} />
                </button>
                <button
                  className="icon-btn danger tiny"
                  title="Delete"
                  onClick={() => {
                    const next = sigs.filter((x) => x.id !== s.id);
                    saveSigs(next);
                    setSigs(next);
                  }}
                >
                  <Icon name="trash" size={14} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">No saved signatures yet. Create one with Draw, Type or Image.</p>
        ))}

      {tab === 'draw' && (
        <>
          <canvas ref={canvas} className="sig-pad" width={1200} height={360} />
          <div className="row end gap">
            <button
              onClick={() => {
                const c = canvas.current!;
                c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
                drawn.current = false;
              }}
            >
              Clear
            </button>
            <button className="primary" onClick={() => drawn.current && finish(trimCanvas(canvas.current!).toDataURL('image/png'), kind, true)}>
              Use signature
            </button>
          </div>
        </>
      )}

      {tab === 'type' && (
        <>
          <input className="big-input" placeholder={kind === 'initials' ? 'Your initials' : 'Your full name'} value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
          <div className="font-pick">
            {SIGNATURE_FONTS.map((f) => (
              <button key={f} className={font === f ? 'on' : ''} style={{ fontFamily: `"${f}", cursive`, color }} onClick={() => setFont(f)}>
                {typed || 'Signature'}
              </button>
            ))}
          </div>
          <div className="row end">
            <button className="primary" disabled={!typed.trim()} onClick={() => finish(typedSignature(typed.trim(), font, color), kind, true)}>
              Use signature
            </button>
          </div>
        </>
      )}

      {tab === 'upload' && (
        <div className="center-box">
          <p className="muted">Use a scanned signature, a company seal, or any picture. PNGs with transparency look best.</p>
          <button className="primary" onClick={upload}>
            <Icon name="image" /> Choose image…
          </button>
        </div>
      )}

      {tab === 'stamp' && <StampPad onPick={onPick} show={show} setShow={setShow} userName={userName} setUserName={setUserName} />}
    </Modal>
  );
}
