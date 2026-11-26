// PDF/A-2b preparation: the archive flavour of PDF. Adds the identification metadata and a colour profile,
// removes what PDF/A forbids (scripts, launch actions, attachments, hidden annotations), and checks the fonts.
// It cannot embed a font that the file does not carry, so it reports those instead of claiming a pass.
import { dropFileSpec } from './navdata';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFHexString, PDFStream, PDFString } from 'pdf-lib';

// ---------------------------------------------------------------- an sRGB colour profile, built here
const s15 = (v: number) => Math.round(v * 65536) | 0;

/** A small ICC v2 sRGB profile (matrix and curve), so no profile file has to ship with the app. */
export function srgbProfile(): Uint8Array {
  const tags: { sig: string; data: Uint8Array }[] = [];
  const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
  const xyz = (x: number, y: number, z: number) => Uint8Array.from([...ascii('XYZ '), 0, 0, 0, 0, ...u32(s15(x)), ...u32(s15(y)), ...u32(s15(z))]);
  const text = (s: string) => Uint8Array.from([...ascii('text'), 0, 0, 0, 0, ...ascii(s), 0]);
  const desc = (s: string) => {
    const a = [...ascii(s), 0];
    return Uint8Array.from([...ascii('desc'), 0, 0, 0, 0, ...u32(a.length), ...a, ...u32(0), ...u32(0), 0, 0, 0, ...new Array(67).fill(0)]);
  };
  // sRGB transfer curve as 1024 points
  const n = 1024;
  const curve = new Uint8Array(12 + n * 2);
  curve.set([...ascii('curv'), 0, 0, 0, 0, ...u32(n)]);
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    const y = x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    const v = Math.round(y * 65535);
    curve[12 + i * 2] = v >> 8;
    curve[13 + i * 2] = v & 255;
  }
  tags.push(
    { sig: 'desc', data: desc('sRGB IEC61966-2.1') },
    { sig: 'cprt', data: text('Public domain') },
    { sig: 'wtpt', data: xyz(0.9642, 1.0, 0.8249) },
    { sig: 'rXYZ', data: xyz(0.4360747, 0.2225045, 0.0139322) },
    { sig: 'gXYZ', data: xyz(0.3850649, 0.7168786, 0.0971045) },
    { sig: 'bXYZ', data: xyz(0.1430804, 0.0606169, 0.7141733) },
    { sig: 'rTRC', data: curve },
    { sig: 'gTRC', data: curve },
    { sig: 'bTRC', data: curve },
  );
  const pad4 = (len: number) => (len + 3) & ~3;
  const tableLen = 4 + tags.length * 12;
  let off = 128 + tableLen;
  const placed: { sig: string; off: number; size: number; data: Uint8Array }[] = [];
  const seen = new Map<Uint8Array, number>();
  for (const t of tags) {
    const dup = seen.get(t.data);
    if (dup !== undefined) placed.push({ sig: t.sig, off: dup, size: t.data.length, data: new Uint8Array(0) });
    else {
      seen.set(t.data, off);
      placed.push({ sig: t.sig, off, size: t.data.length, data: t.data });
      off += pad4(t.data.length);
    }
  }
  const out = new Uint8Array(off);
  const put = (at: number, bytes: number[] | Uint8Array) => out.set(bytes, at);
  put(0, u32(off));
  put(8, u32(0x02100000));
  put(12, ascii('mntr'));
  put(16, ascii('RGB '));
  put(20, ascii('XYZ '));
  put(24, [0x07, 0xe0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0]); // 2016-01-01 00:00:00
  put(36, ascii('acsp'));
  put(40, ascii('MSFT'));
  put(68, [...u32(s15(0.9642)), ...u32(s15(1.0)), ...u32(s15(0.8249))]);
  put(128, u32(tags.length));
  placed.forEach((p, i) => {
    put(132 + i * 12, [...ascii(p.sig), ...u32(p.off), ...u32(p.size)]);
    if (p.data.length) put(p.off, p.data);
  });
  return out;
}

// ---------------------------------------------------------------- the conversion
export interface PdfaReport {
  /** things that were changed */
  fixed: string[];
  /** things that stop the file being a true PDF/A, which this tool cannot fix */
  problems: string[];
  /** true when nothing is known to stand in the way */
  likelyCompliant: boolean;
}

const FORBIDDEN_ACTIONS = new Set(['JavaScript', 'Launch', 'Sound', 'Movie', 'ResetForm', 'ImportData', 'SetOCGState', 'Rendition', 'Trans', 'GoTo3DView']);
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const iso = (d: Date) => d.toISOString().replace(/\.\d+Z$/, 'Z');

function xmp(o: { title: string; author: string; subject: string; keywords: string; created: Date; modified: Date }) {
  const lang = (tag: string, v: string) => (v ? `<dc:${tag}><rdf:Alt><rdf:li xml:lang="x-default">${esc(v)}</rdf:li></rdf:Alt></dc:${tag}>` : '');
  return (
    `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n` +
    `<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"><pdfaid:part>2</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance></rdf:Description>\n` +
    `<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:format>application/pdf</dc:format>${lang('title', o.title)}${o.author ? `<dc:creator><rdf:Seq><rdf:li>${esc(o.author)}</rdf:li></rdf:Seq></dc:creator>` : ''}${lang('description', o.subject)}</rdf:Description>\n` +
    `<rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/"><xmp:CreatorTool>PweDeF</xmp:CreatorTool><xmp:CreateDate>${iso(o.created)}</xmp:CreateDate><xmp:ModifyDate>${iso(o.modified)}</xmp:ModifyDate><xmp:MetadataDate>${iso(o.modified)}</xmp:MetadataDate></rdf:Description>\n` +
    `<rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/"><pdf:Producer>PweDeF</pdf:Producer>${o.keywords ? `<pdf:Keywords>${esc(o.keywords)}</pdf:Keywords>` : ''}</rdf:Description>\n` +
    `</rdf:RDF></x:xmpmeta>\n<?xpacket end="w"?>`
  );
}

/** Names of fonts that are used but not stored in the file. */
function unembeddedFonts(doc: PDFDocument): string[] {
  const names = new Set<string>();
  for (const [, o] of doc.context.enumerateIndirectObjects()) {
    if (!(o instanceof PDFDict) || o.get(PDFName.of('Type')) !== PDFName.of('Font')) continue;
    const sub = o.get(PDFName.of('Subtype'));
    if (sub === PDFName.of('Type3')) continue;
    let font: PDFDict = o;
    if (sub === PDFName.of('Type0')) {
      const d = o.lookupMaybe(PDFName.of('DescendantFonts'), PDFArray)?.lookupMaybe(0, PDFDict);
      if (!d) continue;
      font = d;
    }
    const fd = font.lookupMaybe(PDFName.of('FontDescriptor'), PDFDict);
    const has = fd && (fd.has(PDFName.of('FontFile')) || fd.has(PDFName.of('FontFile2')) || fd.has(PDFName.of('FontFile3')));
    if (!has) {
      const base = o.lookup(PDFName.of('BaseFont'));
      names.add(base instanceof PDFName ? base.decodeText().replace(/^[A-Z]{6}\+/, '') : 'a font');
    }
  }
  return [...names].sort();
}

export async function toPdfA(bytes: Uint8Array): Promise<{ bytes: Uint8Array; report: PdfaReport }> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = doc.context;
  const fixed: string[] = [];
  const problems: string[] = [];
  const cat = doc.catalog;

  // 1. no scripts, no launching, no sounds or movies
  let stripped = 0;
  const actionName = (a: unknown) => {
    const d = a instanceof PDFDict ? a : null;
    const s = d?.lookup(PDFName.of('S'));
    return s instanceof PDFName ? s.decodeText() : '';
  };
  for (const [, o] of ctx.enumerateIndirectObjects()) {
    const d = o instanceof PDFStream ? o.dict : o;
    if (!(d instanceof PDFDict)) continue;
    if (d.has(PDFName.of('AA'))) (d.delete(PDFName.of('AA')), stripped++);
    for (const key of ['A', 'OpenAction'] as const) {
      const a = d.lookup(PDFName.of(key)); // may be a destination array, which is fine and must not throw
      if (a instanceof PDFDict && FORBIDDEN_ACTIONS.has(actionName(a))) (d.delete(PDFName.of(key)), stripped++);
    }
  }
  const open = cat.lookup(PDFName.of('OpenAction'));
  if (open instanceof PDFDict && FORBIDDEN_ACTIONS.has(actionName(open))) (cat.delete(PDFName.of('OpenAction')), stripped++);
  const namesObj = cat.lookup(PDFName.of('Names'));
  const names = namesObj instanceof PDFDict ? namesObj : undefined;
  if (names?.has(PDFName.of('JavaScript'))) (names.delete(PDFName.of('JavaScript')), stripped++);
  if (stripped) fixed.push(`Removed ${stripped} script or launch action${stripped === 1 ? '' : 's'}.`);

  // 2. attached files are not allowed in PDF/A-2b
  const efTree = names?.lookup(PDFName.of('EmbeddedFiles'));
  if (names && efTree instanceof PDFDict) {
    const walk = (node: PDFDict) => {
      const arr = node.lookup(PDFName.of('Names'));
      if (arr instanceof PDFArray) for (let i = 1; i < arr.size(); i += 2) dropFileSpec(ctx, arr.get(i));
      const kids = node.lookup(PDFName.of('Kids'));
      if (kids instanceof PDFArray) for (let k = 0; k < kids.size(); k++) {
        const kid = kids.lookup(k);
        if (kid instanceof PDFDict) walk(kid);
      }
    };
    walk(efTree);
    names.delete(PDFName.of('EmbeddedFiles'));
    fixed.push('Removed attached files.');
  }
  cat.delete(PDFName.of('Encrypt'));

  // 3. annotations must print and must not be hidden; remove file attachments and media
  let flagged = 0;
  let removed = 0;
  for (const page of doc.getPages()) {
    const arr = page.node.Annots();
    if (!arr) continue;
    for (let k = arr.size() - 1; k >= 0; k--) {
      const annotObj: unknown = arr.lookup(k);
      const annot: PDFDict | undefined = annotObj instanceof PDFDict ? annotObj : undefined;
      if (!annot) continue;
      const sub = annot.lookup(PDFName.of('Subtype'));
      const st = sub instanceof PDFName ? sub.decodeText() : '';
      if (['FileAttachment', 'Sound', 'Movie', 'Screen', 'RichMedia', '3D'].includes(st)) {
        if (st === 'FileAttachment') dropFileSpec(ctx, annot.get(PDFName.of('FS')));
        arr.remove(k);
        removed++;
        continue;
      }
      if (st === 'Popup') continue;
      const f = annot.lookup(PDFName.of('F'));
      const cur = f instanceof PDFNumber ? f.asNumber() : 0;
      const next = (cur | 4) & ~(1 | 2 | 32);
      if (next !== cur) (annot.set(PDFName.of('F'), PDFNumber.of(next)), flagged++);
    }
  }
  if (removed) fixed.push(`Removed ${removed} attachment or media annotation${removed === 1 ? '' : 's'}.`);
  if (flagged) fixed.push(`Set ${flagged} annotation${flagged === 1 ? '' : 's'} to print and be visible.`);

  // 4. identification metadata (XMP), kept in step with the document info
  const now = new Date();
  const created = doc.getCreationDate() || now;
  const info = { title: doc.getTitle() || '', author: doc.getAuthor() || '', subject: doc.getSubject() || '', keywords: doc.getKeywords() || '' };
  doc.setProducer('PweDeF');
  doc.setCreator('PweDeF');
  doc.setCreationDate(created);
  doc.setModificationDate(now);
  const meta = ctx.stream(new TextEncoder().encode(xmp({ ...info, created, modified: now })), { Type: 'Metadata', Subtype: 'XML' });
  cat.set(PDFName.of('Metadata'), ctx.register(meta));
  fixed.push('Added the PDF/A-2b identification metadata.');

  // 5. a colour profile, so device colours have a defined meaning
  const icc = ctx.flateStream(srgbProfile(), { N: 3, Alternate: 'DeviceRGB' });
  const intent = ctx.obj({
    Type: 'OutputIntent',
    S: 'GTS_PDFA1',
    OutputConditionIdentifier: PDFString.of('sRGB IEC61966-2.1'),
    Info: PDFString.of('sRGB IEC61966-2.1'),
    RegistryName: PDFString.of('http://www.color.org'),
    DestOutputProfile: ctx.register(icc),
  });
  cat.set(PDFName.of('OutputIntents'), ctx.obj([ctx.register(intent)]));
  fixed.push('Added the sRGB colour profile.');

  // 6. a file ID
  if (!ctx.trailerInfo.ID) {
    const id = PDFHexString.of([...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join(''));
    ctx.trailerInfo.ID = ctx.obj([id, id]);
    fixed.push('Added a file ID.');
  }

  // 7. what cannot be fixed here
  const fonts = unembeddedFonts(doc);
  if (fonts.length) problems.push(`These fonts are not stored in the file, which PDF/A requires: ${fonts.slice(0, 8).join(', ')}${fonts.length > 8 ? '…' : ''}. Print the file to PDF from the program that made it with "embed all fonts", or re-create it from the original document.`);
  if (new TextDecoder('latin1').decode(bytes).includes('/ByteRange')) problems.push('This file has a digital signature. Converting it makes that signature invalid, so sign the PDF/A copy last.');

  const out = await doc.save({ useObjectStreams: true });
  return { bytes: out, report: { fixed, problems, likelyCompliant: problems.length === 0 } };
}

