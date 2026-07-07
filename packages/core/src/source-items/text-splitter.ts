import type { LineSpan, TextChunk, TextRegion } from "./types.js";

const SOURCE_ITEM_MAX_CHARS = 6000;
const FENCE_LINE_PATTERN = /^(?:```|~~~)/;

export function splitTextIntoChunks(text: string): TextChunk[] {
  const regions = splitTextIntoRegions(text);
  const chunks: TextChunk[] = [];

  for (const region of regions) {
    const regionChunks = splitRegionBySize(text, region);
    const fromLongRegion =
      region.endChar - region.startChar > SOURCE_ITEM_MAX_CHARS;

    for (const regionChunk of regionChunks) {
      chunks.push({
        ...regionChunk,
        fromLongRegion,
      });
    }
  }

  return chunks;
}

function splitTextIntoRegions(text: string): TextRegion[] {
  const regions: TextRegion[] = [];
  let regionStartChar: number | undefined;
  let regionEndChar: number | undefined;
  let inFence = false;

  for (const line of scanLines(text)) {
    const trimmedLine = line.text.trim();
    const isFenceLine = FENCE_LINE_PATTERN.test(trimmedLine);
    const isBlankOutsideFence = !inFence && trimmedLine.length === 0;

    if (isBlankOutsideFence) {
      if (
        regionStartChar !== undefined &&
        regionEndChar !== undefined &&
        regionEndChar > regionStartChar
      ) {
        regions.push({
          startChar: regionStartChar,
          endChar: regionEndChar,
        });
      }

      regionStartChar = undefined;
      regionEndChar = undefined;
      continue;
    }

    regionStartChar ??= line.startChar;
    regionEndChar = line.endChar;

    if (isFenceLine) {
      inFence = !inFence;
    }
  }

  if (
    regionStartChar !== undefined &&
    regionEndChar !== undefined &&
    regionEndChar > regionStartChar
  ) {
    regions.push({
      startChar: regionStartChar,
      endChar: regionEndChar,
    });
  }

  return regions;
}

function scanLines(text: string): LineSpan[] {
  const lines: LineSpan[] = [];
  let startChar = 0;

  while (startChar < text.length) {
    const newlineIndex = text.indexOf("\n", startChar);
    const endChar = newlineIndex === -1 ? text.length : newlineIndex;
    const nextStartChar = newlineIndex === -1 ? text.length : newlineIndex + 1;

    lines.push({
      startChar,
      endChar,
      nextStartChar,
      text: text.slice(startChar, endChar),
    });

    startChar = nextStartChar;
  }

  return lines;
}

function splitRegionBySize(text: string, region: TextRegion): TextRegion[] {
  if (region.endChar - region.startChar <= SOURCE_ITEM_MAX_CHARS) {
    return [region];
  }

  const regions: TextRegion[] = [];
  let startChar = region.startChar;

  while (startChar < region.endChar) {
    const maxEndChar = Math.min(
      startChar + SOURCE_ITEM_MAX_CHARS,
      region.endChar,
    );
    const split = findSplitPoint(text, startChar, maxEndChar, region.endChar);

    regions.push({
      startChar,
      endChar: split.endChar,
    });

    startChar = split.nextStartChar;
  }

  return regions;
}

function findSplitPoint(
  text: string,
  startChar: number,
  maxEndChar: number,
  regionEndChar: number,
): { endChar: number; nextStartChar: number } {
  if (maxEndChar >= regionEndChar) {
    return {
      endChar: regionEndChar,
      nextStartChar: regionEndChar,
    };
  }

  const safeMaxEndChar = previousCodePointBoundary(
    text,
    maxEndChar,
    startChar,
    regionEndChar,
  );
  const searchStartChar = startChar + 1;
  const blankLineIndex = text.lastIndexOf("\n\n", safeMaxEndChar);

  if (blankLineIndex >= searchStartChar) {
    return {
      endChar: blankLineIndex,
      nextStartChar: blankLineIndex + 2,
    };
  }

  const newlineIndex = text.lastIndexOf("\n", safeMaxEndChar);

  if (newlineIndex >= searchStartChar) {
    return {
      endChar: newlineIndex,
      nextStartChar: newlineIndex + 1,
    };
  }

  return {
    endChar: safeMaxEndChar,
    nextStartChar: safeMaxEndChar,
  };
}

function previousCodePointBoundary(
  text: string,
  index: number,
  startChar: number,
  regionEndChar: number,
): number {
  if (index <= startChar || index >= regionEndChar || index >= text.length) {
    return index;
  }

  if (!isLowSurrogate(text.charCodeAt(index))) {
    return index;
  }

  const previousIndex = index - 1;

  if (
    previousIndex > startChar &&
    isHighSurrogate(text.charCodeAt(previousIndex))
  ) {
    return previousIndex;
  }

  return nextCodePointBoundary(text, startChar, regionEndChar);
}

function nextCodePointBoundary(
  text: string,
  startChar: number,
  regionEndChar: number,
): number {
  const nextChar = Math.min(startChar + 1, regionEndChar);

  if (
    nextChar < regionEndChar &&
    isHighSurrogate(text.charCodeAt(startChar)) &&
    isLowSurrogate(text.charCodeAt(nextChar))
  ) {
    return Math.min(startChar + 2, regionEndChar);
  }

  return nextChar;
}

function isHighSurrogate(charCode: number): boolean {
  return charCode >= 0xd800 && charCode <= 0xdbff;
}

function isLowSurrogate(charCode: number): boolean {
  return charCode >= 0xdc00 && charCode <= 0xdfff;
}
