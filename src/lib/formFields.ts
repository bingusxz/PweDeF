// Form designer: turns the field boxes drawn in the editor into real, fillable AcroForm fields.
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFPage, PDFRadioGroup, PDFString, rgb } from 'pdf-lib';
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
