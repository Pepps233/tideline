import {
  normalizeContextAction,
  normalizeTurnRole,
  parseJsonStringArray,
} from "../validation.js";
import type {
  StoredContextBlock,
  RawBlobPointer,
  SourceLabel,
  StoredSourceItem,
  StoredTranscriptTurn,
} from "../types.js";

export interface RawBlobRow {
  raw_pointer_id: string;
  sha256: string;
  byte_length: number;
  media_type: string;
  storage_kind: string;
  storage_path: string;
}

export interface TranscriptTurnRow {
  turn_id: string;
  thread_id: string;
  turn_index: number;
  turn_role: string;
  raw_pointer_id: string;
  source_item_ids: string;
  derived_context_block_ids: string;
  created_at: string;
}

export interface SourceItemRow {
  source_item_id: string;
  turn_id: string;
  item_index: number;
  raw_pointer_id: string;
  raw_start_byte_offset: number | null;
  raw_end_byte_offset: number | null;
  rendered_excerpt: string;
  context_action: string;
  action_reason: string;
  created_at: string;
}

export interface SourceLabelRow {
  source_item_id: string;
  label: string;
}

export interface ContextBlockRow {
  context_block_id: string;
  thread_id: string;
  block_index: number;
  summary: string;
  created_at: string;
}

export interface ContextBlockLabelRow {
  context_block_id: string;
  label: string;
}

export interface ContextBlockSourceItemRow {
  context_block_id: string;
  source_item_id: string;
}

export interface SqliteNextTurnIndexRow {
  next_turn_index: number;
}

export function mapRawBlobRow(row: RawBlobRow): RawBlobPointer {
  if (row.storage_kind !== "file") {
    throw new Error(
      `Unsupported raw blob storage kind ${row.storage_kind} for raw pointer ${row.raw_pointer_id}`,
    );
  }

  return {
    rawPointerId: row.raw_pointer_id,
    sha256: row.sha256,
    byteLength: row.byte_length,
    mediaType: row.media_type,
    storageKind: "file",
    storagePath: row.storage_path,
  };
}

export function mapTranscriptTurnRow(
  row: TranscriptTurnRow,
): StoredTranscriptTurn {
  return {
    turnId: row.turn_id,
    threadId: row.thread_id,
    turnIndex: row.turn_index,
    turnRole: normalizeTurnRole(row.turn_role),
    rawPointerId: row.raw_pointer_id,
    sourceItemIds: parseJsonStringArray(row.source_item_ids, "source_item_ids"),
    derivedContextBlockIds: parseJsonStringArray(
      row.derived_context_block_ids,
      "derived_context_block_ids",
    ),
    createdAt: row.created_at,
  };
}

export function mapSourceItemRow(
  row: SourceItemRow,
  labelsByItemId: Map<string, SourceLabel[]>,
): StoredSourceItem {
  return {
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
  };
}

export function mapContextBlockRow(
  row: ContextBlockRow,
  sourceItemIdsByBlockId: Map<string, string[]>,
  labelsByBlockId: Map<string, SourceLabel[]>,
): StoredContextBlock {
  return {
    contextBlockId: row.context_block_id,
    threadId: row.thread_id,
    blockIndex: row.block_index,
    summary: row.summary,
    sourceItemIds: sourceItemIdsByBlockId.get(row.context_block_id) ?? [],
    labels: labelsByBlockId.get(row.context_block_id) ?? [],
    createdAt: row.created_at,
  };
}
