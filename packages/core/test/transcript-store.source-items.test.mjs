import assert from "node:assert/strict";
import test from "node:test";

import {
  assertSourceItemShape,
  assertTextOffsets,
  createIsolatedStore,
  findItemByText,
} from "./helpers/transcript-store.mjs";

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

test("discards duplicate exact source items within one turn", async (t) => {
  const { store } = await createIsolatedStore(t);
  const raw = [
    "Please keep CHANGELOG.md untouched.",
    "",
    "Please keep CHANGELOG.md untouched.",
  ].join("\n");

  const turn = await store.appendTurn({
    threadId: "thread-duplicate-source-items",
    turnRole: "user",
    raw,
  });
  const items = await store.listTurnSourceItems(turn.turnId);

  assert.equal(items.length, 2);
  assert.equal(items[0].contextAction, "preserve_exact");
  assert.equal(items[0].actionReason, "preserve_exact:user_instruction");
  assert.equal(items[1].contextAction, "discard");
  assert.equal(items[1].actionReason, "discard:duplicate_in_turn");
  assert.ok(items[1].labels.includes("user_instruction"));
  assert.ok(items[1].labels.includes("exact_value"));
});

test("keeps text chunk byte offsets valid across surrogate boundaries", async (t) => {
  const { store } = await createIsolatedStore(t);
  const nonBmp = String.fromCodePoint(0x1f4a1);
  const raw = `A${nonBmp.repeat(3000)}Z`;

  const turn = await store.appendTurn({
    threadId: "thread-surrogate-boundaries",
    turnRole: "model",
    raw,
  });
  const items = await store.listTurnSourceItems(turn.turnId);
  const rawBytes = await store.readTurnRaw(turn.turnId);

  assert.ok(items.length > 1);

  for (const item of items) {
    assertTextOffsets(rawBytes, item);
    assert.doesNotMatch(item.renderedExcerpt, /[\uD800-\uDFFF]/u);
  }
});

test("compacts text media bytes that are not valid UTF-8", async (t) => {
  const { store } = await createIsolatedStore(t);
  const raw = Uint8Array.from([0xff, 0xfe, 0xfd]);

  const turn = await store.appendTurn({
    threadId: "thread-invalid-utf8",
    turnRole: "model",
    raw,
    mediaType: "text/plain; charset=utf-8",
  });
  const items = await store.listTurnSourceItems(turn.turnId);

  assert.equal(items.length, 1);

  const [item] = items;
  assert.equal(item.rawStartByteOffset, null);
  assert.equal(item.rawEndByteOffset, null);
  assert.equal(item.contextAction, "compact");
  assert.equal(item.actionReason, "compact:undecodable_text");
  assert.deepEqual(item.labels, ["file_output"]);
  assert.match(item.renderedExcerpt, /Undecodable text source item/);
  assert.match(item.renderedExcerpt, /3 bytes/);
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
