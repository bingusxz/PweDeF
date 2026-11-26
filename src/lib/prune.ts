// pdf-lib writes every object it has ever held, even ones nothing points to any more. After a page is removed or
// rebuilt (redaction, delete pages) its old content, fonts and pictures would stay inside the saved file and could
// be dug out with a PDF tool. This walks the document from its roots and deletes whatever cannot be reached.
import { PDFArray, PDFDict, PDFDocument, PDFRef, PDFStream, type PDFObject } from 'pdf-lib';

/** Deletes objects that nothing in the document points to. Call after `await doc.flush()`. Returns how many went. */
export function pruneUnreachable(doc: PDFDocument): number {
  const ctx = doc.context;
  const seen = new Set<number>();
  const stack: PDFObject[] = [];
  const t = ctx.trailerInfo as Record<string, PDFObject | undefined>;
  for (const k of ['Root', 'Info', 'Encrypt']) if (t[k]) stack.push(t[k]!);
  while (stack.length) {
    const o = stack.pop()!;
    if (o instanceof PDFRef) {
      if (seen.has(o.objectNumber)) continue;
      seen.add(o.objectNumber);
      const target = ctx.lookup(o);
      if (target) stack.push(target);
    } else if (o instanceof PDFStream) stack.push(o.dict);
    else if (o instanceof PDFDict) for (const [, v] of o.entries()) stack.push(v);
    else if (o instanceof PDFArray) for (let i = 0; i < o.size(); i++) stack.push(o.get(i));
  }
  let removed = 0;
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (!seen.has(ref.objectNumber)) {
      ctx.delete(ref);
      removed++;
    }
  }
  return removed;
}
