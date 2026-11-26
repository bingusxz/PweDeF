import { useState } from 'react';
import { BrandName } from './Logo';
import { AUTHOR, TERMS, TERMS_VERSION } from '../help/terms';

const KEY = 'acro.terms';

/** True once this version of the terms has been accepted on this computer. */
export const termsAccepted = () => {
  try {
    return localStorage.getItem(KEY) === TERMS_VERSION;
  } catch {
    return false;
  }
};

/** First-run screen: read and accept the terms. It cannot be dismissed; Decline closes the app. */
export function TermsGate({ onAccept }: { onAccept: () => void }) {
  const [ok, setOk] = useState(false);
  const accept = () => {
    try {
      localStorage.setItem(KEY, TERMS_VERSION);
    } catch {
      /* storage unavailable: the app still opens, and asks again next time */
    }
    onAccept();
  };
  return (
    <div className="terms-gate" role="dialog" aria-modal="true" aria-label="Terms of use">
      <div className="terms-card">
        <header>
          <h2>Welcome to <BrandName /></h2>
          <p>Please read and accept the terms of use. It takes a minute.</p>
          <small className="terms-by">Created by {AUTHOR} · free and open source</small>
        </header>
        <div className="terms-scroll" tabIndex={0}>
          {TERMS.map((s) => (
            <section key={s.title} className="terms-sec">
              <h4>{s.title}</h4>
              {s.body.map((p, i) => (
                <p key={i}>{p}</p>
              ))}
            </section>
          ))}
          <p className="muted">Terms version {TERMS_VERSION}. You can read them again any time under Help.</p>
        </div>
        <footer>
          <label className="check">
            <input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} /> I have read and accept the terms of use
          </label>
          <span className="tb-spacer" />
          <button onClick={() => window.acro.confirmClose()}>Decline and close</button>
          <button className="primary" disabled={!ok} onClick={accept}>
            I accept
          </button>
        </footer>
      </div>
    </div>
  );
}
