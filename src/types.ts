// All annotation geometry is stored in "page units": the pdf.js viewport at scale 1
// for the page's current rotation (origin top-left, y down, 1 unit = 1pt).
// The renderer multiplies by zoom; the baker converts to PDF user space.

export type Tool =
  | 'select'
  | 'hand'
  | 'editText'
  | 'text'
  | 'highlight'
  | 'underline'
  | 'strike'
  | 'ink'
  | 'rect'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'whiteout'
  | 'redact'
  | 'note'
  | 'place'; // placing an image (signature / stamp / picture)

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Base {
  id: string;
  page: number;
}

export type MarkupAnnot = Base & { type: 'highlight' | 'underline' | 'strike'; rects: Rect[]; color: string };
export type InkAnnot = Base & { type: 'ink'; points: [number, number][]; color: string; width: number };
export type ShapeAnnot = Base & Rect & { type: 'rect' | 'ellipse'; color: string; width: number; fill: string | null };
export type LineAnnot = Base & {
  type: 'line' | 'arrow';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  width: number;
};
export type TextAnnot = Base &
  Rect & {
    type: 'text' | 'replace';
    text: string;
    fontSize: number;
    color: string;
    bold?: boolean;
    font?: 'sans' | 'serif' | 'mono';
    /** background drawn underneath (used by edit-text to cover the original words) */
    bg?: string | null;
  };
export type WhiteoutAnnot = Base & Rect & { type: 'whiteout'; color: string };
/** True redaction: the page is re-rendered as an image with the area removed (no hidden text survives). */
export type RedactAnnot = Base & Rect & { type: 'redact' };
export type ImageAnnot = Base & Rect & { type: 'image'; dataUrl: string; label?: string };
export type NoteAnnot = Base & { type: 'note'; x: number; y: number; text: string; color: string };

export type Annot =
  | MarkupAnnot
  | InkAnnot
  | ShapeAnnot
  | LineAnnot
  | TextAnnot
  | WhiteoutAnnot
  | RedactAnnot
  | ImageAnnot
  | NoteAnnot;

export type FormValues = Record<string, string | boolean>;

export interface Snapshot {
  bytes: Uint8Array;
  annots: Annot[];
  form: FormValues;
}

export interface DocTab {
  id: string;
  name: string;
  path: string | null;
  bytes: Uint8Array;
  annots: Annot[];
  form: FormValues;
  past: Snapshot[];
  future: Snapshot[];
  dirty: boolean;
  /** increments whenever `bytes` changes so the viewer reloads */
  rev: number;
  /** a tool to launch as soon as the document is open (from the Tool hub) */
  startAction?: string;
}

export interface StyleState {
  color: string;
  width: number;
  fontSize: number;
  fill: string | null;
  highlight: string;
}
