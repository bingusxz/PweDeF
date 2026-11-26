import { useState } from 'react';
import { details, reportText } from '../lib/report';

const KINDS = ['Something does not work', 'Something looks wrong', 'It is slow or freezes', 'I want a new feature', 'Other'];

/** "Report a problem": sends a short message to the developer. The user never sees where it goes. */
export function ReportForm({ version, fileName, pageCount }: { version: string; fileName?: string; pageCount?: number }) {
  const [kind, setKind] = useState(KINDS[0]);
  const [what, setWhat] = useState('');
  const [contact, setContact] = useState('');
  const [inc, setInc] = useState(true);
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'copied'>('idle');
  const [err, setErr] = useState('');
  const input = { what, kind, contact, includeDetails: inc, version, fileName, pageCount };

  const send = async () => {
    setState('sending');
    setErr('');
    const r = await window.acro.sendReport({ subject: `${kind}: ${what.trim().slice(0, 60)}`, text: reportText(input).slice(0, 8000) });
    if (r.ok) return setState('sent');
    // no connection, or sending is not set up: keep the text so nothing is lost
    try {
      await navigator.clipboard.writeText(reportText(input));
      setState('copied');
    } catch {
      setState('idle');
      setErr('It could not be sent. Check the internet connection and try again.');
    }
  };

  if (state === 'sent')
    return (
      <>
        <h3>Report a problem</h3>
        <p>Thank you. Your report was sent. It will be read and, where possible, fixed in a later update.</p>
        <button onClick={() => { setWhat(''); setState('idle'); }}>Send another</button>
      </>
    );
  if (state === 'copied')
    return (
      <>
        <h3>Report a problem</h3>
        <p>It could not be sent from here (no internet, or sending is not set up). The report was copied instead. Paste it into a message to the person who looks after PweDeF.</p>
        <button onClick={() => setState('idle')}>Back</button>
      </>
    );
  return (
    <>
      <h3>Report a problem</h3>
      <p className="muted">Tell us what went wrong or what you would like. It goes straight to the developer.</p>
      <label>What is this about?</label>
      <select value={kind} onChange={(e) => setKind(e.target.value)}>
        {KINDS.map((k) => (
          <option key={k}>{k}</option>
        ))}
      </select>
      <label>What happened? What did you expect?</label>
      <textarea rows={6} value={what} maxLength={4000} onChange={(e) => setWhat(e.target.value)} placeholder="For example: I pressed Save after editing a line and nothing happened." />
      <label>Your name or a way to reach you (optional)</label>
      <input value={contact} maxLength={120} onChange={(e) => setContact(e.target.value)} placeholder="So we can ask a question if needed" />
      <label className="check">
        <input type="checkbox" checked={inc} onChange={(e) => setInc(e.target.checked)} /> Include technical details (version, Windows, recent errors)
      </label>
      {inc && <pre className="report-details">{details(input)}</pre>}
      <p className="muted small-text">Your PDF is never attached. Only what you see above is sent, and only when you press Send.</p>
      {err && <p className="merge-err">{err}</p>}
      <button className="primary" disabled={what.trim().length < 5 || state === 'sending'} onClick={send}>
        {state === 'sending' ? 'Sending' : 'Send report'}
      </button>
    </>
  );
}
