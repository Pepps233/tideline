import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  createIsolatedStore,
  createTranscriptStore,
  openSqlite,
} from "./helpers/transcript-store.mjs";

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

test("lists session summaries by latest activity", async (t) => {
  const { store } = await createIsolatedStore(t);

  await store.captureTurnEvent({
    eventId: "session-empty-start",
    kind: "session_start",
    threadId: "thread-empty",
    createdAt: "2026-07-08T12:00:00.000Z",
    payload: {},
  });
  await store.appendTurn({
    threadId: "thread-old",
    turnRole: "user",
    raw: "Task: older session",
    createdAt: "2026-07-08T12:01:00.000Z",
  });
  await store.appendTurn({
    threadId: "thread-new",
    turnRole: "user",
    raw: "Task: newer session",
    createdAt: "2026-07-08T12:02:00.000Z",
  });
  await store.captureTurnEvent({
    eventId: "session-new-tool",
    kind: "tool_result",
    threadId: "thread-new",
    createdAt: "2026-07-08T12:03:00.000Z",
    payload: {
      tool_name: "shell",
      call_id: "call-new",
      input: { command: "pnpm test" },
      status: "success",
      output: "pass",
    },
  });

  const sessions = await store.listSessions();

  assert.deepEqual(
    sessions.map((session) => session.threadId),
    ["thread-new", "thread-old", "thread-empty"],
  );
  assert.deepEqual(
    sessions.map((session) => session.nextActiveTurn),
    [2, 2, 1],
  );
  assert.equal(sessions[0].turnCount, 1);
  assert.equal(sessions[0].pendingToolEventCount, 1);
  assert.equal(sessions[0].latestActivityAt, "2026-07-08T12:03:00.000Z");
  assert.equal(sessions[2].turnCount, 0);
  assert.equal(sessions[2].processedEventCount, 1);

  assert.deepEqual(
    (await store.listSessions({ limit: 2 })).map((session) => session.threadId),
    ["thread-new", "thread-old"],
  );

  await assert.rejects(
    async () => await store.listSessions({ limit: 0 }),
    /limit|positive|integer/i,
  );
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
