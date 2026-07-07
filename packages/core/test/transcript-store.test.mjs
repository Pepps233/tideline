import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { createTranscriptStore } from "../dist/index.js";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function createIsolatedStore(t) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "tideline-core-"));
  const sqlitePath = path.join(tempDir, "store.sqlite");
  const blobDir = path.join(tempDir, "blobs");
  const store = await createTranscriptStore({ sqlitePath, blobDir });
  let isClosed = false;
  const closeStore = async () => {
    if (!isClosed) {
      isClosed = true;
      await store.close();
    }
  };

  t.after(async () => {
    await closeStore();
    await rm(tempDir, { force: true, recursive: true });
  });

  return { blobDir, closeStore, sqlitePath, store };
}

function openSqlite(sqlitePath) {
  const db = new DatabaseSync(sqlitePath);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function getRawBlobRow(sqlitePath, rawPointerId) {
  const db = openSqlite(sqlitePath);

  try {
    const rawBlob = db
      .prepare(
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

    assert.ok(rawBlob, `Expected raw blob ${rawPointerId}`);
    return rawBlob;
  } finally {
    db.close();
  }
}

function getBlobPath(blobDir, rawBlobRow) {
  assert.equal(rawBlobRow.storage_kind, "file");
  assert.equal(path.basename(rawBlobRow.storage_path), rawBlobRow.sha256);
  return path.join(blobDir, rawBlobRow.storage_path);
}

test("writes SHA-addressed raw blobs and reuses duplicate content", async (t) => {
  const { blobDir, sqlitePath, store } = await createIsolatedStore(t);
  const raw = "same transcript payload";
  const mediaType = "text/plain; charset=utf-8";
  const expectedSha = sha256(Buffer.from(raw));

  const first = await store.appendTurn({
    threadId: "thread-a",
    turnRole: "user",
    raw,
    mediaType,
  });
  const second = await store.appendTurn({
    threadId: "thread-a",
    turnRole: "model",
    raw: Buffer.from(raw),
    mediaType,
  });

  assert.equal(second.rawPointerId, first.rawPointerId);

  const rawBlob = getRawBlobRow(sqlitePath, first.rawPointerId);
  assert.equal(rawBlob.raw_pointer_id, first.rawPointerId);
  assert.equal(rawBlob.sha256, expectedSha);
  assert.equal(rawBlob.byte_length, Buffer.byteLength(raw));
  assert.equal(rawBlob.media_type, mediaType);

  const db = openSqlite(sqlitePath);

  try {
    const { count } = db.prepare("SELECT COUNT(*) AS count FROM raw_blobs").get();
    assert.equal(count, 1);
  } finally {
    db.close();
  }

  const blobBytes = await readFile(getBlobPath(blobDir, rawBlob));
  assert.equal(sha256(blobBytes), expectedSha);
});

test("reads text and binary raw content through stored turns", async (t) => {
  const { store } = await createIsolatedStore(t);
  const textTurn = await store.appendTurn({
    threadId: "thread-a",
    turnRole: "user",
    raw: "hello model",
  });
  const binary = Uint8Array.from([0, 1, 2, 250, 255]);
  const binaryTurn = await store.appendTurn({
    threadId: "thread-a",
    turnRole: "model",
    raw: binary,
    mediaType: "application/octet-stream",
  });

  const storedText = await store.readTurnRaw(textTurn.turnId);
  const storedBinary = await store.readTurnRaw(binaryTurn.turnId);

  assert.equal(Buffer.from(storedText).toString("utf8"), "hello model");
  assert.deepEqual(Buffer.from(storedBinary), Buffer.from(binary));
});

test("refuses to reuse a blob file whose contents no longer match its address", async (t) => {
  const { blobDir, sqlitePath, store } = await createIsolatedStore(t);
  const original = "uncorrupted raw turn";
  const turn = await store.appendTurn({
    threadId: "thread-a",
    turnRole: "user",
    raw: original,
  });
  const rawBlob = getRawBlobRow(sqlitePath, turn.rawPointerId);
  const blobPath = getBlobPath(blobDir, rawBlob);

  await writeFile(blobPath, "corrupted raw turn");

  await assert.rejects(
    async () =>
      await store.appendTurn({
        threadId: "thread-a",
        turnRole: "model",
        raw: original,
      }),
    /sha|checksum|corrupt|mismatch/i,
  );
});

test("reports missing and unreadable blob files clearly", async (t) => {
  const { blobDir, sqlitePath, store } = await createIsolatedStore(t);
  const missingTurn = await store.appendTurn({
    threadId: "thread-a",
    turnRole: "user",
    raw: "missing blob",
  });
  const unreadableTurn = await store.appendTurn({
    threadId: "thread-a",
    turnRole: "model",
    raw: "unreadable blob",
  });

  const missingBlob = getRawBlobRow(sqlitePath, missingTurn.rawPointerId);
  const unreadableBlob = getRawBlobRow(sqlitePath, unreadableTurn.rawPointerId);
  const missingPath = getBlobPath(blobDir, missingBlob);
  const unreadablePath = getBlobPath(blobDir, unreadableBlob);

  await rm(missingPath);
  await chmod(unreadablePath, 0o000);
  t.after(async () => {
    await chmod(unreadablePath, 0o600).catch(() => {});
  });

  await assert.rejects(
    async () => await store.readTurnRaw(missingTurn.turnId),
    /missing|not found|ENOENT/i,
  );
  await assert.rejects(
    async () => await store.readTurnRaw(unreadableTurn.turnId),
    /unreadable|permission|EACCES/i,
  );
});

test("appends and lists ordered turns independently per thread", async (t) => {
  const { store } = await createIsolatedStore(t);
  const firstCreatedAt = new Date("2026-01-01T00:00:00.000Z");
  const first = await store.appendTurn({
    threadId: "thread-a",
    turnRole: "user",
    raw: "a1",
    createdAt: firstCreatedAt,
  });
  await store.appendTurn({
    threadId: "thread-b",
    turnRole: "user",
    raw: "b1",
  });
  const second = await store.appendTurn({
    threadId: "thread-a",
    turnRole: "model",
    raw: "a2",
  });
  const third = await store.appendTurn({
    threadId: "thread-a",
    turnRole: "user",
    raw: "a3",
  });

  assert.equal(first.turnIndex, 1);
  assert.equal(second.turnIndex, 2);
  assert.equal(third.turnIndex, 3);
  assert.deepEqual(first.sourceItemIds, []);
  assert.deepEqual(first.derivedContextBlockIds, []);
  assert.equal(new Date(first.createdAt).toISOString(), firstCreatedAt.toISOString());

  const threadA = await store.listThreadTurns("thread-a");
  const threadB = await store.listThreadTurns("thread-b");
  const fetched = await store.getTurn(second.turnId);

  assert.deepEqual(
    threadA.map((turn) => turn.turnId),
    [first.turnId, second.turnId, third.turnId],
  );
  assert.deepEqual(
    threadA.map((turn) => turn.turnIndex),
    [1, 2, 3],
  );
  assert.deepEqual(
    threadB.map((turn) => turn.turnIndex),
    [1],
  );
  assert.equal(fetched.turnId, second.turnId);
  assert.equal(fetched.threadId, "thread-a");
  assert.equal(fetched.turnRole, "model");
});

test("configures SQLite WAL mode and raw pointer foreign keys", async (t) => {
  const { sqlitePath, store } = await createIsolatedStore(t);
  await store.appendTurn({
    threadId: "thread-a",
    turnRole: "user",
    raw: "schema probe",
  });

  const db = openSqlite(sqlitePath);

  try {
    const { journal_mode: journalMode } = db.prepare("PRAGMA journal_mode").get();
    const rawPointerKeys = db
      .prepare("PRAGMA foreign_key_list(transcript_turns)")
      .all()
      .filter(
        (foreignKey) =>
          foreignKey.table === "raw_blobs" &&
          foreignKey.from === "raw_pointer_id" &&
          foreignKey.to === "raw_pointer_id",
      );

    assert.equal(journalMode, "wal");
    assert.equal(rawPointerKeys.length, 1);
    assert.throws(
      () =>
        db
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
            "turn-with-invalid-pointer",
            "thread-a",
            99,
            "user",
            "raw-pointer-missing",
            "[]",
            "[]",
            "2026-01-01T00:00:00.000Z",
          ),
      /foreign key/i,
    );
  } finally {
    db.close();
  }
});

test("assigns turn indexes transactionally for concurrent appends", async (t) => {
  const { store } = await createIsolatedStore(t);

  await Promise.all(
    Array.from({ length: 25 }, (_, index) =>
      store.appendTurn({
        threadId: "thread-a",
        turnRole: index % 2 === 0 ? "user" : "model",
        raw: `turn ${index}`,
      }),
    ),
  );

  const turns = await store.listThreadTurns("thread-a");

  assert.deepEqual(
    turns.map((turn) => turn.turnIndex),
    Array.from({ length: 25 }, (_, index) => index + 1),
  );
  assert.equal(new Set(turns.map((turn) => turn.turnIndex)).size, 25);
});

test("stores only raw pointers on transcript turns", async (t) => {
  const { sqlitePath, store } = await createIsolatedStore(t);
  const raw = `raw payload ${randomUUID()} must stay out of transcript_turns`;

  await store.appendTurn({
    threadId: "thread-a",
    turnRole: "user",
    raw,
  });

  const db = openSqlite(sqlitePath);

  try {
    const columns = db.prepare("PRAGMA table_info(transcript_turns)").all();
    const columnNames = columns.map((column) => column.name);

    assert.deepEqual(
      columnNames.filter((name) => /raw|body|content|payload|bytes|text/i.test(name)),
      ["raw_pointer_id"],
    );

    const rows = db.prepare("SELECT * FROM transcript_turns").all();
    assert.equal(JSON.stringify(rows).includes(raw), false);
  } finally {
    db.close();
  }
});

test("rejects invalid append inputs clearly", async (t) => {
  const { store } = await createIsolatedStore(t);

  await assert.rejects(
    async () =>
      await store.appendTurn({
        threadId: "",
        turnRole: "user",
        raw: "no thread",
      }),
    /threadId|thread.*id|empty/i,
  );
  await assert.rejects(
    async () =>
      await store.appendTurn({
        threadId: "thread-a",
        turnRole: "assistant",
        raw: "wrong role",
      }),
    /turnRole|role|user|model/i,
  );
});

test("reports dangling raw pointers clearly", async (t) => {
  const { blobDir, closeStore, sqlitePath } = await createIsolatedStore(t);
  await closeStore();

  const db = openSqlite(sqlitePath);

  try {
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare(
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
    ).run(
      "turn-with-missing-pointer",
      "thread-a",
      1,
      "user",
      "raw-pointer-missing",
      "[]",
      "[]",
      "2026-01-01T00:00:00.000Z",
    );
  } finally {
    db.close();
  }

  const reopened = await createTranscriptStore({ blobDir, sqlitePath });

  try {
    await assert.rejects(
      async () => await reopened.readTurnRaw("turn-with-missing-pointer"),
      /raw pointer|rawPointerId|missing|not found/i,
    );
  } finally {
    await reopened.close();
  }
});
