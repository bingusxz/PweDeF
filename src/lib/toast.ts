type Kind = 'info' | 'ok' | 'error';
export interface ToastMsg {
  id: number;
  text: string;
  kind: Kind;
}
type L = (t: ToastMsg) => void;
const listeners = new Set<L>();
let n = 0;

export function toast(text: string, kind: Kind = 'info') {
  const t = { id: ++n, text, kind };
  listeners.forEach((l) => l(t));
}
export function onToast(l: L) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
export function errText(e: unknown) {
  const m = e instanceof Error ? e.message : String(e);
  if (/encrypt/i.test(m)) return 'This PDF is password-protected/encrypted. Editing encrypted PDFs is not supported yet.';
  return m;
}
