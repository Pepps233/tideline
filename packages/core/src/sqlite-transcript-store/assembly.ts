import { isUtf8 } from "node:buffer";
import { randomUUID } from "node:crypto";

import type BetterSqlite3 from "better-sqlite3";

import { normalizeSourceLabel } from "../source-items/labels.js";
import { mapSourceItemRow, mapTranscriptTurnRow } from "../sqlite/rows.js";
import type {
  SourceItemRow,
  SourceLabelRow,
  TranscriptTurnRow,
} from "../sqlite/rows.js";
import type {
  AssembleContextInput,
  AssembledContextItem,
  AssembledContextPacket,
  AssembledContextSection,
  AssemblyReceipt,
  AssemblyReceiptEntityType,
  EmbeddingProvider,
  RelationshipEntityType,
  SearchContextTextKind,
  SourceLabel,
  StoredContextBlock,
  StoredSourceItem,
  StoredTranscriptTurn,
} from "../types.js";
import { normalizeThreadId } from "../validation.js";
import { listThreadContextBlocks } from "./context-blocks.js";
import {
  insertAssemblyReceipt,
  listSupersededContextBlockIds,
  rankAssemblyCandidates,
} from "./retrieval.js";
import type { AssemblyRankingCandidate } from "./retrieval.js";

interface TranscriptTurnWithMediaType extends StoredTranscriptTurn {
  mediaType: string;
}

interface SourceItemWithTurn extends StoredSourceItem {
  turnIndex: number;
}

interface SourceItemWithTurnRow extends SourceItemRow {
  turn_index: number;
}

interface MiddleCandidate {
  baseOrder: number;
  entityId: string;
  entityType: RelationshipEntityType;
  item: AssembledContextItem;
  labels: SourceLabel[];
  sectionKind:
    "exact_source_items" | "open_questions" | "compacted_context_blocks";
  textKind: SearchContextTextKind;
  turnIndex: number;
}

interface ScoredMiddleCandidate extends MiddleCandidate {
  reasons: string[];
  score: number;
}

interface ReceiptItemDraft {
  entityType: AssemblyReceiptEntityType;
  entityId: string;
  sectionKind: AssembledContextSection["kind"];
  included: boolean;
  estimatedTokens: number;
  score: number;
  reasons: string[];
  omitReason?: string | undefined;
}

interface IncludeRenderedItemResult {
  included: boolean;
  estimatedTokens: number;
  omitReason?: string | undefined;
}

const SECTION_ORDER: AssembledContextSection["kind"][] = [
  "full_transcript_anchors",
  "recent_full_transcript",
  "exact_source_items",
  "open_questions",
  "compacted_context_blocks",
  "expandable_sources",
];

const SECTION_TITLES: Record<AssembledContextSection["kind"], string> = {
  full_transcript_anchors: "Full transcript anchors",
  recent_full_transcript: "Recent full transcript",
  exact_source_items: "Exact source items",
  open_questions: "Open questions",
  compacted_context_blocks: "Compacted context blocks",
  expandable_sources: "Expandable sources",
};

const NON_TEXT_PLACEHOLDER_MAX_LENGTH = 120;

export async function assembleContext(input: {
  clock: () => Date | string;
  db: BetterSqlite3.Database;
  embeddingProvider: EmbeddingProvider;
  readTurnRaw: (turnId: string) => Promise<Uint8Array>;
  request: AssembleContextInput;
}): Promise<AssembledContextPacket> {
  if (!input.request || typeof input.request !== "object") {
    throw new Error("assembleContext input is required");
  }

  const threadId = normalizeThreadId(input.request.threadId);
  const activeTurn = normalizeActiveTurn(input.request.activeTurn);
  const tokenBudget = normalizeTokenBudget(input.request.tokenBudget);
  const createdAt = normalizeAssemblyCreatedAt(input.clock());
  const turns = listThreadTurnsWithMediaType(input.db, threadId).filter(
    (turn) => turn.turnIndex < activeTurn,
  );
  const turnsByIndex = new Map(turns.map((turn) => [turn.turnIndex, turn]));
  const anchorTurns = [1, 2, 3]
    .map((turnIndex) => turnsByIndex.get(turnIndex))
    .filter((turn): turn is TranscriptTurnWithMediaType => turn !== undefined);
  const recentTurn =
    activeTurn > 1 ? turnsByIndex.get(activeTurn - 1) : undefined;
  const recentTurns =
    recentTurn && !anchorTurns.some((turn) => turn.turnId === recentTurn.turnId)
      ? [recentTurn]
      : [];
  const middleTurns = turns.filter(
    (turn) => turn.turnIndex >= 4 && turn.turnIndex <= activeTurn - 2,
  );
  const middleTurnIds = new Set(middleTurns.map((turn) => turn.turnId));
  const middleSourceItems = listThreadSourceItemsWithTurn(input.db, threadId)
    .filter((item) => middleTurnIds.has(item.turnId))
    .sort(compareSourceItems);
  const sourceItemsById = new Map(
    middleSourceItems.map((item) => [item.sourceItemId, item]),
  );
  const discardedSourceItemIds = middleSourceItems
    .filter((item) => item.contextAction === "discard")
    .map((item) => item.sourceItemId);
  const openQuestionItems = middleSourceItems.filter(
    (item) =>
      item.contextAction === "preserve_exact" &&
      item.labels.includes("open_question"),
  );
  const exactItems = middleSourceItems.filter(
    (item) =>
      item.contextAction === "preserve_exact" &&
      !item.labels.includes("open_question"),
  );
  const compactItems = middleSourceItems.filter(
    (item) => item.contextAction === "compact",
  );
  const compactItemIds = new Set(compactItems.map((item) => item.sourceItemId));
  const compactBlocks = listThreadContextBlocks(input.db, threadId)
    .filter(
      (block) =>
        block.sourceItemIds.length > 0 &&
        block.sourceItemIds.every((sourceItemId) =>
          compactItemIds.has(sourceItemId),
        ),
    )
    .sort(compareContextBlocks);
  const contextBlocksById = new Map(
    compactBlocks.map((block) => [block.contextBlockId, block]),
  );
  const supersededContextBlockIds = listSupersededContextBlockIds(
    input.db,
    threadId,
  );
  const coveredCompactItemIds = new Set(
    compactBlocks.flatMap((block) =>
      block.sourceItemIds.filter((sourceItemId) =>
        compactItemIds.has(sourceItemId),
      ),
    ),
  );
  const uncoveredCompactItems = compactItems.filter(
    (item) => !coveredCompactItemIds.has(item.sourceItemId),
  );
  const renderedRegistry = createRenderedRegistry();
  const anchorItems = await createFullTurnItems(
    anchorTurns,
    "anchor",
    input.readTurnRaw,
  );
  const recentItems = await createFullTurnItems(
    recentTurns,
    "recent",
    input.readTurnRaw,
  );
  const middleCandidates = await scoreMiddleCandidates({
    compactBlocks,
    db: input.db,
    embeddingProvider: input.embeddingProvider,
    exactItems,
    openQuestionItems,
    recentItems,
    request: input.request,
    sourceItemsById,
    threadId,
  });
  const sectionItems = new Map<
    AssembledContextSection["kind"],
    AssembledContextItem[]
  >(SECTION_ORDER.map((kind) => [kind, []]));
  const receipt: AssemblyReceipt = {
    assemblyId: randomUUID(),
    threadId,
    activeTurn,
    status: "assembled",
    includedFullTurnIds: [],
    middleTurnIds: middleTurns.map((turn) => turn.turnId),
    exactSourceItemIds: [],
    contextBlockIds: [],
    discardedSourceItemIds,
    estimatedTokens: 0,
    items: [],
    createdAt,
  };
  const receiptItems: ReceiptItemDraft[] = [];
  const includedExactItems: SourceItemWithTurn[] = [];
  const includedOpenQuestionItems: SourceItemWithTurn[] = [];
  const includedContextBlocks: StoredContextBlock[] = [];
  let estimatedTokens = 0;

  for (const item of anchorItems) {
    const includeResult = includeRenderedItem({
      estimatedTokens,
      item,
      renderedRegistry,
      tokenBudget,
    });

    if (includeResult.included) {
      sectionItems.get("full_transcript_anchors")?.push(item);
      estimatedTokens += includeResult.estimatedTokens;

      if (item.turnId) {
        receipt.includedFullTurnIds.push(item.turnId);
      }
    }

    receiptItems.push({
      entityType: "turn",
      entityId: item.turnId ?? item.id,
      sectionKind: "full_transcript_anchors",
      included: includeResult.included,
      estimatedTokens: includeResult.estimatedTokens,
      score: 0,
      reasons: [item.reason],
      omitReason: includeResult.omitReason,
    });
  }

  for (const item of recentItems) {
    const includeResult = includeRenderedItem({
      estimatedTokens,
      item,
      renderedRegistry,
      tokenBudget,
    });

    if (includeResult.included) {
      sectionItems.get("recent_full_transcript")?.push(item);
      estimatedTokens += includeResult.estimatedTokens;

      if (item.turnId) {
        receipt.includedFullTurnIds.push(item.turnId);
      }
    }

    receiptItems.push({
      entityType: "turn",
      entityId: item.turnId ?? item.id,
      sectionKind: "recent_full_transcript",
      included: includeResult.included,
      estimatedTokens: includeResult.estimatedTokens,
      score: 0,
      reasons: [item.reason],
      omitReason: includeResult.omitReason,
    });
  }

  for (const candidate of orderMiddleCandidates(middleCandidates)) {
    const isSuperseded =
      candidate.entityType === "context_block" &&
      supersededContextBlockIds.has(candidate.entityId);
    const includeResult = isSuperseded
      ? {
          included: false,
          estimatedTokens: estimateTextTokens(candidate.item.text),
          omitReason: "superseded by newer context block",
        }
      : includeRenderedItem({
          estimatedTokens,
          item: candidate.item,
          renderedRegistry,
          tokenBudget,
        });

    if (includeResult.included) {
      sectionItems.get(candidate.sectionKind)?.push(candidate.item);
      estimatedTokens += includeResult.estimatedTokens;

      if (candidate.sectionKind === "exact_source_items") {
        receipt.exactSourceItemIds.push(candidate.entityId);

        const sourceItem = sourceItemsById.get(candidate.entityId);
        if (sourceItem) {
          includedExactItems.push(sourceItem);
        }
      } else if (candidate.sectionKind === "open_questions") {
        receipt.exactSourceItemIds.push(candidate.entityId);

        const sourceItem = sourceItemsById.get(candidate.entityId);
        if (sourceItem) {
          includedOpenQuestionItems.push(sourceItem);
        }
      } else {
        receipt.contextBlockIds.push(candidate.entityId);

        const contextBlock = contextBlocksById.get(candidate.entityId);
        if (contextBlock) {
          includedContextBlocks.push(contextBlock);
        }
      }
    }

    receiptItems.push({
      entityType: candidate.entityType,
      entityId: candidate.entityId,
      sectionKind: candidate.sectionKind,
      included: includeResult.included,
      estimatedTokens: includeResult.estimatedTokens,
      score: candidate.score,
      reasons: candidate.reasons,
      omitReason: includeResult.omitReason,
    });
  }

  const expandableCandidates = buildExpandableItems({
    contextBlocks: includedContextBlocks,
    exactItems: includedExactItems,
    openQuestionItems: includedOpenQuestionItems,
    sourceItemsById,
    uncoveredCompactItems,
  });
  const expandableItems: AssembledContextItem[] = [];

  for (const item of expandableCandidates) {
    const includeResult = includeRenderedItem({
      estimatedTokens,
      item,
      renderedRegistry,
      tokenBudget,
    });

    if (includeResult.included) {
      expandableItems.push(item);
      estimatedTokens += includeResult.estimatedTokens;
    }

    receiptItems.push({
      entityType: "source_item",
      entityId: item.sourceItemIds?.[0] ?? item.id,
      sectionKind: "expandable_sources",
      included: includeResult.included,
      estimatedTokens: includeResult.estimatedTokens,
      score: 0,
      reasons: [item.reason],
      omitReason: includeResult.omitReason,
    });
  }

  sectionItems.set("expandable_sources", expandableItems);

  for (const turn of middleTurns) {
    receiptItems.push({
      entityType: "turn",
      entityId: turn.turnId,
      sectionKind: "expandable_sources",
      included: false,
      estimatedTokens: 0,
      score: 0,
      reasons: ["middle zone"],
      omitReason: "middle turn tracked",
    });
  }

  for (const sourceItemId of discardedSourceItemIds) {
    receiptItems.push({
      entityType: "source_item",
      entityId: sourceItemId,
      sectionKind: "expandable_sources",
      included: false,
      estimatedTokens: 0,
      score: 0,
      reasons: ["discarded source item"],
      omitReason: "discarded source item",
    });
  }

  const sections = SECTION_ORDER.map((kind) => ({
    kind,
    title: SECTION_TITLES[kind],
    items: sectionItems.get(kind) ?? [],
  }));

  receipt.items = finalizeReceiptItems(receiptItems);
  receipt.estimatedTokens = estimatedTokens;

  insertAssemblyReceipt(input.db, receipt);

  return {
    threadId,
    activeTurn,
    sections,
    receipt,
  };
}

async function scoreMiddleCandidates(input: {
  compactBlocks: StoredContextBlock[];
  db: BetterSqlite3.Database;
  embeddingProvider: EmbeddingProvider;
  exactItems: SourceItemWithTurn[];
  openQuestionItems: SourceItemWithTurn[];
  recentItems: AssembledContextItem[];
  request: AssembleContextInput;
  sourceItemsById: Map<string, SourceItemWithTurn>;
  threadId: string;
}): Promise<ScoredMiddleCandidate[]> {
  const candidates = createMiddleCandidates(input);
  const hasRequestedRanking =
    input.request.task !== undefined || input.request.scope !== undefined;
  const queryText = hasRequestedRanking
    ? [
        input.request.task,
        input.request.scope,
        ...input.recentItems.map((item) => item.text),
      ]
        .filter((value): value is string => value !== undefined)
        .join("\n")
    : "";
  const rankingCandidates: AssemblyRankingCandidate[] = candidates.map(
    (candidate) => ({
      key: middleCandidateKey(candidate),
      entityType: candidate.entityType,
      entityId: candidate.entityId,
      textKind: candidate.textKind,
      text: candidate.item.text,
      labels: candidate.labels,
      turnIndex: candidate.turnIndex,
    }),
  );
  const scores = await rankAssemblyCandidates({
    candidates: rankingCandidates,
    db: input.db,
    embeddingProvider: input.embeddingProvider,
    queryText,
    threadId: input.threadId,
  });

  return candidates.map((candidate) => {
    const ranking = scores.get(middleCandidateKey(candidate)) ?? {
      score: 0,
      reasons: ["deterministic order"],
    };

    return {
      ...candidate,
      score: ranking.score,
      reasons: ranking.reasons,
    };
  });
}

function createMiddleCandidates(input: {
  compactBlocks: StoredContextBlock[];
  exactItems: SourceItemWithTurn[];
  openQuestionItems: SourceItemWithTurn[];
  sourceItemsById: Map<string, SourceItemWithTurn>;
}): MiddleCandidate[] {
  const candidates: MiddleCandidate[] = [];
  let baseOrder = 0;

  for (const item of input.exactItems) {
    candidates.push({
      baseOrder,
      entityId: item.sourceItemId,
      entityType: "source_item",
      item: createExactSourceItem(item, "preserve exact source item"),
      labels: item.labels,
      sectionKind: "exact_source_items",
      textKind: "source_item_exact",
      turnIndex: item.turnIndex,
    });
    baseOrder += 1;
  }

  for (const item of input.openQuestionItems) {
    candidates.push({
      baseOrder,
      entityId: item.sourceItemId,
      entityType: "source_item",
      item: createExactSourceItem(item, "open question preserved exactly"),
      labels: item.labels,
      sectionKind: "open_questions",
      textKind: "source_item_exact",
      turnIndex: item.turnIndex,
    });
    baseOrder += 1;
  }

  for (const block of input.compactBlocks) {
    const sourceItems = block.sourceItemIds
      .map((sourceItemId) => input.sourceItemsById.get(sourceItemId))
      .filter((item): item is SourceItemWithTurn => item !== undefined);
    const earliestTurnIndex =
      sourceItems.length > 0
        ? Math.min(...sourceItems.map((item) => item.turnIndex))
        : block.blockIndex;

    candidates.push({
      baseOrder,
      entityId: block.contextBlockId,
      entityType: "context_block",
      item: createContextBlockItem(block),
      labels: block.labels,
      sectionKind: "compacted_context_blocks",
      textKind: "context_block_summary",
      turnIndex: earliestTurnIndex,
    });
    baseOrder += 1;
  }

  return candidates;
}

function orderMiddleCandidates(
  candidates: ScoredMiddleCandidate[],
): ScoredMiddleCandidate[] {
  return [...candidates].sort(
    (left, right) =>
      right.score - left.score ||
      sectionOrderIndex(left.sectionKind) -
        sectionOrderIndex(right.sectionKind) ||
      left.baseOrder - right.baseOrder ||
      left.entityId.localeCompare(right.entityId),
  );
}

function sectionOrderIndex(kind: AssembledContextSection["kind"]): number {
  return SECTION_ORDER.indexOf(kind);
}

function includeRenderedItem(input: {
  estimatedTokens: number;
  item: AssembledContextItem;
  renderedRegistry: RenderedRegistry;
  tokenBudget: number | undefined;
}): IncludeRenderedItemResult {
  const itemTokens = estimateTextTokens(input.item.text);

  if (
    input.tokenBudget !== undefined &&
    input.estimatedTokens + itemTokens > input.tokenBudget
  ) {
    return {
      included: false,
      estimatedTokens: itemTokens,
      omitReason: "omitted by budget or rank",
    };
  }

  if (!registerRenderedItem(input.renderedRegistry, input.item)) {
    return {
      included: false,
      estimatedTokens: itemTokens,
      omitReason: "duplicate rendered item",
    };
  }

  return {
    included: true,
    estimatedTokens: itemTokens,
  };
}

function middleCandidateKey(candidate: MiddleCandidate): string {
  return `${candidate.entityType}:${candidate.entityId}:${candidate.textKind}`;
}

function finalizeReceiptItems(
  receiptItems: ReceiptItemDraft[],
): AssemblyReceipt["items"] {
  return receiptItems.map((item, itemIndex) => {
    const receiptItem: AssemblyReceipt["items"][number] = {
      itemIndex,
      entityType: item.entityType,
      entityId: item.entityId,
      sectionKind: item.sectionKind,
      included: item.included,
      estimatedTokens: item.estimatedTokens,
      score: item.score,
      reasons: item.reasons,
    };

    if (item.omitReason !== undefined) {
      receiptItem.omitReason = item.omitReason;
    }

    return receiptItem;
  });
}

function normalizeActiveTurn(activeTurn: number): number {
  if (!Number.isInteger(activeTurn) || activeTurn <= 0) {
    throw new Error("activeTurn must be a positive integer");
  }

  return activeTurn;
}

function normalizeTokenBudget(
  tokenBudget: number | undefined,
): number | undefined {
  if (tokenBudget === undefined) {
    return undefined;
  }

  if (!Number.isFinite(tokenBudget) || tokenBudget <= 0) {
    throw new Error("tokenBudget must be a positive number");
  }

  return tokenBudget;
}

function normalizeAssemblyCreatedAt(createdAt: Date | string): string {
  const date = createdAt instanceof Date ? createdAt : new Date(createdAt);

  if (Number.isNaN(date.getTime())) {
    throw new Error("assembly createdAt must be a valid date");
  }

  return date.toISOString();
}

function listThreadTurnsWithMediaType(
  db: BetterSqlite3.Database,
  threadId: string,
): TranscriptTurnWithMediaType[] {
  const rows = db
    .prepare<
      [string],
      TranscriptTurnRow & {
        media_type: string;
      }
    >(
      `SELECT
        transcript_turns.turn_id,
        transcript_turns.thread_id,
        transcript_turns.turn_index,
        transcript_turns.turn_role,
        transcript_turns.raw_pointer_id,
        transcript_turns.source_item_ids,
        transcript_turns.derived_context_block_ids,
        transcript_turns.created_at,
        raw_blobs.media_type
      FROM transcript_turns
      INNER JOIN raw_blobs
        ON raw_blobs.raw_pointer_id = transcript_turns.raw_pointer_id
      WHERE transcript_turns.thread_id = ?
      ORDER BY transcript_turns.turn_index ASC`,
    )
    .all(threadId);

  return rows.map((row) => ({
    ...mapTranscriptTurnRow(row),
    mediaType: row.media_type,
  }));
}

function listThreadSourceItemsWithTurn(
  db: BetterSqlite3.Database,
  threadId: string,
): SourceItemWithTurn[] {
  const rows = db
    .prepare<[string], SourceItemWithTurnRow>(
      `SELECT
        source_items.source_item_id,
        source_items.turn_id,
        source_items.item_index,
        source_items.raw_pointer_id,
        source_items.raw_start_byte_offset,
        source_items.raw_end_byte_offset,
        source_items.rendered_excerpt,
        source_items.context_action,
        source_items.action_reason,
        source_items.created_at,
        transcript_turns.turn_index
      FROM source_items
      INNER JOIN transcript_turns
        ON transcript_turns.turn_id = source_items.turn_id
      WHERE transcript_turns.thread_id = ?
      ORDER BY transcript_turns.turn_index ASC, source_items.item_index ASC`,
    )
    .all(threadId);
  const labelsByItemId = getSourceLabels(
    db,
    rows.map((row) => row.source_item_id),
  );

  return rows.map((row) => ({
    ...mapSourceItemRow(row, labelsByItemId),
    turnIndex: row.turn_index,
  }));
}

function getSourceLabels(
  db: BetterSqlite3.Database,
  sourceItemIds: string[],
): Map<string, SourceLabel[]> {
  const labelsByItemId = new Map<string, SourceLabel[]>();

  for (const sourceItemId of sourceItemIds) {
    labelsByItemId.set(sourceItemId, []);
  }

  if (sourceItemIds.length === 0) {
    return labelsByItemId;
  }

  const placeholders = sourceItemIds.map(() => "?").join(", ");
  const rows = db
    .prepare<unknown[], SourceLabelRow>(
      `SELECT
        source_item_id,
        label
      FROM source_labels
      WHERE source_item_id IN (${placeholders})
      ORDER BY source_item_id ASC, label_index ASC, label ASC`,
    )
    .all(...sourceItemIds);

  for (const row of rows) {
    labelsByItemId
      .get(row.source_item_id)
      ?.push(normalizeSourceLabel(row.label));
  }

  return labelsByItemId;
}

async function createFullTurnItems(
  turns: TranscriptTurnWithMediaType[],
  kind: "anchor" | "recent",
  readTurnRaw: (turnId: string) => Promise<Uint8Array>,
): Promise<AssembledContextItem[]> {
  return Promise.all(
    turns.map(async (turn) => {
      const raw = await readTurnRaw(turn.turnId);
      const rawBuffer = Buffer.from(raw);
      const text =
        isUtf8TextMediaType(turn.mediaType) && isUtf8(rawBuffer)
          ? new TextDecoder("utf-8").decode(rawBuffer)
          : formatNonTextPlaceholder(turn.mediaType, raw.byteLength);

      return {
        id: `turn:${turn.turnId}`,
        sourceType: "turn",
        text,
        reason:
          kind === "anchor"
            ? "full transcript anchor"
            : "recent full transcript turn",
        turnId: turn.turnId,
        turnIndex: turn.turnIndex,
      } satisfies AssembledContextItem;
    }),
  );
}

function createExactSourceItem(
  item: SourceItemWithTurn,
  reason: string,
): AssembledContextItem {
  return {
    id: `source_item:${item.sourceItemId}`,
    sourceType: "source_item",
    text: item.renderedExcerpt,
    reason,
    labels: item.labels,
    turnId: item.turnId,
    turnIndex: item.turnIndex,
    sourceItemIds: [item.sourceItemId],
  };
}

function createContextBlockItem(
  block: StoredContextBlock,
): AssembledContextItem {
  return {
    id: `context_block:${block.contextBlockId}`,
    sourceType: "context_block",
    text: block.summary,
    reason: "context block for compact source items",
    labels: block.labels,
    sourceItemIds: block.sourceItemIds,
    contextBlockId: block.contextBlockId,
  };
}

function buildExpandableItems(input: {
  contextBlocks: StoredContextBlock[];
  exactItems: SourceItemWithTurn[];
  openQuestionItems: SourceItemWithTurn[];
  sourceItemsById: Map<string, SourceItemWithTurn>;
  uncoveredCompactItems: SourceItemWithTurn[];
}): AssembledContextItem[] {
  const items = [
    ...input.exactItems.map((item) =>
      createExpandableSourceItem({
        detail: "Already included exactly; raw source can be expanded by ID.",
        item,
        reason: "expandable exact source reference",
      }),
    ),
    ...input.openQuestionItems.map((item) =>
      createExpandableSourceItem({
        detail:
          "Already included as an open question; raw source can be expanded by ID.",
        item,
        reason: "expandable open question reference",
      }),
    ),
    ...input.contextBlocks.flatMap((block) =>
      block.sourceItemIds.flatMap((sourceItemId) => {
        const item = input.sourceItemsById.get(sourceItemId);

        return item
          ? [
              createExpandableSourceItem({
                contextBlockId: block.contextBlockId,
                detail: `Covered by context block ${block.contextBlockId}; raw source can be expanded by ID.`,
                item,
                reason:
                  "expandable compact source reference covered by a context block",
              }),
            ]
          : [];
      }),
    ),
    ...input.uncoveredCompactItems.map((item) =>
      createExpandableSourceItem({
        detail:
          "No context block covered this compact source item; raw source can be expanded by ID.",
        item,
        reason: "expandable compact source reference with no context block",
      }),
    ),
  ];
  const seenIds = new Set<string>();

  return items.filter((item) => {
    if (seenIds.has(item.id)) {
      return false;
    }

    seenIds.add(item.id);
    return true;
  });
}

function createExpandableSourceItem(input: {
  contextBlockId?: string;
  detail: string;
  item: SourceItemWithTurn;
  reason: string;
}): AssembledContextItem {
  const labels =
    input.item.labels.length > 0
      ? ` Labels: ${input.item.labels.join(", ")}.`
      : "";
  const assembledItem: AssembledContextItem = {
    id: `expandable:${input.item.sourceItemId}`,
    sourceType: "source_item",
    text: `Source item ${input.item.sourceItemId} from turn ${input.item.turnIndex}. ${input.detail}${labels}`,
    reason: input.reason,
    labels: input.item.labels,
    turnId: input.item.turnId,
    turnIndex: input.item.turnIndex,
    sourceItemIds: [input.item.sourceItemId],
  };

  if (input.contextBlockId !== undefined) {
    assembledItem.contextBlockId = input.contextBlockId;
  }

  return assembledItem;
}

interface RenderedRegistry {
  seenIds: Set<string>;
  seenTexts: Set<string>;
}

function createRenderedRegistry(): RenderedRegistry {
  return {
    seenIds: new Set<string>(),
    seenTexts: new Set<string>(),
  };
}

function registerRenderedItem(
  registry: RenderedRegistry,
  item: AssembledContextItem,
): boolean {
  if (registry.seenIds.has(item.id)) {
    return false;
  }

  const normalizedText = normalizeRenderedText(item.text);

  if (normalizedText.length > 0 && registry.seenTexts.has(normalizedText)) {
    registry.seenIds.add(item.id);
    return false;
  }

  registry.seenIds.add(item.id);

  if (normalizedText.length > 0) {
    registry.seenTexts.add(normalizedText);
  }

  return true;
}

function normalizeRenderedText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function compareSourceItems(
  left: SourceItemWithTurn,
  right: SourceItemWithTurn,
): number {
  return (
    left.turnIndex - right.turnIndex ||
    left.itemIndex - right.itemIndex ||
    left.sourceItemId.localeCompare(right.sourceItemId)
  );
}

function compareContextBlocks(
  left: StoredContextBlock,
  right: StoredContextBlock,
): number {
  return (
    left.blockIndex - right.blockIndex ||
    left.contextBlockId.localeCompare(right.contextBlockId)
  );
}

function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function isUtf8TextMediaType(mediaType: string): boolean {
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

function formatNonTextPlaceholder(
  mediaType: string,
  byteLength: number,
): string {
  const placeholder = `[Non-text transcript content: ${mediaType}, ${byteLength} bytes]`;

  if (placeholder.length <= NON_TEXT_PLACEHOLDER_MAX_LENGTH) {
    return placeholder;
  }

  return `${placeholder.slice(0, NON_TEXT_PLACEHOLDER_MAX_LENGTH - 1)}]`;
}
