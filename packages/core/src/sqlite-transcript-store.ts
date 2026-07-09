import Database from "better-sqlite3";
import { isUtf8 } from "node:buffer";
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
import {
  captureTurnEventInTransaction,
  normalizeCaptureTurnEventInput,
} from "./sqlite-transcript-store/capture-events.js";
import { expandContextBlock as expandContextBlockFromStore } from "./sqlite-transcript-store/expansion.js";
import {
  createDefaultEmbeddingProvider,
  getAssemblyReceipt as getAssemblyReceiptFromDb,
  listThreadAssemblyReceipts as listThreadAssemblyReceiptsFromDb,
  listThreadRelationships as listThreadRelationshipsFromDb,
  refreshThreadSearchIndex as refreshThreadSearchIndexInDb,
  searchContext as searchContextInDb,
} from "./sqlite-transcript-store/retrieval.js";
import type { AppendTurnInTransactionInput } from "./sqlite-transcript-store/capture-events.js";
import type {
  AppendTranscriptTurnInput,
  AssembleContextInput,
  AssembledContextPacket,
  BuildContextBlocksInput,
  CaptureTurnEventInput,
  CaptureTurnEventReceipt,
  CreateTranscriptStoreOptions,
  EmbeddingProvider,
  ExpandContextBlockInput,
  ExpandedContextBlock,
  GetSessionStatusInput,
  ListRecentMessagesInput,
  ListSessionsInput,
  RawBlobPointer,
  SearchContextInput,
  SearchContextResult,
  SessionStatus,
  SourceLabel,
  StoredAssemblyReceipt,
  StoredContextBlock,
  StoredMessagePreview,
  StoredRelationship,
  StoredSessionSummary,
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
} from "./validation.js";

export async function createTranscriptStore(
  options: CreateTranscriptStoreOptions,
): Promise<TranscriptStore> {
  return new SqliteTranscriptStore(options);
}

interface SessionSummaryRow {
  thread_id: string;
  turn_count: number;
  latest_turn_index: number;
  context_block_count: number;
  assembly_receipt_count: number;
  processed_event_count: number;
  pending_tool_event_count: number;
  first_activity_at: string;
  latest_activity_at: string;
}

interface MessagePreviewRow extends TranscriptTurnRow, RawBlobRow {}

interface SessionSummaryPreviews {
  firstUserMessagePreview: StoredMessagePreview | null;
  latestUserMessagePreview: StoredMessagePreview | null;
}

const DEFAULT_RECENT_MESSAGE_LIMIT = 8;
const MAX_RECENT_MESSAGE_LIMIT = 50;
const DEFAULT_RECENT_MESSAGE_TEXT_LENGTH = 2000;
const DEFAULT_SESSION_PREVIEW_TEXT_LENGTH = 240;
const MAX_MESSAGE_PREVIEW_TEXT_LENGTH = 4000;

class SqliteTranscriptStore implements TranscriptStore {
  private readonly blobDir: string;
  private readonly clock: () => Date | string;
  private readonly db: BetterSqlite3.Database;
  private readonly embeddingProvider: EmbeddingProvider;
  private readonly sqlitePath: string;
  private isClosed = false;

  constructor(options: CreateTranscriptStoreOptions) {
    this.blobDir = path.resolve(options.blobDir);
    this.clock = options.clock ?? (() => new Date());
    this.embeddingProvider =
      options.embeddingProvider ?? createDefaultEmbeddingProvider();
    this.sqlitePath = path.resolve(options.sqlitePath);

    mkdirSync(path.dirname(this.sqlitePath), { recursive: true });
    mkdirSync(this.blobDir, { recursive: true });

    this.db = new Database(this.sqlitePath);
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
    const captureTransaction = this.db.transaction(() =>
      captureTurnEventInTransaction({
        appendTurnInTransaction: (turnInput) =>
          this.appendTurnInTransaction(turnInput),
        clock: this.clock,
        db: this.db,
        event,
      }),
    );

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
      await this.refreshThreadSearchIndex(input.threadId);

      return await assembleContextPacket({
        clock: this.clock,
        db: this.db,
        embeddingProvider: this.embeddingProvider,
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

    return expandContextBlockFromStore({
      getContextBlock: (contextBlockId) => this.getContextBlock(contextBlockId),
      getRawBlobById: (rawPointerId) => this.getRawBlobById(rawPointerId),
      getSourceItem: (sourceItemId) => this.getSourceItem(sourceItemId),
      getTurn: (turnId) => this.getTurn(turnId),
      readAndVerifyBlob: (pointer) => this.readAndVerifyBlob(pointer),
      request: input,
    });
  }

  async getContextBlock(
    contextBlockId: string,
  ): Promise<StoredContextBlock | undefined> {
    this.assertOpen();

    return getContextBlockById(this.db, contextBlockId);
  }

  async getAssemblyReceipt(
    assemblyId: string,
  ): Promise<StoredAssemblyReceipt | undefined> {
    this.assertOpen();

    return getAssemblyReceiptFromDb(this.db, assemblyId);
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

  async getSessionStatus(input: GetSessionStatusInput): Promise<SessionStatus> {
    this.assertOpen();

    const threadId = normalizeThreadId(input.threadId);
    const sessions = await this.listSessions();
    const session = sessions.find(
      (candidate) => candidate.threadId === threadId,
    );
    const [latestStoredMessagePreview] = await this.listRecentMessages({
      threadId,
      limit: 1,
      maxTextLength: DEFAULT_SESSION_PREVIEW_TEXT_LENGTH,
    });
    const pendingToolEventCount = session?.pendingToolEventCount ?? 0;

    return {
      threadId,
      storage: {
        sqlitePath: this.sqlitePath,
        blobDir: this.blobDir,
      },
      latestActivityAt: session?.latestActivityAt ?? null,
      turnCount: session?.turnCount ?? 0,
      processedEventCount: session?.processedEventCount ?? 0,
      pendingToolEventCount,
      latestStoredMessagePreview: latestStoredMessagePreview ?? null,
      captureState: {
        pendingToolEvents: pendingToolEventCount,
        hookTrustVerification: "not_checked",
        hookInstallVerification: "not_checked",
        doctorCommand: "tideline-context doctor codex",
      },
    };
  }

  async listRecentMessages(
    input: ListRecentMessagesInput,
  ): Promise<StoredMessagePreview[]> {
    this.assertOpen();

    const threadId = normalizeThreadId(input.threadId);
    const limit = normalizeRecentMessageLimit(input.limit);
    const maxTextLength = normalizeMessagePreviewTextLength(
      input.maxTextLength,
      DEFAULT_RECENT_MESSAGE_TEXT_LENGTH,
    );
    const rows = this.db
      .prepare<[string, number], MessagePreviewRow>(
        `SELECT
          transcript_turns.turn_id,
          transcript_turns.thread_id,
          transcript_turns.turn_index,
          transcript_turns.turn_role,
          transcript_turns.raw_pointer_id,
          transcript_turns.source_item_ids,
          transcript_turns.derived_context_block_ids,
          transcript_turns.created_at,
          raw_blobs.sha256,
          raw_blobs.byte_length,
          raw_blobs.media_type,
          raw_blobs.storage_kind,
          raw_blobs.storage_path
        FROM transcript_turns
        INNER JOIN raw_blobs
          ON raw_blobs.raw_pointer_id = transcript_turns.raw_pointer_id
        WHERE transcript_turns.thread_id = ?
        ORDER BY transcript_turns.turn_index DESC
        LIMIT ?`,
      )
      .all(threadId, limit);

    return rows
      .reverse()
      .map((row) => this.mapMessagePreviewRow(row, maxTextLength));
  }

  async listThreadContextBlocks(
    threadId: string,
  ): Promise<StoredContextBlock[]> {
    this.assertOpen();

    return listThreadContextBlocksInDb(this.db, threadId);
  }

  async listThreadAssemblyReceipts(
    threadId: string,
  ): Promise<StoredAssemblyReceipt[]> {
    this.assertOpen();

    return listThreadAssemblyReceiptsFromDb(this.db, threadId);
  }

  async listThreadRelationships(
    threadId: string,
  ): Promise<StoredRelationship[]> {
    this.assertOpen();

    return listThreadRelationshipsFromDb(this.db, threadId);
  }

  async listSessions(
    input: ListSessionsInput = {},
  ): Promise<StoredSessionSummary[]> {
    this.assertOpen();

    const limit = normalizeSessionListLimit(input.limit);
    const limitClause = limit === undefined ? "" : "LIMIT ?";
    const rows = this.db
      .prepare<[number?], SessionSummaryRow>(
        `WITH activity AS (
          SELECT thread_id, created_at FROM transcript_turns
          UNION ALL
          SELECT thread_id, created_at FROM context_blocks
          UNION ALL
          SELECT thread_id, created_at FROM assembly_receipts
          UNION ALL
          SELECT thread_id, created_at FROM hook_processed_events
          UNION ALL
          SELECT thread_id, created_at FROM hook_pending_tool_events
        ),
        activity_stats AS (
          SELECT
            thread_id,
            MIN(created_at) AS first_activity_at,
            MAX(created_at) AS latest_activity_at
          FROM activity
          GROUP BY thread_id
        ),
        turn_stats AS (
          SELECT
            thread_id,
            COUNT(*) AS turn_count,
            MAX(turn_index) AS latest_turn_index
          FROM transcript_turns
          GROUP BY thread_id
        ),
        context_block_stats AS (
          SELECT thread_id, COUNT(*) AS context_block_count
          FROM context_blocks
          GROUP BY thread_id
        ),
        assembly_receipt_stats AS (
          SELECT thread_id, COUNT(*) AS assembly_receipt_count
          FROM assembly_receipts
          GROUP BY thread_id
        ),
        processed_event_stats AS (
          SELECT thread_id, COUNT(*) AS processed_event_count
          FROM hook_processed_events
          GROUP BY thread_id
        ),
        pending_tool_event_stats AS (
          SELECT thread_id, COUNT(*) AS pending_tool_event_count
          FROM hook_pending_tool_events
          GROUP BY thread_id
        )
        SELECT
          activity_stats.thread_id,
          COALESCE(turn_stats.turn_count, 0) AS turn_count,
          COALESCE(turn_stats.latest_turn_index, 0) AS latest_turn_index,
          COALESCE(
            context_block_stats.context_block_count,
            0
          ) AS context_block_count,
          COALESCE(
            assembly_receipt_stats.assembly_receipt_count,
            0
          ) AS assembly_receipt_count,
          COALESCE(
            processed_event_stats.processed_event_count,
            0
          ) AS processed_event_count,
          COALESCE(
            pending_tool_event_stats.pending_tool_event_count,
            0
          ) AS pending_tool_event_count,
          activity_stats.first_activity_at,
          activity_stats.latest_activity_at
        FROM activity_stats
        LEFT JOIN turn_stats
          ON turn_stats.thread_id = activity_stats.thread_id
        LEFT JOIN context_block_stats
          ON context_block_stats.thread_id = activity_stats.thread_id
        LEFT JOIN assembly_receipt_stats
          ON assembly_receipt_stats.thread_id = activity_stats.thread_id
        LEFT JOIN processed_event_stats
          ON processed_event_stats.thread_id = activity_stats.thread_id
        LEFT JOIN pending_tool_event_stats
          ON pending_tool_event_stats.thread_id = activity_stats.thread_id
        ORDER BY activity_stats.latest_activity_at DESC, activity_stats.thread_id ASC
        ${limitClause}`,
      )
      .all(...(limit === undefined ? [] : [limit]));

    return rows.map((row) =>
      mapSessionSummaryRow(row, {
        firstUserMessagePreview: this.getUserMessagePreview(
          row.thread_id,
          "ASC",
        ),
        latestUserMessagePreview: this.getUserMessagePreview(
          row.thread_id,
          "DESC",
        ),
      }),
    );
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

  async refreshThreadSearchIndex(threadId: string): Promise<void> {
    this.assertOpen();

    try {
      await refreshThreadSearchIndexInDb({
        clock: this.clock,
        db: this.db,
        embeddingProvider: this.embeddingProvider,
        threadId,
      });
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  async searchContext(input: SearchContextInput): Promise<SearchContextResult> {
    this.assertOpen();

    try {
      return await searchContextInDb({
        clock: this.clock,
        db: this.db,
        embeddingProvider: this.embeddingProvider,
        request: input,
      });
    } catch (error) {
      throw normalizeSqliteError(error);
    }
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

  private appendTurnInTransaction(
    input: AppendTurnInTransactionInput,
  ): StoredTranscriptTurn {
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

  private getUserMessagePreview(
    threadId: string,
    order: "ASC" | "DESC",
  ): StoredMessagePreview | null {
    const row = this.db
      .prepare<[string], MessagePreviewRow>(
        `SELECT
          transcript_turns.turn_id,
          transcript_turns.thread_id,
          transcript_turns.turn_index,
          transcript_turns.turn_role,
          transcript_turns.raw_pointer_id,
          transcript_turns.source_item_ids,
          transcript_turns.derived_context_block_ids,
          transcript_turns.created_at,
          raw_blobs.sha256,
          raw_blobs.byte_length,
          raw_blobs.media_type,
          raw_blobs.storage_kind,
          raw_blobs.storage_path
        FROM transcript_turns
        INNER JOIN raw_blobs
          ON raw_blobs.raw_pointer_id = transcript_turns.raw_pointer_id
        WHERE transcript_turns.thread_id = ?
          AND transcript_turns.turn_role = 'user'
        ORDER BY transcript_turns.turn_index ${order}
        LIMIT 1`,
      )
      .get(threadId);

    return row
      ? this.mapMessagePreviewRow(row, DEFAULT_SESSION_PREVIEW_TEXT_LENGTH)
      : null;
  }

  private mapMessagePreviewRow(
    row: MessagePreviewRow,
    maxTextLength: number,
  ): StoredMessagePreview {
    const preview = this.createMessagePreviewText(row, maxTextLength);

    return {
      text: preview.text,
      role: normalizeTurnRole(row.turn_role),
      turnIndex: row.turn_index,
      createdAt: row.created_at,
      truncated: preview.truncated,
    };
  }

  private createMessagePreviewText(
    row: MessagePreviewRow,
    maxTextLength: number,
  ): { text: string; truncated: boolean } {
    if (!isTextMediaType(row.media_type)) {
      return {
        text: createNonTextMessagePlaceholder(row.media_type),
        truncated: false,
      };
    }

    const raw = this.readAndVerifyBlob(mapRawBlobRow(row));

    if (!isUtf8(raw)) {
      return {
        text: createNonTextMessagePlaceholder(row.media_type),
        truncated: false,
      };
    }

    return truncateMessagePreviewText(
      Buffer.from(raw).toString("utf8"),
      maxTextLength,
    );
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

function normalizeSessionListLimit(
  limit: number | undefined,
): number | undefined {
  if (limit === undefined) {
    return undefined;
  }

  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("limit must be a positive integer");
  }

  return limit;
}

function normalizeRecentMessageLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_RECENT_MESSAGE_LIMIT;
  }

  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("limit must be a positive integer");
  }

  return Math.min(limit, MAX_RECENT_MESSAGE_LIMIT);
}

function normalizeMessagePreviewTextLength(
  maxTextLength: number | undefined,
  defaultMaxTextLength: number,
): number {
  if (maxTextLength === undefined) {
    return defaultMaxTextLength;
  }

  if (!Number.isInteger(maxTextLength) || maxTextLength <= 0) {
    throw new Error("maxTextLength must be a positive integer");
  }

  return Math.min(maxTextLength, MAX_MESSAGE_PREVIEW_TEXT_LENGTH);
}

function isTextMediaType(mediaType: string): boolean {
  const baseType = mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "";

  return (
    baseType.startsWith("text/") ||
    baseType === "application/json" ||
    baseType === "application/javascript" ||
    baseType === "application/xml" ||
    baseType === "application/x-ndjson" ||
    baseType.endsWith("+json") ||
    baseType.endsWith("+xml")
  );
}

function createNonTextMessagePlaceholder(mediaType: string): string {
  return `[non-text ${mediaType.split(";", 1)[0]?.trim() ?? mediaType}]`;
}

function truncateMessagePreviewText(
  text: string,
  maxTextLength: number,
): { text: string; truncated: boolean } {
  if (text.length <= maxTextLength) {
    return { text, truncated: false };
  }

  if (maxTextLength <= 3) {
    return {
      text: text.slice(0, maxTextLength),
      truncated: true,
    };
  }

  return {
    text: `${text.slice(0, maxTextLength - 3)}...`,
    truncated: true,
  };
}

function mapSessionSummaryRow(
  row: SessionSummaryRow,
  previews: SessionSummaryPreviews,
): StoredSessionSummary {
  return {
    threadId: row.thread_id,
    turnCount: row.turn_count,
    latestTurnIndex: row.latest_turn_index,
    nextActiveTurn: row.latest_turn_index + 1,
    contextBlockCount: row.context_block_count,
    assemblyReceiptCount: row.assembly_receipt_count,
    processedEventCount: row.processed_event_count,
    pendingToolEventCount: row.pending_tool_event_count,
    firstActivityAt: row.first_activity_at,
    latestActivityAt: row.latest_activity_at,
    firstUserMessagePreview: previews.firstUserMessagePreview,
    latestUserMessagePreview: previews.latestUserMessagePreview,
  };
}
