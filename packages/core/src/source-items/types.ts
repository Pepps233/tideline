import type { ContextAction, SourceLabel } from "../types.js";

export interface SourceItemDraft {
  rawStartByteOffset: number | null;
  rawEndByteOffset: number | null;
  renderedExcerpt: string;
  contextAction: ContextAction;
  actionReason: string;
  labels: SourceLabel[];
}

export interface TextRegion {
  startChar: number;
  endChar: number;
}

export interface TextChunk extends TextRegion {
  fromLongRegion: boolean;
}

export interface LineSpan {
  startChar: number;
  endChar: number;
  nextStartChar: number;
  text: string;
}
