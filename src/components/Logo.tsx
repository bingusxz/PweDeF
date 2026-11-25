// Acrobatics mark: a carbonless form set (yellow, pink, original) fanned out, with an
// "A" set on the original whose crossbar is the red serial line.
export function LogoMark({ size = 24, title = 'Acrobatics' }: { size?: number; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" role="img" aria-label={title} className="logo-mark">
      <rect x="10.5" y="1.5" width="19" height="23" rx="1.5" fill="var(--copy-yellow)" stroke="var(--logo-edge)" strokeWidth="1" />
      <rect x="6.5" y="4.5" width="19" height="23" rx="1.5" fill="var(--copy-pink)" stroke="var(--logo-edge)" strokeWidth="1" />
      <rect x="2.5" y="7.5" width="19" height="23" rx="1.5" fill="var(--logo-paper)" stroke="var(--logo-edge)" strokeWidth="1.25" />
      <path d="M6.6 27 L12 11.6 L17.4 27" fill="none" stroke="var(--logo-ink)" strokeWidth="2.6" strokeLinejoin="miter" strokeLinecap="square" />
      <path d="M8.3 22 H15.7" stroke="var(--serial)" strokeWidth="2.6" strokeLinecap="square" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="wordmark">
      <LogoMark size={22} />
      <span className="wordmark-text">Acrobatics</span>
    </span>
  );
}
