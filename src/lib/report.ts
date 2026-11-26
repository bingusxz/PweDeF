// Problem reports: the last few errors are kept in memory so a report can say what failed.
const recent: { at: string; text: string }[] = [];

export function noteError(text: string) {
  recent.push({ at: new Date().toISOString(), text: String(text).slice(0, 300) });
  if (recent.length > 12) recent.shift();
}

/** Remember uncaught errors too (not only the ones shown in a toast). */
export function installErrorCapture() {
  window.addEventListener('error', (e) => noteError(`${e.message} (${(e.filename || '').split('/').pop()}:${e.lineno})`));
  window.addEventListener('unhandledrejection', (e) => noteError(`Unhandled: ${e.reason instanceof Error ? e.reason.message : String(e.reason)}`));
}

export type ReportInput = { what: string; kind: string; contact: string; includeDetails: boolean; version: string; fileName?: string; pageCount?: number };

/** The technical details that go with a report. Nothing from inside the document is included, only its name and page count. */
export function details(i: Pick<ReportInput, 'version' | 'fileName' | 'pageCount'>) {
  const lines = [
    `PweDeF version: ${i.version || 'unknown'}`,
    `System: ${navigator.userAgent.replace(/^Mozilla\/5\.0 /, '')}`,
    `Screen: ${window.screen.width}x${window.screen.height}`,
    i.fileName ? `Open file: ${i.fileName}${i.pageCount ? ` (${i.pageCount} pages)` : ''}` : 'Open file: none',
    recent.length ? 'Recent errors:\n' + recent.map((r) => `  ${r.at.slice(11, 19)}  ${r.text}`).join('\n') : 'Recent errors: none',
  ];
  return lines.join('\n');
}

export function reportText(i: ReportInput) {
  return [`Type: ${i.kind}`, `What happened:\n${i.what.trim()}`, i.contact.trim() ? `Contact: ${i.contact.trim()}` : '', i.includeDetails ? `\n${details(i)}` : ''].filter(Boolean).join('\n');
}
