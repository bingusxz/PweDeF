import { useEffect } from 'react';
import type { Release } from '../help/whatsNew';

/** The release notes as a paper slip held by tape: it drops in at the bottom corner once after an update. */
export function WhatsNew({ release, onClose }: { release: Release; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <aside className="whatsnew-slip" role="dialog" aria-label={`What's new in ${release.version}`}>
      <span className="whatsnew-tape" aria-hidden="true" />
      <div className="whatsnew-head">
        <span className="whatsnew-ver">New in {release.version}</span>
        <button className="icon-btn" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <p className="whatsnew-title">{release.title}</p>
      <ul className="whatsnew-list">
        {release.items.map((t, i) => (
          <li key={t} style={{ animationDelay: 450 + i * 70 + 'ms' }}>
            {t}
          </li>
        ))}
      </ul>
      <button className="primary whatsnew-ok" onClick={onClose}>
        Got it
      </button>
    </aside>
  );
}
