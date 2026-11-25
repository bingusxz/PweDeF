import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { pdfjs, type PDFDocumentProxy, type PDFPageProxy } from '../lib/pdf';
import { useEditor } from './EditorContext';
import type { Annot, Rect, TextAnnot } from '../types';
import { annotBounds, isBoxAnnot, normRect, uid } from '../lib/util';
import { Icon } from './Icon';
import { markStrokes } from '../lib/marks';

interface Props {
  pdf: PDFDocumentProxy;
  index: number;
  size: { w: number; h: number };
  rev: number;
  registerEl: (i: number, el: HTMLDivElement | null) => void;
}

interface Widget {
  id: string;
  fieldName: string;
  fieldType: string;
  rect: number[];
  fieldValue: any;
  checkBox?: boolean;
  radioButton?: boolean;
  pushButton?: boolean;
  buttonValue?: string;
  exportValue?: string;
  multiLine?: boolean;
  combo?: boolean;
  options?: { exportValue: string; displayValue: string }[];
  readOnly?: boolean;
  maxLen?: number;
}

const DRAW_TOOLS = new Set(['ink', 'rect', 'ellipse', 'line', 'arrow', 'whiteout', 'redact', 'text', 'note', 'mark', 'place', 'hand']);const MARKUP_TOOLS = new Set(['highlight', 'underline', 'strike']);

function PageViewInner({ pdf, index, size, rev, registerEl }: Props) {
  const ed = useEditor();
  const { zoom, tool, style } = ed;
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState<PDFPageProxy | null>(null);
  const [visible, setVisible] = useState(false);
  const [widgets, setWidgets] = useState<Widget[]>([]);
  const [draft, setDraft] = useState<Annot | null>(null);
  const [rendered, setRendered] = useState(false);
  const textItems = useRef<any[]>([]);

  // visibility (lazy render)
  useEffect(() => {
    const el = wrapRef.current!;
    registerEl(index, el);
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { rootMargin: '800px 0px' });
    io.observe(el);
    return () => {
      io.disconnect();
      registerEl(index, null);
    };
  }, [index, registerEl]);

  useEffect(() => {
    if (!visible || page) return;
    let alive = true;
    pdf.getPage(index + 1).then((p) => alive && setPage(p));
    return () => {
      alive = false;
    };
  }, [visible, page, pdf, index, rev]);

  // form widgets on this page
  useEffect(() => {
    if (!page) return;
    let alive = true;
    page
      .getAnnotations({ intent: 'display' })
      .then((anns) => alive && setWidgets(anns.filter((a: any) => a.subtype === 'Widget' && a.fieldName) as Widget[]))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [page]);

  // canvas
  useEffect(() => {
    if (!page || !visible) return;
    const canvas = canvasRef.current!;
    const dpr = window.devicePixelRatio || 1;
    const vp = page.getViewport({ scale: zoom * dpr });
    const off = document.createElement('canvas');
    off.width = Math.ceil(vp.width);
    off.height = Math.ceil(vp.height);
    const task = page.render({
      canvasContext: off.getContext('2d')!,
      viewport: vp,
      annotationMode: pdfjs.AnnotationMode.ENABLE_FORMS,
    });
    task.promise
      .then(() => {
        canvas.width = off.width;
        canvas.height = off.height;
        canvas.getContext('2d')!.drawImage(off, 0, 0);
        setRendered(true);
      })
      .catch(() => {});
    return () => task.cancel();
  }, [page, visible, zoom]);

  // selectable text layer
  useEffect(() => {
    if (!page || !visible) return;
    const el = textRef.current!;
    el.replaceChildren();
    let tl: InstanceType<typeof pdfjs.TextLayer> | null = null;
    let alive = true;
    page.getTextContent().then((tc) => {
      if (!alive) return;
      const items = (tc.items as any[]).filter((it) => typeof it.str === 'string');
      textItems.current = items;
      tl = new pdfjs.TextLayer({ textContentSource: tc, container: el, viewport: page.getViewport({ scale: zoom }) });
      tl.render()
        .then(() => {
          // tag each span with its text item so Edit Text can read the exact font, size and baseline
          tl!.textDivs.forEach((div, i) => ((div as HTMLElement).dataset.item = String(i)));
        })
        .catch(() => {});
    });
    return () => {
      alive = false;
      tl?.cancel();
    };
  }, [page, visible, zoom]);

  const toPage = (cx: number, cy: number) => {
    const r = wrapRef.current!.getBoundingClientRect();
    return [(cx - r.left) / zoom, (cy - r.top) / zoom] as [number, number];
  };

  // ---------- drawing tools ----------
  const onCapturePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (tool === 'hand') return startPan(e);
    e.preventDefault();
    const [x0, y0] = toPage(e.clientX, e.clientY);
    const id = uid();

    if (tool === 'text') {
      const a: TextAnnot = {
        id, page: index, type: 'text', x: x0, y: y0 - style.fontSize * 0.7, w: 220,
        h: style.fontSize * 1.2 + 4, text: '', fontSize: style.fontSize, color: style.color,
      };
      ed.addAnnot(a, true);
      return;
    }
    if (tool === 'note') {
      ed.addAnnot({ id, page: index, type: 'note', x: x0 - 11, y: y0 - 11, text: '', color: '#f5b800' }, true);
      return;
    }
    if (tool === 'place') {
      ed.placeImageAt(index, x0, y0);
      return;
    }
    if (tool === 'mark') {
      ed.addAnnot({ id, page: index, type: 'mark', kind: style.mark, x: x0, y: y0, size: style.markSize, color: style.color === '#c62828' ? '#000000' : style.color });
      return;
    }
    if (tool === 'move') {
      // grabbing an existing selection drags it; otherwise draw a new selection box
      const hitMove = ed.annots.find((a) => {
        if (a.page !== index || a.type !== 'move') return false;
        const b = annotBounds(a);
        return x0 >= b.x && x0 <= b.x + b.w && y0 >= b.y && y0 <= b.y + b.h;
      });
      if (hitMove) {
        ed.select(hitMove.id);
        ed.pushHistory();
        let last = [x0, y0];
        const mv = (ev: PointerEvent) => {
          const [x, y] = toPage(ev.clientX, ev.clientY);
          const ddx = x - last[0], ddy = y - last[1];
          last = [x, y];
          ed.changeAnnot(hitMove.id, (c) => moveAnnotBy(c, ddx, ddy), false);
        };
        const upMv = () => {
          window.removeEventListener('pointermove', mv);
          window.removeEventListener('pointerup', upMv);
        };
        window.addEventListener('pointermove', mv);
        window.addEventListener('pointerup', upMv);
        return;
      }
    }

    let current: Annot | null = null;
    const move = (ev: PointerEvent) => {
      const [x, y] = toPage(ev.clientX, ev.clientY);
      if (tool === 'ink') {
        const pts = current && current.type === 'ink' ? current.points : [[x0, y0] as [number, number]];
        current = { id, page: index, type: 'ink', points: [...pts, [x, y]], color: style.color, width: style.width };
      } else if (tool === 'line' || tool === 'arrow') {
        let x2 = x, y2 = y;
        if (ev.shiftKey) {
          // snap to 45Â°
          const ang = Math.round(Math.atan2(y - y0, x - x0) / (Math.PI / 4)) * (Math.PI / 4);
          const len = Math.hypot(x - x0, y - y0);
          x2 = x0 + len * Math.cos(ang);
          y2 = y0 + len * Math.sin(ang);
        }
        current = { id, page: index, type: tool, x1: x0, y1: y0, x2, y2, color: style.color, width: style.width };
      } else {
        let r = normRect(x0, y0, x, y);
        if (ev.shiftKey && (tool === 'rect' || tool === 'ellipse')) {
          const s = Math.max(r.w, r.h);
          r = { x: x < x0 ? x0 - s : x0, y: y < y0 ? y0 - s : y0, w: s, h: s };
        }
        if (tool === 'move') current = { id, page: index, type: 'move', from: r, dx: 0, dy: 0, snapshot: '', texts: [] };
        else if (tool === 'whiteout') current = { id, page: index, type: 'whiteout', ...r, color: '#ffffff' };
        else if (tool === 'redact') current = { id, page: index, type: 'redact', ...r };
        else if (tool === 'rect' || tool === 'ellipse')
          current = { id, page: index, type: tool, ...r, color: style.color, width: style.width, fill: style.fill };
      }
      setDraft(current);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDraft(null);
      if (!current) return;
      const b = annotBounds(current);
      if (current.type !== 'ink' && b.w < 3 && b.h < 3) return;
      if (current.type === 'move') {
        const sel = captureArea(current.from);
        ed.addAnnot({ ...current, ...sel });
        ed.select(current.id);
        // fill in exact typefaces for the captured text
        sel.texts.forEach((t, k) => {
          const name = sel.fontNames[k];
          if (name)
            window.acro.matchFont(name).then((m) => {
              if (m)
                ed.changeAnnot(
                  current!.id,
                  (c) => (c.type === 'move' ? { ...c, texts: c.texts.map((x, j) => (j === k ? { ...x, family: m.family, bold: m.bold, italic: m.italic } : x)) } : c),
                  false,
                );
            });
        });
        return;
      }
      ed.addAnnot(current);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /** Text geometry of a pdf.js item in page units (scale 1). */
  const itemGeom = (item: any) => {
    const vp1 = page!.getViewport({ scale: 1 });
    const tx = pdfjs.Util.transform(vp1.transform, item.transform);
    const size = Math.hypot(tx[2], tx[3]);
    return { startX: tx[4], baseline: tx[5], size, w: item.width as number, rect: { x: tx[4] - 1, y: tx[5] - size * 0.95, w: item.width + 2, h: size * 1.25 } };
  };
  const fontNameOf = (item: any) => {
    try {
      return (page!.commonObjs.has(item.fontName) && (page!.commonObjs.get(item.fontName) as any)?.name) || '';
    } catch {
      return '';
    }
  };

  /** Snapshot + text runs inside a Move selection. */
  const captureArea = (r: Rect) => {
    const canvas = canvasRef.current!;
    const k = canvas.width / size.w;
    let snapshot = '';
    try {
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(r.w * k));
      c.height = Math.max(1, Math.round(r.h * k));
      c.getContext('2d')!.drawImage(canvas, r.x * k, r.y * k, r.w * k, r.h * k, 0, 0, c.width, c.height);
      snapshot = c.toDataURL('image/png');
    } catch {
      /* preview only */
    }
    const texts: import('../types').MovedText[] = [];
    const fontNames: string[] = [];
    for (const item of textItems.current) {
      if (!item.str || !item.str.trim()) continue;
      const g = itemGeom(item);
      const inside = g.rect.x >= r.x - 1 && g.rect.y >= r.y - 1 && g.rect.x + g.rect.w <= r.x + r.w + 1 && g.rect.y + g.rect.h <= r.y + r.h + 1;
      if (!inside) continue;
      const name = fontNameOf(item);
      const fam = name.toLowerCase();
      texts.push({
        text: item.str,
        orig: g.rect,
        startX: g.startX,
        baseline: g.baseline,
        fontSize: Math.round(g.size * 100) / 100,
        bold: /bold|black|heavy|semibold|demi/i.test(name),
        italic: /italic|oblique/i.test(name),
        font: /courier|mono/.test(fam) ? 'mono' : /times|serif|georgia|garamond|cambria/.test(fam) && !/sans/.test(fam) ? 'serif' : 'sans',
        color: sampleInkRect(canvas, g.rect, k),
      });
      fontNames.push(name);
    }
    return { snapshot, texts, fontNames };
  };

  // ---------- line reflow: a longer edit pushes the rest of its line along ----------
  const prevEditing = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevEditing.current;
    prevEditing.current = ed.editingId;
    if (!prev || prev === ed.editingId || !page) return;
    const a = ed.annots.find((x) => x.id === prev);
    if (!a || a.type !== 'replace' || a.page !== index || a.itemIndex === undefined || a.startX === undefined || a.baseline === undefined) return;
    const src = textItems.current[a.itemIndex];
    if (!src) return;
    const ctx = document.createElement('canvas').getContext('2d')!;
    ctx.font = `${a.italic ? 'italic ' : ''}${a.bold ? 700 : 400} ${a.fontSize}px "${a.family || 'Arial'}", sans-serif`;
    const newEnd = a.startX + ctx.measureText(a.text).width;
    const origEnd = a.startX + src.width;
    const delta = newEnd - origEnd;
    // neighbours on the same baseline, to the right, contiguous (gaps under 3em)
    const row = textItems.current
      .map((it, i) => ({ it, i, g: it.str?.trim() ? itemGeom(it) : null }))
      .filter((x) => x.g && x.i !== a.itemIndex && Math.abs(x.g.baseline - a.baseline!) < 0.6 && x.g.startX >= origEnd - 0.5)
      .sort((p, q) => p.g!.startX - q.g!.startX);
    const chain: typeof row = [];
    let end = origEnd;
    for (const r of row) {
      if (r.g!.startX - end > a.fontSize * 3) break;
      chain.push(r);
      end = r.g!.startX + r.g!.w;
    }
    // replace previous pushes, then push only when the edit would collide
    for (const id of a.pushed || []) ed.removeAnnot(id);
    if (delta <= 0.5 || !chain.length) {
      if (a.pushed?.length) ed.changeAnnot(a.id, (c) => ({ ...c, pushed: [] }) as Annot, false);
      return;
    }
    const canvas = canvasRef.current!;
    const k = canvas.width / size.w;
    const ids: string[] = [];
    for (const { it, g } of chain) {
      const name = fontNameOf(it);
      const nid = uid();
      ids.push(nid);
      ed.addAnnot({
        id: nid, page: index, type: 'replace', x: g!.rect.x + delta, y: g!.rect.y, w: g!.rect.w, h: g!.rect.h, orig: g!.rect,
        text: it.str, fontSize: Math.round(g!.size * 100) / 100, color: sampleInkRect(canvas, g!.rect, k), bg: '#ffffff',
        bold: /bold|black|heavy|semibold|demi/i.test(name), italic: /italic|oblique/i.test(name),
        baseline: g!.baseline, startX: g!.startX + delta, pushedBy: a.id,
      });
      if (name) window.acro.matchFont(name).then((m) => m && ed.changeAnnot(nid, (c) => ({ ...c, family: m.family, bold: m.bold, italic: m.italic }) as Annot, false));
    }
    ed.changeAnnot(a.id, (c) => ({ ...c, pushed: ids }) as Annot, false);
  }, [ed.editingId]);

  const startPan = (e: React.PointerEvent) => {
    const scroller = wrapRef.current!.closest('.viewer') as HTMLElement;
    const sx = e.clientX, sy = e.clientY, sl = scroller.scrollLeft, st = scroller.scrollTop;
    const move = (ev: PointerEvent) => {
      scroller.scrollLeft = sl - (ev.clientX - sx);
      scroller.scrollTop = st - (ev.clientY - sy);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // ---------- text markup (highlight / underline / strike) & edit text ----------
  const markStart = useRef<[number, number] | null>(null);
  const onWrapPointerDown = (e: React.PointerEvent) => {
    if (MARKUP_TOOLS.has(tool)) markStart.current = toPage(e.clientX, e.clientY);
    if (tool === 'select' && e.target === e.currentTarget) ed.select(null);
  };
  const onWrapPointerUp = (e: React.PointerEvent) => {
    if (!MARKUP_TOOLS.has(tool)) return;
    const sel = window.getSelection();
    const color = tool === 'highlight' ? style.highlight : style.color;
    const type = tool as 'highlight' | 'underline' | 'strike';
    if (sel && !sel.isCollapsed && sel.rangeCount && textRef.current!.contains(sel.anchorNode)) {
      const rects = mergeLineRects(
        [...sel.getRangeAt(0).getClientRects()]
          .filter((r) => r.width > 0.5 && r.height > 0.5)
          .map((r) => {
            const [x, y] = toPage(r.left, r.top);
            return { x, y, w: r.width / zoom, h: r.height / zoom };
          }),
      );
      sel.removeAllRanges();
      if (rects.length) ed.addAnnot({ id: uid(), page: index, type, rects, color });
    } else if (markStart.current) {
      // area markup for scanned pages
      const [x0, y0] = markStart.current;
      const [x1, y1] = toPage(e.clientX, e.clientY);
      const r = normRect(x0, y0, x1, y1);
      if (r.w > 4 && r.h > 4) ed.addAnnot({ id: uid(), page: index, type, rects: [r], color });
    }
    markStart.current = null;
  };

  const onTextClick = (e: React.MouseEvent) => {
    if (tool !== 'editText' || !page) return;
    const span = (e.target as HTMLElement).closest('span') as HTMLElement | null;
    if (!span || !textRef.current!.contains(span) || !span.textContent?.trim()) return;
    const r = span.getBoundingClientRect();
    const [x, y] = toPage(r.left, r.top);
    const w = r.width / zoom;
    const h = r.height / zoom;
    const item = textItems.current[Number(span.dataset.item)];

    // exact geometry from the PDF text item (scale-1 page units)
    let fontSize = Math.max(4, Math.round(h * 0.9 * 2) / 2);
    let baseline: number | undefined;
    let startX: number | undefined;
    let pdfFontName = '';
    if (item) {
      const vp1 = page.getViewport({ scale: 1 });
      const tx = pdfjs.Util.transform(vp1.transform, item.transform);
      fontSize = Math.round(Math.hypot(tx[2], tx[3]) * 100) / 100;
      baseline = tx[5];
      startX = tx[4];
      try {
        pdfFontName = (page.commonObjs.has(item.fontName) && (page.commonObjs.get(item.fontName) as any)?.name) || '';
      } catch {
        pdfFontName = '';
      }
    }
    const bold = /bold|black|heavy|semibold|demi/i.test(pdfFontName);
    const italic = /italic|oblique/i.test(pdfFontName);
    const fam = (span.style.fontFamily + ' ' + pdfFontName).toLowerCase();
    const font = /courier|mono/.test(fam) ? 'mono' : /times|serif|georgia|garamond|cambria|book/.test(fam) && !/sans/.test(fam) ? 'serif' : 'sans';
    const id = uid();
    const box = { x: x - 1, y: y - 0.5, w: w + 2, h: h + 1 };
    ed.addAnnot(
      {
        id, page: index, type: 'replace', ...box, orig: box,
        text: span.textContent, fontSize, color: sampleInk(canvasRef.current!, r, wrapRef.current!), bg: '#ffffff', itemIndex: item ? Number(span.dataset.item) : undefined,
        font, bold, italic, baseline, startX,
      },
      true,
    );
    // upgrade to the exact installed typeface once we know it
    if (pdfFontName)
      window.acro.matchFont(pdfFontName).then((m) => {
        if (m) ed.changeAnnot(id, (a) => ({ ...a, family: m.family, bold: m.bold, italic: m.italic }) as Annot, false);
      });
  };

  const pageAnnots = ed.annots.filter((a) => a.page === index);
  const pageHits = ed.hits.map((h, i) => ({ ...h, i })).filter((h) => h.page === index);
  const W = size.w * zoom;
  const H = size.h * zoom;
  const textOnTop = tool === 'select' || tool === 'editText' || MARKUP_TOOLS.has(tool);

  return (
    <div
      ref={wrapRef}
      className={`page tool-${tool}`}
      style={{ width: W, height: H, ['--scale-factor' as any]: zoom, ['--user-unit' as any]: 1, ['--total-scale-factor' as any]: zoom }}
      data-page={index}
      onPointerDown={onWrapPointerDown}
      onPointerUp={onWrapPointerUp}
    >
      <canvas ref={canvasRef} className="page-canvas" style={{ width: W, height: H }} />
      {!rendered && <div className="page-loading">Loading page {index + 1}â€¦</div>}
      <div ref={textRef} className={`textLayer ${textOnTop ? 'on-top' : ''}`} onClick={onTextClick} />

      {/* annotations */}
      <svg className="annot-svg" width={W} height={H}>
        {pageHits.map((h) => (
          <rect
            key={'h' + h.i}
            x={h.rect.x * zoom}
            y={h.rect.y * zoom}
            width={h.rect.w * zoom}
            height={h.rect.h * zoom}
            className={h.i === ed.activeHit ? 'hit active' : 'hit'}
          />
        ))}
        {[...pageAnnots, ...(draft ? [draft] : [])].map((a) => (
          <SvgAnnot key={a.id} a={a} zoom={zoom} />
        ))}
      </svg>
      <div className="annot-html">
        {pageAnnots.map((a) => (
          <HtmlAnnot key={a.id} a={a} />
        ))}
        {draft && <HtmlAnnot a={draft} draft />}
      </div>

      {/* live form fields */}
      <div className="form-layer">
        {widgets.map((w) => (
          <FormField key={w.id} w={w} page={page!} index={index} />
        ))}
      </div>

      {!textOnTop && <div className="capture" onPointerDown={onCapturePointerDown} />}
      <div className="page-number">{index + 1}</div>
    </div>
  );
}

/** Same as sampleInk, for a rect in page units (k = canvas pixels per page unit). */
function sampleInkRect(canvas: HTMLCanvasElement, r: Rect, k: number): string {
  try {
    const x = Math.max(0, Math.floor(r.x * k)), y = Math.max(0, Math.floor(r.y * k));
    const w = Math.max(1, Math.min(canvas.width - x, Math.ceil(r.w * k)));
    const h = Math.max(1, Math.min(canvas.height - y, Math.ceil(r.h * k)));
    const d = canvas.getContext('2d')!.getImageData(x, y, w, h).data;
    let best = 766;
    let rgb = [0, 0, 0];
    for (let i = 0; i < d.length; i += 4) {
      const lum = d[i] + d[i + 1] + d[i + 2];
      if (d[i + 3] > 200 && lum < best) {
        best = lum;
        rgb = [d[i], d[i + 1], d[i + 2]];
      }
    }
    if (best < 120) return '#000000';
    return '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
  } catch {
    return '#000000';
  }
}

/** Darkest ink inside the clicked text: the original text colour (black for most documents). */
function sampleInk(canvas: HTMLCanvasElement, r: DOMRect, wrap: HTMLElement): string {
  try {
    const wr = wrap.getBoundingClientRect();
    const sx = canvas.width / wr.width;
    const sy = canvas.height / wr.height;
    const x = Math.max(0, Math.floor((r.left - wr.left) * sx));
    const y = Math.max(0, Math.floor((r.top - wr.top) * sy));
    const w = Math.max(1, Math.min(canvas.width - x, Math.ceil(r.width * sx)));
    const h = Math.max(1, Math.min(canvas.height - y, Math.ceil(r.height * sy)));
    const d = canvas.getContext('2d')!.getImageData(x, y, w, h).data;
    let best = 766;
    let rgb = [0, 0, 0];
    for (let k = 0; k < d.length; k += 4) {
      const lum = d[k] + d[k + 1] + d[k + 2];
      if (d[k + 3] > 200 && lum < best) {
        best = lum;
        rgb = [d[k], d[k + 1], d[k + 2]];
      }
    }
    // near-black anti-aliasing noise -> pure black
    if (best < 120) return '#000000';
    return '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
  } catch {
    return '#000000';
  }
}

function mergeLineRects(rs: Rect[]): Rect[] {
  const sorted = [...rs].sort((a, b) => a.y - b.y || a.x - b.x);
  const out: Rect[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.y - r.y) < r.h * 0.5 && r.x <= last.x + last.w + 3) {
      const x2 = Math.max(last.x + last.w, r.x + r.w);
      const y2 = Math.max(last.y + last.h, r.y + r.h);
      last.x = Math.min(last.x, r.x);
      last.y = Math.min(last.y, r.y);
      last.w = x2 - last.x;
      last.h = y2 - last.y;
    } else out.push({ ...r });
  }
  return out;
}

function arrowHead(a: { x1: number; y1: number; x2: number; y2: number; width: number }, z: number) {
  const ang = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
  const len = Math.max(8, a.width * 4) * z;
  const ex = a.x2 * z, ey = a.y2 * z;
  return [Math.PI - 0.45, Math.PI + 0.45].map((d) => `M${ex},${ey}L${ex + len * Math.cos(ang + d)},${ey + len * Math.sin(ang + d)}`).join('');
}

function SvgAnnot({ a, zoom: z }: { a: Annot; zoom: number }) {
  const ed = useEditor();
  const sel = ed.selectedId === a.id;
  const interactive = ed.tool === 'select';
  const onDown = (e: React.PointerEvent) => interactive && startMove(e, a, ed, z);
  const common = { onPointerDown: onDown, className: `svg-annot ${sel ? 'selected' : ''} ${interactive ? 'interactive' : ''}` };
  switch (a.type) {
    case 'highlight':
      return (
        <g {...common} style={{ mixBlendMode: 'multiply' }}>
          {a.rects.map((r, i) => (
            <rect key={i} x={r.x * z} y={r.y * z} width={r.w * z} height={r.h * z} fill={a.color} opacity={0.4} />
          ))}
        </g>
      );
    case 'underline':
    case 'strike':
      return (
        <g {...common}>
          {a.rects.map((r, i) => {
            const yy = (a.type === 'underline' ? r.y + r.h * 0.95 : r.y + r.h * 0.55) * z;
            return (
              <g key={i}>
                <rect x={r.x * z} y={r.y * z} width={r.w * z} height={r.h * z} fill="transparent" />
                <line x1={r.x * z} x2={(r.x + r.w) * z} y1={yy} y2={yy} stroke={a.color} strokeWidth={Math.max(0.8, r.h * 0.07) * z} />
              </g>
            );
          })}
        </g>
      );
    case 'ink':
      return (
        <polyline
          {...common}
          points={a.points.map(([x, y]) => `${x * z},${y * z}`).join(' ')}
          fill="none"
          stroke={a.color}
          strokeWidth={a.width * z}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      );
    case 'rect':
      return (
        <rect {...common} x={a.x * z} y={a.y * z} width={a.w * z} height={a.h * z} stroke={a.color} strokeWidth={a.width * z} fill={a.fill || 'transparent'} />
      );
    case 'ellipse':
      return (
        <ellipse
          {...common}
          cx={(a.x + a.w / 2) * z}
          cy={(a.y + a.h / 2) * z}
          rx={(a.w / 2) * z}
          ry={(a.h / 2) * z}
          stroke={a.color}
          strokeWidth={a.width * z}
          fill={a.fill || 'transparent'}
        />
      );
    case 'mark': {
      const s = a.size * z;
      const cx = a.x * z;
      const cy = a.y * z;
      return (
        <g {...common}>
          <rect x={cx - s / 2} y={cy - s / 2} width={s} height={s} fill="transparent" />
          {a.kind === 'dot' ? (
            <circle cx={cx} cy={cy} r={s * 0.28} fill={a.color} />
          ) : (
            markStrokes(a.kind).map((pts, i) => (
              <polyline
                key={i}
                points={pts.map(([px, py]) => `${cx + px * s},${cy + py * s}`).join(' ')}
                fill="none"
                stroke={a.color}
                strokeWidth={Math.max(1, s * 0.13)}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ))
          )}
        </g>
      );
    }
    case 'line':
    case 'arrow':
      return (
        <g {...common}>
          <line x1={a.x1 * z} y1={a.y1 * z} x2={a.x2 * z} y2={a.y2 * z} stroke="transparent" strokeWidth={Math.max(10, a.width * z)} />
          <path
            d={`M${a.x1 * z},${a.y1 * z}L${a.x2 * z},${a.y2 * z}${a.type === 'arrow' ? arrowHead(a, z) : ''}`}
            stroke={a.color}
            strokeWidth={a.width * z}
            strokeLinecap="round"
            fill="none"
          />
        </g>
      );
    default:
      return null;
  }
}

function startMove(e: React.PointerEvent, a: Annot, ed: ReturnType<typeof useEditor>, zoom: number) {
  if (e.button !== 0) return;
  e.stopPropagation();
  e.preventDefault();
  ed.select(a.id);
  const sx = e.clientX, sy = e.clientY;
  let moved = false;
  let last = [0, 0];
  const move = (ev: PointerEvent) => {
    const dx = (ev.clientX - sx) / zoom, dy = (ev.clientY - sy) / zoom;
    if (!moved && Math.hypot(dx, dy) * zoom < 3) return;
    if (!moved) ed.pushHistory();
    moved = true;
    const ddx = dx - last[0], ddy = dy - last[1];
    last = [dx, dy];
    ed.changeAnnot(a.id, (cur) => moveAnnotBy(cur, ddx, ddy), false);
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

import { moveAnnot as moveAnnotBy } from '../lib/util';

function startResize(e: React.PointerEvent, a: Annot & Rect, ed: ReturnType<typeof useEditor>, zoom: number) {
  e.stopPropagation();
  e.preventDefault();
  ed.pushHistory();
  const sx = e.clientX, sy = e.clientY;
  const { w: w0, h: h0 } = a;
  const keepAspect = a.type === 'image';
  const move = (ev: PointerEvent) => {
    let w = Math.max(8, w0 + (ev.clientX - sx) / zoom);
    let h = Math.max(8, h0 + (ev.clientY - sy) / zoom);
    if (keepAspect !== ev.shiftKey) h = (w * h0) / w0;
    ed.changeAnnot(a.id, (cur) => ({ ...cur, w, h }) as Annot, false);
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function HtmlAnnot({ a, draft }: { a: Annot; draft?: boolean }) {
  const ed = useEditor();
  const z = ed.zoom;
  const sel = ed.selectedId === a.id && !draft;
  const editing = ed.editingId === a.id;
  const interactive = ed.tool === 'select' && !draft;
  const taRef = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    if (editing && taRef.current) {
      taRef.current.focus();
      if (a.type === 'replace') taRef.current.select();
    }
  }, [editing]);

  // auto-grow text boxes while typing
  useLayoutEffect(() => {
    if (!editing || !taRef.current || (a.type !== 'text' && a.type !== 'replace')) return;
    const ta = taRef.current;
    const needH = ta.scrollHeight / z;
    const needW = ta.scrollWidth / z;
    if (needH > a.h + 0.5 || (a.type === 'replace' && needW > a.w + 0.5))
      ed.changeAnnot(a.id, (c) => ({ ...c, h: Math.max((c as any).h, needH), w: a.type === 'replace' ? Math.max((c as any).w, needW) : (c as any).w }) as Annot, false);
  });

  const b = annotBounds(a);
  const box = { left: b.x * z, top: b.y * z, width: b.w * z, height: b.h * z };
  const onDown = (e: React.PointerEvent) => {
    if (!interactive || editing) return;
    startMove(e, a, ed, z);
  };
  const onDbl = () => {
    if (a.type === 'text' || a.type === 'replace' || a.type === 'note') ed.edit(a.id);
  };

  let body: React.ReactNode = null;
  switch (a.type) {
    case 'text':
    case 'replace': {
      const st: React.CSSProperties = {
        fontSize: a.fontSize * z,
        color: a.color,
        background: a.bg || 'transparent',
        fontWeight: a.bold ? 700 : 400,
        fontStyle: a.italic ? 'italic' : undefined,
        padding: 2 * z,
        fontFamily: a.family
          ? `"${a.family}", ${a.font === 'serif' ? 'serif' : a.font === 'mono' ? 'monospace' : 'sans-serif'}`
          : a.font === 'serif'
            ? '"Times New Roman", Times, serif'
            : a.font === 'mono'
              ? '"Courier New", Courier, monospace'
              : undefined,
        whiteSpace: a.type === 'replace' ? 'pre' : undefined,
      };
      if (a.type === 'replace' && a.orig) st.background = 'transparent'; // only the original word is hidden (see cover below)
      if (a.type === 'replace' && a.baseline !== undefined && a.startX !== undefined) {
        // sit the preview on the original baseline (â‰ˆ0.9em ascent) and start x
        st.lineHeight = 1;
        st.padding = `${Math.max(0, (a.baseline - a.y - a.fontSize * 0.9) * z)}px 0 0 ${Math.max(0, (a.startX - a.x) * z)}px`;
      }
      // preview-only: hide exactly the original word (on save it is removed from the PDF itself)
      const cover =
        a.type === 'replace' && a.orig ? (
          <div
            className="orig-cover"
            style={{
              left: (a.orig.x + 0.75 - b.x) * z,
              top: (a.orig.y + 0.5 - b.y) * z,
              width: Math.max(0, a.orig.w - 1.5) * z,
              height: Math.max(0, a.orig.h - 1) * z,
            }}
          />
        ) : null;
      body = (
        <>
          {cover}
          {editing ? (
            <textarea
              ref={taRef}
              className="text-edit"
              rows={1}
              style={st}
              value={a.text}
              onChange={(e) => ed.changeAnnot(a.id, (c) => ({ ...c, text: e.target.value }) as Annot, false)}
              onBlur={() => {
                ed.edit(null);
                if (!a.text.trim() && a.type === 'text') ed.removeAnnot(a.id);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') (e.target as HTMLTextAreaElement).blur();
                e.stopPropagation();
              }}
            />
          ) : (
            <div className="text-view" style={st}>
              {a.text}
            </div>
          )}
        </>
      );
      break;
    }
    case 'move':
      body = (
        <>
          {(a.dx || a.dy) && (
            // the original spot, emptied (preview; on save the objects really move)
            <div className="orig-cover" style={{ left: -a.dx * z, top: -a.dy * z, width: a.from.w * z, height: a.from.h * z }} />
          )}
          {a.snapshot && <img src={a.snapshot} draggable={false} alt="" className="move-snap" />}
          <div className="move-frame" />
        </>
      );
      break;
    case 'whiteout':
      body = <div className="fill" style={{ background: a.color }} />;
      break;
    case 'redact':
      body = <div className="fill redact" />;
      break;
    case 'image':
      body = <img src={a.dataUrl} draggable={false} alt={a.label || 'image'} />;
      break;
    case 'note':
      body = (
        <>
          <div className="note-icon" style={{ background: a.color }}>
            <Icon name="note" size={14 * Math.min(z, 1.6)} />
          </div>
          {(editing || sel) && (
            <div className="note-pop" onPointerDown={(e) => e.stopPropagation()}>
              <textarea
                ref={editing ? taRef : undefined}
                placeholder="Write a commentâ€¦"
                value={a.text}
                onChange={(e) => ed.changeAnnot(a.id, (c) => ({ ...c, text: e.target.value }) as Annot, false)}
                onFocus={() => ed.edit(a.id)}
                onBlur={() => ed.edit(null)}
                onKeyDown={(e) => e.stopPropagation()}
              />
            </div>
          )}
        </>
      );
      break;
    default:
      // vector annotations render in SVG; only draw selection chrome here
      if (!sel) return null;
  }

  return (
    <div
      className={`html-annot t-${a.type} ${sel ? 'selected' : ''} ${interactive ? 'interactive' : ''} ${body ? '' : 'chrome-only'}`}
      style={box}
      onPointerDown={body ? onDown : undefined}
      onDoubleClick={onDbl}
    >
      {body}
      {sel && isBoxAnnot(a) && (
        <div className="resize-handle" onPointerDown={(e) => startResize(e, a as Annot & Rect, ed, z)} />
      )}
    </div>
  );
}

function FormField({ w, page, index }: { w: Widget; page: PDFPageProxy; index: number }) {
  const ed = useEditor();
  const vp = page.getViewport({ scale: ed.zoom });
  const [x1, y1, x2, y2] = vp.convertToViewportRectangle(w.rect);
  const style: React.CSSProperties = {
    left: Math.min(x1, x2),
    top: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
  const stored = ed.form[w.fieldName];
  const disabled = w.readOnly || ed.tool !== 'select';
  const h = Math.abs(y2 - y1);

  if (w.fieldType === 'Tx') {
    const value = (stored ?? w.fieldValue ?? '') as string;
    const fs = Math.min(h * 0.68, 14 * ed.zoom);
    const common = {
      className: 'ff ff-text',
      style: { ...style, fontSize: w.multiLine ? 11 * ed.zoom : fs },
      value: String(value),
      disabled,
      maxLength: w.maxLen || undefined,
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => ed.setFormValue(w.fieldName, e.target.value),
      onKeyDown: (e: React.KeyboardEvent) => e.stopPropagation(),
      title: w.fieldName,
    };
    return w.multiLine ? <textarea {...common} /> : <input {...common} />;
  }
  if (w.fieldType === 'Btn' && w.checkBox) {
    const checked = stored !== undefined ? !!stored : !!w.fieldValue && w.fieldValue !== 'Off';
    return (
      <input
        type="checkbox"
        className="ff ff-check"
        style={style}
        checked={checked}
        disabled={disabled}
        title={w.fieldName}
        onChange={(e) => ed.setFormValue(w.fieldName, e.target.checked)}
      />
    );
  }
  if (w.fieldType === 'Btn' && w.radioButton) {
    const cur = stored !== undefined ? stored : w.fieldValue;
    return (
      <input
        type="radio"
        className="ff ff-check"
        style={style}
        name={`${index}-${w.fieldName}`}
        checked={cur === w.buttonValue}
        disabled={disabled}
        title={`${w.fieldName}: ${w.buttonValue}`}
        onChange={() => ed.setFormValue(w.fieldName, w.buttonValue || '')}
      />
    );
  }
  if (w.fieldType === 'Ch' && w.options) {
    const value = String(stored ?? (Array.isArray(w.fieldValue) ? w.fieldValue[0] : w.fieldValue) ?? '');
    return (
      <select
        className="ff ff-select"
        style={{ ...style, fontSize: Math.min(h * 0.6, 13 * ed.zoom) }}
        value={value}
        disabled={disabled}
        title={w.fieldName}
        onChange={(e) => ed.setFormValue(w.fieldName, e.target.value)}
      >
        <option value="" />
        {w.options.map((o) => (
          <option key={o.exportValue} value={o.exportValue}>
            {o.displayValue}
          </option>
        ))}
      </select>
    );
  }
  if (w.fieldType === 'Sig') {
    return (
      <button
        className="ff ff-sig"
        style={style}
        disabled={ed.tool !== 'select'}
        onClick={() => {
          const r = Math.min(x1, x2) / ed.zoom;
          ed.signField(index, { x: r, y: Math.min(y1, y2) / ed.zoom, w: Math.abs(x2 - x1) / ed.zoom, h: Math.abs(y2 - y1) / ed.zoom });
        }}
      >
        <Icon name="sign" size={14} /> Sign here
      </button>
    );
  }
  return null;
}

export const PageView = memo(PageViewInner);
export { DRAW_TOOLS };
