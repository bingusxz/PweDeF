// Bookmarks (the outline) and attached files: reading them for the side panels and writing changes back.
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRef, PDFString } from 'pdf-lib';
import type { PDFDocumentProxy } from './pdf';

const load = (b: Uint8Array) => PDFDocument.load(b, { updateMetadata: false });
const save = (d: PDFDocument) => d.save({ useObjectStreams: true });

export interface OutlineItem {
  title: string;
  /** zero-based page, or null for a bookmark that points nowhere or to a web address */
  page: number | null;
  url?: string;
  children: OutlineItem[];
}

/** The bookmark tree of the open document. */
export async function readOutline(pdf: PDFDocumentProxy): Promise<OutlineItem[]> {
  const raw = await pdf.getOutline();
  const walk = async (items: any[]): Promise<OutlineItem[]> => {
    const out: OutlineItem[] = [];
    for (const it of items || []) {
      let page: number | null = null;
      try {
        let dest: any = it.dest;
        if (typeof dest === 'string') dest = await pdf.getDestination(dest);
        if (Array.isArray(dest)) {
          const ref = dest[0];
          const idx = typeof ref === 'object' && ref !== null ? await pdf.getPageIndex(ref) : Number(ref);
          if (Number.isFinite(idx)) page = idx;
        }
      } catch {
        /* points nowhere */
      }
      out.push({ title: String(it.title || '').trim() || '(untitled)', page, url: it.url || undefined, children: await walk(it.items || []) });
    }
    return out;
  };
  return walk(raw || []);
}

/** Replaces the whole bookmark tree. Bookmarks that point to a web address keep it. */
export async function writeOutline(bytes: Uint8Array, items: OutlineItem[]) {
  const doc = await load(bytes);
  const ctx = doc.context;
  const pages = doc.getPages();
  const catalog = doc.catalog;
  if (!items.length) {
    catalog.delete(PDFName.of('Outlines'));
    return save(doc);
  }
  const rootRef = ctx.nextRef();
  const count = (list: OutlineItem[]): number => list.reduce((n, i) => n + 1 + count(i.children), 0);

  const build = (list: OutlineItem[], parent: PDFRef): { first: PDFRef; last: PDFRef } => {
    const refs = list.map(() => ctx.nextRef());
    list.forEach((it, k) => {
      const dict = ctx.obj({ Title: PDFHexString.fromText(it.title), Parent: parent });
      if (k > 0) dict.set(PDFName.of('Prev'), refs[k - 1]);
      if (k < list.length - 1) dict.set(PDFName.of('Next'), refs[k + 1]);
      if (it.page !== null && pages[it.page]) dict.set(PDFName.of('Dest'), ctx.obj([pages[it.page].ref, PDFName.of('XYZ'), null, null, null]));
      else if (it.url) dict.set(PDFName.of('A'), ctx.obj({ S: 'URI', URI: PDFString.of(it.url) }));
      if (it.children.length) {
        const sub = build(it.children, refs[k]);
        dict.set(PDFName.of('First'), sub.first);
        dict.set(PDFName.of('Last'), sub.last);
        dict.set(PDFName.of('Count'), ctx.obj(count(it.children)));
      }
      ctx.assign(refs[k], dict);
    });
    return { first: refs[0], last: refs[refs.length - 1] };
  };
  const { first, last } = build(items, rootRef);
  ctx.assign(rootRef, ctx.obj({ Type: 'Outlines', First: first, Last: last, Count: count(items) }));
  catalog.set(PDFName.of('Outlines'), rootRef);
  return save(doc);
}

// ---------------------------------------------------------------- attachments
export interface Attachment {
  name: string;
  description: string;
  size: number;
}

/** Files embedded in the document (not the paperclip notes pinned to a page). */
export async function listAttachments(pdf: PDFDocumentProxy): Promise<(Attachment & { data: Uint8Array })[]> {
  const att = (await pdf.getAttachments()) as Record<string, { filename: string; content: Uint8Array; description?: string }> | null;
  return Object.values(att || {}).map((a) => ({ name: a.filename, description: a.description || '', size: a.content.length, data: a.content }));
}

export async function attachFile(bytes: Uint8Array, file: { name: string; data: Uint8Array; description?: string }) {
  const doc = await load(bytes);
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const mime: Record<string, string> = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', txt: 'text/plain', csv: 'text/csv', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', zip: 'application/zip' };
  await doc.attach(file.data, file.name, { mimeType: mime[ext] || 'application/octet-stream', description: file.description, creationDate: new Date(), modificationDate: new Date() });
  return save(doc);
}

/** Deletes a file specification and the embedded data it points to, so the bytes are really gone from the saved file. */
export function dropFileSpec(ctx: PDFDocument['context'], spec: unknown) {
  const ref = spec instanceof PDFRef ? spec : null;
  const dict = ref ? ctx.lookup(ref) : spec;
  if (dict instanceof PDFDict) {
    const ef = dict.lookup(PDFName.of('EF'));
    if (ef instanceof PDFDict) for (const [, v] of ef.entries()) if (v instanceof PDFRef) ctx.delete(v);
  }
  if (ref) ctx.delete(ref);
}

/** Removes the embedded file with this name from the document's name tree. */
export async function removeAttachment(bytes: Uint8Array, name: string) {
  const doc = await load(bytes);
  const ctx = doc.context;
  const names = ctx.lookupMaybe(doc.catalog.get(PDFName.of('Names')), PDFDict);
  const ef = names && ctx.lookupMaybe(names.get(PDFName.of('EmbeddedFiles')), PDFDict);
  if (!ef) return save(doc);
  let removed = 0;
  const walk = (node: PDFDict) => {
    const arr = ctx.lookupMaybe(node.get(PDFName.of('Names')), PDFArray);
    if (arr) {
      for (let i = 0; i + 1 < arr.size(); i += 2) {
        const key = arr.lookup(i);
        const label = key instanceof PDFHexString || key instanceof PDFString ? key.decodeText() : '';
        const spec = arr.lookup(i + 1);
        const f = spec instanceof PDFDict ? spec.lookup(PDFName.of('UF')) ?? spec.lookup(PDFName.of('F')) : null;
        const fname = f instanceof PDFHexString || f instanceof PDFString ? f.decodeText() : label;
        if (label === name || fname === name) {
          dropFileSpec(ctx, arr.get(i + 1));
          arr.remove(i + 1);
          arr.remove(i);
          removed++;
          i -= 2;
        }
      }
    }
    const kids = ctx.lookupMaybe(node.get(PDFName.of('Kids')), PDFArray);
    if (kids) for (let k = 0; k < kids.size(); k++) {
      const kid = ctx.lookupMaybe(kids.get(k), PDFDict);
      if (kid) walk(kid);
    }
  };
  walk(ef);
  if (!removed) throw new Error('That attachment was not found.');
  return save(doc);
}
