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
