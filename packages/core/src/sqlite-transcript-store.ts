import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
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
  mapRawBlobRow,
  mapSourceItemRow,
  mapTranscriptTurnRow,
} from "./sqlite/rows.js";
import type {
  RawBlobRow,
  SourceItemRow,
  SourceLabelRow,
  SqliteNextTurnIndexRow,
  TranscriptTurnRow,
} from "./sqlite/rows.js";
import {
  buildContextBlocksInTransaction,
  getContextBlockById,
  listThreadContextBlocks as listThreadContextBlocksInDb,
} from "./sqlite-transcript-store/context-blocks.js";
import { assembleContext as assembleContextPacket } from "./sqlite-transcript-store/assembly.js";
import type {
  AppendTranscriptTurnInput,
  AssembleContextInput,
  AssembledContextPacket,
  BuildContextBlocksInput,
  CaptureTurnEventInput,
  CaptureTurnEventKind,
  CaptureTurnEventReceipt,
  CreateTranscriptStoreOptions,
  ExpandContextBlockInput,
  ExpandedContextBlock,
  ExpandedContextBlockSource,
  RawBlobPointer,
  SourceLabel,
  StoredContextBlock,
  StoredSourceItem,
  StoredTranscriptTurn,
  TranscriptStore,
  TranscriptRole,
} from "./types.js";
import {
  normalizeCreatedAt,
  normalizeMediaType,
  normalizeRaw,
  normalizeThreadId,
  normalizeTurnRole,
} from "./validation.js";

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

    const appendTurnTransaction = this.db.transaction(() =>
      this.appendTurnInTransaction({
        createdAt,
        mediaType,
        raw,
        threadId,
        turnRole,
      }),
    );

    try {
      return appendTurnTransaction.immediate();
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  async captureTurnEvent(
    input: CaptureTurnEventInput,
  ): Promise<CaptureTurnEventReceipt> {
    this.assertOpen();

    const event = normalizeCaptureTurnEventInput(input);
    const captureTransaction = this.db.transaction(() => {
      const existingReceipt = this.getProcessedHookReceipt(event.eventId);

      if (existingReceipt) {
        return existingReceipt;
      }

      const appendedTurnIds: string[] = [];
      const flushedToolEventIds: string[] = [];
      let contextBlockIds: string[] = [];
      let compactionActiveTurn: number | undefined;

      switch (event.kind) {
        case "session_start":
          break;

        case "tool_result":
          this.insertPendingToolEvent(event);
          break;

        case "model_response_complete": {
          const messageText = extractModelResponseText(event.payload);
          const flushInput: {
            assistantText?: string;
            createdAt: string;
            threadId: string;
          } = {
            createdAt: event.createdAt,
            threadId: event.threadId,
          };

          if (messageText !== undefined) {
            flushInput.assistantText = messageText;
          }

          const flush = this.flushPendingToolEvents(flushInput);

          appendedTurnIds.push(...flush.appendedTurnIds);
          flushedToolEventIds.push(...flush.flushedToolEventIds);
          break;
        }

        case "prompt_submit": {
          const flush = this.flushPendingToolEvents({
            createdAt: event.createdAt,
            threadId: event.threadId,
          });
          const userTurn = this.appendTurnInTransaction({
            createdAt: event.createdAt,
            mediaType: "text/plain; charset=utf-8",
            raw: Buffer.from(extractPromptText(event.payload), "utf8"),
            threadId: event.threadId,
            turnRole: "user",
          });

          appendedTurnIds.push(...flush.appendedTurnIds, userTurn.turnId);
          flushedToolEventIds.push(...flush.flushedToolEventIds);
          compactionActiveTurn = userTurn.turnIndex;
          break;
        }

        case "session_stop": {
          const flush = this.flushPendingToolEvents({
            createdAt: event.createdAt,
            threadId: event.threadId,
          });
          const checkpointText = extractCheckpointText(event.payload);
          const checkpointTurn =
            checkpointText !== undefined
              ? this.appendTurnInTransaction({
                  createdAt: event.createdAt,
                  mediaType: "text/plain; charset=utf-8",
                  raw: Buffer.from(checkpointText, "utf8"),
                  threadId: event.threadId,
                  turnRole: "model",
                })
              : undefined;

          appendedTurnIds.push(...flush.appendedTurnIds);
          flushedToolEventIds.push(...flush.flushedToolEventIds);

          if (checkpointTurn) {
            appendedTurnIds.push(checkpointTurn.turnId);
            compactionActiveTurn = checkpointTurn.turnIndex;
          } else if (flush.lastTurnIndex !== undefined) {
            compactionActiveTurn = flush.lastTurnIndex;
          } else {
            compactionActiveTurn = this.latestTurnIndex(event.threadId) + 1;
          }

          break;
        }

        default:
          assertNever(event.kind);
      }

      if (compactionActiveTurn !== undefined) {
        contextBlockIds = this.compactEligibleSourceItems({
          activeTurn: compactionActiveTurn,
          createdAt: event.createdAt,
          threadId: event.threadId,
        });
      }

      const receipt = this.createCaptureReceipt({
        appendedTurnIds,
        contextBlockIds,
        event,
        flushedToolEventIds,
      });

      this.insertProcessedHookReceipt(receipt);
      return receipt;
    });

    try {
      return captureTransaction.immediate();
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  async assembleContext(
    input: AssembleContextInput,
  ): Promise<AssembledContextPacket> {
    this.assertOpen();

    try {
      return await assembleContextPacket({
        clock: this.clock,
        db: this.db,
        readTurnRaw: (turnId) => this.readTurnRaw(turnId),
        request: input,
      });
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  async buildContextBlocks(
    input: BuildContextBlocksInput,
  ): Promise<StoredContextBlock[]> {
    this.assertOpen();

    const buildTransaction = this.db.transaction(() =>
      buildContextBlocksInTransaction({
        clock: this.clock,
        db: this.db,
        request: input,
      }),
    );

    try {
      return buildTransaction.immediate();
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  async expandContextBlock(
    input: ExpandContextBlockInput,
  ): Promise<ExpandedContextBlock | undefined> {
    this.assertOpen();

    const tokenBudget = normalizeExpansionTokenBudget(input.tokenBudget);
    const contextBlock = await this.getContextBlock(input.contextBlockId);

    if (!contextBlock) {
      return undefined;
    }

    const sources: ExpandedContextBlockSource[] = [];
    let estimatedTokens = 0;
    let truncated = false;

    for (const sourceItemId of contextBlock.sourceItemIds) {
      const sourceItem = await this.getSourceItem(sourceItemId);

      if (!sourceItem) {
        throw new Error(`Context block source item not found: ${sourceItemId}`);
      }

      const turn = await this.getTurn(sourceItem.turnId);

      if (!turn) {
        throw new Error(`Source item turn not found: ${sourceItem.turnId}`);
      }

      const rawPointer = this.getRawBlobById(sourceItem.rawPointerId);

      if (!rawPointer) {
        throw new Error(
          `Source item ${sourceItem.sourceItemId} has missing raw pointer ${sourceItem.rawPointerId}`,
        );
      }

      const raw = this.readAndVerifyBlob(rawPointer);
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

  async getContextBlock(
    contextBlockId: string,
  ): Promise<StoredContextBlock | undefined> {
    this.assertOpen();

    return getContextBlockById(this.db, contextBlockId);
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

    return listThreadContextBlocksInDb(this.db, threadId);
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

  private appendTurnInTransaction(input: {
    createdAt: string;
    mediaType: string;
    raw: Buffer;
    threadId: string;
    turnRole: TranscriptRole;
  }): StoredTranscriptTurn {
    const rawPointer = this.getOrCreateRawBlob(
      input.raw,
      input.mediaType,
      input.createdAt,
    );
    const turnIndex = this.nextTurnIndex(input.threadId);
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
        input.threadId,
        turnIndex,
        input.turnRole,
        rawPointer.rawPointerId,
        "[]",
        derivedContextBlockIds,
        input.createdAt,
      );

    const sourceItemDrafts = createSourceItemDrafts({
      mediaType: input.mediaType,
      raw: input.raw,
      turnRole: input.turnRole,
    });
    const sourceItemIds = this.insertSourceItems({
      createdAt: input.createdAt,
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
      threadId: input.threadId,
      turnIndex,
      turnRole: input.turnRole,
      rawPointerId: rawPointer.rawPointerId,
      sourceItemIds,
      derivedContextBlockIds: [],
      createdAt: input.createdAt,
    };
  }

  private getProcessedHookReceipt(
    eventId: string,
  ): CaptureTurnEventReceipt | undefined {
    const row = this.db
      .prepare<[string], HookProcessedEventRow>(
        `SELECT receipt_json
        FROM hook_processed_events
        WHERE event_id = ?`,
      )
      .get(eventId);

    return row
      ? normalizeCaptureTurnEventReceipt(JSON.parse(row.receipt_json))
      : undefined;
  }

  private insertProcessedHookReceipt(receipt: CaptureTurnEventReceipt): void {
    this.db
      .prepare(
        `INSERT INTO hook_processed_events (
          event_id,
          thread_id,
          kind,
          receipt_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        receipt.eventId,
        receipt.threadId,
        receipt.kind,
        JSON.stringify(receipt),
        receipt.createdAt,
      );
  }

  private insertPendingToolEvent(event: NormalizedCaptureTurnEvent): void {
    this.db
      .prepare(
        `INSERT INTO hook_pending_tool_events (
          event_id,
          thread_id,
          created_at,
          payload_json
        ) VALUES (?, ?, ?, ?)`,
      )
      .run(
        event.eventId,
        event.threadId,
        event.createdAt,
        JSON.stringify(event.payload),
      );
  }

  private flushPendingToolEvents(input: {
    assistantText?: string;
    createdAt: string;
    threadId: string;
  }): {
    appendedTurnIds: string[];
    flushedToolEventIds: string[];
    lastTurnIndex?: number;
  } {
    const pendingToolEvents = this.listPendingToolEvents(input.threadId);
    const assistantText = input.assistantText?.trim();

    if (pendingToolEvents.length === 0 && !assistantText) {
      return {
        appendedTurnIds: [],
        flushedToolEventIds: [],
      };
    }

    const raw = formatModelTurn({
      assistantText,
      toolEvents: pendingToolEvents,
    });
    const turn = this.appendTurnInTransaction({
      createdAt: input.createdAt,
      mediaType: "text/plain; charset=utf-8",
      raw: Buffer.from(raw, "utf8"),
      threadId: input.threadId,
      turnRole: "model",
    });
    const flushedToolEventIds = pendingToolEvents.map((event) => event.eventId);

    if (flushedToolEventIds.length > 0) {
      this.deletePendingToolEvents(flushedToolEventIds);
    }

    return {
      appendedTurnIds: [turn.turnId],
      flushedToolEventIds,
      lastTurnIndex: turn.turnIndex,
    };
  }

  private listPendingToolEvents(threadId: string): PendingToolEvent[] {
    const rows = this.db
      .prepare<[string], HookPendingToolEventRow>(
        `SELECT
          event_id,
          thread_id,
          created_at,
          payload_json
        FROM hook_pending_tool_events
        WHERE thread_id = ?
        ORDER BY created_at ASC, event_id ASC`,
      )
      .all(threadId);

    return rows.map((row) => ({
      eventId: row.event_id,
      threadId: row.thread_id,
      createdAt: row.created_at,
      payload: normalizeObjectPayload(JSON.parse(row.payload_json)),
    }));
  }

  private deletePendingToolEvents(eventIds: string[]): void {
    if (eventIds.length === 0) {
      return;
    }

    const placeholders = eventIds.map(() => "?").join(", ");

    this.db
      .prepare(
        `DELETE FROM hook_pending_tool_events
        WHERE event_id IN (${placeholders})`,
      )
      .run(...eventIds);
  }

  private compactEligibleSourceItems(input: {
    activeTurn: number;
    createdAt: string;
    threadId: string;
  }): string[] {
    const groups = this.listEligibleCompactGroups(
      input.threadId,
      input.activeTurn,
    );

    if (groups.length === 0) {
      return [];
    }

    const blocks = buildContextBlocksInTransaction({
      clock: this.clock,
      db: this.db,
      request: {
        threadId: input.threadId,
        groups: groups.map((sourceItemIds) => ({ sourceItemIds })),
        createdAt: input.createdAt,
      },
    });

    return blocks.map((block) => block.contextBlockId);
  }

  private listEligibleCompactGroups(
    threadId: string,
    activeTurn: number,
  ): string[][] {
    if (activeTurn < 6) {
      return [];
    }

    const rows = this.db
      .prepare<[string, number], EligibleCompactSourceItemRow>(
        `SELECT
          source_items.source_item_id,
          source_items.turn_id,
          source_items.item_index,
          transcript_turns.turn_index
        FROM source_items
        INNER JOIN transcript_turns
          ON transcript_turns.turn_id = source_items.turn_id
        WHERE transcript_turns.thread_id = ?
          AND transcript_turns.turn_index >= 4
          AND transcript_turns.turn_index <= ?
          AND source_items.context_action = 'compact'
          AND NOT EXISTS (
            SELECT 1
            FROM context_block_source_items
            WHERE context_block_source_items.source_item_id =
              source_items.source_item_id
          )
        ORDER BY transcript_turns.turn_index ASC, source_items.item_index ASC`,
      )
      .all(threadId, activeTurn - 2);
    const groups: string[][] = [];
    let currentGroup: string[] = [];
    let currentTurnId: string | undefined;
    let previousItemIndex: number | undefined;

    for (const row of rows) {
      const continuesGroup =
        currentTurnId === row.turn_id &&
        previousItemIndex !== undefined &&
        row.item_index === previousItemIndex + 1;

      if (!continuesGroup && currentGroup.length > 0) {
        groups.push(currentGroup);
        currentGroup = [];
      }

      currentGroup.push(row.source_item_id);
      currentTurnId = row.turn_id;
      previousItemIndex = row.item_index;
    }

    if (currentGroup.length > 0) {
      groups.push(currentGroup);
    }

    return groups;
  }

  private createCaptureReceipt(input: {
    appendedTurnIds: string[];
    contextBlockIds: string[];
    event: NormalizedCaptureTurnEvent;
    flushedToolEventIds: string[];
  }): CaptureTurnEventReceipt {
    return {
      eventId: input.event.eventId,
      kind: input.event.kind,
      threadId: input.event.threadId,
      createdAt: input.event.createdAt,
      appendedTurnIds: input.appendedTurnIds,
      flushedToolEventIds: input.flushedToolEventIds,
      contextBlockIds: input.contextBlockIds,
      timeline: {
        turns: this.listThreadTurnsInTransaction(input.event.threadId),
        contextBlocks: listThreadContextBlocksInDb(
          this.db,
          input.event.threadId,
        ),
      },
    };
  }

  private listThreadTurnsInTransaction(
    threadId: string,
  ): StoredTranscriptTurn[] {
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
      .all(threadId);

    return rows.map(mapTranscriptTurnRow);
  }

  private latestTurnIndex(threadId: string): number {
    const row = this.db
      .prepare<[string], { latest_turn_index: number | null }>(
        `SELECT MAX(turn_index) AS latest_turn_index
        FROM transcript_turns
        WHERE thread_id = ?`,
      )
      .get(threadId);

    return row?.latest_turn_index ?? 0;
  }

  private configureDatabase(): void {
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
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

interface HookProcessedEventRow {
  receipt_json: string;
}

interface HookPendingToolEventRow {
  event_id: string;
  thread_id: string;
  created_at: string;
  payload_json: string;
}

interface EligibleCompactSourceItemRow {
  source_item_id: string;
  turn_id: string;
  item_index: number;
  turn_index: number;
}

interface NormalizedCaptureTurnEvent {
  eventId: string;
  kind: CaptureTurnEventKind;
  threadId: string;
  createdAt: string;
  payload: Record<string, unknown>;
}

interface PendingToolEvent {
  eventId: string;
  threadId: string;
  createdAt: string;
  payload: Record<string, unknown>;
}

const CAPTURE_TURN_EVENT_KINDS = new Set<string>([
  "session_start",
  "prompt_submit",
  "tool_result",
  "model_response_complete",
  "session_stop",
]);

function normalizeCaptureTurnEventInput(
  input: CaptureTurnEventInput,
): NormalizedCaptureTurnEvent {
  if (!input || typeof input !== "object") {
    throw new Error("captureTurnEvent input is required");
  }

  return {
    eventId: normalizeEventId(input.eventId),
    kind: normalizeCaptureTurnEventKind(input.kind),
    threadId: normalizeThreadId(input.threadId),
    createdAt: normalizeCreatedAt(input.createdAt),
    payload: normalizeObjectPayload(input.payload ?? {}),
  };
}

function normalizeCaptureTurnEventKind(kind: string): CaptureTurnEventKind {
  if (!CAPTURE_TURN_EVENT_KINDS.has(kind)) {
    throw new Error(`Unsupported capture event kind: ${kind}`);
  }

  return kind as CaptureTurnEventKind;
}

function normalizeEventId(eventId: string): string {
  if (typeof eventId !== "string" || eventId.trim().length === 0) {
    throw new Error("eventId must be a non-empty string");
  }

  return eventId;
}

function normalizeObjectPayload(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("payload must be an object");
  }

  return payload as Record<string, unknown>;
}

function normalizeCaptureTurnEventReceipt(
  value: unknown,
): CaptureTurnEventReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Stored hook receipt must be an object");
  }

  const receipt = value as CaptureTurnEventReceipt;

  normalizeEventId(receipt.eventId);
  normalizeCaptureTurnEventKind(receipt.kind);
  normalizeThreadId(receipt.threadId);
  normalizeCreatedAt(receipt.createdAt);

  if (
    !Array.isArray(receipt.appendedTurnIds) ||
    !Array.isArray(receipt.flushedToolEventIds) ||
    !Array.isArray(receipt.contextBlockIds) ||
    !receipt.timeline ||
    typeof receipt.timeline !== "object" ||
    !Array.isArray(receipt.timeline.turns) ||
    !Array.isArray(receipt.timeline.contextBlocks)
  ) {
    throw new Error("Stored hook receipt has an invalid shape");
  }

  return receipt;
}

function extractPromptText(payload: Record<string, unknown>): string {
  const text =
    stringField(payload, "prompt") ??
    stringField(payload, "text") ??
    textFromValue(payload.message);

  if (text === undefined || text.trim().length === 0) {
    throw new Error("prompt_submit payload.prompt must be a non-empty string");
  }

  return text;
}

function extractModelResponseText(
  payload: Record<string, unknown>,
): string | undefined {
  const message = payload.message;

  if (message && typeof message === "object" && !Array.isArray(message)) {
    const role = (message as Record<string, unknown>).role;

    if (role !== undefined && role !== "assistant" && role !== "model") {
      throw new Error("model response message role must be assistant or model");
    }
  }

  const text =
    textFromValue(message) ??
    stringField(payload, "response") ??
    stringField(payload, "content") ??
    stringField(payload, "text");

  return text && text.trim().length > 0 ? text : undefined;
}

function extractCheckpointText(
  payload: Record<string, unknown>,
): string | undefined {
  const text = textFromValue(payload.checkpoint);

  return text && text.trim().length > 0 ? text : undefined;
}

function textFromValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((item) => textFromValue(item))
      .filter((part): part is string => part !== undefined);

    return parts.length > 0 ? parts.join("\n") : undefined;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;

    return stringField(record, "content") ?? stringField(record, "text");
  }

  return undefined;
}

function stringField(
  record: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = record[field];

  return typeof value === "string" ? value : undefined;
}

function formatModelTurn(input: {
  assistantText: string | undefined;
  toolEvents: PendingToolEvent[];
}): string {
  const sections: string[] = [];

  if (input.assistantText && input.assistantText.trim().length > 0) {
    sections.push(input.assistantText.trim());
  }

  sections.push(...input.toolEvents.map(formatToolEvent));

  return sections.join("\n\n");
}

function formatToolEvent(event: PendingToolEvent): string {
  const toolName =
    stringField(event.payload, "tool_name") ??
    stringField(event.payload, "toolName") ??
    stringField(event.payload, "name") ??
    "unknown";
  const status = stringField(event.payload, "status") ?? "unknown";
  const output = stringifyToolOutput(event.payload.output);
  const section = [`Tool: ${toolName}`];
  const callId =
    stringField(event.payload, "call_id") ??
    stringField(event.payload, "callId");

  if (callId !== undefined && callId.trim().length > 0) {
    section.push(`Call ID: ${callId}`);
  }

  if (Object.hasOwn(event.payload, "input")) {
    section.push(codeFence("json", stringifyJson(event.payload.input)));
  }

  section.push(`Status: ${status}`);
  section.push(codeFence("text", output));

  return section.join("\n");
}

function stringifyJson(value: unknown): string {
  const json = JSON.stringify(value, null, 2);

  return json === undefined ? "null" : json;
}

function stringifyToolOutput(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  return stringifyJson(value);
}

function codeFence(language: "json" | "text", text: string): string {
  const body = text.endsWith("\n") ? text : `${text}\n`;
  const fence = body.includes("```") ? "````" : "```";

  return `${fence}${language}\n${body}${fence}`;
}

function assertNever(value: never): never {
  throw new Error(`Unsupported capture event kind: ${String(value)}`);
}

interface SourceExcerpt {
  excerpt: string;
  excerptStartByteOffset: number | null;
  excerptEndByteOffset: number | null;
  usedRenderedExcerpt: boolean;
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
