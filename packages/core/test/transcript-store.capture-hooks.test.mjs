import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createIsolatedStore,
  findItemByText,
  openSqlite,
} from "./helpers/transcript-store.mjs";

test("exports hook capture public types and store method", async () => {
  const declarations = await readFile(
    new URL("../dist/index.d.ts", import.meta.url),
    "utf8",
  );
  const compactDeclarations = declarations.replace(/\s+/g, " ");

  assert.match(compactDeclarations, /\bCaptureTurnEventInput\b/);
  assert.match(compactDeclarations, /\bCaptureTurnEventReceipt\b/);
  assert.match(
    compactDeclarations,
    /captureTurnEvent\(input: CaptureTurnEventInput\): Promise<CaptureTurnEventReceipt>/,
  );
});

test("records session start without appending transcript turns", async (t) => {
  const { sqlitePath, store } = await createIsolatedStore(t);
  const receipt = await store.captureTurnEvent({
    eventId: "event-session-start",
    kind: "session_start",
    threadId: "thread-capture-start",
    createdAt: "2026-07-08T12:00:00.000Z",
    payload: {},
  });

  assertReceiptShape(receipt, {
    eventId: "event-session-start",
    kind: "session_start",
    threadId: "thread-capture-start",
  });
  assert.deepEqual(receipt.appendedTurnIds, []);
  assert.deepEqual(receipt.flushedToolEventIds, []);
  assert.deepEqual(receipt.contextBlockIds, []);
  assert.deepEqual(receipt.timeline.turns, []);
  assert.deepEqual(await store.listThreadTurns("thread-capture-start"), []);

  const db = openSqlite(sqlitePath);

  try {
    assertTableExists(db, "hook_processed_events");
    assertTableExists(db, "hook_pending_tool_events");
  } finally {
    db.close();
  }
});

test("captures prompt, tool result, and assistant completion in transcript order", async (t) => {
  const { store } = await createIsolatedStore(t);
  const threadId = "thread-capture-session";

  const promptReceipt = await store.captureTurnEvent({
    eventId: "event-prompt-1",
    kind: "prompt_submit",
    threadId,
    createdAt: "2026-07-08T12:00:01.000Z",
    payload: {
      prompt: "Task: Capture the hook prompt as a user turn.",
    },
  });

  assert.deepEqual(promptReceipt.appendedTurnIds.length, 1);
  assert.deepEqual(promptReceipt.flushedToolEventIds, []);

  const pendingReceipt = await store.captureTurnEvent({
    eventId: "event-tool-1",
    kind: "tool_result",
    threadId,
    createdAt: "2026-07-08T12:00:02.000Z",
    payload: {
      tool_name: "shell",
      call_id: "call-1",
      input: { command: "pnpm --filter @tideline/core test" },
      status: "success",
      output: "PASS capture hook test\n",
    },
  });

  assert.deepEqual(pendingReceipt.appendedTurnIds, []);
  assert.deepEqual(pendingReceipt.flushedToolEventIds, []);
  assert.deepEqual((await store.listThreadTurns(threadId)).length, 1);

  const completionReceipt = await store.captureTurnEvent({
    eventId: "event-model-1",
    kind: "model_response_complete",
    threadId,
    createdAt: "2026-07-08T12:00:03.000Z",
    payload: {
      message: {
        role: "assistant",
        content:
          "I inspected hook storage because retry behavior remains in progress.",
      },
    },
  });
  const duplicateReceipt = await store.captureTurnEvent({
    eventId: "event-model-1",
    kind: "model_response_complete",
    threadId,
    createdAt: "2026-07-08T12:00:03.000Z",
    payload: {
      message: {
        role: "assistant",
        content:
          "I inspected hook storage because retry behavior remains in progress.",
      },
    },
  });
  const turns = await store.listThreadTurns(threadId);

  assert.deepEqual(duplicateReceipt, completionReceipt);
  assert.deepEqual(
    turns.map((turn) => turn.turnRole),
    ["user", "model"],
  );
  assert.equal(turns[1].turnIndex, 2);
  assert.deepEqual(completionReceipt.appendedTurnIds, [turns[1].turnId]);
  assert.deepEqual(completionReceipt.flushedToolEventIds, ["event-tool-1"]);
  assert.equal((await store.listThreadTurns(threadId)).length, 2);

  const raw = Buffer.from(await store.readTurnRaw(turns[1].turnId)).toString(
    "utf8",
  );

  assert.match(raw, /^I inspected hook storage because/m);
  assert.match(raw, /Tool: shell/);
  assert.match(raw, /Call ID: call-1/);
  assert.match(
    raw,
    /```json\n\{\n  "command": "pnpm --filter @tideline\/core test"\n\}\n```/,
  );
  assert.match(raw, /Status: success/);
  assert.match(raw, /```text\nPASS capture hook test\n```/);

  const sourceItems = await store.listTurnSourceItems(turns[1].turnId);
  const compactItem = findItemByText(sourceItems, "hook storage because retry");
  const toolItem = findItemByText(sourceItems, "PASS capture hook test");

  assert.equal(compactItem.contextAction, "compact");
  assert.ok(toolItem.labels.includes("tool_output"));
});

test("flushes pending tools before the next prompt submit", async (t) => {
  const { store } = await createIsolatedStore(t);
  const threadId = "thread-capture-tool-before-prompt";

  await store.captureTurnEvent({
    eventId: "event-prompt-existing",
    kind: "prompt_submit",
    threadId,
    createdAt: "2026-07-08T12:01:00.000Z",
    payload: { prompt: "Task: Existing prompt." },
  });
  await store.captureTurnEvent({
    eventId: "event-tool-before-prompt",
    kind: "tool_result",
    threadId,
    createdAt: "2026-07-08T12:01:01.000Z",
    payload: {
      tool_name: "read_file",
      call_id: "call-before-prompt",
      status: "error",
      output: "ENOENT: missing fixture",
    },
  });

  const receipt = await store.captureTurnEvent({
    eventId: "event-prompt-next",
    kind: "prompt_submit",
    threadId,
    createdAt: "2026-07-08T12:01:02.000Z",
    payload: { prompt: "Task: Next user prompt after pending tool." },
  });
  const turns = await store.listThreadTurns(threadId);

  assert.deepEqual(
    turns.map((turn) => turn.turnRole),
    ["user", "model", "user"],
  );
  assert.deepEqual(receipt.flushedToolEventIds, ["event-tool-before-prompt"]);
  assert.deepEqual(receipt.appendedTurnIds, [turns[1].turnId, turns[2].turnId]);
  assert.match(
    Buffer.from(await store.readTurnRaw(turns[1].turnId)).toString("utf8"),
    /Tool: read_file[\s\S]*Status: error[\s\S]*ENOENT: missing fixture/,
  );
  assert.match(
    Buffer.from(await store.readTurnRaw(turns[2].turnId)).toString("utf8"),
    /Next user prompt after pending tool/,
  );
});

test("records empty model completions without appending transcript turns", async (t) => {
  const { store } = await createIsolatedStore(t);
  const threadId = "thread-capture-empty-model";
  const receipt = await store.captureTurnEvent({
    eventId: "event-empty-model",
    kind: "model_response_complete",
    threadId,
    createdAt: "2026-07-08T12:02:00.000Z",
    payload: {},
  });

  assert.deepEqual(receipt.appendedTurnIds, []);
  assert.deepEqual(receipt.flushedToolEventIds, []);
  assert.deepEqual(await store.listThreadTurns(threadId), []);
});

test("session stop flushes tools, records checkpoint, and compacts eligible turns", async (t) => {
  const { store } = await createIsolatedStore(t);
  const threadId = "thread-capture-stop";

  await appendTurn(store, threadId, "user", "Task: Anchor one.");
  await appendTurn(store, threadId, "model", "Decision: Anchor two.");
  await appendTurn(store, threadId, "user", "Rules:\n- Keep anchors exact.");
  const compactTurn = await appendTurn(
    store,
    threadId,
    "model",
    "I inspected stop compaction because tool state remains in progress.",
  );
  await appendTurn(store, threadId, "user", "Task: Recent prompt.");

  const compactItem = findItemByText(
    await store.listTurnSourceItems(compactTurn.turnId),
    "stop compaction because tool state",
  );

  await store.captureTurnEvent({
    eventId: "event-stop-tool",
    kind: "tool_result",
    threadId,
    createdAt: "2026-07-08T12:03:00.000Z",
    payload: {
      tool_name: "shell",
      status: "success",
      output: "checkpoint command output",
    },
  });

  const receipt = await store.captureTurnEvent({
    eventId: "event-stop",
    kind: "session_stop",
    threadId,
    createdAt: "2026-07-08T12:03:01.000Z",
    payload: {
      checkpoint:
        "Working through stop checkpoint because the next session needs a compact task state.",
    },
  });
  const turns = await store.listThreadTurns(threadId);
  const blocks = await store.listThreadContextBlocks(threadId);

  assert.deepEqual(
    turns.map((turn) => turn.turnRole),
    ["user", "model", "user", "model", "user", "model", "model"],
  );
  assert.equal(receipt.flushedToolEventIds[0], "event-stop-tool");
  assert.deepEqual(receipt.appendedTurnIds, [turns[5].turnId, turns[6].turnId]);
  assert.deepEqual(
    blocks.map((block) => block.sourceItemIds),
    [[compactItem.sourceItemId]],
  );
  assert.deepEqual(receipt.contextBlockIds, [blocks[0].contextBlockId]);
});

test("prompt submit compacts uncovered compact middle items once", async (t) => {
  const { store } = await createIsolatedStore(t);
  const threadId = "thread-capture-auto-compact";

  await appendTurn(store, threadId, "user", "Task: Anchor one.");
  await appendTurn(store, threadId, "model", "Decision: Anchor two.");
  await appendTurn(store, threadId, "user", "Rules:\n- Keep anchors exact.");
  const turnFour = await appendTurn(
    store,
    threadId,
    "model",
    [
      "I inspected grouped alpha because the first compact item remains in progress.",
      "",
      "I inspected grouped beta because the second compact item remains in progress.",
    ].join("\n"),
  );
  const turnFive = await appendTurn(
    store,
    threadId,
    "model",
    "I inspected separate gamma because another turn remains in progress.",
  );
  const turnSix = await appendTurn(
    store,
    threadId,
    "model",
    "I inspected recent delta because this turn must stay full fidelity.",
  );

  const turnFourCompactItems = (
    await store.listTurnSourceItems(turnFour.turnId)
  ).filter((item) => item.contextAction === "compact");
  const turnFiveCompactItem = findItemByText(
    await store.listTurnSourceItems(turnFive.turnId),
    "separate gamma because another",
  );
  const turnSixCompactItem = findItemByText(
    await store.listTurnSourceItems(turnSix.turnId),
    "recent delta because this turn",
  );

  assert.equal(turnFourCompactItems.length, 2);

  const receipt = await store.captureTurnEvent({
    eventId: "event-compact-prompt",
    kind: "prompt_submit",
    threadId,
    createdAt: "2026-07-08T12:04:00.000Z",
    payload: { prompt: "Task: Active prompt should trigger compaction." },
  });
  const duplicateReceipt = await store.captureTurnEvent({
    eventId: "event-compact-prompt",
    kind: "prompt_submit",
    threadId,
    createdAt: "2026-07-08T12:04:00.000Z",
    payload: { prompt: "Task: Active prompt should trigger compaction." },
  });
  const blocks = await store.listThreadContextBlocks(threadId);
  const packet = await store.assembleContext({
    threadId,
    activeTurn: 7,
  });

  assert.deepEqual(duplicateReceipt, receipt);
  assert.deepEqual(
    blocks.map((block) => block.sourceItemIds),
    [
      turnFourCompactItems.map((item) => item.sourceItemId),
      [turnFiveCompactItem.sourceItemId],
    ],
  );
  assert.deepEqual(
    blocks
      .flatMap((block) => block.sourceItemIds)
      .includes(turnSixCompactItem.sourceItemId),
    false,
  );
  assert.deepEqual(receipt.contextBlockIds, [
    blocks[0].contextBlockId,
    blocks[1].contextBlockId,
  ]);
  assert.equal((await store.listThreadContextBlocks(threadId)).length, 2);
  assert.deepEqual(
    getSection(packet, "compacted_context_blocks").items.map(
      (item) => item.contextBlockId,
    ),
    blocks.map((block) => block.contextBlockId),
  );
  assert.match(
    sectionText(getSection(packet, "recent_full_transcript")),
    /recent delta because this turn must stay full fidelity/,
  );
});

async function appendTurn(store, threadId, turnRole, raw) {
  return await store.appendTurn({ threadId, turnRole, raw });
}

function assertReceiptShape(receipt, expected) {
  assert.equal(receipt.eventId, expected.eventId);
  assert.equal(receipt.kind, expected.kind);
  assert.equal(receipt.threadId, expected.threadId);
  assert.equal(typeof receipt.createdAt, "string");
  assert.ok(Array.isArray(receipt.appendedTurnIds));
  assert.ok(Array.isArray(receipt.flushedToolEventIds));
  assert.ok(Array.isArray(receipt.contextBlockIds));
  assert.ok(receipt.timeline);
  assert.ok(Array.isArray(receipt.timeline.turns));
  assert.ok(Array.isArray(receipt.timeline.contextBlocks));
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

function getSection(packet, kind) {
  const section = packet.sections.find((candidate) => candidate.kind === kind);

  assert.ok(section, `Expected section ${kind}`);
  return section;
}

function sectionText(section) {
  return section.items.map((item) => item.text).join("\n");
}
