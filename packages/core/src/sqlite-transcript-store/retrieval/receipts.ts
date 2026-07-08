import type BetterSqlite3 from "better-sqlite3";

import { parseJsonStringArray } from "../../validation.js";
import {
  normalizeAssemblyReceiptEntityType,
  normalizeAssemblyStatus,
  normalizeSectionKind,
} from "./normalizers.js";
import type {
  AssemblyReceipt,
  AssemblyReceiptItem,
  AssemblyReceiptItemRow,
  AssemblyReceiptRow,
  StoredAssemblyReceipt,
} from "./types.js";

export function insertAssemblyReceipt(
  db: BetterSqlite3.Database,
  receipt: AssemblyReceipt,
): void {
  db.transaction(() => {
    db.prepare(
      `INSERT INTO assembly_receipts (
        assembly_id,
        thread_id,
        active_turn,
        status,
        estimated_tokens,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      receipt.assemblyId,
      receipt.threadId,
      receipt.activeTurn,
      receipt.status,
      receipt.estimatedTokens,
      receipt.createdAt,
    );

    const insertItem = db.prepare(
      `INSERT INTO assembly_receipt_items (
        assembly_id,
        item_index,
        entity_type,
        entity_id,
        section_kind,
        included,
        estimated_tokens,
        score,
        reason_json,
        omit_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const item of receipt.items) {
      insertItem.run(
        receipt.assemblyId,
        item.itemIndex,
        item.entityType,
        item.entityId,
        item.sectionKind,
        item.included ? 1 : 0,
        item.estimatedTokens,
        item.score,
        JSON.stringify(item.reasons),
        item.omitReason ?? null,
      );
    }
  }).immediate();
}

export function getAssemblyReceipt(
  db: BetterSqlite3.Database,
  assemblyId: string,
): StoredAssemblyReceipt | undefined {
  if (typeof assemblyId !== "string" || assemblyId.trim().length === 0) {
    throw new Error("assemblyId must be a non-empty string");
  }

  const row = db
    .prepare<[string], AssemblyReceiptRow>(
      `SELECT
        assembly_id,
        thread_id,
        active_turn,
        status,
        estimated_tokens,
        created_at
      FROM assembly_receipts
      WHERE assembly_id = ?`,
    )
    .get(assemblyId);

  return row ? mapAssemblyReceiptRow(db, row) : undefined;
}

export function listThreadAssemblyReceipts(
  db: BetterSqlite3.Database,
  threadId: string,
): StoredAssemblyReceipt[] {
  const rows = db
    .prepare<[string], AssemblyReceiptRow>(
      `SELECT
        assembly_id,
        thread_id,
        active_turn,
        status,
        estimated_tokens,
        created_at
      FROM assembly_receipts
      WHERE thread_id = ?
      ORDER BY created_at ASC, assembly_id ASC`,
    )
    .all(threadId);

  return rows.map((row) => mapAssemblyReceiptRow(db, row));
}

function mapAssemblyReceiptRow(
  db: BetterSqlite3.Database,
  row: AssemblyReceiptRow,
): StoredAssemblyReceipt {
  const receipt: StoredAssemblyReceipt = {
    assemblyId: row.assembly_id,
    threadId: row.thread_id,
    activeTurn: row.active_turn,
    status: normalizeAssemblyStatus(row.status),
    includedFullTurnIds: [],
    middleTurnIds: [],
    exactSourceItemIds: [],
    contextBlockIds: [],
    discardedSourceItemIds: [],
    estimatedTokens: row.estimated_tokens,
    items: listAssemblyReceiptItems(db, row.assembly_id),
    createdAt: row.created_at,
  };

  for (const item of receipt.items) {
    if (!item.included) {
      continue;
    }

    if (item.entityType === "turn") {
      receipt.includedFullTurnIds.push(item.entityId);
    }

    if (
      item.entityType === "source_item" &&
      (item.sectionKind === "exact_source_items" ||
        item.sectionKind === "open_questions")
    ) {
      receipt.exactSourceItemIds.push(item.entityId);
    }

    if (
      item.entityType === "context_block" &&
      item.sectionKind === "compacted_context_blocks"
    ) {
      receipt.contextBlockIds.push(item.entityId);
    }
  }

  receipt.middleTurnIds = listReceiptMiddleTurnIds(db, row.assembly_id);
  receipt.discardedSourceItemIds = listReceiptDiscardedSourceItemIds(
    db,
    row.assembly_id,
  );

  return receipt;
}

function listAssemblyReceiptItems(
  db: BetterSqlite3.Database,
  assemblyId: string,
): AssemblyReceiptItem[] {
  const rows = db
    .prepare<[string], AssemblyReceiptItemRow>(
      `SELECT
        assembly_id,
        item_index,
        entity_type,
        entity_id,
        section_kind,
        included,
        estimated_tokens,
        score,
        reason_json,
        omit_reason
      FROM assembly_receipt_items
      WHERE assembly_id = ?
      ORDER BY item_index ASC`,
    )
    .all(assemblyId);

  return rows.map(mapAssemblyReceiptItemRow);
}

function listReceiptMiddleTurnIds(
  db: BetterSqlite3.Database,
  assemblyId: string,
): string[] {
  const rows = db
    .prepare<[string], { entity_id: string }>(
      `SELECT entity_id
      FROM assembly_receipt_items
      WHERE assembly_id = ?
        AND entity_type = 'turn'
        AND section_kind = 'expandable_sources'
        AND included = 0
        AND omit_reason = 'middle turn tracked'
      ORDER BY item_index ASC`,
    )
    .all(assemblyId);

  return rows.map((row) => row.entity_id);
}

function listReceiptDiscardedSourceItemIds(
  db: BetterSqlite3.Database,
  assemblyId: string,
): string[] {
  const rows = db
    .prepare<[string], { entity_id: string }>(
      `SELECT entity_id
      FROM assembly_receipt_items
      WHERE assembly_id = ?
        AND entity_type = 'source_item'
        AND section_kind = 'expandable_sources'
        AND included = 0
        AND omit_reason = 'discarded source item'
      ORDER BY item_index ASC`,
    )
    .all(assemblyId);

  return rows.map((row) => row.entity_id);
}

function mapAssemblyReceiptItemRow(
  row: AssemblyReceiptItemRow,
): AssemblyReceiptItem {
  const item: AssemblyReceiptItem = {
    itemIndex: row.item_index,
    entityType: normalizeAssemblyReceiptEntityType(row.entity_type),
    entityId: row.entity_id,
    sectionKind: normalizeSectionKind(row.section_kind),
    included: row.included === 1,
    estimatedTokens: row.estimated_tokens,
    score: row.score,
    reasons: parseJsonStringArray(row.reason_json, "reason_json"),
  };

  if (row.omit_reason !== null) {
    item.omitReason = row.omit_reason;
  }

  return item;
}
