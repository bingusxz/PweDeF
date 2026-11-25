// Light ("original") / dark ("carbon") appearance. Follows Windows by default.
export type ThemeMode = 'system' | 'light' | 'dark';
const KEY = 'acro.theme';

export function loadTheme(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(mode: ThemeMode) {
  const root = document.documentElement;
  if (mode === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* ignore */
  }
  // keeps native dialogs + the window's caption buttons in the same appearance
  window.acro.setTheme?.(mode);
}

export const nextTheme = (m: ThemeMode): ThemeMode => (m === 'system' ? 'light' : m === 'light' ? 'dark' : 'system');
