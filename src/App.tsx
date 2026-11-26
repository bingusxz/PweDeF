import { useCallback, useEffect, useRef, useState } from 'react';
import type { DocTab } from './types';
import { PasswordPrompt } from './components/MoreDialogs';
import { decryptPdf, isEncrypted, WrongPasswordError, type Protection } from './lib/pdfCrypt';
import type { OpenedFile } from './global';
import { Editor } from './components/Editor';
import { BatchDialog } from './components/BatchDialog';
import { MergeDialog } from './components/MergeDialog';
import { CompareDialog } from './components/CompareDialog';
import { HelpDialog } from './components/HelpDialog';
import { WhatsNew } from './components/WhatsNew';
import { whatsNewFor, type Release } from './help/whatsNew';
import { Tour, tourDone } from './components/Tour';
import { TermsGate, termsAccepted } from './components/TermsGate';
import { EDITOR_TOUR, HOME_TOUR } from './help/tours';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ToolHub, type HubAction } from './components/ToolHub';
import { Modal } from './components/Modal';
import { BrandName, Wordmark } from './components/Logo';
import { Icon } from './components/Icon';
import { onToast, toast, errText, type ToastMsg } from './lib/toast';
import { uid } from './lib/util';
import { IMAGE_FILTERS, imagesFilesToPdf } from './lib/convert';

interface Recent {
  path: string;
  name: string;
  at: number;
}
const RKEY = 'acro.recent.v1';
const loadRecent = (): Recent[] => {
  try {
    return JSON.parse(localStorage.getItem(RKEY) || '[]');
  } catch {
    return [];
  }
};

function newTab(bytes: Uint8Array, name: string, path: string | null, protect?: Protection | null): DocTab {
  return { id: uid(), name, path, bytes, annots: [], form: {}, past: [], future: [], dirty: !path, rev: 0, protect: protect ?? null };
}

export default function App() {
  const [tabs, setTabs] = useState<DocTab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [batch, setBatch] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const [termsOk, setTermsOk] = useState(termsAccepted);
  const [helpOpen, setHelpOpen] = useState(false);
  const [tour, setTour] = useState<'home' | 'editor' | null>(null);
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  const [recent, setRecent] = useState<Recent[]>(loadRecent);
  const [update, setUpdate] = useState<{ version: string; ready: boolean; percent?: number } | null>(null);
  const [updHidden, setUpdHidden] = useState(false);
  const [version, setVersion] = useState('');
  const [news, setNews] = useState<Release | null>(null);
  useEffect(() => {
    if (version && termsOk) setNews(whatsNewFor(version));
  }, [version, termsOk]);
  const [dragging, setDragging] = useState(false);
  const saveFns = useRef(new Map<string, (as?: boolean) => Promise<boolean>>());
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  const remember = (f: { path: string; name: string }) => {
    const next = [{ path: f.path, name: f.name, at: Date.now() }, ...loadRecent().filter((r) => r.path !== f.path)].slice(0, 12);
    try {
      localStorage.setItem(RKEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
    setRecent(next);
  };

  const [pwAsk, setPwAsk] = useState<{ name: string; wrong: boolean; resolve: (pw: string | null) => void } | null>(null);
  const askPassword = (name: string, wrong: boolean) => new Promise<string | null>((resolve) => setPwAsk({ name, wrong, resolve }));
  /** Protected files are opened here, before a tab exists, so the editor only ever sees a plain PDF. */
  const unlock = async (f: OpenedFile): Promise<{ data: Uint8Array; protect: Protection | null } | null> => {
    if (!(await isEncrypted(f.data))) return { data: f.data, protect: null };
    try {
      // some files only limit printing or editing and open without a password
      const r = await decryptPdf(f.data, '');
      const p = r.protection.permissions;
      if (!(p.print && p.edit && p.copy && p.annotate && p.fillForms && p.assemble)) toast(`${f.name} had limits on printing or editing. They are not kept when you save.`, 'info');
      return { data: r.bytes, protect: null };
    } catch (e) {
      if (!(e instanceof WrongPasswordError)) {
        toast(`${f.name}: ${errText(e)}`, 'error');
        return null;
      }
    }
    let wrong = false;
    for (;;) {
      const pw = await askPassword(f.name, wrong);
      setPwAsk(null);
      if (pw === null) return null;
      try {
        const r = await decryptPdf(f.data, pw);
        toast('Saving keeps the password you just typed. Any other password this file had is replaced.', 'info');
        return { data: r.bytes, protect: r.protection };
      } catch (e) {
        if (!(e instanceof WrongPasswordError)) {
          toast(`${f.name}: ${errText(e)}`, 'error');
          return null;
        }
        wrong = true;
      }
    }
  };

  const openFiles = useCallback(async (files: OpenedFile[]) => {
    if (!files.length) return;
    let lastId = '';
    const made: DocTab[] = [];
    for (const f of files) {
      const existing = [...tabsRef.current, ...made].find((t) => t.path && t.path === f.path);
      if (existing) {
        lastId = existing.id;
        continue;
      }
      const opened = await unlock(f);
      if (!opened) continue;
      const real = f.path && !f.path.startsWith('dropped:') ? f.path : null;
      const t = newTab(opened.data, f.name, real, opened.protect);
      made.push(t);
      lastId = t.id;
    }
    if (!lastId) return;
    tabsRef.current = [...tabsRef.current, ...made];
    setTabs(tabsRef.current);
    setActive(lastId);
    files.filter((f) => f.path && !f.path.startsWith('dropped:')).forEach(remember);
  }, []);

  const openNew = useCallback((bytes: Uint8Array, name: string) => {
    const t = newTab(bytes, name, null);
    setTabs((cur) => [...cur, t]);
    setActive(t.id);
  }, []);

  const openDialog = async () => openFiles(await window.acro.openPdfs());

  // opens the Merge window: add files, order them, pick pages, turn them, then combine
  const combineFiles = async () => setMergeOpen(true);

  const imagesToPdf = async () => {
    const files = await window.acro.openPdfs({ title: 'Choose images', filters: IMAGE_FILTERS });
    if (!files.length) return;
    try {
      openNew(await imagesFilesToPdf(files), 'Images.pdf');
    } catch (e) {
      toast(errText(e), 'error');
    }
  };

  const [caps, setCaps] = useState<{ office: boolean; libreoffice: boolean } | null>(null);
  const [urlDialog, setUrlDialog] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  useEffect(() => {
    window.acro.convertCaps().then(setCaps).catch(() => {});
  }, []);

  const withWorking = async (msg: string, fn: () => Promise<void>) => {
    setWorking(msg);
    try {
      await fn();
    } catch (e) {
      toast(errText(e), 'error');
    } finally {
      setWorking(null);
    }
  };

  const hubAction = async (a: HubAction) => {
    switch (a) {
      case 'open':
        return openDialog();
      case 'merge':
        return combineFiles();
      case 'compare':
        return setCompareOpen(true);
      case 'batch':
        return setBatch(true);
      case 'imgToPdf':
        return imagesToPdf();
      case 'wordToPdf':
      case 'excelToPdf':
      case 'pptToPdf': {
        const kind = a === 'wordToPdf' ? 'word' : a === 'excelToPdf' ? 'excel' : 'ppt';
        return withWorking('Converting with ' + (caps?.office ? 'Microsoft Office' : 'LibreOffice') + '…', async () => {
          const res = await window.acro.officeToPdf(kind);
          for (const r of res) {
            if (r.data) openNew(r.data, r.name);
            else toast(`${r.name}: ${r.error}`, 'error');
          }
        });
      }
      case 'webToPdf':
        return setUrlDialog(true);
      case 'htmlToPdf': {
        const [f] = await window.acro.openPdfs({
          multi: false,
          title: 'Choose an HTML, text or Markdown file',
          filters: [{ name: 'HTML / Text', extensions: ['html', 'htm', 'txt', 'md', 'markdown', 'log', 'csv'] }],
        });
        if (!f) return;
        return withWorking('Converting…', async () => {
          const name = f.name.replace(/\.[^.]+$/, '') + '.pdf';
          if (/\.html?$/i.test(f.name)) {
            const html = new TextDecoder().decode(f.data);
            const r = await window.acro.htmlToPdf(html, name);
            openNew(r.data, name);
          } else {
            const { textToPdf } = await import('./lib/exporters');
            const r = await textToPdf(new TextDecoder().decode(f.data), name);
            openNew(r.data, name);
          }
        });
      }
      default: {
        // tools that run on a PDF: pick one, open it, then launch the tool
        const files = await window.acro.openPdfs({ multi: false, title: 'Choose a PDF' });
        if (!files.length) return;
        await openFiles(files);
        const id = tabsRef.current.find((t) => t.path === files[0].path)?.id;
        if (id) setTabs((cur) => cur.map((t) => (t.id === id ? { ...t, startAction: a } : t)));
      }
    }
  };

  const closeTab = async (id: string) => {
    const t = tabsRef.current.find((x) => x.id === id);
    if (!t) return;
    if (t.dirty && (t.annots.length || Object.keys(t.form).length || t.past.length || t.protectDirty)) {
      const choice = window.confirm(`"${t.name}" has unsaved changes.\n\nOK = save first, Cancel = discard changes`);
      if (choice) {
        const ok = await saveFns.current.get(id)?.(false);
        if (!ok) return;
      }
    }
    setTabs((cur) => {
      const idx = cur.findIndex((x) => x.id === id);
      const next = cur.filter((x) => x.id !== id);
      if (active === id) setActive(next[Math.max(0, idx - 1)]?.id ?? null);
      return next;
    });
    saveFns.current.delete(id);
  };

  // ---------- global events ----------
  useEffect(() => {
    const offs = [
      window.acro.onOpenFiles(openFiles),
      window.acro.onBeforeClose(() => {
        const dirty = tabsRef.current.filter((t) => t.dirty && (t.annots.length || Object.keys(t.form).length || t.past.length || t.protectDirty));
        if (!dirty.length || window.confirm(`You have unsaved changes in ${dirty.length} document(s). Quit anyway?`)) window.acro.confirmClose();
      }),
      window.acro.onUpdateAvailable((v) => setUpdate({ version: v, ready: false })),
      window.acro.onUpdateReady((v) => {
        setUpdHidden(false);
        setUpdate({ version: v, ready: true, percent: 100 });
      }),
      window.acro.onUpdateProgress((p) => setUpdate((u) => (u && !u.ready ? { ...u, percent: p } : u))),
      onToast((t) => {
        setToasts((cur) => [...cur, t]);
        setTimeout(() => setToasts((cur) => cur.filter((x) => x.id !== t.id)), t.kind === 'error' ? 7000 : 3500);
      }),
    ];
    window.acro.version().then(setVersion);
    window.acro.ready().then(openFiles);
    return () => offs.forEach((o) => o());
  }, [openFiles]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        openDialog();
      } else if (mod && e.key.toLowerCase() === 'w' && active) {
        e.preventDefault();
        closeTab(active);
      } else if (mod && e.key === 'Tab' && tabs.length > 1) {
        e.preventDefault();
        const i = tabs.findIndex((t) => t.id === active);
        setActive(tabs[(i + (e.shiftKey ? -1 : 1) + tabs.length) % tabs.length].id);
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });

  // drag & drop files from Explorer
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = [...e.dataTransfer.files];
    const pdfs = files.filter((f) => /\.pdf$/i.test(f.name));
    const imgs = files.filter((f) => /\.(png|jpe?g|webp|bmp|gif)$/i.test(f.name));
    if (pdfs.length)
      openFiles(
        await Promise.all(
          pdfs.map(async (f) => ({
            path: window.acro.pathForFile(f) || `dropped:${f.name}:${Date.now()}`,
            name: f.name,
            data: new Uint8Array(await f.arrayBuffer()),
          })),
        ),
      );
    if (imgs.length) openNew(await imagesFilesToPdf(await Promise.all(imgs.map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) })))), 'Images.pdf');
  };

  const updateTab = useCallback((id: string) => (fn: (t: DocTab) => DocTab) => setTabs((cur) => cur.map((t) => (t.id === id ? fn(t) : t))), []);
  const activeTab = tabs.find((t) => t.id === active) || null;

  // F1 opens Help from anywhere
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'F1') {
        e.preventDefault();
        setHelpOpen(true);
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  // the first time a document opens, offer the short editor tour (once per computer)
  const hasDoc = !!activeTab;
  useEffect(() => {
    if (!hasDoc || !termsOk || tourDone('editor')) return;
    const t = setTimeout(() => setTour((cur) => cur ?? 'editor'), 900);
    return () => clearTimeout(t);
  }, [hasDoc, termsOk]);

  return (
    <div
      className="app"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={onDrop}
    >
      <header className="titlebar">
        <button className={`brand ${!activeTab ? 'on' : ''}`} onClick={() => setActive(null)} title="All tools (home)">
          <Wordmark />
        </button>
        <div className="tabs">
          {tabs.map((t) => (
            <div key={t.id} className={`tab ${t.id === active ? 'on' : ''}`} onClick={() => setActive(t.id)} title={t.path || t.name}>
              <span className="tab-name">
                {t.dirty && <span className="dot" />}
                {t.name}
              </span>
              <button
                className="tab-x"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(t.id);
                }}
                aria-label="Close tab"
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          ))}
          <button className="icon-btn" onClick={openDialog} title="Open (Ctrl+O)">
            <Icon name="add" />
          </button>
          <button className="icon-btn help-btn" onClick={() => setHelpOpen(true)} title="Help and tour (F1)" aria-label="Help">
            <Icon name="help" />
          </button>
        </div>
      </header>

      <main className="main">
        {tabs.map((t) => (
          <div key={t.id} className="tab-pane" style={{ display: t.id === active ? 'flex' : 'none' }}>
            <ErrorBoundary label={t.name}>
              <Editor
                tab={t}
                onUpdate={updateTab(t.id)}
                openNew={openNew}
                registerSave={(fn) => {
                  saveFns.current.set(t.id, fn);
                }}
              />
            </ErrorBoundary>
          </div>
        ))}
        {!activeTab && (
          <Home
            recent={recent}
            version={version}
            caps={caps}
            onAction={hubAction}
            onRecent={async (r) => {
              try {
                openFiles([await window.acro.readPdf(r.path)]);
              } catch {
                toast(`Can't open ${r.name}. It may have been moved or deleted.`, 'error');
                const next = recent.filter((x) => x.path !== r.path);
                localStorage.setItem(RKEY, JSON.stringify(next));
                setRecent(next);
              }
            }}
          />
        )}
      </main>

      {dragging && (
        <div className="drop-overlay">
          <Icon name="download" size={40} />
          Drop PDFs to open · drop images to convert
        </div>
      )}
      {batch && <BatchDialog onClose={() => setBatch(false)} />}
      {update && !updHidden && (
        <div className={'update-float' + (update.ready ? ' ready' : '')} role="status" aria-live="polite">
          <b>{update.ready ? 'Update ready' : <>Updating <BrandName /></>}</b>
          <span>{update.ready ? 'Version ' + update.version + ' is downloaded. Restart to finish.' : 'Downloading version ' + update.version + '… ' + (update.percent ?? 0) + '%'}</span>
          {!update.ready && (
            <span className="update-bar">
              <span className="update-fill" style={{ width: (update.percent ?? 0) + '%' }} />
            </span>
          )}
          {update.ready && (
            <span className="update-float-actions">
              <button onClick={() => setUpdHidden(true)}>Later</button>
              <button className="primary" onClick={() => window.acro.installUpdate()}>
                Restart now
              </button>
            </span>
          )}
        </div>
      )}
      {compareOpen && <CompareDialog onClose={() => setCompareOpen(false)} />}
      {pwAsk && <PasswordPrompt name={pwAsk.name} wrong={pwAsk.wrong} onSubmit={(pw) => pwAsk.resolve(pw)} onCancel={() => pwAsk.resolve(null)} />}
      {helpOpen && (
        <HelpDialog
          version={version}
          onClose={() => setHelpOpen(false)}
          onTour={() => {
            setHelpOpen(false);
            setTour(activeTab ? 'editor' : 'home');
          }}
        />
      )}
      {news && !tour && <WhatsNew release={news} onClose={() => setNews(null)} />}
      {tour && <Tour key={tour} id={tour} steps={tour === 'home' ? HOME_TOUR : EDITOR_TOUR} onDone={() => setTour(null)} />}
      {!termsOk && (
        <TermsGate
          onAccept={() => {
            setTermsOk(true);
            if (!tourDone('home')) setTimeout(() => setTour('home'), 300);
          }}
        />
      )}
      {mergeOpen && (
        <MergeDialog
          initial={[]}
          onClose={() => setMergeOpen(false)}
          onDone={(bytes, name) => {
            setMergeOpen(false);
            openNew(bytes, name);
          }}
        />
      )}
      {urlDialog && (
        <UrlDialog
          onClose={() => setUrlDialog(false)}
          onRun={(url, landscape) => {
            setUrlDialog(false);
            withWorking('Loading page & creating PDF…', async () => {
              const r = await window.acro.webToPdf(url, landscape);
              openNew(r.data, r.name);
            });
          }}
        />
      )}
      {working && (
        <div className="busy">
          <div className="busy-card">
            <div className="spinner" />
            <div>{working}</div>
          </div>
        </div>
      )}
      <div className="toasts" role="status">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function UrlDialog({ onClose, onRun }: { onClose: () => void; onRun: (url: string, landscape: boolean) => void }) {
  const [url, setUrl] = useState('https://');
  const [landscape, setLandscape] = useState(false);
  return (
    <Modal
      title="Web page to PDF"
      onClose={onClose}
      footer={
        <>
          <button className="primary" disabled={url.length < 10} onClick={() => onRun(url, landscape)}>
            Convert
          </button>
        </>
      }
    >
      <input className="big-input" value={url} autoFocus onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onRun(url, landscape)} />
      <label className="check">
        <input type="checkbox" checked={landscape} onChange={(e) => setLandscape(e.target.checked)} /> Landscape
      </label>
    </Modal>
  );
}

function Home({
  recent,
  version,
  caps,
  onAction,
  onRecent,
}: {
  recent: Recent[];
  version: string;
  caps: { office: boolean; libreoffice: boolean } | null;
  onAction: (a: HubAction) => void;
  onRecent: (r: Recent) => void;
}) {
  const stamp = (t: number) =>
    new Date(t).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  const folder = (p: string) => p.replace(/[\\/][^\\/]*$/, '');
  return (
    <div className="home">
      <div className="home-sheet">
        <header className="home-head">
          <div className="home-title">
            <h1><BrandName /></h1>
            <p>Edit, sign, convert and organize PDFs. Drop files anywhere on this window to start.</p>
          </div>
          <div className="home-actions">
            <span className="serial" title="Installed version. It updates itself.">
              Version <b>{version || '-'}</b>
            </span>
            <button className="primary big" onClick={() => onAction('open')}>
              <Icon name="open" size={18} /> Open PDF
            </button>
          </div>
        </header>

        <div className="home-body">
          <ToolHub onAction={onAction} caps={caps} />

          <aside className="filing-log" aria-label="Recent files">
            <h2>Filing log</h2>
            {recent.length ? (
              <ol>
                {recent.map((r) => (
                  <li key={r.path}>
                    <button className="log-row" onClick={() => onRecent(r)} title={r.path}>
                      <span className="log-name">{r.name}</span>
                      <span className="log-folder">{folder(r.path)}</span>
                      <span className="log-time">{stamp(r.at)}</span>
                    </button>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="empty-line">PDFs you open are logged here so you can reopen them in one click.</p>
            )}
            <p className="note-line">
              Tip: make PweDeF your default PDF app.{' '}
              <button className="link-btn" onClick={() => window.acro.openDefaultApps()}>
                Show me how
              </button>
            </p>
            <button
              className="link-btn update-check"
              onClick={async () => {
                const r = await window.acro.checkUpdates();
                // an update that is downloading already shows in the header, so no second notice for it
                if (r.status !== 'downloading') toast(r.message, r.status === 'error' ? 'error' : r.status === 'latest' ? 'ok' : 'info');
              }}
            >
              Check for updates
            </button>
          </aside>
        </div>
      </div>
    </div>
  );
}
