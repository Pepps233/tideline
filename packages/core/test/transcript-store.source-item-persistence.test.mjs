import assert from "node:assert/strict";
import test from "node:test";

import {
  createIsolatedStore,
  createTranscriptStore,
  findItemByText,
  openSqlite,
} from "./helpers/transcript-store.mjs";

test("persists source item schema, label joins, thread ordering, and reopen behavior", async (t) => {
  const { blobDir, closeStore, sqlitePath, store } =
    await createIsolatedStore(t);
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
