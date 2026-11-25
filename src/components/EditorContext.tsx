import { createContext, useContext } from 'react';
import type { Annot, FormValues, Rect, StyleState, Tool } from '../types';

export interface Hit {
  page: number;
  rect: Rect;
  snippet: string;
}

export interface PendingImage {
  dataUrl: string;
  w: number;
  h: number;
  label?: string;
}

export interface EditorApi {
  zoom: number;
  tool: Tool;
  style: StyleState;
  annots: Annot[];
  form: FormValues;
  selectedId: string | null;
  editingId: string | null;
  hits: Hit[];
  activeHit: number;
  pendingImage: PendingImage | null;
  addAnnot(a: Annot, edit?: boolean): void;
  changeAnnot(id: string, fn: (a: Annot) => Annot, history?: boolean): void;
  removeAnnot(id: string): void;
  pushHistory(): void;
  select(id: string | null): void;
  edit(id: string | null): void;
  setFormValue(name: string, value: string | boolean): void;
  placeImageAt(page: number, x: number, y: number, fit?: Rect): void;
  signField(page: number, rect: Rect): void;
}

export const EditorCtx = createContext<EditorApi | null>(null);
export const useEditor = () => useContext(EditorCtx)!;
