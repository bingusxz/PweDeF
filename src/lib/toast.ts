import { noteError } from './report';

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
  if (kind === 'error') noteError(text);
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
  if (/encrypt/i.test(m)) return 'This PDF is protected with a password. Open it again and type the password when asked.';
  const lock = /FILE_LOCKED: (.*)/.exec(m);
  if (lock) return `${lock[1]} is open in another program, so it cannot be overwritten. Close it there, or use Save as to make a copy.`;
  return m.replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
}
