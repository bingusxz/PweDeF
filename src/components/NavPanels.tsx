// Side panels for the bookmarks (outline) and the files attached to a PDF.
import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import type { PDFDocumentProxy } from '../lib/pdf';
import { listAttachments, readOutline, type Attachment, type OutlineItem } from '../lib/navdata';
import { errText, toast } from '../lib/toast';

type Path = number[];

const at = (tree: OutlineItem[], path: Path): OutlineItem => path.reduce<any>((list, i, k) => (k === path.length - 1 ? list[i] : list[i].children), tree);
const listOf = (tree: OutlineItem[], path: Path): OutlineItem[] => (path.length === 1 ? tree : at(tree, path.slice(0, -1)).children);
const clone = (t: OutlineItem[]): OutlineItem[] => JSON.parse(JSON.stringify(t));

export function BookmarksPanel({ pdf, rev, current, onGo, onSave }: { pdf: PDFDocumentProxy; rev: number; current: number; onGo: (page: number) => void; onSave: (tree: OutlineItem[]) => void }) {
  const [tree, setTree] = useState<OutlineItem[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  useEffect(() => {
    let alive = true;
    setTree(null);
    readOutline(pdf)
      .then((t) => alive && setTree(t))
      .catch(() => alive && setTree([]));
    return () => {
      alive = false;
    };
  }, [pdf, rev]);

  const apply = (fn: (t: OutlineItem[]) => void) => {
    const t = clone(tree || []);
    fn(t);
    onSave(t);
  };
  const add = () =>
    apply((t) => {
      // a new bookmark goes under the nearest earlier top-level bookmark's level: simply at the end
      t.push({ title: `Page ${current + 1}`, page: current, children: [] });
    });
  const commit = (p: Path) => {
    const title = draft.trim();
    setEditing(null);
    if (title) apply((t) => (at(t, p).title = title));
  };
  const move = (p: Path, d: -1 | 1) =>
    apply((t) => {
      const l = listOf(t, p);
      const i = p[p.length - 1];
      if (i + d < 0 || i + d >= l.length) return;
      [l[i], l[i + d]] = [l[i + d], l[i]];
    });
  const remove = (p: Path) => apply((t) => listOf(t, p).splice(p[p.length - 1], 1));
  const addChild = (p: Path) => apply((t) => at(t, p).children.push({ title: `Page ${current + 1}`, page: current, children: [] }));

  const rows = (list: OutlineItem[], base: Path): React.ReactNode =>
    list.map((it, i) => {
      const p = [...base, i];
      const key = p.join('.');
      return (
        <div key={key}>
          <div className="bm-row" style={{ paddingLeft: 8 + base.length * 14 }}>
            {editing === key ? (
              <input
                autoFocus
                className="bm-edit"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => commit(p)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commit(p);
                  if (e.key === 'Escape') setEditing(null);
                }}
              />
            ) : (
              <button className="bm-title" title={it.url ? it.url : it.page !== null ? `Go to page ${it.page + 1}` : 'Does not point to a page'} disabled={it.page === null} onClick={() => it.page !== null && onGo(it.page)}>
                {it.title}
                {it.page !== null && <span className="muted"> p.{it.page + 1}</span>}
              </button>
            )}
            <span className="bm-actions">
              <button title="Rename" onClick={() => (setDraft(it.title), setEditing(key))}>
                <Icon name="editText" size={14} />
              </button>
              <button title="Add a bookmark for this page inside it" onClick={() => addChild(p)}>
                <Icon name="add" size={14} />
              </button>
              <button title="Move up" onClick={() => move(p, -1)} disabled={i === 0}>
                <Icon name="chevD" size={14} className="flip" />
              </button>
              <button title="Move down" onClick={() => move(p, 1)} disabled={i === list.length - 1}>
                <Icon name="chevD" size={14} />
              </button>
              <button title="Delete this bookmark" onClick={() => remove(p)}>
                <Icon name="trash" size={14} />
              </button>
            </span>
          </div>
          {it.children.length > 0 && rows(it.children, p)}
        </div>
      );
    });

  return (
    <div className="bm-panel">
      <button className="tb-btn bm-add" onClick={add} disabled={!tree}>
        <Icon name="add" size={14} /> Bookmark page {current + 1}
      </button>
      {tree === null && <p className="muted small-text">Reading bookmarks…</p>}
      {tree && !tree.length && <p className="muted small-text">No bookmarks yet. Add one for the page you are on. They also help when you split by bookmarks.</p>}
      {tree && rows(tree, [])}
    </div>
  );
}

const size = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

export function AttachmentsPanel({ pdf, rev, onAttach, onRemove }: { pdf: PDFDocumentProxy; rev: number; onAttach: (f: { name: string; data: Uint8Array }) => void; onRemove: (name: string) => void }) {
  const [files, setFiles] = useState<(Attachment & { data: Uint8Array })[] | null>(null);
  useEffect(() => {
    let alive = true;
    setFiles(null);
    listAttachments(pdf)
      .then((f) => alive && setFiles(f))
      .catch(() => alive && setFiles([]));
    return () => {
      alive = false;
    };
  }, [pdf, rev]);

  const attach = async () => {
    const [f] = await window.acro.openPdfs({ multi: false, title: 'Choose a file to attach', filters: [{ name: 'Any file', extensions: ['*'] }] });
    if (f) onAttach({ name: f.name, data: f.data });
  };
  const saveOut = async (f: { name: string; data: Uint8Array }) => {
    try {
      const to = await window.acro.saveFile(f.name, f.data, [{ name: 'File', extensions: [(f.name.split('.').pop() || '*').toLowerCase()] }]);
      if (to) toast(`Saved ${to.split(/[\\/]/).pop()}`, 'ok');
    } catch (e) {
      toast(errText(e), 'error');
    }
  };
  return (
    <div className="bm-panel">
      <button className="tb-btn bm-add" onClick={attach}>
        <Icon name="add" size={14} /> Attach a file…
      </button>
      {files === null && <p className="muted small-text">Looking for attached files…</p>}
      {files && !files.length && <p className="muted small-text">No files are attached to this PDF.</p>}
      {files?.map((f) => (
        <div className="bm-row att-row" key={f.name}>
          <span className="bm-title static">
            {f.name}
            <span className="muted"> {size(f.size)}</span>
          </span>
          <span className="bm-actions show">
            <button title="Save a copy of this file" onClick={() => saveOut(f)}>
              <Icon name="download" size={14} />
            </button>
            <button title="Remove it from the PDF" onClick={() => onRemove(f.name)}>
              <Icon name="trash" size={14} />
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}
