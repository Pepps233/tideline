import type {
  ExpandContextBlockInput,
  ExpandedContextBlock,
  ExpandedContextBlockSource,
  RawBlobPointer,
  StoredContextBlock,
  StoredSourceItem,
  StoredTranscriptTurn,
} from "../types.js";

interface SourceExcerpt {
  excerpt: string;
  excerptStartByteOffset: number | null;
  excerptEndByteOffset: number | null;
  usedRenderedExcerpt: boolean;
}

export async function expandContextBlock(input: {
  getContextBlock: (
    contextBlockId: string,
  ) => Promise<StoredContextBlock | undefined>;
  getRawBlobById: (rawPointerId: string) => RawBlobPointer | undefined;
  getSourceItem: (
    sourceItemId: string,
  ) => Promise<StoredSourceItem | undefined>;
  getTurn: (turnId: string) => Promise<StoredTranscriptTurn | undefined>;
  readAndVerifyBlob: (pointer: RawBlobPointer) => Uint8Array;
  request: ExpandContextBlockInput;
}): Promise<ExpandedContextBlock | undefined> {
  const tokenBudget = normalizeExpansionTokenBudget(input.request.tokenBudget);
  const contextBlock = await input.getContextBlock(
    input.request.contextBlockId,
  );

  if (!contextBlock) {
    return undefined;
  }

  const sources: ExpandedContextBlockSource[] = [];
  let estimatedTokens = 0;
  let truncated = false;

  for (const sourceItemId of contextBlock.sourceItemIds) {
    const sourceItem = await input.getSourceItem(sourceItemId);

    if (!sourceItem) {
      throw new Error(`Context block source item not found: ${sourceItemId}`);
    }

    const turn = await input.getTurn(sourceItem.turnId);

    if (!turn) {
      throw new Error(`Source item turn not found: ${sourceItem.turnId}`);
    }

    const rawPointer = input.getRawBlobById(sourceItem.rawPointerId);

    if (!rawPointer) {
      throw new Error(
        `Source item ${sourceItem.sourceItemId} has missing raw pointer ${sourceItem.rawPointerId}`,
      );
    }

    const raw = input.readAndVerifyBlob(rawPointer);
    const fullExcerpt = createSourceExcerpt(sourceItem, raw, rawPointer);
    const remainingTokens = Math.max(tokenBudget - estimatedTokens, 0);
    const boundedExcerpt = truncateExcerpt(fullExcerpt, remainingTokens);
    const sourceTokens = estimateTextTokens(boundedExcerpt.excerpt);

    sources.push({
      sourceItem,
      turn,
      mediaType: rawPointer.mediaType,
      rawByteLength: rawPointer.byteLength,
      excerpt: boundedExcerpt.excerpt,
      excerptStartByteOffset: boundedExcerpt.excerptStartByteOffset,
      excerptEndByteOffset: boundedExcerpt.excerptEndByteOffset,
      truncated: boundedExcerpt.truncated,
      usedRenderedExcerpt: fullExcerpt.usedRenderedExcerpt,
    });

    estimatedTokens += sourceTokens;
    truncated = truncated || boundedExcerpt.truncated;
  }

  return {
    contextBlock,
    sources,
    tokenBudget,
    estimatedTokens,
    truncated,
  };
}

function normalizeExpansionTokenBudget(
  tokenBudget: number | undefined,
): number {
  if (tokenBudget === undefined) {
    return 5000;
  }

  if (!Number.isFinite(tokenBudget) || tokenBudget < 1) {
    throw new Error("tokenBudget must be a positive number");
  }

  return Math.floor(tokenBudget);
}

function createSourceExcerpt(
  sourceItem: StoredSourceItem,
  raw: Uint8Array,
  rawPointer: RawBlobPointer,
): SourceExcerpt {
  if (
    isTextMediaType(rawPointer.mediaType) &&
    sourceItem.rawStartByteOffset !== null &&
    sourceItem.rawEndByteOffset !== null
  ) {
    validateRawOffsets(sourceItem, raw.byteLength);

    const rawSlice = raw.slice(
      sourceItem.rawStartByteOffset,
      sourceItem.rawEndByteOffset,
    );

    return {
      excerpt: Buffer.from(rawSlice).toString("utf8"),
      excerptStartByteOffset: sourceItem.rawStartByteOffset,
      excerptEndByteOffset: sourceItem.rawEndByteOffset,
      usedRenderedExcerpt: false,
    };
  }

  return {
    excerpt: sourceItem.renderedExcerpt,
    excerptStartByteOffset: null,
    excerptEndByteOffset: null,
    usedRenderedExcerpt: true,
  };
}

function validateRawOffsets(
  sourceItem: StoredSourceItem,
  rawByteLength: number,
): void {
  const { rawStartByteOffset, rawEndByteOffset } = sourceItem;

  if (
    rawStartByteOffset === null ||
    rawEndByteOffset === null ||
    rawStartByteOffset < 0 ||
    rawEndByteOffset < rawStartByteOffset ||
    rawEndByteOffset > rawByteLength
  ) {
    throw new Error(
      `Invalid raw byte offsets for source item ${sourceItem.sourceItemId}`,
    );
  }
}

function truncateExcerpt(
  sourceExcerpt: SourceExcerpt,
  tokenBudget: number,
): SourceExcerpt & { truncated: boolean } {
  const fullTokens = estimateTextTokens(sourceExcerpt.excerpt);

  if (fullTokens <= tokenBudget) {
    return {
      ...sourceExcerpt,
      truncated: false,
    };
  }

  const excerpt = takeFirstCodePoints(sourceExcerpt.excerpt, tokenBudget * 4);
  const excerptEndByteOffset =
    sourceExcerpt.excerptStartByteOffset === null
      ? null
      : sourceExcerpt.excerptStartByteOffset + Buffer.byteLength(excerpt);

  return {
    ...sourceExcerpt,
    excerpt,
    excerptEndByteOffset,
    truncated: true,
  };
}

function takeFirstCodePoints(text: string, maxLength: number): string {
  if (maxLength <= 0) {
    return "";
  }

  let result = "";

  for (const char of text) {
    if (result.length + char.length > maxLength) {
      break;
    }

    result += char;
  }

  return result;
}

function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
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
