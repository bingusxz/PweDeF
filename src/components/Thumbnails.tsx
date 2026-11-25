import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from '../lib/pdf';
import { Icon } from './Icon';

export interface PageActions {
  rotate(indices: number[], delta: number): void;
  remove(indices: number[]): void;
  extract(indices: number[]): void;
  duplicate(indices: number[]): void;
  insertBlank(at: number): void;
  insertFile(at: number): void;
  reorder(order: number[]): void;
  goto(i: number): void;
}

export function Thumbnails({
  pdf,
  rev,
  current,
  actions,
}: {
  pdf: PDFDocumentProxy;
  rev: number;
  current: number;
  actions: PageActions;
}) {
  const n = pdf.numPages;
  const [sel, setSel] = useState<number[]>([]);
  const anchor = useRef(0);
  const [dragOver, setDragOver] = useState<number | null>(null);

  useEffect(() => {
    setSel([]);
  }, [rev]);

  const click = (i: number, e: React.MouseEvent) => {
    if (e.shiftKey) {
      const [a, b] = [Math.min(anchor.current, i), Math.max(anchor.current, i)];
      setSel(Array.from({ length: b - a + 1 }, (_, k) => a + k));
    } else if (e.ctrlKey || e.metaKey) {
      setSel((s) => (s.includes(i) ? s.filter((x) => x !== i) : [...s, i]));
      anchor.current = i;
    } else {
      setSel([i]);
      anchor.current = i;
      actions.goto(i);
    }
  };

  const target = sel.length ? [...sel].sort((a, b) => a - b) : [current];

  const drop = (to: number, e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(null);
    const from = Number(e.dataTransfer.getData('text/acro-page'));
    if (Number.isNaN(from)) return;
    const moving = sel.includes(from) ? [...sel].sort((a, b) => a - b) : [from];
    const rest = Array.from({ length: n }, (_, i) => i).filter((i) => !moving.includes(i));
    const insertAt = rest.filter((i) => i < to).length;
    const order = [...rest.slice(0, insertAt), ...moving, ...rest.slice(insertAt)];
    if (order.some((v, i) => v !== i)) actions.reorder(order);
  };

  return (
    <div className="thumbs-panel">
      <div className="panel-toolbar">
        <button className="icon-btn" title="Rotate left" onClick={() => actions.rotate(target, -90)}>
          <Icon name="rotL" />
        </button>
        <button className="icon-btn" title="Rotate right" onClick={() => actions.rotate(target, 90)}>
          <Icon name="rotR" />
        </button>
        <button className="icon-btn" title="Duplicate" onClick={() => actions.duplicate(target)}>
          <Icon name="copy" />
        </button>
        <button className="icon-btn" title="Extract to new PDF" onClick={() => actions.extract(target)}>
          <Icon name="extract" />
        </button>
        <button className="icon-btn" title="Insert blank page after" onClick={() => actions.insertBlank(target[target.length - 1] + 1)}>
          <Icon name="plus" />
        </button>
        <button className="icon-btn" title="Insert pages from PDF after" onClick={() => actions.insertFile(target[target.length - 1] + 1)}>
          <Icon name="merge" />
        </button>
        <button className="icon-btn danger" title="Delete pages" onClick={() => actions.remove(target)}>
          <Icon name="trash" />
        </button>
      </div>
      <div className="panel-hint">
        {sel.length > 1 ? `${sel.length} pages selected` : 'Click, Ctrl/Shift-click to select · drag to reorder'}
      </div>
      <div className="thumbs">
        {Array.from({ length: n }, (_, i) => (
          <div
            key={`${rev}-${i}`}
            className={`thumb ${sel.includes(i) ? 'sel' : ''} ${current === i ? 'current' : ''} ${dragOver === i ? 'drop' : ''}`}
            draggable
            onDragStart={(e) => e.dataTransfer.setData('text/acro-page', String(i))}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(i);
            }}
            onDragLeave={() => setDragOver(null)}
            onDrop={(e) => drop(i, e)}
            onClick={(e) => click(i, e)}
          >
            <Thumb pdf={pdf} index={i} />
            <span>{i + 1}</span>
          </div>
        ))}
        <div
          className={`thumb-end ${dragOver === n ? 'drop' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(n);
          }}
          onDrop={(e) => drop(n, e)}
        />
      </div>
    </div>
  );
}

function Thumb({ pdf, index }: { pdf: PDFDocumentProxy; index: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [vis, setVis] = useState(false);
  useEffect(() => {
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setVis(true), { rootMargin: '300px' });
    io.observe(ref.current!);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!vis) return;
    let task: any;
    pdf.getPage(index + 1).then((p) => {
      const base = p.getViewport({ scale: 1 });
      const vp = p.getViewport({ scale: (130 / base.width) * (window.devicePixelRatio || 1) });
      const c = ref.current;
      if (!c) return;
      c.width = vp.width;
      c.height = vp.height;
      task = p.render({ canvasContext: c.getContext('2d')!, viewport: vp });
      task.promise.catch(() => {});
    });
    return () => task?.cancel();
  }, [vis, pdf, index]);
  return <canvas ref={ref} className="thumb-canvas" />;
}
