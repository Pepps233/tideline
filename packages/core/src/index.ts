import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import type BetterSqlite3 from "better-sqlite3";

export type TranscriptRole = "user" | "model";

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

interface SqliteNextTurnIndexRow {
  next_turn_index: number;
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
      const sourceItemIds = "[]";
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
          sourceItemIds,
          derivedContextBlockIds,
          createdAt,
        );

      return {
        turnId,
        threadId,
        turnIndex,
        turnRole,
        rawPointerId: rawPointer.rawPointerId,
        sourceItemIds: [],
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
        UNIQUE (sha256, byte_length)
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
    `);
  }

  private getOrCreateRawBlob(
    raw: Buffer,
    mediaType: string,
    createdAt: string,
  ): RawBlobPointer {
    const sha256 = hashBytes(raw);
    const byteLength = raw.byteLength;
    const existing = this.db
      .prepare<[string, number], RawBlobRow>(
        `SELECT
          raw_pointer_id,
          sha256,
          byte_length,
          media_type,
          storage_kind,
          storage_path
        FROM raw_blobs
        WHERE sha256 = ? AND byte_length = ?`,
      )
      .get(sha256, byteLength);

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

    if (existsSync(blobPath)) {
      const existing = readBlobFile(blobPath, storagePath);
      if (
        existing.byteLength !== expectedByteLength ||
        hashBytes(existing) !== expectedSha
      ) {
        throw new Error(`Raw blob SHA mismatch at ${storagePath}`);
      }

      return;
    }

    try {
      writeFileSync(blobPath, raw, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        const existing = readBlobFile(blobPath, storagePath);
        if (
          existing.byteLength === expectedByteLength &&
          hashBytes(existing) === expectedSha
        ) {
          return;
        }
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
