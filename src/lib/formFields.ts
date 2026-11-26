// Form designer: turns the field boxes drawn in the editor into real, fillable AcroForm fields.
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFPage, PDFRadioGroup, PDFRef, PDFString, rgb } from 'pdf-lib';
import type { PDFDocumentProxy } from './pdf';
import type { Annot, FieldAnnot, FieldKind } from '../types';
import { uid } from './util';

export const FIELD_KINDS: { kind: FieldKind; name: string; prefix: string; w: number; h: number }[] = [
  { kind: 'text', name: 'Text field', prefix: 'Text', w: 160, h: 22 },
  { kind: 'checkbox', name: 'Check box', prefix: 'Check', w: 16, h: 16 },
  { kind: 'radio', name: 'Radio button', prefix: 'Group', w: 16, h: 16 },
  { kind: 'dropdown', name: 'Dropdown', prefix: 'Dropdown', w: 160, h: 22 },
  { kind: 'list', name: 'List box', prefix: 'List', w: 160, h: 72 },
  { kind: 'signature', name: 'Signature', prefix: 'Signature', w: 190, h: 52 },
];
export const kindInfo = (k: FieldKind) => FIELD_KINDS.find((x) => x.kind === k)!;

/** Next unused name for a kind: Text1, Text2… Consecutive radio buttons join the last group by default. */
export function nextFieldName(kind: FieldKind, fields: FieldAnnot[], page?: number): string {
  if (kind === 'radio') {
    const last = [...fields].reverse().find((f) => f.kind === 'radio' && (page === undefined || f.page === page));
    if (last) return last.name;
  }
  const prefix = kindInfo(kind).prefix;
  const used = new Set(fields.map((f) => f.name));
  let n = 1;
  while (used.has(prefix + n)) n++;
  return prefix + n;
}

/** A free export value for a radio button inside its group: Choice1, Choice2… */
export function nextChoice(group: string, fields: FieldAnnot[]) {
  const used = new Set(fields.filter((f) => f.kind === 'radio' && f.name === group).map((f) => f.exportValue));
  let n = 1;
  while (used.has('Choice' + n)) n++;
  return 'Choice' + n;
}

function freeName(doc: PDFDocument, wanted: string) {
  const form = doc.getForm();
  const base = wanted.replace(/[.\s]+/g, '_') || 'Field';
  let name = base;
  for (let i = 2; form.getFieldMaybe(name); i++) name = `${base}_${i}`;
  return name;
}

const border = rgb(0.45, 0.45, 0.5);
const wash = rgb(0.93, 0.96, 1);

/** Writes one designed field into the document. `r` is the box in PDF space (origin bottom-left). */
export function addField(doc: PDFDocument, page: PDFPage, a: FieldAnnot, r: { x: number; y: number; w: number; h: number }) {
  const form = doc.getForm();
  const opts = { x: r.x, y: r.y, width: r.w, height: r.h, borderWidth: 1, borderColor: border };
  const tip = (dict: PDFDict) => a.tooltip && dict.set(PDFName.of('TU'), PDFHexString.fromText(a.tooltip));
  const flags = (f: { enableRequired(): void; enableReadOnly(): void }) => {
    if (a.required) f.enableRequired();
    if (a.readOnly) f.enableReadOnly();
  };

  switch (a.kind) {
    case 'text': {
      const f = form.createTextField(freeName(doc, a.name));
      f.addToPage(page, { ...opts, backgroundColor: wash }); // first: this sets the field's default appearance
      if (a.multiline) f.enableMultiline();
      if (a.maxLen && a.maxLen > 0) f.setMaxLength(a.maxLen);
      f.setFontSize(a.fontSize || 11);
      if (a.value) f.setText(a.value);
      flags(f);
      tip(f.acroField.dict);
      break;
    }
    case 'checkbox': {
      const f = form.createCheckBox(freeName(doc, a.name));
      f.addToPage(page, { ...opts, backgroundColor: wash });
      if (a.checked) f.check();
      flags(f);
      tip(f.acroField.dict);
      break;
    }
    case 'radio': {
      const existing = form.getFieldMaybe(a.name);
      const group = existing instanceof PDFRadioGroup ? existing : form.createRadioGroup(freeName(doc, a.name));
      const value = a.exportValue || 'Choice1';
      group.addOptionToPage(value, page, { ...opts, backgroundColor: wash });
      if (a.checked) group.select(value);
      flags(group);
      tip(group.acroField.dict);
      break;
    }
    case 'dropdown':
    case 'list': {
      const options = (a.options || []).filter((o) => o.trim());
      const f = a.kind === 'dropdown' ? form.createDropdown(freeName(doc, a.name)) : form.createOptionList(freeName(doc, a.name));
      f.addOptions(options.length ? options : ['Option 1', 'Option 2']);
      f.addToPage(page, { ...opts, backgroundColor: wash });
      f.setFontSize(a.fontSize || 11);
      if (a.value && options.includes(a.value)) f.select(a.value);
      flags(f);
      tip(f.acroField.dict);
      break;
    }
    case 'signature': {
      // pdf-lib has no signature-field helper: write the widget by hand so Acrobat and others offer "Sign here"
      const ctx = doc.context;
      const widget = ctx.obj({
        Type: 'Annot',
        Subtype: 'Widget',
        FT: 'Sig',
        T: PDFString.of(freeName(doc, a.name)),
        Rect: [r.x, r.y, r.x + r.w, r.y + r.h],
        F: 4,
        P: page.ref,
        MK: { BC: [0.3, 0.3, 0.6], BG: [0.95, 0.97, 1] },
        ...(a.tooltip ? { TU: PDFHexString.fromText(a.tooltip) } : {}),
      });
      const ref = ctx.register(widget);
      page.node.addAnnot(ref);
      const acro = form.acroForm.dict;
      let fields = acro.lookupMaybe(PDFName.of('Fields'), PDFArray);
      if (!fields) {
        fields = ctx.obj([]) as PDFArray;
        acro.set(PDFName.of('Fields'), fields);
      }
      fields.push(ref);
      break;
    }
  }
}

/** A new field of `kind` with a sensible name and starting values. */
export function newField(kind: FieldKind, annots: Annot[], page: number, x: number, y: number, w: number, h: number, id: string = uid()): FieldAnnot {
  const fields = annots.filter((a): a is FieldAnnot => a.type === 'field');
  const name = nextFieldName(kind, fields, page);
  const f: FieldAnnot = { id, page, type: 'field', kind, name, x, y, w, h, fontSize: 11 };
  if (kind === 'radio') f.exportValue = nextChoice(name, fields);
  if (kind === 'dropdown' || kind === 'list') f.options = ['Option 1', 'Option 2', 'Option 3'];
  return f;
}

/** Everything about a field that the user can change, as text: used to tell whether an imported field was edited. */
export const fieldSig = (a: FieldAnnot) =>
  JSON.stringify([a.kind, a.name, a.page, Math.round(a.x * 10), Math.round(a.y * 10), Math.round(a.w * 10), Math.round(a.h * 10), a.tooltip || '', !!a.readOnly, !!a.required, !!a.multiline, a.value || '', a.options || [], a.fontSize, a.maxLen || 0, a.exportValue || '', !!a.checked]);

/** Annotations that are real edits: an imported field nobody touched is only a stand-in for the live one. */
export const realEdits = (annots: Annot[]) => annots.filter((a) => !(a.type === 'field' && a.srcField && !a.gone && a.srcSig === fieldSig(a)));

/**
 * Fields that are already in the PDF, as editable boxes. Each remembers its widget (`srcField`), which is
 * removed from the file on save and replaced by the edited field, so renaming, moving and resizing just work.
 * Signature fields and push buttons are left alone: re-making them could destroy a signature or a script.
 */
export async function importFields(pdf: PDFDocumentProxy, have: Annot[], bytes?: Uint8Array): Promise<FieldAnnot[]> {
  // radio buttons: the viewer only knows the internal state name (often 0, 1, 2); the real choice names are in the file
  const radioValue = new Map<string, string>();
  if (bytes) {
    try {
      const d = await PDFDocument.load(bytes, { updateMetadata: false });
      for (const f of d.getForm().getFields())
        if (f instanceof PDFRadioGroup) {
          const opts = f.getOptions();
          f.acroField.getWidgets().forEach((w, i) => {
            const r = d.context.getObjectRef(w.dict);
            if (r && opts[i] !== undefined) radioValue.set(`${r.objectNumber}R${r.generationNumber ? r.generationNumber : ''}`, opts[i]);
          });
        }
    } catch {
      /* fall back to the state names */
    }
  }
  const known = new Set(have.filter((a): a is FieldAnnot => a.type === 'field' && !!a.srcField).map((a) => a.srcField!.id));
  const out: FieldAnnot[] = [];
  for (let i = 0; i < pdf.numPages; i++) {
    const page = await pdf.getPage(i + 1);
    const vp = page.getViewport({ scale: 1 });
    for (const w of (await page.getAnnotations({ intent: 'display' })) as any[]) {
      const m = /^(\d+)R(\d*)$/.exec(String(w.id));
      if (w.subtype !== 'Widget' || !w.fieldName || !m || known.has(String(w.id)) || w.pushButton || w.fieldType === 'Sig' || !w.rect) continue;
      const [x1, y1, x2, y2] = vp.convertToViewportRectangle(w.rect);
      const base = { id: uid(), page: i, type: 'field' as const, x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1), name: String(w.fieldName), fontSize: w.defaultAppearanceData?.fontSize || 11, srcField: { id: String(w.id), num: +m[1], gen: +(m[2] || 0) } };
      const f: Partial<FieldAnnot> = { tooltip: w.alternativeText || undefined, readOnly: !!w.readOnly };
      if (w.fieldType === 'Tx') Object.assign(f, { kind: 'text', multiline: !!w.multiLine, maxLen: w.maxLen || undefined, value: typeof w.fieldValue === 'string' ? w.fieldValue : '' });
      else if (w.fieldType === 'Btn' && w.radioButton) Object.assign(f, { kind: 'radio', exportValue: radioValue.get(String(w.id)) || w.buttonValue || 'Choice1', checked: !!w.fieldValue && w.fieldValue === w.buttonValue });
      else if (w.fieldType === 'Btn') Object.assign(f, { kind: 'checkbox', checked: !!w.fieldValue && w.fieldValue !== 'Off' });
      else if (w.fieldType === 'Ch') {
        const options = ((w.options || []) as { displayValue: string }[]).map((o) => o.displayValue);
        Object.assign(f, { kind: w.combo ? 'dropdown' : 'list', options, value: Array.isArray(w.fieldValue) ? w.fieldValue[0] : w.fieldValue || undefined });
      } else continue;
      const made = { ...base, ...f } as FieldAnnot;
      made.srcSig = fieldSig(made);
      out.push(made);
    }
  }
  return out;
}

/** Takes the original widgets of edited or deleted existing fields out of the document (before the new ones are added). */
export function removeSourceWidgets(doc: PDFDocument, srcs: { num: number; gen: number }[]) {
  if (!srcs.length) return;
  const ctx = doc.context;
  const want = new Set(srcs.map((r) => `${r.num}:${r.gen}`));
  const isWanted = (ref?: PDFRef | null) => !!ref && want.has(`${ref.objectNumber}:${ref.generationNumber}`);
  const form = doc.getForm();
  for (const f of [...form.getFields()]) {
    const widgets = f.acroField.getWidgets();
    const hit = widgets.map((w, i) => ({ i, ref: ctx.getObjectRef(w.dict) })).filter((x) => isWanted(x.ref));
    if (!hit.length) continue;
    if (hit.length === widgets.length) {
      form.removeField(f);
      continue;
    }
    for (const h of [...hit].reverse()) f.acroField.removeWidget(h.i);
    for (const page of doc.getPages()) {
      const arr = page.node.Annots();
      if (arr) for (let k = arr.size() - 1; k >= 0; k--) if (isWanted(arr.get(k) as PDFRef)) arr.remove(k);
    }
  }
}
