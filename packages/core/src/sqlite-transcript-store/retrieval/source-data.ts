import type BetterSqlite3 from "better-sqlite3";

import { normalizeSourceLabel } from "../../source-items/labels.js";
import type { SourceLabel } from "../../types.js";
import { normalizeContextAction } from "../../validation.js";
import { listThreadContextBlocks } from "../context-blocks.js";
import type {
  ContextBlockWithText,
  SourceItemWithTurn,
  SourceItemWithTurnRow,
  SourceLabelRow,
} from "./types.js";

export function listContextBlocksWithText(
  db: BetterSqlite3.Database,
  threadId: string,
  sourceItemsById: Map<string, SourceItemWithTurn>,
): ContextBlockWithText[] {
  return listThreadContextBlocks(db, threadId).map((block) => {
    const sourceItems = block.sourceItemIds
      .map((sourceItemId) => sourceItemsById.get(sourceItemId))
      .filter((item): item is SourceItemWithTurn => item !== undefined);
    const sourceText = sourceItems
      .map((item) => item.renderedExcerpt)
      .join("\n");
    const earliestTurnIndex =
      sourceItems.length > 0
        ? Math.min(...sourceItems.map((item) => item.turnIndex))
        : block.blockIndex;

    return {
      ...block,
      earliestTurnIndex,
      searchableText: [block.summary, sourceText].filter(Boolean).join("\n"),
    };
  });
}

export function listThreadSourceItemsWithTurn(
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
        transcript_turns.thread_id,
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
    sourceItemId: row.source_item_id,
    turnId: row.turn_id,
    itemIndex: row.item_index,
    rawPointerId: row.raw_pointer_id,
    rawStartByteOffset: row.raw_start_byte_offset,
    rawEndByteOffset: row.raw_end_byte_offset,
    renderedExcerpt: row.rendered_excerpt,
    contextAction: normalizeContextAction(row.context_action),
    actionReason: row.action_reason,
    labels: labelsByItemId.get(row.source_item_id) ?? [],
    createdAt: row.created_at,
    threadId: row.thread_id,
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
    const labels = labelsByItemId.get(row.source_item_id);

    if (labels) {
      labels.push(normalizeSourceLabel(row.label));
    }
  }

  return labelsByItemId;
}
