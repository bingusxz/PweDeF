import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { TourStep } from '../help/tours';

const KEY = (id: string) => `acro.tour.${id}`;
export const tourDone = (id: string) => {
  try {
    return localStorage.getItem(KEY(id)) === '1';
  } catch {
    return true; // storage blocked: never nag
  }
};

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A guided tour: dims the screen, rings the real control for each step and explains it. Esc skips. */
export function Tour({ id, steps, onDone }: { id: string; steps: TourStep[]; onDone: () => void }) {
  const [i, setI] = useState(0);
  const [box, setBox] = useState<Box | null>(null);
  const [view, setView] = useState({ w: window.innerWidth, h: window.innerHeight });
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardH, setCardH] = useState(150);
  const step = steps[i];
  const last = i === steps.length - 1;

  const finish = () => {
    try {
      localStorage.setItem(KEY(id), '1');
    } catch {
      /* ignore */
    }
    onDone();
  };

  // where the target is on screen: bring it into view first, then follow it if the window or any panel scrolls or resizes
  useLayoutEffect(() => {
    const find = () => (step.target ? (document.querySelector(step.target) as HTMLElement | null) : null);
    find()?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const measure = () => {
      setView({ w: window.innerWidth, h: window.innerHeight });
      const el = find();
      if (!el) return setBox(null);
      const r = el.getBoundingClientRect();
      setBox(r.width && r.height ? { x: r.left, y: r.top, w: r.width, h: r.height } : null);
    };
    measure();
    let raf = 0;
    const soon = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    window.addEventListener('resize', soon);
    window.addEventListener('scroll', soon, true); // capture: also scrolling inside panels
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', soon);
      window.removeEventListener('scroll', soon, true);
    };
  }, [step]);
  useLayoutEffect(() => {
    if (cardRef.current) setCardH(cardRef.current.offsetHeight);
  }, [i, box]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish();
      else if (e.key === 'ArrowRight' || e.key === 'Enter') (last ? finish : () => setI(i + 1))();
      else if (e.key === 'ArrowLeft' && i > 0) setI(i - 1);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  });

  // the note sits below the target if there is room, else above; no target = centred
  const W = Math.min(340, view.w - 24);
  const pad = 8;
  let left = view.w / 2 - W / 2;
  let top = view.h / 2 - cardH / 2;
  if (box) {
    left = Math.min(Math.max(12, box.x + box.w / 2 - W / 2), view.w - W - 12);
    const below = box.y + box.h + pad + 12;
    top = below + cardH + 12 < view.h ? below : Math.max(12, box.y - pad - 12 - cardH);
    // a very tall target (a whole panel): put the note beside it
    if (box.h > view.h * 0.6) {
      top = Math.min(Math.max(12, box.y + 20), view.h - cardH - 12);
      left = box.x + box.w + 16 + W < view.w ? box.x + box.w + 16 : Math.max(12, box.x - W - 16);
    }
  }

  return (
    <div className="tour" role="dialog" aria-modal="true" aria-label="Guided tour">
      {box ? <div className="tour-ring" style={{ left: box.x - pad, top: box.y - pad, width: box.w + pad * 2, height: box.h + pad * 2 }} /> : <div className="tour-dim" />}
      <div ref={cardRef} className="tour-card" style={{ left, top, width: W }}>
        <small className="tour-count">
          {i + 1} of {steps.length}
        </small>
        <h3>{step.title}</h3>
        <p>{step.text}</p>
        <div className="tour-actions">
          <button className="link-btn" onClick={finish}>
            Skip tour
          </button>
          <span className="tb-spacer" />
          {i > 0 && <button onClick={() => setI(i - 1)}>Back</button>}
          <button className="primary" onClick={last ? finish : () => setI(i + 1)} autoFocus>
            {last ? 'Done' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  );
}
