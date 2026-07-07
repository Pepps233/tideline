import { isUtf8 } from "node:buffer";

import type { TranscriptRole } from "../types.js";
import { chooseContextAction } from "./context-action.js";
import { classifySourceLabels } from "./labels.js";
import { splitTextIntoChunks } from "./text-splitter.js";
import type { SourceItemDraft } from "./types.js";

const NON_TEXT_EXCERPT_MAX_CHARS = 512;

export function createSourceItemDrafts(input: {
  mediaType: string;
  raw: Buffer;
  turnRole: TranscriptRole;
}): SourceItemDraft[] {
  if (!isTextMediaType(input.mediaType)) {
    return [
      {
        rawStartByteOffset: null,
        rawEndByteOffset: null,
        renderedExcerpt: boundedNonTextExcerpt(input.mediaType, input.raw),
        contextAction: "compact",
        actionReason: "compact:non_text",
        labels: ["file_output"],
      },
    ];
  }

  if (!isUtf8(input.raw)) {
    return [
      {
        rawStartByteOffset: null,
        rawEndByteOffset: null,
        renderedExcerpt: boundedUndecodableTextExcerpt(
          input.mediaType,
          input.raw,
        ),
        contextAction: "compact",
        actionReason: "compact:undecodable_text",
        labels: ["file_output"],
      },
    ];
  }

  const text = input.raw.toString("utf8");
  const chunks = splitTextIntoChunks(text);
  const seenExcerpts = new Set<string>();

  if (chunks.length === 0) {
    return [
      {
        rawStartByteOffset: null,
        rawEndByteOffset: null,
        renderedExcerpt: "",
        contextAction: "discard",
        actionReason: "discard:empty",
        labels: [],
      },
    ];
  }

  return chunks.map((chunk) => {
    const renderedExcerpt = text.slice(chunk.startChar, chunk.endChar);
    const normalizedExcerpt = normalizeExcerptForDeduplication(renderedExcerpt);
    const isDuplicate =
      normalizedExcerpt.length > 0 && seenExcerpts.has(normalizedExcerpt);
    const labels = classifySourceLabels(renderedExcerpt, input.turnRole);
    const action = chooseContextAction({
      fromLongRegion: chunk.fromLongRegion,
      isDuplicate,
      labels,
      renderedExcerpt,
    });

    if (normalizedExcerpt.length > 0) {
      seenExcerpts.add(normalizedExcerpt);
    }

    return {
      rawStartByteOffset: byteOffsetForChar(text, chunk.startChar),
      rawEndByteOffset: byteOffsetForChar(text, chunk.endChar),
      renderedExcerpt,
      contextAction: action.contextAction,
      actionReason: action.actionReason,
      labels,
    };
  });
}

function isTextMediaType(mediaType: string): boolean {
  const normalized = mediaType.toLowerCase();

  return (
    normalized.startsWith("text/") ||
    normalized.includes("charset=") ||
    normalized === "application/json" ||
    normalized.endsWith("+json") ||
    normalized === "application/xml" ||
    normalized.endsWith("+xml") ||
    normalized === "application/javascript" ||
    normalized === "application/typescript"
  );
}

function boundedNonTextExcerpt(mediaType: string, raw: Buffer): string {
  const excerpt = `Non-text source item: ${mediaType}, ${raw.byteLength} bytes`;

  return excerpt.length <= NON_TEXT_EXCERPT_MAX_CHARS
    ? excerpt
    : excerpt.slice(0, NON_TEXT_EXCERPT_MAX_CHARS);
}

function boundedUndecodableTextExcerpt(mediaType: string, raw: Buffer): string {
  const excerpt = `Undecodable text source item: ${mediaType}, ${raw.byteLength} bytes`;

  return excerpt.length <= NON_TEXT_EXCERPT_MAX_CHARS
    ? excerpt
    : excerpt.slice(0, NON_TEXT_EXCERPT_MAX_CHARS);
}

function normalizeExcerptForDeduplication(renderedExcerpt: string): string {
  return renderedExcerpt.trim().replace(/\s+/g, " ");
}

function byteOffsetForChar(text: string, charIndex: number): number {
  return Buffer.byteLength(text.slice(0, charIndex), "utf8");
}
