import { useMemo, useState } from 'react';
import { Modal } from './Modal';
import { HELP } from '../help/helpContent';
import { AUTHOR, LICENSES, PROJECT_URL, TERMS, TERMS_VERSION } from '../help/terms';

type Pick = { kind: 'topic'; id: string } | { kind: 'terms' } | { kind: 'licenses' } | { kind: 'about' };

/** Help center: how-tos for every tool, shortcuts, troubleshooting, the terms and the open-source licenses. */
export function HelpDialog({ onClose, onTour, version, initial }: { onClose: () => void; onTour: () => void; version: string; initial?: string }) {
  const [upd, setUpd] = useState('');
  const [pick, setPick] = useState<Pick>(initial ? { kind: 'topic', id: initial } : { kind: 'topic', id: 'start' });
  const groups = useMemo(() => {
    const out: { name: string; items: typeof HELP }[] = [];
    for (const t of HELP) {
      const g = out.find((x) => x.name === t.group) || out[out.push({ name: t.group, items: [] }) - 1];
      g.items.push(t);
    }
    return out;
  }, []);
  const topic = pick.kind === 'topic' ? HELP.find((t) => t.id === pick.id) : null;

  return (
    <Modal title="Help" width={940} onClose={onClose}>
      <div className="help">
        <nav className="help-nav" aria-label="Help topics">
          <button className="help-tour" onClick={onTour}>
            ▶ Take the tour
          </button>
          {groups.map((g) => (
            <div key={g.name}>
              <div className="help-group">{g.name}</div>
              {g.items.map((t) => (
                <button key={t.id} className={`help-link ${pick.kind === 'topic' && pick.id === t.id ? 'on' : ''}`} onClick={() => setPick({ kind: 'topic', id: t.id })}>
                  {t.title}
                </button>
              ))}
            </div>
          ))}
          <div className="help-group">About</div>
          <button className={`help-link ${pick.kind === 'terms' ? 'on' : ''}`} onClick={() => setPick({ kind: 'terms' })}>
            Terms of use
          </button>
          <button className={`help-link ${pick.kind === 'licenses' ? 'on' : ''}`} onClick={() => setPick({ kind: 'licenses' })}>
            Open-source licenses
          </button>
          <button className={`help-link ${pick.kind === 'about' ? 'on' : ''}`} onClick={() => setPick({ kind: 'about' })}>
            About PweDeF
          </button>
        </nav>

        <article className="help-body">
          {topic && (
            <>
              <h3>{topic.title}</h3>
              {topic.intro && <p className="help-intro">{topic.intro}</p>}
              {topic.steps && (
                <ol className={topic.id === 'shortcuts' || topic.id === 'fix' ? 'plain' : undefined}>
                  {topic.steps.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ol>
              )}
              {topic.tips && (
                <div className="help-tips">
                  <b>Good to know</b>
                  <ul>
                    {topic.tips.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
          {pick.kind === 'terms' && (
            <>
              <h3>Terms of use</h3>
              <p className="muted">Version {TERMS_VERSION}</p>
              {TERMS.map((s) => (
                <section key={s.title} className="terms-sec">
                  <h4>{s.title}</h4>
                  {s.body.map((p, i) => (
                    <p key={i}>{p}</p>
                  ))}
                </section>
              ))}
            </>
          )}
          {pick.kind === 'licenses' && (
            <>
              <h3>Open-source licenses</h3>
              <p>PweDeF is built with these open-source components. Thank you to their authors.</p>
              <table className="license-table">
                <tbody>
                  {LICENSES.map((l) => (
                    <tr key={l.name}>
                      <td>
                        <b>{l.name}</b>
                        <small>{l.what}</small>
                      </td>
                      <td>{l.license}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {pick.kind === 'about' && (
            <>
              <h3>About PweDeF</h3>
              <p>
                Version <b>{version || '-'}</b>. A PDF tool for editing, signing, converting and organizing.
              </p>
              <p>
                Created by <b>{AUTHOR}</b>. Free and open source.
                <br />
                <a href={PROJECT_URL} target="_blank" rel="noreferrer">
                  {PROJECT_URL}
                </a>
              </p>
              <p>It works on your own computer, updates itself, and does not upload your documents.</p>
              <p>
                <b>Open PDFs with PweDeF by default:</b> click the button, then in Windows pick <b>.pdf</b> and choose <b>PweDeF</b> (Windows only lets you make this choice yourself). Or right-click any PDF, choose Open with, then PweDeF, and tick “Always”.
              </p>
              <button onClick={() => window.acro.openDefaultApps()}>Make PweDeF my default PDF app…</button>{' '}
              <button
                onClick={async () => {
                  setUpd((await window.acro.checkUpdates()).message);
                }}
              >
                Check for updates
              </button>
              {upd && <p className="muted">{upd}</p>}
            </>
          )}
        </article>
      </div>
    </Modal>
  );
}
