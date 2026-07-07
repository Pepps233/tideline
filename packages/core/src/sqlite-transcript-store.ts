import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import type BetterSqlite3 from "better-sqlite3";

import { normalizeSqliteError, isNodeError } from "./errors.js";
import { hashBytes, readBlobFile, verifyExistingBlob } from "./raw-blobs.js";
import { normalizeSourceLabel } from "./source-items/labels.js";
import { createSourceItemDrafts } from "./source-items/index.js";
import type { SourceItemDraft } from "./source-items/index.js";
import { createSchema } from "./sqlite/schema.js";
import {
  mapContextBlockRow,
  mapRawBlobRow,
  mapSourceItemRow,
  mapTranscriptTurnRow,
} from "./sqlite/rows.js";
import type {
  ContextBlockLabelRow,
  ContextBlockRow,
  ContextBlockSourceItemRow,
  RawBlobRow,
  SourceItemRow,
  SourceLabelRow,
  SqliteNextTurnIndexRow,
  TranscriptTurnRow,
} from "./sqlite/rows.js";
import type {
  AppendTranscriptTurnInput,
  BuildContextBlocksInput,
  CreateTranscriptStoreOptions,
  RawBlobPointer,
  SourceLabel,
  StoredContextBlock,
  StoredSourceItem,
  StoredTranscriptTurn,
  TranscriptStore,
} from "./types.js";
import {
  normalizeCreatedAt,
  normalizeMediaType,
  normalizeRaw,
  normalizeThreadId,
  normalizeTurnRole,
  parseJsonStringArray,
} from "./validation.js";

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

export async function createTranscriptStore(
  options: CreateTranscriptStoreOptions,
): Promise<TranscriptStore> {
  return new SqliteTranscriptStore(options);
}

class SqliteTranscriptStore implements TranscriptStore {
  private readonly blobDir: string;
  private readonly clock: () => Date | string;
  private readonly db: BetterSqlite3.Database;
  private isClosed = false;

  constructor(options: CreateTranscriptStoreOptions) {
    this.blobDir = path.resolve(options.blobDir);
    this.clock = options.clock ?? (() => new Date());

    mkdirSync(path.dirname(options.sqlitePath), { recursive: true });
    mkdirSync(this.blobDir, { recursive: true });

    this.db = new Database(options.sqlitePath);
    this.configureDatabase();
    createSchema(this.db);
  }

  async appendTurn(
    input: AppendTranscriptTurnInput,
  ): Promise<StoredTranscriptTurn> {
    this.assertOpen();

    const threadId = normalizeThreadId(input.threadId);
    const turnRole = normalizeTurnRole(input.turnRole);
    const raw = normalizeRaw(input.raw);
    const mediaType = normalizeMediaType(input.mediaType, input.raw);
    const createdAt = normalizeCreatedAt(input.createdAt ?? this.clock());

    const appendTurnTransaction = this.db.transaction(() => {
      const rawPointer = this.getOrCreateRawBlob(raw, mediaType, createdAt);
      const turnIndex = this.nextTurnIndex(threadId);
      const turnId = randomUUID();
      const derivedContextBlockIds = "[]";

      this.db
        .prepare(
          `INSERT INTO transcript_turns (
            turn_id,
            thread_id,
            turn_index,
            turn_role,
            raw_pointer_id,
            source_item_ids,
            derived_context_block_ids,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          turnId,
          threadId,
          turnIndex,
          turnRole,
          rawPointer.rawPointerId,
          "[]",
          derivedContextBlockIds,
          createdAt,
        );

      const sourceItemDrafts = createSourceItemDrafts({
        mediaType,
        raw,
        turnRole,
      });
      const sourceItemIds = this.insertSourceItems({
        createdAt,
        drafts: sourceItemDrafts,
        rawPointerId: rawPointer.rawPointerId,
        turnId,
      });

      this.db
        .prepare(
          `UPDATE transcript_turns
          SET source_item_ids = ?
          WHERE turn_id = ?`,
        )
        .run(JSON.stringify(sourceItemIds), turnId);

      return {
        turnId,
        threadId,
        turnIndex,
        turnRole,
        rawPointerId: rawPointer.rawPointerId,
        sourceItemIds,
        derivedContextBlockIds: [],
        createdAt,
      };
    });

    try {
      return appendTurnTransaction.immediate();
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  async buildContextBlocks(
    input: BuildContextBlocksInput,
  ): Promise<StoredContextBlock[]> {
    this.assertOpen();

    if (!input || typeof input !== "object") {
      throw new Error("buildContextBlocks input is required");
    }

    const threadId = normalizeThreadId(input.threadId);
    const groups = this.normalizeContextBlockGroups(input.groups);
    const createdAt = normalizeCreatedAt(input.createdAt ?? this.clock());

    const buildTransaction = this.db.transaction(() => {
      const resolvedGroups = this.resolveContextBlockGroups(threadId, groups);
      const sortedGroups = resolvedGroups.sort(compareResolvedGroups);
      const contextBlockIds = sortedGroups.map((group) =>
        this.getOrCreateContextBlock(threadId, group, createdAt),
      );

      this.reindexThreadContextBlocks(threadId);

      const blocksById = this.getContextBlocksByIds(contextBlockIds);
      return contextBlockIds.map((contextBlockId) => {
        const block = blocksById.get(contextBlockId);

        if (!block) {
          throw new Error(`Context block not found: ${contextBlockId}`);
        }

        return block;
      });
    });

    try {
      return buildTransaction.immediate();
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  async getContextBlock(
    contextBlockId: string,
  ): Promise<StoredContextBlock | undefined> {
    this.assertOpen();

    return this.getContextBlockById(contextBlockId);
  }

  async getTurn(turnId: string): Promise<StoredTranscriptTurn | undefined> {
    this.assertOpen();

    const row = this.db
      .prepare<[string], TranscriptTurnRow>(
        `SELECT
          turn_id,
          thread_id,
          turn_index,
          turn_role,
          raw_pointer_id,
          source_item_ids,
          derived_context_block_ids,
          created_at
        FROM transcript_turns
        WHERE turn_id = ?`,
      )
      .get(turnId);

    return row ? mapTranscriptTurnRow(row) : undefined;
  }

  async listThreadContextBlocks(
    threadId: string,
  ): Promise<StoredContextBlock[]> {
    this.assertOpen();

    const normalizedThreadId = normalizeThreadId(threadId);
    const rows = this.db
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

    return this.mapContextBlockRows(rows);
  }

  async getSourceItem(
    sourceItemId: string,
  ): Promise<StoredSourceItem | undefined> {
    this.assertOpen();

    const row = this.db
      .prepare<[string], SourceItemRow>(
        `SELECT
          source_item_id,
          turn_id,
          item_index,
          raw_pointer_id,
          raw_start_byte_offset,
          raw_end_byte_offset,
          rendered_excerpt,
          context_action,
          action_reason,
          created_at
        FROM source_items
        WHERE source_item_id = ?`,
      )
      .get(sourceItemId);

    if (!row) {
      return undefined;
    }

    return mapSourceItemRow(row, this.getSourceLabels([sourceItemId]));
  }

  async listTurnSourceItems(turnId: string): Promise<StoredSourceItem[]> {
    this.assertOpen();

    const rows = this.db
      .prepare<[string], SourceItemRow>(
        `SELECT
          source_item_id,
          turn_id,
          item_index,
          raw_pointer_id,
          raw_start_byte_offset,
          raw_end_byte_offset,
          rendered_excerpt,
          context_action,
          action_reason,
          created_at
        FROM source_items
        WHERE turn_id = ?
        ORDER BY item_index ASC`,
      )
      .all(turnId);

    return this.mapSourceItemRows(rows);
  }

  async listThreadSourceItems(threadId: string): Promise<StoredSourceItem[]> {
    this.assertOpen();

    const normalizedThreadId = normalizeThreadId(threadId);
    const rows = this.db
      .prepare<[string], SourceItemRow>(
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
          source_items.created_at
        FROM source_items
        INNER JOIN transcript_turns
          ON transcript_turns.turn_id = source_items.turn_id
        WHERE transcript_turns.thread_id = ?
        ORDER BY transcript_turns.turn_index ASC, source_items.item_index ASC`,
      )
      .all(normalizedThreadId);

    return this.mapSourceItemRows(rows);
  }

  async listThreadTurns(threadId: string): Promise<StoredTranscriptTurn[]> {
    this.assertOpen();

    const normalizedThreadId = normalizeThreadId(threadId);
    const rows = this.db
      .prepare<[string], TranscriptTurnRow>(
        `SELECT
          turn_id,
          thread_id,
          turn_index,
          turn_role,
          raw_pointer_id,
          source_item_ids,
          derived_context_block_ids,
          created_at
        FROM transcript_turns
        WHERE thread_id = ?
        ORDER BY turn_index ASC`,
      )
      .all(normalizedThreadId);

    return rows.map(mapTranscriptTurnRow);
  }

  async readTurnRaw(turnId: string): Promise<Uint8Array> {
    this.assertOpen();

    const turn = await this.getTurn(turnId);
    if (!turn) {
      throw new Error(`Transcript turn not found: ${turnId}`);
    }

    const rawPointer = this.getRawBlobById(turn.rawPointerId);
    if (!rawPointer) {
      throw new Error(
        `Transcript turn ${turnId} has missing raw pointer ${turn.rawPointerId}`,
      );
    }

    return this.readAndVerifyBlob(rawPointer);
  }

  async close(): Promise<void> {
    if (!this.isClosed) {
      this.db.close();
      this.isClosed = true;
    }
  }

  private configureDatabase(): void {
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
  }

  private normalizeContextBlockGroups(
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
        throw new Error(
          `groups[${groupIndex}].sourceItemIds must not be empty`,
        );
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

  private resolveContextBlockGroups(
    threadId: string,
    groups: string[][],
  ): ResolvedContextBlockGroup[] {
    const sourceItemIds = [...new Set(groups.flat())];
    const sourceItemsById = this.getSourceItemsWithTurn(sourceItemIds);

    return groups.map((group) => {
      const sourceItems = group.map((sourceItemId) => {
        const sourceItem = sourceItemsById.get(sourceItemId);

        if (!sourceItem) {
          throw new Error(
            `Context block source item not found: ${sourceItemId}`,
          );
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
      const sourceItemIds = canonicalSourceItems.map(
        (sourceItem) => sourceItem.sourceItemId,
      );
      const earliestSourceItem = canonicalSourceItems[0];

      if (!earliestSourceItem) {
        throw new Error("Context block source item group must not be empty");
      }

      return {
        sourceItems: canonicalSourceItems,
        sourceItemSignature: createSourceItemSignature(sourceItemIds),
        labels,
        summary: createContextBlockSummary(canonicalSourceItems, labels),
        earliestTurnIndex: earliestSourceItem.turnIndex,
        earliestItemIndex: earliestSourceItem.itemIndex,
      };
    });
  }

  private getSourceItemsWithTurn(
    sourceItemIds: string[],
  ): Map<string, ResolvedContextBlockSourceItem> {
    if (sourceItemIds.length === 0) {
      return new Map();
    }

    const placeholders = sourceItemIds.map(() => "?").join(", ");
    const rows = this.db
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
    const labelsByItemId = this.getSourceLabels(
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

  private getOrCreateContextBlock(
    threadId: string,
    group: ResolvedContextBlockGroup,
    createdAt: string,
  ): string {
    const existing = this.db
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
      this.updateSourceTurnReverseLookups(
        existing.context_block_id,
        group.sourceItems,
      );
      return existing.context_block_id;
    }

    const contextBlockId = randomUUID();
    const blockIndex = this.nextContextBlockIndex(threadId);

    this.db
      .prepare(
        `INSERT INTO context_blocks (
          context_block_id,
          thread_id,
          block_index,
          source_item_signature,
          summary,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        contextBlockId,
        threadId,
        blockIndex,
        group.sourceItemSignature,
        group.summary,
        createdAt,
      );

    const insertLabel = this.db.prepare(
      `INSERT INTO context_block_labels (
        context_block_id,
        label,
        label_index
      ) VALUES (?, ?, ?)`,
    );

    for (const [labelIndex, label] of group.labels.entries()) {
      insertLabel.run(contextBlockId, label, labelIndex);
    }

    const insertSourceLink = this.db.prepare(
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

    this.updateSourceTurnReverseLookups(contextBlockId, group.sourceItems);

    return contextBlockId;
  }

  private updateSourceTurnReverseLookups(
    contextBlockId: string,
    sourceItems: ResolvedContextBlockSourceItem[],
  ): void {
    const turnIds = [
      ...new Set(sourceItems.map((sourceItem) => sourceItem.turnId)),
    ];
    const selectTurn = this.db.prepare<
      [string],
      SqliteDerivedContextBlockIdsRow
    >(
      `SELECT derived_context_block_ids
      FROM transcript_turns
      WHERE turn_id = ?`,
    );
    const updateTurn = this.db.prepare<[string, string]>(
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

  private reindexThreadContextBlocks(threadId: string): void {
    const rows = this.db
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

    const setBlockIndex = this.db.prepare<[number, string]>(
      `UPDATE context_blocks
      SET block_index = ?
      WHERE context_block_id = ?`,
    );
    const firstTemporaryIndex = this.nextContextBlockIndex(threadId);

    for (const [index, row] of rows.entries()) {
      setBlockIndex.run(firstTemporaryIndex + index, row.context_block_id);
    }

    for (const [index, row] of rows.entries()) {
      setBlockIndex.run(index + 1, row.context_block_id);
    }
  }

  private nextContextBlockIndex(threadId: string): number {
    const row = this.db
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

  private getContextBlockById(
    contextBlockId: string,
  ): StoredContextBlock | undefined {
    const row = this.db
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

    return row ? this.mapContextBlockRows([row])[0] : undefined;
  }

  private getContextBlocksByIds(
    contextBlockIds: string[],
  ): Map<string, StoredContextBlock> {
    const uniqueContextBlockIds = [...new Set(contextBlockIds)];

    if (uniqueContextBlockIds.length === 0) {
      return new Map();
    }

    const placeholders = uniqueContextBlockIds.map(() => "?").join(", ");
    const rows = this.db
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
      this.mapContextBlockRows(rows).map((block) => [
        block.contextBlockId,
        block,
      ]),
    );
  }

  private mapContextBlockRows(rows: ContextBlockRow[]): StoredContextBlock[] {
    if (rows.length === 0) {
      return [];
    }

    const contextBlockIds = rows.map((row) => row.context_block_id);
    const sourceItemIdsByBlockId =
      this.getContextBlockSourceItemIds(contextBlockIds);
    const labelsByBlockId = this.getContextBlockLabels(contextBlockIds);

    return rows.map((row) =>
      mapContextBlockRow(row, sourceItemIdsByBlockId, labelsByBlockId),
    );
  }

  private getContextBlockSourceItemIds(
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
    const rows = this.db
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

  private getContextBlockLabels(
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
    const rows = this.db
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

  private mapSourceItemRows(rows: SourceItemRow[]): StoredSourceItem[] {
    if (rows.length === 0) {
      return [];
    }

    const labelsByItemId = this.getSourceLabels(
      rows.map((row) => row.source_item_id),
    );

    return rows.map((row) => mapSourceItemRow(row, labelsByItemId));
  }

  private getSourceLabels(sourceItemIds: string[]): Map<string, SourceLabel[]> {
    const labelsByItemId = new Map<string, SourceLabel[]>();

    for (const sourceItemId of sourceItemIds) {
      labelsByItemId.set(sourceItemId, []);
    }

    if (sourceItemIds.length === 0) {
      return labelsByItemId;
    }

    const placeholders = sourceItemIds.map(() => "?").join(", ");
    const rows = this.db
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

  private insertSourceItems(input: {
    createdAt: string;
    drafts: SourceItemDraft[];
    rawPointerId: string;
    turnId: string;
  }): string[] {
    const insertItem = this.db.prepare(
      `INSERT INTO source_items (
        source_item_id,
        turn_id,
        item_index,
        raw_pointer_id,
        raw_start_byte_offset,
        raw_end_byte_offset,
        rendered_excerpt,
        context_action,
        action_reason,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertLabel = this.db.prepare(
      `INSERT INTO source_labels (
        source_item_id,
        label,
        label_index
      ) VALUES (?, ?, ?)`,
    );
    const sourceItemIds: string[] = [];

    for (const [itemIndex, draft] of input.drafts.entries()) {
      const sourceItemId = randomUUID();

      insertItem.run(
        sourceItemId,
        input.turnId,
        itemIndex,
        input.rawPointerId,
        draft.rawStartByteOffset,
        draft.rawEndByteOffset,
        draft.renderedExcerpt,
        draft.contextAction,
        draft.actionReason,
        input.createdAt,
      );

      for (const [labelIndex, label] of draft.labels.entries()) {
        insertLabel.run(sourceItemId, label, labelIndex);
      }

      sourceItemIds.push(sourceItemId);
    }

    return sourceItemIds;
  }

  private getOrCreateRawBlob(
    raw: Buffer,
    mediaType: string,
    createdAt: string,
  ): RawBlobPointer {
    const sha256 = hashBytes(raw);
    const byteLength = raw.byteLength;
    const existing = this.db
      .prepare<[string, number, string], RawBlobRow>(
        `SELECT
          raw_pointer_id,
          sha256,
          byte_length,
          media_type,
          storage_kind,
          storage_path
        FROM raw_blobs
        WHERE sha256 = ? AND byte_length = ? AND media_type = ?`,
      )
      .get(sha256, byteLength, mediaType);

    if (existing) {
      const pointer = mapRawBlobRow(existing);
      this.readAndVerifyBlob(pointer);
      return pointer;
    }

    const storagePath = sha256;
    this.writeNewBlob(raw, storagePath, sha256, byteLength);

    const rawPointerId = randomUUID();
    this.db
      .prepare(
        `INSERT INTO raw_blobs (
          raw_pointer_id,
          sha256,
          byte_length,
          media_type,
          storage_kind,
          storage_path,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rawPointerId,
        sha256,
        byteLength,
        mediaType,
        "file",
        storagePath,
        createdAt,
      );

    return {
      rawPointerId,
      sha256,
      byteLength,
      mediaType,
      storageKind: "file",
      storagePath,
    };
  }

  private nextTurnIndex(threadId: string): number {
    const row = this.db
      .prepare<[string], SqliteNextTurnIndexRow>(
        `SELECT COALESCE(MAX(turn_index), 0) + 1 AS next_turn_index
        FROM transcript_turns
        WHERE thread_id = ?`,
      )
      .get(threadId);

    if (!row) {
      throw new Error(`Unable to assign turn index for threadId ${threadId}`);
    }

    return row.next_turn_index;
  }

  private getRawBlobById(rawPointerId: string): RawBlobPointer | undefined {
    const row = this.db
      .prepare<[string], RawBlobRow>(
        `SELECT
          raw_pointer_id,
          sha256,
          byte_length,
          media_type,
          storage_kind,
          storage_path
        FROM raw_blobs
        WHERE raw_pointer_id = ?`,
      )
      .get(rawPointerId);

    return row ? mapRawBlobRow(row) : undefined;
  }

  private readAndVerifyBlob(pointer: RawBlobPointer): Uint8Array {
    if (pointer.storageKind !== "file") {
      throw new Error(
        `Unsupported raw blob storage kind ${pointer.storageKind} for raw pointer ${pointer.rawPointerId}`,
      );
    }

    const blobPath = this.resolveBlobPath(pointer.storagePath);
    const bytes = readBlobFile(blobPath, pointer.rawPointerId);

    if (bytes.byteLength !== pointer.byteLength) {
      throw new Error(
        `Raw blob byte length mismatch for raw pointer ${pointer.rawPointerId}`,
      );
    }

    const actualSha = hashBytes(bytes);
    if (actualSha !== pointer.sha256) {
      throw new Error(
        `Raw blob SHA mismatch for raw pointer ${pointer.rawPointerId}`,
      );
    }

    return bytes;
  }

  private writeNewBlob(
    raw: Buffer,
    storagePath: string,
    expectedSha: string,
    expectedByteLength: number,
  ): void {
    const blobPath = this.resolveBlobPath(storagePath);

    try {
      writeFileSync(blobPath, raw, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        verifyExistingBlob(
          blobPath,
          storagePath,
          expectedSha,
          expectedByteLength,
        );
        return;
      }

      throw error;
    }
  }

  private resolveBlobPath(storagePath: string): string {
    const resolved = path.resolve(this.blobDir, storagePath);
    const relative = path.relative(this.blobDir, resolved);

    if (
      relative === "" ||
      relative.startsWith("..") ||
      path.isAbsolute(relative)
    ) {
      throw new Error(`Unsafe raw blob storage path: ${storagePath}`);
    }

    return resolved;
  }

  private assertOpen(): void {
    if (this.isClosed) {
      throw new Error("Transcript store is closed");
    }
  }
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
