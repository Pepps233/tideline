import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import type BetterSqlite3 from "better-sqlite3";

export type TranscriptRole = "user" | "model";

export type ContextAction = "preserve_exact" | "compact" | "discard";

export type SourceLabel =
  | "acceptance_criterion"
  | "api_name"
  | "code_reference"
  | "command"
  | "design_decision"
  | "error_message"
  | "exact_value"
  | "external_fact"
  | "file_output"
  | "file_path"
  | "open_question"
  | "project_convention"
  | "reasoning"
  | "rule"
  | "task_state"
  | "test_result"
  | "tool_output"
  | "user_instruction"
  | "exploration";

export interface StoredTranscriptTurn {
  turnId: string;
  threadId: string;
  turnIndex: number;
  turnRole: TranscriptRole;
  rawPointerId: string;
  sourceItemIds: string[];
  derivedContextBlockIds: string[];
  createdAt: string;
}

export interface RawBlobPointer {
  rawPointerId: string;
  sha256: string;
  byteLength: number;
  mediaType: string;
  storageKind: "file";
  storagePath: string;
}

export interface StoredSourceItem {
  sourceItemId: string;
  turnId: string;
  itemIndex: number;
  rawPointerId: string;
  rawStartByteOffset: number | null;
  rawEndByteOffset: number | null;
  renderedExcerpt: string;
  contextAction: ContextAction;
  actionReason: string;
  labels: SourceLabel[];
  createdAt: string;
}

export interface AppendTranscriptTurnInput {
  threadId: string;
  turnRole: TranscriptRole;
  raw: string | Uint8Array | ArrayBuffer;
  mediaType?: string;
  createdAt?: Date | string;
}

export interface TranscriptStore {
  appendTurn(input: AppendTranscriptTurnInput): Promise<StoredTranscriptTurn>;
  getTurn(turnId: string): Promise<StoredTranscriptTurn | undefined>;
  getSourceItem(sourceItemId: string): Promise<StoredSourceItem | undefined>;
  listTurnSourceItems(turnId: string): Promise<StoredSourceItem[]>;
  listThreadSourceItems(threadId: string): Promise<StoredSourceItem[]>;
  listThreadTurns(threadId: string): Promise<StoredTranscriptTurn[]>;
  readTurnRaw(turnId: string): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface CreateTranscriptStoreOptions {
  sqlitePath: string;
  blobDir: string;
  clock?: () => Date | string;
}

interface RawBlobRow {
  raw_pointer_id: string;
  sha256: string;
  byte_length: number;
  media_type: string;
  storage_kind: string;
  storage_path: string;
}

interface TranscriptTurnRow {
  turn_id: string;
  thread_id: string;
  turn_index: number;
  turn_role: string;
  raw_pointer_id: string;
  source_item_ids: string;
  derived_context_block_ids: string;
  created_at: string;
}

interface SourceItemRow {
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

interface SourceLabelRow {
  source_item_id: string;
  label: string;
}

interface SourceItemDraft {
  rawStartByteOffset: number | null;
  rawEndByteOffset: number | null;
  renderedExcerpt: string;
  contextAction: ContextAction;
  actionReason: string;
  labels: SourceLabel[];
}

interface TextRegion {
  startChar: number;
  endChar: number;
}

interface TextChunk extends TextRegion {
  fromLongRegion: boolean;
}

interface LineSpan {
  startChar: number;
  endChar: number;
  nextStartChar: number;
  text: string;
}

interface SqliteNextTurnIndexRow {
  next_turn_index: number;
}

const mediaTypeToken = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const mediaTypePattern = new RegExp(
  `^${mediaTypeToken}/${mediaTypeToken}(?: *; *${mediaTypeToken}=(?:${mediaTypeToken}|"[^"\\\\]*"))*$`,
);
const controlCharacterPattern = /[\u0000-\u001F\u007F]/u;

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
    this.createSchema();
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

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS raw_blobs (
        raw_pointer_id TEXT PRIMARY KEY,
        sha256 TEXT NOT NULL,
        byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
        media_type TEXT NOT NULL CHECK (length(media_type) > 0),
        storage_kind TEXT NOT NULL CHECK (storage_kind = 'file'),
        storage_path TEXT NOT NULL CHECK (length(storage_path) > 0),
        created_at TEXT NOT NULL,
        UNIQUE (sha256, byte_length, media_type)
      );

      CREATE TABLE IF NOT EXISTS transcript_turns (
        turn_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL CHECK (length(trim(thread_id)) > 0),
        turn_index INTEGER NOT NULL CHECK (turn_index > 0),
        turn_role TEXT NOT NULL CHECK (turn_role IN ('user', 'model')),
        raw_pointer_id TEXT NOT NULL,
        source_item_ids TEXT NOT NULL DEFAULT '[]'
          CHECK (
            json_valid(source_item_ids)
            AND json_type(source_item_ids) = 'array'
          ),
        derived_context_block_ids TEXT NOT NULL DEFAULT '[]'
          CHECK (
            json_valid(derived_context_block_ids)
            AND json_type(derived_context_block_ids) = 'array'
          ),
        created_at TEXT NOT NULL,
        UNIQUE (thread_id, turn_index),
        FOREIGN KEY (raw_pointer_id)
          REFERENCES raw_blobs(raw_pointer_id)
          ON UPDATE RESTRICT
          ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS transcript_turns_thread_order_idx
        ON transcript_turns(thread_id, turn_index);

      CREATE TABLE IF NOT EXISTS source_items (
        source_item_id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        item_index INTEGER NOT NULL CHECK (item_index >= 0),
        raw_pointer_id TEXT NOT NULL,
        raw_start_byte_offset INTEGER
          CHECK (raw_start_byte_offset IS NULL OR raw_start_byte_offset >= 0),
        raw_end_byte_offset INTEGER
          CHECK (raw_end_byte_offset IS NULL OR raw_end_byte_offset >= 0),
        rendered_excerpt TEXT NOT NULL,
        context_action TEXT NOT NULL
          CHECK (context_action IN ('preserve_exact', 'compact', 'discard')),
        action_reason TEXT NOT NULL CHECK (length(action_reason) > 0),
        created_at TEXT NOT NULL,
        UNIQUE (turn_id, item_index),
        CHECK (
          (
            raw_start_byte_offset IS NULL
            AND raw_end_byte_offset IS NULL
          )
          OR (
            raw_start_byte_offset IS NOT NULL
            AND raw_end_byte_offset IS NOT NULL
            AND raw_end_byte_offset > raw_start_byte_offset
          )
        ),
        FOREIGN KEY (turn_id)
          REFERENCES transcript_turns(turn_id)
          ON UPDATE RESTRICT
          ON DELETE RESTRICT,
        FOREIGN KEY (raw_pointer_id)
          REFERENCES raw_blobs(raw_pointer_id)
          ON UPDATE RESTRICT
          ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS source_items_turn_order_idx
        ON source_items(turn_id, item_index);

      CREATE INDEX IF NOT EXISTS source_items_raw_pointer_idx
        ON source_items(raw_pointer_id);

      CREATE TABLE IF NOT EXISTS source_labels (
        source_item_id TEXT NOT NULL,
        label TEXT NOT NULL CHECK (length(label) > 0),
        label_index INTEGER NOT NULL DEFAULT 0 CHECK (label_index >= 0),
        PRIMARY KEY (source_item_id, label),
        UNIQUE (source_item_id, label_index),
        FOREIGN KEY (source_item_id)
          REFERENCES source_items(source_item_id)
          ON UPDATE RESTRICT
          ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS source_labels_item_order_idx
        ON source_labels(source_item_id, label_index);
    `);
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

function normalizeThreadId(threadId: string): string {
  if (typeof threadId !== "string" || threadId.trim().length === 0) {
    throw new Error("threadId must be a non-empty string");
  }

  return threadId;
}

function normalizeTurnRole(turnRole: string): TranscriptRole {
  if (turnRole !== "user" && turnRole !== "model") {
    throw new Error("turnRole must be either user or model");
  }

  return turnRole;
}

function normalizeRaw(raw: string | Uint8Array | ArrayBuffer): Buffer {
  if (typeof raw === "string") {
    return Buffer.from(raw, "utf8");
  }

  if (raw instanceof Uint8Array) {
    return Buffer.from(raw);
  }

  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw);
  }

  throw new Error("raw must be text or bytes");
}

function normalizeMediaType(
  mediaType: string | undefined,
  raw: string | Uint8Array | ArrayBuffer,
): string {
  if (mediaType !== undefined) {
    const normalized = mediaType.trim();

    if (normalized.length === 0) {
      throw new Error("mediaType must not be empty");
    }

    if (
      controlCharacterPattern.test(normalized) ||
      !mediaTypePattern.test(normalized)
    ) {
      throw new Error("mediaType must be a valid media type");
    }

    return normalized;
  }

  return typeof raw === "string"
    ? "text/plain; charset=utf-8"
    : "application/octet-stream";
}

function normalizeCreatedAt(createdAt: Date | string): string {
  const date = createdAt instanceof Date ? createdAt : new Date(createdAt);

  if (Number.isNaN(date.getTime())) {
    throw new Error("createdAt must be a valid date");
  }

  return date.toISOString();
}

function createSourceItemDrafts(input: {
  mediaType: string;
  raw: Buffer;
  turnRole: TranscriptRole;
}): SourceItemDraft[] {
  if (!isTextMediaType(input.mediaType)) {
    return [
      {
        rawStartByteOffset: null,
        rawEndByteOffset: null,
        renderedExcerpt: boundedNonTextExcerpt(input.mediaType, input.raw),
        contextAction: "compact",
        actionReason: "compact:non_text",
        labels: ["file_output"],
      },
    ];
  }

  const text = input.raw.toString("utf8");
  const chunks = splitTextIntoChunks(text);
  const seenExcerpts = new Set<string>();

  if (chunks.length === 0) {
    return [
      {
        rawStartByteOffset: null,
        rawEndByteOffset: null,
        renderedExcerpt: "",
        contextAction: "discard",
        actionReason: "discard:empty",
        labels: [],
      },
    ];
  }

  return chunks.map((chunk) => {
    const renderedExcerpt = text.slice(chunk.startChar, chunk.endChar);
    const normalizedExcerpt = normalizeExcerptForDeduplication(renderedExcerpt);
    const isDuplicate =
      normalizedExcerpt.length > 0 && seenExcerpts.has(normalizedExcerpt);
    const labels = classifySourceLabels(renderedExcerpt, input.turnRole);
    const action = chooseContextAction({
      fromLongRegion: chunk.fromLongRegion,
      isDuplicate,
      labels,
      renderedExcerpt,
    });

    if (normalizedExcerpt.length > 0) {
      seenExcerpts.add(normalizedExcerpt);
    }

    return {
      rawStartByteOffset: byteOffsetForChar(text, chunk.startChar),
      rawEndByteOffset: byteOffsetForChar(text, chunk.endChar),
      renderedExcerpt,
      contextAction: action.contextAction,
      actionReason: action.actionReason,
      labels,
    };
  });
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

function boundedNonTextExcerpt(mediaType: string, raw: Buffer): string {
  const excerpt = `Non-text source item: ${mediaType}, ${raw.byteLength} bytes`;

  return excerpt.length <= NON_TEXT_EXCERPT_MAX_CHARS
    ? excerpt
    : excerpt.slice(0, NON_TEXT_EXCERPT_MAX_CHARS);
}

function splitTextIntoChunks(text: string): TextChunk[] {
  const regions = splitTextIntoRegions(text);
  const chunks: TextChunk[] = [];

  for (const region of regions) {
    const regionChunks = splitRegionBySize(text, region);
    const fromLongRegion =
      region.endChar - region.startChar > SOURCE_ITEM_MAX_CHARS;

    for (const regionChunk of regionChunks) {
      chunks.push({
        ...regionChunk,
        fromLongRegion,
      });
    }
  }

  return chunks;
}

function splitTextIntoRegions(text: string): TextRegion[] {
  const regions: TextRegion[] = [];
  let regionStartChar: number | undefined;
  let regionEndChar: number | undefined;
  let inFence = false;

  for (const line of scanLines(text)) {
    const trimmedLine = line.text.trim();
    const isFenceLine = FENCE_LINE_PATTERN.test(trimmedLine);
    const isBlankOutsideFence = !inFence && trimmedLine.length === 0;

    if (isBlankOutsideFence) {
      if (
        regionStartChar !== undefined &&
        regionEndChar !== undefined &&
        regionEndChar > regionStartChar
      ) {
        regions.push({
          startChar: regionStartChar,
          endChar: regionEndChar,
        });
      }

      regionStartChar = undefined;
      regionEndChar = undefined;
      continue;
    }

    regionStartChar ??= line.startChar;
    regionEndChar = line.endChar;

    if (isFenceLine) {
      inFence = !inFence;
    }
  }

  if (
    regionStartChar !== undefined &&
    regionEndChar !== undefined &&
    regionEndChar > regionStartChar
  ) {
    regions.push({
      startChar: regionStartChar,
      endChar: regionEndChar,
    });
  }

  return regions;
}

function scanLines(text: string): LineSpan[] {
  const lines: LineSpan[] = [];
  let startChar = 0;

  while (startChar < text.length) {
    const newlineIndex = text.indexOf("\n", startChar);
    const endChar = newlineIndex === -1 ? text.length : newlineIndex;
    const nextStartChar = newlineIndex === -1 ? text.length : newlineIndex + 1;

    lines.push({
      startChar,
      endChar,
      nextStartChar,
      text: text.slice(startChar, endChar),
    });

    startChar = nextStartChar;
  }

  return lines;
}

function splitRegionBySize(text: string, region: TextRegion): TextRegion[] {
  if (region.endChar - region.startChar <= SOURCE_ITEM_MAX_CHARS) {
    return [region];
  }

  const regions: TextRegion[] = [];
  let startChar = region.startChar;

  while (startChar < region.endChar) {
    const maxEndChar = Math.min(
      startChar + SOURCE_ITEM_MAX_CHARS,
      region.endChar,
    );
    const split = findSplitPoint(text, startChar, maxEndChar, region.endChar);

    regions.push({
      startChar,
      endChar: split.endChar,
    });

    startChar = split.nextStartChar;
  }

  return regions;
}

function findSplitPoint(
  text: string,
  startChar: number,
  maxEndChar: number,
  regionEndChar: number,
): { endChar: number; nextStartChar: number } {
  if (maxEndChar >= regionEndChar) {
    return {
      endChar: regionEndChar,
      nextStartChar: regionEndChar,
    };
  }

  const searchStartChar = startChar + 1;
  const blankLineIndex = text.lastIndexOf("\n\n", maxEndChar);

  if (blankLineIndex >= searchStartChar) {
    return {
      endChar: blankLineIndex,
      nextStartChar: blankLineIndex + 2,
    };
  }

  const newlineIndex = text.lastIndexOf("\n", maxEndChar);

  if (newlineIndex >= searchStartChar) {
    return {
      endChar: newlineIndex,
      nextStartChar: newlineIndex + 1,
    };
  }

  return {
    endChar: maxEndChar,
    nextStartChar: maxEndChar,
  };
}

function classifySourceLabels(
  renderedExcerpt: string,
  turnRole: TranscriptRole,
): SourceLabel[] {
  if (isRepeatedProgress(renderedExcerpt)) {
    return [];
  }

  const labels = new Set<SourceLabel>();
  const trimmedExcerpt = renderedExcerpt.trim();

  if (isUserInstruction(trimmedExcerpt, turnRole)) {
    labels.add("user_instruction");
  }

  if (RULE_PATTERN.test(renderedExcerpt)) {
    labels.add("rule");
  }

  if (ACCEPTANCE_CRITERIA_PATTERN.test(renderedExcerpt)) {
    labels.add("acceptance_criterion");
  }

  if (DESIGN_DECISION_PATTERN.test(renderedExcerpt)) {
    labels.add("design_decision");
  }

  if (OPEN_QUESTION_PATTERN.test(trimmedExcerpt)) {
    labels.add("open_question");
  }

  if (COMMAND_PATTERN.test(renderedExcerpt)) {
    labels.add("command");
  }

  if (TOOL_OUTPUT_PATTERN.test(renderedExcerpt)) {
    labels.add("tool_output");
  }

  if (TEST_RESULT_PATTERN.test(renderedExcerpt)) {
    labels.add("test_result");
  }

  if (ERROR_MESSAGE_PATTERN.test(renderedExcerpt)) {
    labels.add("error_message");
  }

  if (FILE_PATH_PATTERN.test(renderedExcerpt)) {
    labels.add("file_path");
  }

  if (API_NAME_PATTERN.test(renderedExcerpt)) {
    labels.add("api_name");
  }

  if (CODE_REFERENCE_PATTERN.test(renderedExcerpt)) {
    labels.add("code_reference");
  }

  if (PROJECT_CONVENTION_PATTERN.test(renderedExcerpt)) {
    labels.add("project_convention");
  }

  if (TASK_STATE_PATTERN.test(renderedExcerpt)) {
    labels.add("task_state");
  }

  if (REASONING_PATTERN.test(renderedExcerpt)) {
    labels.add("reasoning");
  }

  if (EXPLORATION_PATTERN.test(renderedExcerpt)) {
    labels.add("exploration");
  }

  if (EXTERNAL_FACT_PATTERN.test(renderedExcerpt)) {
    labels.add("external_fact");
  }

  if (
    EXACT_VALUE_PATTERN.test(renderedExcerpt) &&
    !(labels.has("tool_output") && isVerboseOutput(renderedExcerpt))
  ) {
    labels.add("exact_value");
  }

  return sortSourceLabels([...labels]);
}

function isUserInstruction(
  trimmedExcerpt: string,
  turnRole: TranscriptRole,
): boolean {
  if (turnRole !== "user" || trimmedExcerpt.length === 0) {
    return false;
  }

  if (LOW_SIGNAL_USER_TEXT_PATTERN.test(trimmedExcerpt)) {
    return false;
  }

  return USER_INSTRUCTION_PATTERN.test(trimmedExcerpt);
}

function chooseContextAction(input: {
  fromLongRegion: boolean;
  isDuplicate: boolean;
  labels: SourceLabel[];
  renderedExcerpt: string;
}): { contextAction: ContextAction; actionReason: string } {
  if (input.renderedExcerpt.trim().length === 0) {
    return {
      contextAction: "discard",
      actionReason: "discard:empty",
    };
  }

  if (isRepeatedProgress(input.renderedExcerpt)) {
    return {
      contextAction: "discard",
      actionReason: "discard:repeated_progress",
    };
  }

  const exactReason = exactActionReason(input.labels);

  if (exactReason) {
    return {
      contextAction: "preserve_exact",
      actionReason: exactReason,
    };
  }

  if (input.isDuplicate) {
    return {
      contextAction: "discard",
      actionReason: "discard:duplicate_in_turn",
    };
  }

  if (input.labels.includes("tool_output")) {
    return {
      contextAction: "compact",
      actionReason:
        input.fromLongRegion || isVerboseOutput(input.renderedExcerpt)
          ? "compact:long_tool_output"
          : "compact:tool_output",
    };
  }

  if (input.labels.includes("file_output")) {
    return {
      contextAction: "compact",
      actionReason: "compact:long_file_output",
    };
  }

  if (input.labels.includes("reasoning")) {
    return {
      contextAction: "compact",
      actionReason: "compact:reasoning",
    };
  }

  if (input.labels.includes("exploration")) {
    return {
      contextAction: "compact",
      actionReason: "compact:exploration",
    };
  }

  if (input.labels.includes("task_state")) {
    return {
      contextAction: "compact",
      actionReason: "compact:task_state",
    };
  }

  return {
    contextAction: "discard",
    actionReason: "discard:low_signal",
  };
}

function exactActionReason(labels: SourceLabel[]): string | undefined {
  for (const [label, reason] of EXACT_ACTION_REASONS) {
    if (labels.includes(label)) {
      return reason;
    }
  }

  return undefined;
}

function isRepeatedProgress(renderedExcerpt: string): boolean {
  const lines = renderedExcerpt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length < 2) {
    return false;
  }

  const firstLine = lines[0];

  if (!firstLine || !REPEATED_PROGRESS_LINE_PATTERN.test(firstLine)) {
    return false;
  }

  return lines.every((line) => line === firstLine);
}

function isVerboseOutput(renderedExcerpt: string): boolean {
  return (
    renderedExcerpt.length > VERBOSE_OUTPUT_MIN_CHARS ||
    renderedExcerpt.split(/\r?\n/).length > VERBOSE_OUTPUT_MIN_LINES
  );
}

function normalizeExcerptForDeduplication(renderedExcerpt: string): string {
  return renderedExcerpt.trim().replace(/\s+/g, " ");
}

function sortSourceLabels(labels: SourceLabel[]): SourceLabel[] {
  return labels.sort(
    (left, right) =>
      SOURCE_LABEL_ORDER.indexOf(left) - SOURCE_LABEL_ORDER.indexOf(right),
  );
}

function byteOffsetForChar(text: string, charIndex: number): number {
  return Buffer.byteLength(text.slice(0, charIndex), "utf8");
}

function mapRawBlobRow(row: RawBlobRow): RawBlobPointer {
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

function mapTranscriptTurnRow(row: TranscriptTurnRow): StoredTranscriptTurn {
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

function mapSourceItemRow(
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

function normalizeContextAction(contextAction: string): ContextAction {
  if (
    contextAction !== "preserve_exact" &&
    contextAction !== "compact" &&
    contextAction !== "discard"
  ) {
    throw new Error(`Unsupported context action: ${contextAction}`);
  }

  return contextAction;
}

function normalizeSourceLabel(label: string): SourceLabel {
  if (SOURCE_LABELS.has(label)) {
    return label as SourceLabel;
  }

  throw new Error(`Unsupported source label: ${label}`);
}

const SOURCE_ITEM_MAX_CHARS = 6000;
const NON_TEXT_EXCERPT_MAX_CHARS = 512;
const VERBOSE_OUTPUT_MIN_CHARS = 2000;
const VERBOSE_OUTPUT_MIN_LINES = 40;

const SOURCE_LABEL_ORDER: SourceLabel[] = [
  "user_instruction",
  "rule",
  "exact_value",
  "file_path",
  "command",
  "api_name",
  "acceptance_criterion",
  "design_decision",
  "task_state",
  "open_question",
  "tool_output",
  "file_output",
  "test_result",
  "error_message",
  "code_reference",
  "project_convention",
  "reasoning",
  "exploration",
  "external_fact",
];

const SOURCE_LABELS = new Set<string>(SOURCE_LABEL_ORDER);

const EXACT_ACTION_REASONS: ReadonlyArray<readonly [SourceLabel, string]> = [
  ["user_instruction", "preserve_exact:user_instruction"],
  ["rule", "preserve_exact:rule"],
  ["acceptance_criterion", "preserve_exact:acceptance_criterion"],
  ["design_decision", "preserve_exact:design_decision"],
  ["open_question", "preserve_exact:open_question"],
  ["command", "preserve_exact:command"],
  ["test_result", "preserve_exact:test_result"],
  ["error_message", "preserve_exact:error_message"],
  ["file_path", "preserve_exact:file_path"],
  ["api_name", "preserve_exact:api_name"],
  ["project_convention", "preserve_exact:project_convention"],
  ["code_reference", "preserve_exact:code_reference"],
  ["exact_value", "preserve_exact:exact_value"],
  ["external_fact", "preserve_exact:external_fact"],
];

const FENCE_LINE_PATTERN = /^(?:```|~~~)/;
const USER_INSTRUCTION_PATTERN =
  /^(?:please\b|instructions?:|request:|task:|use\b|add\b|update\b|fix\b|implement\b|create\b|make\b|ensure\b|keep\b|do\b|don't\b|do not\b)/i;
const LOW_SIGNAL_USER_TEXT_PATTERN =
  /^(?:thanks?|thank you|thanks in advance|appreciate it)\b/i;
const RULE_PATTERN =
  /(?:^|\n)\s*(?:rules?|constraints?|guidelines?):|(?:^|\n)\s*-?\s*(?:never|always|must|do not|don't|keep)\b/i;
const ACCEPTANCE_CRITERIA_PATTERN = /(?:^|\n)\s*acceptance criteria?:/i;
const DESIGN_DECISION_PATTERN = /(?:^|\n)\s*(?:decision|decided):/i;
const OPEN_QUESTION_PATTERN = /^(?:questions?:\s*)?.+\?$/i;
const COMMAND_PATTERN =
  /(?:^|\n)\s*command:|```(?:bash|sh|shell|zsh)|(?:^|\n)\s*(?:pnpm|npm|yarn|git|node|npx|turbo|tsc|cargo|go|python|pytest)\b/i;
const TOOL_OUTPUT_PATTERN =
  /(?:^|\n)\s*(?:output|log):|```text|(?:^|\n)\s*TRACE\b|(?:^|\n)\s*not ok\b|(?:^|\n)\s*Error:/i;
const TEST_RESULT_PATTERN =
  /\bnot ok\b|\b(?:test|tests?)\s+(?:failed|failing|passed|passing)\b|AssertionError|ERR_ASSERTION|expected .+ actual/i;
const ERROR_MESSAGE_PATTERN =
  /\b(?:Error|TypeError|ReferenceError|SyntaxError|RangeError|ERR_[A-Z_]+):/;
const FILE_PATH_PATTERN =
  /\b(?:packages|apps|docs|src|test|tests|scripts|infra|\.github)\/[^\s`),]+/;
const API_NAME_PATTERN =
  /\b(?:appendTurn|getSourceItem|listTurnSourceItems|listThreadSourceItems|readTurnRaw|createTranscriptStore)\b/;
const CODE_REFERENCE_PATTERN =
  /\b(?:sourceItemIds|rawPointerId|turnRole|TranscriptStore|StoredSourceItem|ContextAction|SourceLabel)\b|[A-Za-z0-9_$.-]+:\d+\b/;
const PROJECT_CONVENTION_PATTERN =
  /\b(?:project convention|repo convention|coding convention|style convention)\b/i;
const TASK_STATE_PATTERN =
  /\b(?:todo|next step|blocked|in progress|working|done|remaining)\b/i;
const REASONING_PATTERN = /\b(?:because|therefore|reasoning|i think)\b/i;
const EXPLORATION_PATTERN =
  /\b(?:inspect(?:ed|ing)?|checked|search(?:ed|ing)?|explor(?:e|ed|ing))\b/i;
const EXTERNAL_FACT_PATTERN = /\bhttps?:\/\/|\baccording to\b|\bas of \d{4}\b/i;
const EXACT_VALUE_PATTERN =
  /`[^`]+`|["'][^"']+["']|\b(?:true|false|null|undefined)\b|\b\d+(?:\.\d+)?\b|[A-Za-z]+[A-Za-z0-9]*\s*\|\s*[A-Za-z]|\b[A-Z_]{2,}\b|@\w+\/[\w-]+|CHANGELOG\.md|sourceItemIds|rawPointerId|turnRole/;
const REPEATED_PROGRESS_LINE_PATTERN =
  /^(?:still working|working|processing|running|waiting|loading)\.{0,3}$/i;

function parseJsonStringArray(value: string, columnName: string): string[] {
  const parsed = JSON.parse(value) as unknown;

  if (
    !Array.isArray(parsed) ||
    !parsed.every((item) => typeof item === "string")
  ) {
    throw new Error(`${columnName} must contain a JSON string array`);
  }

  return parsed;
}

function readBlobFile(blobPath: string, rawPointerId: string): Buffer {
  let stats;

  try {
    stats = statSync(blobPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(
        `Raw blob missing for raw pointer ${rawPointerId}: ${blobPath}`,
      );
    }

    throw new Error(
      `Raw blob unreadable for raw pointer ${rawPointerId}: ${messageFromError(error)}`,
    );
  }

  if (!stats.isFile()) {
    throw new Error(
      `Raw blob unreadable for raw pointer ${rawPointerId}: not a file`,
    );
  }

  if ((stats.mode & 0o444) === 0) {
    throw new Error(
      `Raw blob unreadable for raw pointer ${rawPointerId}: permission denied`,
    );
  }

  try {
    return readFileSync(blobPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(
        `Raw blob missing for raw pointer ${rawPointerId}: ${blobPath}`,
      );
    }

    throw new Error(
      `Raw blob unreadable for raw pointer ${rawPointerId}: ${messageFromError(error)}`,
    );
  }
}

function verifyExistingBlob(
  blobPath: string,
  storagePath: string,
  expectedSha: string,
  expectedByteLength: number,
): void {
  const existing = readBlobFile(blobPath, storagePath);
  if (
    existing.byteLength !== expectedByteLength ||
    hashBytes(existing) !== expectedSha
  ) {
    throw new Error(`Raw blob SHA mismatch at ${storagePath}`);
  }
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeSqliteError(error: unknown): Error {
  if (!isNodeError(error)) {
    return new Error(messageFromError(error));
  }

  if (error.message.toLowerCase().includes("foreign key")) {
    return new Error(`SQLite foreign key constraint failed: ${error.message}`);
  }

  return error;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
