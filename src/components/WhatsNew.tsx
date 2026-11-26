import { Modal } from './Modal';
import type { Release } from '../help/whatsNew';

export function WhatsNew({ release, onClose }: { release: Release; onClose: () => void }) {
  return (
    <Modal
      title={`What's new in ${release.version}`}
      width={520}
      onClose={onClose}
      footer={
        <button className="primary" onClick={onClose}>
          Got it
        </button>
      }
    >
      <p className="whatsnew-title">{release.title}</p>
      <ul className="whatsnew-list">
        {release.items.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
    </Modal>
  );
}
