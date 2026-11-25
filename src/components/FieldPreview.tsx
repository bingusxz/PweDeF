import type { FieldAnnot } from '../types';
import { kindInfo } from '../lib/formFields';

/** How a designed form field looks on the page while you place and adjust it. */
export function FieldPreview({ a, z }: { a: FieldAnnot; z: number }) {
  const fs = Math.max(8, Math.min(a.h * z * 0.6, (a.fontSize || 11) * z));
  let inner: React.ReactNode = null;
  switch (a.kind) {
    case 'checkbox':
      inner = a.checked ? <span className="fd-tick">✓</span> : null;
      break;
    case 'radio':
      inner = a.checked ? <span className="fd-dot" /> : null;
      break;
    case 'dropdown':
      inner = (
        <>
          <span className="fd-text">{a.value || ''}</span>
          <span className="fd-caret">▾</span>
        </>
      );
      break;
    case 'list':
      inner = (a.options || []).slice(0, 6).map((o, i) => (
        <span key={i} className="fd-item">
          {o}
        </span>
      ));
      break;
    case 'signature':
      inner = <span className="fd-sig">Sign here</span>;
      break;
    default:
      inner = <span className="fd-text">{a.value || ''}</span>;
  }
  return (
    <div className={`fd fd-${a.kind} ${a.readOnly ? 'ro' : ''}`} style={{ fontSize: fs }}>
      <span className="fd-tag">
        {kindInfo(a.kind).name}: {a.name}
        {a.kind === 'radio' ? ` = ${a.exportValue || ''}` : ''}
        {a.required ? ' *' : ''}
      </span>
      {inner}
    </div>
  );
}
