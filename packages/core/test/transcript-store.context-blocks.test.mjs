import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createIsolatedStore,
  createTranscriptStore,
  findItemByText,
  openSqlite,
} from "./helpers/transcript-store.mjs";

test("exports context block public types and store methods", async () => {
  const declarations = await readFile(
    new URL("../dist/index.d.ts", import.meta.url),
    "utf8",
  );
  const compactDeclarations = declarations.replace(/\s+/g, " ");

  assert.match(compactDeclarations, /\bStoredContextBlock\b/);
  assert.match(compactDeclarations, /\bBuildContextBlocksInput\b/);
  assert.match(
    compactDeclarations,
    /buildContextBlocks\(input: BuildContextBlocksInput\): Promise<StoredContextBlock\[]>/,
  );
  assert.match(
    compactDeclarations,
    /getContextBlock\(contextBlockId: string\): Promise<StoredContextBlock \| undefined>/,
  );
  assert.match(
    compactDeclarations,
    /listThreadContextBlocks\(threadId: string\): Promise<StoredContextBlock\[]>/,
  );
});

test("persists context blocks, labels, and source links across reopen", async (t) => {
  const { blobDir, closeStore, sqlitePath, store } =
    await createIsolatedStore(t);
  const first = await appendCompactModelItem(store, {
    raw: compactExplorationText("cache retry path"),
    threadId: "thread-context-persistence",
  });
  const second = await appendCompactModelItem(store, {
    raw: compactTaskStateText("assembly summary"),
    threadId: "thread-context-persistence",
  });
  const createdAt = "2026-03-04T05:06:07.000Z";

  const [block] = await store.buildContextBlocks({
    threadId: "thread-context-persistence",
    groups: [
      {
        sourceItemIds: [second.item.sourceItemId, first.item.sourceItemId],
      },
    ],
    createdAt,
  });

  assertContextBlockShape(block);
  assert.equal(block.threadId, "thread-context-persistence");
  assert.equal(block.blockIndex, 1);
  assert.deepEqual(block.sourceItemIds, [
    first.item.sourceItemId,
    second.item.sourceItemId,
  ]);
  assert.deepEqual(block.labels, ["task_state", "reasoning", "exploration"]);
  assertSummaryBounds(block.summary);
  assert.match(block.summary, /cache retry path/i);
  assert.match(block.summary, /assembly summary/i);
  assert.equal(block.createdAt, createdAt);

  const db = openSqlite(sqlitePath);

  try {
    assertTableExists(db, "context_blocks");
    assertTableExists(db, "context_block_labels");
    assertTableExists(db, "context_block_source_items");
    assertForeignKey(db, "context_block_labels", {
      from: "context_block_id",
      table: "context_blocks",
      to: "context_block_id",
    });
    assertForeignKey(db, "context_block_source_items", {
      from: "context_block_id",
      table: "context_blocks",
      to: "context_block_id",
    });
    assertForeignKey(db, "context_block_source_items", {
      from: "source_item_id",
      table: "source_items",
      to: "source_item_id",
    });

    const blockRows = db
      .prepare(
        `SELECT
          context_block_id,
          thread_id,
          block_index,
          summary,
          created_at
        FROM context_blocks
        WHERE context_block_id = ?`,
      )
      .all(block.contextBlockId);

    assert.deepEqual(blockRows, [
      {
        context_block_id: block.contextBlockId,
        thread_id: block.threadId,
        block_index: block.blockIndex,
        summary: block.summary,
        created_at: createdAt,
      },
    ]);

    const labelRows = db
      .prepare(
        `SELECT label, label_index
        FROM context_block_labels
        WHERE context_block_id = ?
        ORDER BY label_index ASC`,
      )
      .all(block.contextBlockId);

    assert.deepEqual(
      labelRows.map((row) => row.label),
      block.labels,
    );
    assert.deepEqual(
      labelRows.map((row) => row.label_index),
      [0, 1, 2],
    );

    const linkRows = db
      .prepare(
        `SELECT source_item_id, source_item_index
        FROM context_block_source_items
        WHERE context_block_id = ?
        ORDER BY source_item_index ASC`,
      )
      .all(block.contextBlockId);

    assert.deepEqual(
      linkRows.map((row) => row.source_item_id),
      block.sourceItemIds,
    );
    assert.deepEqual(
      linkRows.map((row) => row.source_item_index),
      [0, 1],
    );
  } finally {
    db.close();
  }

  await closeStore();
  const reopened = await createTranscriptStore({ blobDir, sqlitePath });

  try {
    assert.deepEqual(
      await reopened.getContextBlock(block.contextBlockId),
      block,
    );
    assert.deepEqual(await reopened.listThreadContextBlocks(block.threadId), [
      block,
    ]);
  } finally {
    await reopened.close();
  }
});

test("builds explicit groups idempotently and updates source turn reverse lookups", async (t) => {
  const { store } = await createIsolatedStore(t);
  const first = await appendCompactModelItem(store, {
    raw: compactExplorationText("draft filtering"),
    threadId: "thread-context-groups",
  });
  const second = await appendCompactModelItem(store, {
    raw: compactTaskStateText("summary bounds"),
    threadId: "thread-context-groups",
  });
  const third = await appendCompactModelItem(store, {
    raw: compactReasoningText("source linking"),
    threadId: "thread-context-groups",
  });
  const input = {
    threadId: "thread-context-groups",
    groups: [
      {
        sourceItemIds: [second.item.sourceItemId, first.item.sourceItemId],
      },
      {
        sourceItemIds: [third.item.sourceItemId],
      },
    ],
    createdAt: "2026-04-05T06:07:08.000Z",
  };

  const firstBuild = await store.buildContextBlocks(input);
  const secondBuild = await store.buildContextBlocks(input);
  const listed = await store.listThreadContextBlocks("thread-context-groups");

  assert.equal(firstBuild.length, 2);
  assert.deepEqual(
    secondBuild.map((block) => block.contextBlockId),
    firstBuild.map((block) => block.contextBlockId),
  );
  assert.deepEqual(
    listed.map((block) => block.contextBlockId),
    firstBuild.map((block) => block.contextBlockId),
  );
  assert.deepEqual(
    listed.map((block) => block.blockIndex),
    [1, 2],
  );
  assert.deepEqual(firstBuild[0].sourceItemIds, [
    first.item.sourceItemId,
    second.item.sourceItemId,
  ]);
  assert.deepEqual(firstBuild[1].sourceItemIds, [third.item.sourceItemId]);
  assert.deepEqual(
    await store.getContextBlock(firstBuild[1].contextBlockId),
    firstBuild[1],
  );

  const firstTurn = await store.getTurn(first.turn.turnId);
  const secondTurn = await store.getTurn(second.turn.turnId);
  const thirdTurn = await store.getTurn(third.turn.turnId);

  assert.deepEqual(firstTurn.derivedContextBlockIds, [
    firstBuild[0].contextBlockId,
  ]);
  assert.deepEqual(secondTurn.derivedContextBlockIds, [
    firstBuild[0].contextBlockId,
  ]);
  assert.deepEqual(thirdTurn.derivedContextBlockIds, [
    firstBuild[1].contextBlockId,
  ]);
});

test("keeps context block list order independent per thread", async (t) => {
  const { store } = await createIsolatedStore(t);
  const threadAFirst = await appendCompactModelItem(store, {
    raw: compactExplorationText("thread a first block"),
    threadId: "thread-context-list-a",
  });
  const threadBOnly = await appendCompactModelItem(store, {
    raw: compactTaskStateText("thread b only block"),
    threadId: "thread-context-list-b",
  });
  const threadASecond = await appendCompactModelItem(store, {
    raw: compactReasoningText("thread a second block"),
    threadId: "thread-context-list-a",
  });

  const threadABlocks = await store.buildContextBlocks({
    threadId: "thread-context-list-a",
    groups: [
      { sourceItemIds: [threadASecond.item.sourceItemId] },
      { sourceItemIds: [threadAFirst.item.sourceItemId] },
    ],
    createdAt: "2026-05-06T07:08:09.000Z",
  });
  const threadBBlocks = await store.buildContextBlocks({
    threadId: "thread-context-list-b",
    groups: [{ sourceItemIds: [threadBOnly.item.sourceItemId] }],
    createdAt: "2026-05-06T07:08:10.000Z",
  });

  assert.deepEqual(
    (await store.listThreadContextBlocks("thread-context-list-a")).map(
      (block) => block.contextBlockId,
    ),
    threadABlocks.map((block) => block.contextBlockId),
  );
  assert.deepEqual(
    (await store.listThreadContextBlocks("thread-context-list-b")).map(
      (block) => block.contextBlockId,
    ),
    threadBBlocks.map((block) => block.contextBlockId),
  );
  assert.deepEqual(
    threadABlocks.map((block) => block.sourceItemIds[0]),
    [threadAFirst.item.sourceItemId, threadASecond.item.sourceItemId],
  );
  assert.deepEqual(
    threadABlocks.map((block) => block.blockIndex),
    [1, 2],
  );
  assert.deepEqual(
    threadBBlocks.map((block) => block.blockIndex),
    [1],
  );
});

test("rejects context block groups with missing source items", async (t) => {
  const { store } = await createIsolatedStore(t);

  await assert.rejects(
    async () =>
      await store.buildContextBlocks({
        threadId: "thread-context-missing",
        groups: [{ sourceItemIds: ["source-item-missing"] }],
      }),
    /source item|sourceItemId|missing|not found/i,
  );
});

test("rejects non-compact source items", async (t) => {
  const { store } = await createIsolatedStore(t);
  const turn = await store.appendTurn({
    threadId: "thread-context-non-compact",
    turnRole: "user",
    raw: "Please keep packages/core/src/index.ts exact.",
  });
  const items = await store.listTurnSourceItems(turn.turnId);
  const exactItem = findItemByText(items, "packages/core/src/index.ts");

  assert.equal(exactItem.contextAction, "preserve_exact");
  await assert.rejects(
    async () =>
      await store.buildContextBlocks({
        threadId: "thread-context-non-compact",
        groups: [{ sourceItemIds: [exactItem.sourceItemId] }],
      }),
    /compact|contextAction|source item/i,
  );
});

test("rejects mixed-thread and wrong-thread source item groups", async (t) => {
  const { store } = await createIsolatedStore(t);
  const first = await appendCompactModelItem(store, {
    raw: compactExplorationText("thread one grouping"),
    threadId: "thread-context-thread-a",
  });
  const second = await appendCompactModelItem(store, {
    raw: compactTaskStateText("thread two grouping"),
    threadId: "thread-context-thread-b",
  });

  await assert.rejects(
    async () =>
      await store.buildContextBlocks({
        threadId: "thread-context-thread-a",
        groups: [
          {
            sourceItemIds: [first.item.sourceItemId, second.item.sourceItemId],
          },
        ],
      }),
    /thread|mixed|source item/i,
  );
  await assert.rejects(
    async () =>
      await store.buildContextBlocks({
        threadId: "thread-context-thread-c",
        groups: [{ sourceItemIds: [first.item.sourceItemId] }],
      }),
    /thread|source item/i,
  );
});

test("rejects empty context block inputs and empty groups", async (t) => {
  const { store } = await createIsolatedStore(t);

  await assert.rejects(
    async () =>
      await store.buildContextBlocks({
        threadId: "thread-context-empty",
        groups: [],
      }),
    /groups|empty/i,
  );
  await assert.rejects(
    async () =>
      await store.buildContextBlocks({
        threadId: "thread-context-empty",
        groups: [{ sourceItemIds: [] }],
      }),
    /sourceItemIds|source item|empty/i,
  );
  await assert.rejects(
    async () =>
      await store.buildContextBlocks({
        threadId: "thread-context-empty",
      }),
    /groups|required|array/i,
  );
});

async function appendCompactModelItem(store, input) {
  const turn = await store.appendTurn({
    threadId: input.threadId,
    turnRole: "model",
    raw: input.raw,
  });
  const items = await store.listTurnSourceItems(turn.turnId);
  const compactItems = items.filter((item) => item.contextAction === "compact");

  assert.equal(
    compactItems.length,
    1,
    `Expected one compact source item for ${input.raw}`,
  );

  return { item: compactItems[0], turn };
}

function compactExplorationText(topic) {
  return [
    `I inspected the ${topic} behavior and the remaining work is summarizing the repeated output because the handoff needs a smaller memory surface.`,
    "The useful detail is the investigation path, while the noisy trace can be represented as a durable context block.",
  ].join("\n");
}

function compactTaskStateText(topic) {
  return [
    `Working through the ${topic} shape because the next step is reducing long investigation notes into a reusable block.`,
    "The current state should survive compaction without carrying every intermediate sentence forward.",
  ].join("\n");
}

function compactReasoningText(topic) {
  return [
    `The ${topic} result should be compact because the detailed exploration is only needed when a future reader expands the original source item.`,
    "That keeps the active transcript focused while preserving links to the full source material.",
  ].join("\n");
}

function assertContextBlockShape(block) {
  assert.equal(typeof block.contextBlockId, "string");
  assert.equal(typeof block.threadId, "string");
  assert.equal(typeof block.blockIndex, "number");
  assert.equal(typeof block.summary, "string");
  assert.ok(Array.isArray(block.sourceItemIds));
  assert.ok(Array.isArray(block.labels));
  assert.equal(typeof block.createdAt, "string");
}

function assertSummaryBounds(summary) {
  const wordCount = summary.trim().split(/\s+/).filter(Boolean).length;

  assert.ok(wordCount >= 30, `Expected at least 30 words, got ${wordCount}`);
  assert.ok(wordCount <= 150, `Expected at most 150 words, got ${wordCount}`);
}

function assertTableExists(db, tableName) {
  const row = db
    .prepare(
      `SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = ?`,
    )
    .get(tableName);

  assert.ok(row, `Expected table ${tableName}`);
}

function assertForeignKey(db, tableName, expected) {
  const matches = db
    .prepare(`PRAGMA foreign_key_list(${tableName})`)
    .all()
    .filter(
      (foreignKey) =>
        foreignKey.from === expected.from &&
        foreignKey.table === expected.table &&
        foreignKey.to === expected.to,
    );

  assert.equal(
    matches.length,
    1,
    `Expected ${tableName}.${expected.from} to reference ${expected.table}.${expected.to}`,
  );
}
