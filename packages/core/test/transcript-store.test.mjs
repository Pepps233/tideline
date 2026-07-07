import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

function assertSourceItemShape(item) {
  assert.equal(typeof item.sourceItemId, "string");
  assert.equal(typeof item.turnId, "string");
  assert.equal(typeof item.itemIndex, "number");
  assert.equal(typeof item.rawPointerId, "string");
  assert.equal(typeof item.renderedExcerpt, "string");
  assert.match(item.contextAction, /^(preserve_exact|compact|discard)$/);
  assert.equal(typeof item.actionReason, "string");
  assert.ok(Array.isArray(item.labels));
  assert.equal(typeof item.createdAt, "string");
}

function assertTextOffsets(rawBytes, item) {
  assert.equal(typeof item.rawStartByteOffset, "number");
  assert.equal(typeof item.rawEndByteOffset, "number");
  assert.ok(item.rawStartByteOffset >= 0);
  assert.ok(item.rawEndByteOffset > item.rawStartByteOffset);
  assert.ok(item.rawEndByteOffset <= rawBytes.byteLength);

  const rawSlice = Buffer.from(
    rawBytes.slice(item.rawStartByteOffset, item.rawEndByteOffset),
  ).toString("utf8");
  assert.equal(rawSlice, item.renderedExcerpt);
}

function findItemByText(items, text) {
  const item = items.find((sourceItem) =>
    sourceItem.renderedExcerpt.includes(text),
  );

  assert.ok(item, `Expected source item containing ${text}`);
  return item;
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
    const { count } = db
      .prepare("SELECT COUNT(*) AS count FROM raw_blobs")
      .get();
    assert.equal(count, 1);
  } finally {
    db.close();
  }

  const blobBytes = await readFile(getBlobPath(blobDir, rawBlob));
  assert.equal(sha256(blobBytes), expectedSha);
});

test("keeps separate raw pointers for different media types", async (t) => {
  const { sqlitePath, store } = await createIsolatedStore(t);
  const raw = "same bytes with different meanings";

  const textTurn = await store.appendTurn({
    threadId: "thread-a",
    turnRole: "user",
    raw,
    mediaType: "text/plain; charset=utf-8",
  });
  const binaryTurn = await store.appendTurn({
    threadId: "thread-a",
    turnRole: "model",
    raw,
    mediaType: "application/octet-stream",
  });

  assert.notEqual(binaryTurn.rawPointerId, textTurn.rawPointerId);

  const textBlob = getRawBlobRow(sqlitePath, textTurn.rawPointerId);
  const binaryBlob = getRawBlobRow(sqlitePath, binaryTurn.rawPointerId);

  assert.equal(textBlob.media_type, "text/plain; charset=utf-8");
  assert.equal(binaryBlob.media_type, "application/octet-stream");
  assert.equal(binaryBlob.storage_path, textBlob.storage_path);
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
  assert.equal(first.sourceItemIds.length, 1);
  assert.deepEqual(first.derivedContextBlockIds, []);
  assert.equal(
    new Date(first.createdAt).toISOString(),
    firstCreatedAt.toISOString(),
  );

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
    const { journal_mode: journalMode } = db
      .prepare("PRAGMA journal_mode")
      .get();
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
      columnNames.filter((name) =>
        /(?:^|_)(?:raw|body|content|payload|bytes|text)(?:_|$)/i.test(name),
      ),
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
  await assert.rejects(
    async () =>
      await store.appendTurn({
        threadId: "thread-a",
        turnRole: "user",
        raw: "unsafe media type",
        mediaType: "text/plain\r\nx-injected: yes",
      }),
    /mediaType|control|invalid/i,
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

test("appends user turns with ordered source items, labels, actions, and offsets", async (t) => {
  const { store } = await createIsolatedStore(t);
  const createdAt = "2026-02-03T04:05:06.000Z";
  const raw = [
    "Please update @tideline/core.",
    "",
    "Rules:",
    "- Never modify CHANGELOG.md.",
    "- Keep turnRole as user | model.",
    "",
    "Paths:",
    "- packages/core/src/index.ts",
    "- packages/core/test/transcript-store.test.mjs",
    "",
    "Acceptance criteria:",
    "- appendTurn returns sourceItemIds in canonical order.",
    "- Persist raw byte offsets for every text item.",
    "",
    "Thanks in advance for taking a look.",
  ].join("\n");

  const turn = await store.appendTurn({
    threadId: "thread-source-items",
    turnRole: "user",
    raw,
    createdAt,
  });
  const items = await store.listTurnSourceItems(turn.turnId);
  const rawBytes = await store.readTurnRaw(turn.turnId);

  assert.deepEqual(
    turn.sourceItemIds,
    items.map((item) => item.sourceItemId),
  );
  assert.deepEqual(
    items.map((item) => item.itemIndex),
    [0, 1, 2, 3, 4],
  );
  assert.deepEqual(
    items.map((item) => item.renderedExcerpt),
    [
      "Please update @tideline/core.",
      [
        "Rules:",
        "- Never modify CHANGELOG.md.",
        "- Keep turnRole as user | model.",
      ].join("\n"),
      [
        "Paths:",
        "- packages/core/src/index.ts",
        "- packages/core/test/transcript-store.test.mjs",
      ].join("\n"),
      [
        "Acceptance criteria:",
        "- appendTurn returns sourceItemIds in canonical order.",
        "- Persist raw byte offsets for every text item.",
      ].join("\n"),
      "Thanks in advance for taking a look.",
    ],
  );

  for (const item of items) {
    assertSourceItemShape(item);
    assert.equal(item.turnId, turn.turnId);
    assert.equal(item.rawPointerId, turn.rawPointerId);
    assert.equal(item.createdAt, createdAt);
    assertTextOffsets(rawBytes, item);
  }

  assert.equal(items[0].contextAction, "preserve_exact");
  assert.equal(items[0].actionReason, "preserve_exact:user_instruction");
  assert.ok(items[0].labels.includes("user_instruction"));

  assert.equal(items[1].contextAction, "preserve_exact");
  assert.equal(items[1].actionReason, "preserve_exact:rule");
  assert.ok(items[1].labels.includes("rule"));
  assert.ok(items[1].labels.includes("exact_value"));

  assert.equal(items[2].contextAction, "preserve_exact");
  assert.equal(items[2].actionReason, "preserve_exact:file_path");
  assert.ok(items[2].labels.includes("file_path"));

  assert.equal(items[3].contextAction, "preserve_exact");
  assert.equal(items[3].actionReason, "preserve_exact:acceptance_criterion");
  assert.ok(items[3].labels.includes("acceptance_criterion"));

  assert.equal(items[4].contextAction, "discard");
  assert.equal(items[4].actionReason, "discard:low_signal");
  assert.deepEqual(items[4].labels, []);

  const fetched = await store.getSourceItem(items[2].sourceItemId);
  assert.deepEqual(fetched, items[2]);
});

test("appends model turns with commands, failures, long logs, decisions, and repeated progress", async (t) => {
  const { store } = await createIsolatedStore(t);
  const longLog = Array.from(
    { length: 320 },
    (_, index) =>
      `TRACE chunk ${String(index).padStart(3, "0")} ` +
      "cache probe repeated diagnostic detail ".repeat(4),
  ).join("\n");
  const raw = [
    "Decision: Keep source item splitting internal to appendTurn.",
    "",
    "Command:",
    "```bash",
    "pnpm --filter @tideline/core test",
    "```",
    "",
    "Output:",
    "```text",
    "not ok 3 - source item ids are canonical",
    "Error: expected sourceItemIds to contain ordered children",
    "```",
    "",
    "Log:",
    "```text",
    longLog,
    "```",
    "",
    "Still working...",
    "Still working...",
    "Still working...",
  ].join("\n");

  const turn = await store.appendTurn({
    threadId: "thread-model-source-items",
    turnRole: "model",
    raw,
  });
  const items = await store.listTurnSourceItems(turn.turnId);
  const rawBytes = await store.readTurnRaw(turn.turnId);

  assert.deepEqual(
    turn.sourceItemIds,
    items.map((item) => item.sourceItemId),
  );
  assert.deepEqual(
    items.map((item) => item.itemIndex),
    Array.from({ length: items.length }, (_, index) => index),
  );

  for (const item of items) {
    assertSourceItemShape(item);
    assertTextOffsets(rawBytes, item);
    assert.ok(item.renderedExcerpt.length <= 6000);
  }

  const decision = findItemByText(items, "Keep source item splitting internal");
  assert.equal(decision.contextAction, "preserve_exact");
  assert.equal(decision.actionReason, "preserve_exact:design_decision");
  assert.ok(decision.labels.includes("design_decision"));

  const command = findItemByText(items, "pnpm --filter @tideline/core test");
  assert.equal(command.contextAction, "preserve_exact");
  assert.equal(command.actionReason, "preserve_exact:command");
  assert.ok(command.labels.includes("command"));

  const failure = findItemByText(items, "not ok 3");
  assert.equal(failure.contextAction, "preserve_exact");
  assert.equal(failure.actionReason, "preserve_exact:test_result");
  assert.ok(failure.labels.includes("test_result"));
  assert.ok(failure.labels.includes("error_message"));

  const logItems = items.filter((item) =>
    item.renderedExcerpt.includes("TRACE chunk"),
  );
  assert.ok(logItems.length > 1);

  for (const item of logItems) {
    assert.equal(item.contextAction, "compact");
    assert.equal(item.actionReason, "compact:long_tool_output");
    assert.ok(item.labels.includes("tool_output"));
    assert.ok(item.renderedExcerpt.length <= 6000);
  }

  const repeatedProgress = findItemByText(items, "Still working...");
  assert.equal(repeatedProgress.contextAction, "discard");
  assert.equal(repeatedProgress.actionReason, "discard:repeated_progress");
  assert.deepEqual(repeatedProgress.labels, []);
});

test("appends non-text turns with one compact synthetic source item", async (t) => {
  const { store } = await createIsolatedStore(t);
  const raw = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0xfa]);
  const turn = await store.appendTurn({
    threadId: "thread-binary-source-items",
    turnRole: "model",
    raw,
    mediaType: "image/png",
  });
  const items = await store.listTurnSourceItems(turn.turnId);
  const storedRaw = await store.readTurnRaw(turn.turnId);

  assert.deepEqual(
    turn.sourceItemIds,
    items.map((item) => item.sourceItemId),
  );
  assert.equal(items.length, 1);
  assert.deepEqual(Buffer.from(storedRaw), Buffer.from(raw));

  const [item] = items;
  assertSourceItemShape(item);
  assert.equal(item.turnId, turn.turnId);
  assert.equal(item.itemIndex, 0);
  assert.equal(item.rawPointerId, turn.rawPointerId);
  assert.equal(item.rawStartByteOffset, null);
  assert.equal(item.rawEndByteOffset, null);
  assert.equal(item.contextAction, "compact");
  assert.equal(item.actionReason, "compact:non_text");
  assert.deepEqual(item.labels, ["file_output"]);
  assert.match(item.renderedExcerpt, /image\/png/);
  assert.match(item.renderedExcerpt, /7 bytes/);
  assert.ok(item.renderedExcerpt.length <= 512);
});

test("persists source item schema, label joins, thread ordering, and reopen behavior", async (t) => {
  const { blobDir, closeStore, sqlitePath, store } = await createIsolatedStore(t);
  const first = await store.appendTurn({
    threadId: "thread-reopen-source-items",
    turnRole: "user",
    raw: [
      "Instruction: Use packages/core/src/index.ts.",
      "",
      "Question: Should source item labels be joined on read?",
    ].join("\n"),
  });
  const second = await store.appendTurn({
    threadId: "thread-reopen-source-items",
    turnRole: "model",
    raw: [
      "Decision: Store labels in a join table.",
      "",
      "Command:",
      "```bash",
      "pnpm --filter @tideline/core test",
      "```",
    ].join("\n"),
  });
  const listedBeforeClose = await store.listThreadSourceItems(
    "thread-reopen-source-items",
  );

  assert.deepEqual(
    listedBeforeClose.map((item) => item.turnId),
    [
      ...Array(first.sourceItemIds.length).fill(first.turnId),
      ...Array(second.sourceItemIds.length).fill(second.turnId),
    ],
  );
  assert.deepEqual(
    listedBeforeClose.map((item) => item.sourceItemId),
    [...first.sourceItemIds, ...second.sourceItemIds],
  );

  const db = openSqlite(sqlitePath);

  try {
    const tables = db
      .prepare(
        `SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('source_items', 'source_labels')
        ORDER BY name`,
      )
      .all()
      .map((row) => row.name);
    assert.deepEqual(tables, ["source_items", "source_labels"]);

    const itemForeignKeys = db
      .prepare("PRAGMA foreign_key_list(source_items)")
      .all();
    assert.ok(
      itemForeignKeys.some(
        (foreignKey) =>
          foreignKey.table === "transcript_turns" &&
          foreignKey.from === "turn_id" &&
          foreignKey.to === "turn_id",
      ),
    );
    assert.ok(
      itemForeignKeys.some(
        (foreignKey) =>
          foreignKey.table === "raw_blobs" &&
          foreignKey.from === "raw_pointer_id" &&
          foreignKey.to === "raw_pointer_id",
      ),
    );

    const labelForeignKeys = db
      .prepare("PRAGMA foreign_key_list(source_labels)")
      .all();
    assert.ok(
      labelForeignKeys.some(
        (foreignKey) =>
          foreignKey.table === "source_items" &&
          foreignKey.from === "source_item_id" &&
          foreignKey.to === "source_item_id",
      ),
    );

    assert.throws(
      () =>
        db
          .prepare(
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
          )
          .run(
            "source-item-with-invalid-pointers",
            "turn-missing",
            0,
            "raw-pointer-missing",
            0,
            1,
            "x",
            "preserve_exact",
            "preserve_exact:user_instruction",
            "2026-01-01T00:00:00.000Z",
          ),
      /foreign key/i,
    );

    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO source_labels (
              source_item_id,
              label
            ) VALUES (?, ?)`,
          )
          .run("source-item-missing", "user_instruction"),
      /foreign key/i,
    );
  } finally {
    db.close();
  }

  await closeStore();

  const reopened = await createTranscriptStore({ blobDir, sqlitePath });

  try {
    const listedAfterReopen = await reopened.listThreadSourceItems(
      "thread-reopen-source-items",
    );
    assert.deepEqual(listedAfterReopen, listedBeforeClose);

    const question = findItemByText(listedAfterReopen, "Should source item");
    assert.equal(question.contextAction, "preserve_exact");
    assert.equal(question.actionReason, "preserve_exact:open_question");
    assert.ok(question.labels.includes("open_question"));

    const command = await reopened.getSourceItem(second.sourceItemIds.at(-1));
    assert.equal(command.contextAction, "preserve_exact");
    assert.equal(command.actionReason, "preserve_exact:command");
    assert.ok(command.labels.includes("command"));
  } finally {
    await reopened.close();
  }
});
