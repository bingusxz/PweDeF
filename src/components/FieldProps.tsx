import type { Annot, FieldAnnot, FieldKind } from '../types';
import { FIELD_KINDS } from '../lib/formFields';

/** Properties of the form field being drawn or selected (Form designer). */
export function FieldProps({ field, kind, setKind, onChange }: { field: FieldAnnot | null; kind: FieldKind; setKind: (k: FieldKind) => void; onChange: (fn: (a: Annot) => Annot) => void }) {
  const patch = (p: Partial<FieldAnnot>) => field && onChange((a) => ({ ...a, ...p }) as Annot);
  const k = field?.kind ?? kind;
  const changeKind = (next: FieldKind) => {
    if (!field) return setKind(next);
    patch({
      kind: next,
      options: next === 'dropdown' || next === 'list' ? field.options?.length ? field.options : ['Option 1', 'Option 2', 'Option 3'] : field.options,
      exportValue: next === 'radio' ? field.exportValue || 'Choice1' : field.exportValue,
    });
    setKind(next);
  };
  return (
    <div className="field-props">
      <label>
        Type
        <select value={k} onChange={(e) => changeKind(e.target.value as FieldKind)}>
          {FIELD_KINDS.map((x) => (
            <option key={x.kind} value={x.kind}>
              {x.name}
            </option>
          ))}
        </select>
      </label>
      {field && (
        <>
          <label>
            {k === 'radio' ? 'Group' : 'Name'}
            <input value={field.name} onChange={(e) => patch({ name: e.target.value })} />
          </label>
          {k === 'radio' && (
            <label>
              Value
              <input value={field.exportValue || ''} onChange={(e) => patch({ exportValue: e.target.value })} />
            </label>
          )}
          <label>
            Tooltip
            <input value={field.tooltip || ''} onChange={(e) => patch({ tooltip: e.target.value })} placeholder="optional" />
          </label>
          {(k === 'text' || k === 'dropdown' || k === 'list') && (
            <label>
              Size
              <input type="number" min={6} max={40} value={field.fontSize || 11} onChange={(e) => patch({ fontSize: +e.target.value || 11 })} />
            </label>
          )}
          {k === 'text' && (
            <>
              <label>
                Starting text
                <input value={field.value || ''} onChange={(e) => patch({ value: e.target.value })} />
              </label>
              <label>
                Max chars
                <input type="number" min={0} value={field.maxLen || ''} onChange={(e) => patch({ maxLen: +e.target.value || undefined })} />
              </label>
              <label className="check">
                <input type="checkbox" checked={!!field.multiline} onChange={(e) => patch({ multiline: e.target.checked })} /> Several lines
              </label>
            </>
          )}
          {(k === 'dropdown' || k === 'list') && (
            <label className="fp-options">
              Choices (one per line)
              <textarea rows={3} value={(field.options || []).join('\n')} onChange={(e) => patch({ options: e.target.value.split('\n') })} />
            </label>
          )}
          {(k === 'checkbox' || k === 'radio') && (
            <label className="check">
              <input type="checkbox" checked={!!field.checked} onChange={(e) => patch({ checked: e.target.checked })} /> Ticked to start
            </label>
          )}
          {k !== 'signature' && (
            <label className="check">
              <input type="checkbox" checked={!!field.readOnly} onChange={(e) => patch({ readOnly: e.target.checked })} /> Read-only
            </label>
          )}
          <label className="check">
            <input type="checkbox" checked={!!field.required} onChange={(e) => patch({ required: e.target.checked })} /> Required
          </label>
        </>
      )}
    </div>
  );
}
