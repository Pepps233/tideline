import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";

import type BetterSqlite3 from "better-sqlite3";

import { normalizeSourceLabel } from "../source-items/labels.js";
import { mapContextBlockRow, mapSourceItemRow } from "../sqlite/rows.js";
import type {
  ContextBlockLabelRow,
  ContextBlockRow,
  ContextBlockSourceItemRow,
  SourceItemRow,
  SourceLabelRow,
} from "../sqlite/rows.js";
import type {
  BuildContextBlocksInput,
  SourceLabel,
  StoredContextBlock,
  StoredSourceItem,
} from "../types.js";
import {
  normalizeCreatedAt,
  normalizeThreadId,
  parseJsonStringArray,
} from "../validation.js";

interface SourceItemWithTurnRow extends SourceItemRow {
  thread_id: string;
  turn_index: number;
}

interface ResolvedContextBlockSourceItem extends StoredSourceItem {
  threadId: string;
  turnIndex: number;
}

interface ResolvedContextBlockGroup {
  sourceItems: ResolvedContextBlockSourceItem[];
  sourceItemSignature: string;
  labels: SourceLabel[];
  summary: string;
  earliestTurnIndex: number;
  earliestItemIndex: number;
}

interface SqliteNextContextBlockIndexRow {
  next_block_index: number;
}

interface SqliteContextBlockOrderRow {
  context_block_id: string;
}

interface SqliteDerivedContextBlockIdsRow {
  derived_context_block_ids: string;
}

export function buildContextBlocksInTransaction(input: {
  clock: () => Date | string;
  db: BetterSqlite3.Database;
  request: BuildContextBlocksInput;
}): StoredContextBlock[] {
  if (!input.request || typeof input.request !== "object") {
    throw new Error("buildContextBlocks input is required");
  }

  const threadId = normalizeThreadId(input.request.threadId);
  const groups = normalizeContextBlockGroups(input.request.groups);
  const createdAt = normalizeCreatedAt(
    input.request.createdAt ?? input.clock(),
  );
  const resolvedGroups = resolveContextBlockGroups(input.db, threadId, groups);
  const sortedGroups = resolvedGroups.sort(compareResolvedGroups);
  const contextBlockIds = sortedGroups.map((group) =>
    getOrCreateContextBlock(input.db, threadId, group, createdAt),
  );

  reindexThreadContextBlocks(input.db, threadId);

  const blocksById = getContextBlocksByIds(input.db, contextBlockIds);

  return contextBlockIds.map((contextBlockId) => {
    const block = blocksById.get(contextBlockId);

    if (!block) {
      throw new Error(`Context block not found: ${contextBlockId}`);
    }

    return block;
  });
}

export function getContextBlockById(
  db: BetterSqlite3.Database,
  contextBlockId: string,
): StoredContextBlock | undefined {
  const row = db
    .prepare<[string], ContextBlockRow>(
      `SELECT
        context_block_id,
        thread_id,
        block_index,
        summary,
        created_at
      FROM context_blocks
      WHERE context_block_id = ?`,
    )
    .get(contextBlockId);

  return row ? mapContextBlockRows(db, [row])[0] : undefined;
}

export function listThreadContextBlocks(
  db: BetterSqlite3.Database,
  threadId: string,
): StoredContextBlock[] {
  const normalizedThreadId = normalizeThreadId(threadId);
  const rows = db
    .prepare<[string], ContextBlockRow>(
      `SELECT
        context_block_id,
        thread_id,
        block_index,
        summary,
        created_at
      FROM context_blocks
      WHERE thread_id = ?
      ORDER BY block_index ASC, context_block_id ASC`,
    )
    .all(normalizedThreadId);

  return mapContextBlockRows(db, rows);
}

function normalizeContextBlockGroups(
  groups: BuildContextBlocksInput["groups"],
): string[][] {
  if (!Array.isArray(groups)) {
    throw new Error("groups is required and must be an array");
  }

  if (groups.length === 0) {
    throw new Error("groups must not be empty");
  }

  return groups.map((group, groupIndex) => {
    if (
      !group ||
      typeof group !== "object" ||
      !Array.isArray(group.sourceItemIds)
    ) {
      throw new Error(
        `groups[${groupIndex}].sourceItemIds is required and must be an array`,
      );
    }

    if (group.sourceItemIds.length === 0) {
      throw new Error(`groups[${groupIndex}].sourceItemIds must not be empty`);
    }

    const seenSourceItemIds = new Set<string>();

    return group.sourceItemIds.map((sourceItemId, sourceItemIndex) => {
      if (
        typeof sourceItemId !== "string" ||
        sourceItemId.trim().length === 0
      ) {
        throw new Error(
          `groups[${groupIndex}].sourceItemIds[${sourceItemIndex}] must be a non-empty string`,
        );
      }

      if (seenSourceItemIds.has(sourceItemId)) {
        throw new Error(
          `groups[${groupIndex}].sourceItemIds must not contain duplicate source item IDs`,
        );
      }

      seenSourceItemIds.add(sourceItemId);
      return sourceItemId;
    });
  });
}

function resolveContextBlockGroups(
  db: BetterSqlite3.Database,
  threadId: string,
  groups: string[][],
): ResolvedContextBlockGroup[] {
  const sourceItemIds = [...new Set(groups.flat())];
  const sourceItemsById = getSourceItemsWithTurn(db, sourceItemIds);

  return groups.map((group) => {
    const sourceItems = group.map((sourceItemId) => {
      const sourceItem = sourceItemsById.get(sourceItemId);

      if (!sourceItem) {
        throw new Error(`Context block source item not found: ${sourceItemId}`);
      }

      return sourceItem;
    });
    const groupThreadIds = new Set(
      sourceItems.map((sourceItem) => sourceItem.threadId),
    );

    if (groupThreadIds.size > 1) {
      throw new Error("Context block source item group mixes threads");
    }

    const sourceThreadId = sourceItems[0]?.threadId;

    if (!sourceThreadId) {
      throw new Error("Context block source item group must not be empty");
    }

    if (sourceThreadId !== threadId) {
      throw new Error(
        `Context block source item belongs to thread ${sourceThreadId}, not ${threadId}`,
      );
    }

    const nonCompactSourceItem = sourceItems.find(
      (sourceItem) => sourceItem.contextAction !== "compact",
    );

    if (nonCompactSourceItem) {
      throw new Error(
        `Context block source item ${nonCompactSourceItem.sourceItemId} must have contextAction compact`,
      );
    }

    const canonicalSourceItems = [...sourceItems].sort(compareSourceItems);
    const labels = collectContextBlockLabels(canonicalSourceItems);
    const canonicalSourceItemIds = canonicalSourceItems.map(
      (sourceItem) => sourceItem.sourceItemId,
    );
    const earliestSourceItem = canonicalSourceItems[0];

    if (!earliestSourceItem) {
      throw new Error("Context block source item group must not be empty");
    }

    return {
      sourceItems: canonicalSourceItems,
      sourceItemSignature: createSourceItemSignature(canonicalSourceItemIds),
      labels,
      summary: createContextBlockSummary(canonicalSourceItems, labels),
      earliestTurnIndex: earliestSourceItem.turnIndex,
      earliestItemIndex: earliestSourceItem.itemIndex,
    };
  });
}

function getSourceItemsWithTurn(
  db: BetterSqlite3.Database,
  sourceItemIds: string[],
): Map<string, ResolvedContextBlockSourceItem> {
  if (sourceItemIds.length === 0) {
    return new Map();
  }

  const placeholders = sourceItemIds.map(() => "?").join(", ");
  const rows = db
    .prepare<unknown[], SourceItemWithTurnRow>(
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
        transcript_turns.thread_id,
        transcript_turns.turn_index
      FROM source_items
      INNER JOIN transcript_turns
        ON transcript_turns.turn_id = source_items.turn_id
      WHERE source_items.source_item_id IN (${placeholders})`,
    )
    .all(...sourceItemIds);
  const labelsByItemId = getSourceLabels(
    db,
    rows.map((row) => row.source_item_id),
  );
  const sourceItemsById = new Map<string, ResolvedContextBlockSourceItem>();

  for (const row of rows) {
    const sourceItem = mapSourceItemRow(row, labelsByItemId);

    sourceItemsById.set(row.source_item_id, {
      ...sourceItem,
      threadId: row.thread_id,
      turnIndex: row.turn_index,
    });
  }

  return sourceItemsById;
}

function getOrCreateContextBlock(
  db: BetterSqlite3.Database,
  threadId: string,
  group: ResolvedContextBlockGroup,
  createdAt: string,
): string {
  const existing = db
    .prepare<
      [string, string],
      {
        context_block_id: string;
      }
    >(
      `SELECT context_block_id
      FROM context_blocks
      WHERE thread_id = ? AND source_item_signature = ?`,
    )
    .get(threadId, group.sourceItemSignature);

  if (existing) {
    updateSourceTurnReverseLookups(
      db,
      existing.context_block_id,
      group.sourceItems,
    );
    return existing.context_block_id;
  }

  const contextBlockId = randomUUID();
  const blockIndex = nextContextBlockIndex(db, threadId);

  db.prepare(
    `INSERT INTO context_blocks (
      context_block_id,
      thread_id,
      block_index,
      source_item_signature,
      summary,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    contextBlockId,
    threadId,
    blockIndex,
    group.sourceItemSignature,
    group.summary,
    createdAt,
  );

  const insertLabel = db.prepare(
    `INSERT INTO context_block_labels (
      context_block_id,
      label,
      label_index
    ) VALUES (?, ?, ?)`,
  );

  for (const [labelIndex, label] of group.labels.entries()) {
    insertLabel.run(contextBlockId, label, labelIndex);
  }

  const insertSourceLink = db.prepare(
    `INSERT INTO context_block_source_items (
      context_block_id,
      source_item_id,
      source_item_index
    ) VALUES (?, ?, ?)`,
  );

  for (const [sourceItemIndex, sourceItem] of group.sourceItems.entries()) {
    insertSourceLink.run(
      contextBlockId,
      sourceItem.sourceItemId,
      sourceItemIndex,
    );
  }

  updateSourceTurnReverseLookups(db, contextBlockId, group.sourceItems);

  return contextBlockId;
}

function updateSourceTurnReverseLookups(
  db: BetterSqlite3.Database,
  contextBlockId: string,
  sourceItems: ResolvedContextBlockSourceItem[],
): void {
  const turnIds = [
    ...new Set(sourceItems.map((sourceItem) => sourceItem.turnId)),
  ];
  const selectTurn = db.prepare<[string], SqliteDerivedContextBlockIdsRow>(
    `SELECT derived_context_block_ids
    FROM transcript_turns
    WHERE turn_id = ?`,
  );
  const updateTurn = db.prepare<[string, string]>(
    `UPDATE transcript_turns
    SET derived_context_block_ids = ?
    WHERE turn_id = ?`,
  );

  for (const turnId of turnIds) {
    const row = selectTurn.get(turnId);

    if (!row) {
      throw new Error(`Transcript turn not found: ${turnId}`);
    }

    const derivedContextBlockIds = parseJsonStringArray(
      row.derived_context_block_ids,
      "derived_context_block_ids",
    );

    if (!derivedContextBlockIds.includes(contextBlockId)) {
      derivedContextBlockIds.push(contextBlockId);
      updateTurn.run(JSON.stringify(derivedContextBlockIds), turnId);
    }
  }
}

function reindexThreadContextBlocks(
  db: BetterSqlite3.Database,
  threadId: string,
): void {
  const rows = db
    .prepare<[string], SqliteContextBlockOrderRow>(
      `SELECT context_blocks.context_block_id
      FROM context_blocks
      INNER JOIN context_block_source_items
        ON context_block_source_items.context_block_id =
          context_blocks.context_block_id
        AND context_block_source_items.source_item_index = 0
      INNER JOIN source_items
        ON source_items.source_item_id =
          context_block_source_items.source_item_id
      INNER JOIN transcript_turns
        ON transcript_turns.turn_id = source_items.turn_id
      WHERE context_blocks.thread_id = ?
      ORDER BY
        transcript_turns.turn_index ASC,
        source_items.item_index ASC,
        context_blocks.source_item_signature ASC`,
    )
    .all(threadId);

  if (rows.length === 0) {
    return;
  }

  const setBlockIndex = db.prepare<[number, string]>(
    `UPDATE context_blocks
    SET block_index = ?
    WHERE context_block_id = ?`,
  );
  const firstTemporaryIndex = nextContextBlockIndex(db, threadId);

  for (const [index, row] of rows.entries()) {
    setBlockIndex.run(firstTemporaryIndex + index, row.context_block_id);
  }

  for (const [index, row] of rows.entries()) {
    setBlockIndex.run(index + 1, row.context_block_id);
  }
}

function nextContextBlockIndex(
  db: BetterSqlite3.Database,
  threadId: string,
): number {
  const row = db
    .prepare<[string], SqliteNextContextBlockIndexRow>(
      `SELECT COALESCE(MAX(block_index), 0) + 1 AS next_block_index
      FROM context_blocks
      WHERE thread_id = ?`,
    )
    .get(threadId);

  if (!row) {
    throw new Error(
      `Unable to assign context block index for threadId ${threadId}`,
    );
  }

  return row.next_block_index;
}

function getContextBlocksByIds(
  db: BetterSqlite3.Database,
  contextBlockIds: string[],
): Map<string, StoredContextBlock> {
  const uniqueContextBlockIds = [...new Set(contextBlockIds)];

  if (uniqueContextBlockIds.length === 0) {
    return new Map();
  }

  const placeholders = uniqueContextBlockIds.map(() => "?").join(", ");
  const rows = db
    .prepare<unknown[], ContextBlockRow>(
      `SELECT
        context_block_id,
        thread_id,
        block_index,
        summary,
        created_at
      FROM context_blocks
      WHERE context_block_id IN (${placeholders})`,
    )
    .all(...uniqueContextBlockIds);

  return new Map(
    mapContextBlockRows(db, rows).map((block) => [block.contextBlockId, block]),
  );
}

function mapContextBlockRows(
  db: BetterSqlite3.Database,
  rows: ContextBlockRow[],
): StoredContextBlock[] {
  if (rows.length === 0) {
    return [];
  }

  const contextBlockIds = rows.map((row) => row.context_block_id);
  const sourceItemIdsByBlockId = getContextBlockSourceItemIds(
    db,
    contextBlockIds,
  );
  const labelsByBlockId = getContextBlockLabels(db, contextBlockIds);

  return rows.map((row) =>
    mapContextBlockRow(row, sourceItemIdsByBlockId, labelsByBlockId),
  );
}

function getContextBlockSourceItemIds(
  db: BetterSqlite3.Database,
  contextBlockIds: string[],
): Map<string, string[]> {
  const sourceItemIdsByBlockId = new Map<string, string[]>();

  for (const contextBlockId of contextBlockIds) {
    sourceItemIdsByBlockId.set(contextBlockId, []);
  }

  if (contextBlockIds.length === 0) {
    return sourceItemIdsByBlockId;
  }

  const placeholders = contextBlockIds.map(() => "?").join(", ");
  const rows = db
    .prepare<unknown[], ContextBlockSourceItemRow>(
      `SELECT
        context_block_id,
        source_item_id
      FROM context_block_source_items
      WHERE context_block_id IN (${placeholders})
      ORDER BY context_block_id ASC, source_item_index ASC`,
    )
    .all(...contextBlockIds);

  for (const row of rows) {
    const sourceItemIds = sourceItemIdsByBlockId.get(row.context_block_id);

    if (sourceItemIds) {
      sourceItemIds.push(row.source_item_id);
    }
  }

  return sourceItemIdsByBlockId;
}

function getContextBlockLabels(
  db: BetterSqlite3.Database,
  contextBlockIds: string[],
): Map<string, SourceLabel[]> {
  const labelsByBlockId = new Map<string, SourceLabel[]>();

  for (const contextBlockId of contextBlockIds) {
    labelsByBlockId.set(contextBlockId, []);
  }

  if (contextBlockIds.length === 0) {
    return labelsByBlockId;
  }

  const placeholders = contextBlockIds.map(() => "?").join(", ");
  const rows = db
    .prepare<unknown[], ContextBlockLabelRow>(
      `SELECT
        context_block_id,
        label
      FROM context_block_labels
      WHERE context_block_id IN (${placeholders})
      ORDER BY context_block_id ASC, label_index ASC, label ASC`,
    )
    .all(...contextBlockIds);

  for (const row of rows) {
    const labels = labelsByBlockId.get(row.context_block_id);

    if (labels) {
      labels.push(normalizeSourceLabel(row.label));
    }
  }

  return labelsByBlockId;
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
    const labels = labelsByItemId.get(row.source_item_id);

    if (labels) {
      labels.push(normalizeSourceLabel(row.label));
    }
  }

  return labelsByItemId;
}

function compareResolvedGroups(
  left: ResolvedContextBlockGroup,
  right: ResolvedContextBlockGroup,
): number {
  return (
    left.earliestTurnIndex - right.earliestTurnIndex ||
    left.earliestItemIndex - right.earliestItemIndex ||
    left.sourceItemSignature.localeCompare(right.sourceItemSignature)
  );
}

function compareSourceItems(
  left: ResolvedContextBlockSourceItem,
  right: ResolvedContextBlockSourceItem,
): number {
  return (
    left.turnIndex - right.turnIndex ||
    left.itemIndex - right.itemIndex ||
    left.sourceItemId.localeCompare(right.sourceItemId)
  );
}

function collectContextBlockLabels(
  sourceItems: ResolvedContextBlockSourceItem[],
): SourceLabel[] {
  const labels: SourceLabel[] = [];
  const seenLabels = new Set<SourceLabel>();

  for (const sourceItem of sourceItems) {
    for (const label of sourceItem.labels) {
      if (!seenLabels.has(label)) {
        seenLabels.add(label);
        labels.push(label);
      }
    }
  }

  return labels;
}

function createSourceItemSignature(sourceItemIds: string[]): string {
  return createHash("sha256")
    .update(JSON.stringify(sourceItemIds), "utf8")
    .digest("hex");
}

function createContextBlockSummary(
  sourceItems: ResolvedContextBlockSourceItem[],
  labels: SourceLabel[],
): string {
  const labelText =
    labels.length > 0
      ? formatList(labels.map((label) => label.replaceAll("_", " ")))
      : "compact transcript material";
  const excerpt = limitWords(
    normalizeSummaryText(
      sourceItems.map((sourceItem) => sourceItem.renderedExcerpt).join(" "),
    ),
    90,
  );
  const detailSentence =
    excerpt.length > 0
      ? `Key source detail: ${ensureSentenceEnd(excerpt)}`
      : "Key source detail is available through the linked source items.";
  let summary = [
    `This context block summarizes compact source items labeled ${labelText}.`,
    detailSentence,
    "The block keeps the active transcript smaller while preserving source links for expansion.",
  ].join(" ");

  if (countWords(summary) < 30) {
    summary = [
      summary,
      "It records enough detail for later continuation without copying every intermediate transcript sentence.",
    ].join(" ");
  }

  return ensureSentenceEnd(limitWords(summary, 150));
}

function normalizeSummaryText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function countWords(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

function limitWords(value: string, maxWords: number): string {
  const words = value.trim().split(/\s+/).filter(Boolean);

  if (words.length <= maxWords) {
    return words.join(" ");
  }

  return words.slice(0, maxWords).join(" ");
}

function ensureSentenceEnd(value: string): string {
  const trimmed = value.trim();

  if (/[.!?]$/u.test(trimmed)) {
    return trimmed;
  }

  return `${trimmed}.`;
}

function formatList(values: string[]): string {
  const first = values[0];

  if (values.length === 1) {
    return first ?? "";
  }

  if (values.length === 2) {
    return `${first ?? ""} and ${values[1] ?? ""}`;
  }

  return `${values.slice(0, -1).join(", ")}, and ${
    values[values.length - 1] ?? ""
  }`;
}
