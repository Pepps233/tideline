import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createIsolatedStore,
  findItemByText,
} from "./helpers/transcript-store.mjs";

test("exports assembly public types and store method", async () => {
  const declarations = await readFile(
    new URL("../dist/index.d.ts", import.meta.url),
    "utf8",
  );
  const compactDeclarations = declarations.replace(/\s+/g, " ");

  assert.match(compactDeclarations, /\bAssembleContextInput\b/);
  assert.match(compactDeclarations, /\bAssembledContextPacket\b/);
  assert.match(compactDeclarations, /\bAssemblyReceipt\b/);
  assert.match(
    compactDeclarations,
    /assembleContext\(input: AssembleContextInput\): Promise<AssembledContextPacket>/,
  );
});

test("assembles anchors, recent transcript, middle exact items, context blocks, and references", async (t) => {
  const fixture = await createAssemblyFixture(t);
  const packet = await fixture.store.assembleContext({
    threadId: fixture.threadId,
    activeTurn: 10,
  });

  assert.equal(packet.threadId, fixture.threadId);
  assert.equal(packet.activeTurn, 10);
  assert.deepEqual(
    packet.sections.map((section) => section.kind),
    [
      "full_transcript_anchors",
      "recent_full_transcript",
      "exact_source_items",
      "open_questions",
      "compacted_context_blocks",
      "expandable_sources",
    ],
  );

  const anchors = getSection(packet, "full_transcript_anchors");
  assert.deepEqual(
    anchors.items.map((item) => item.turnId),
    fixture.turns.slice(0, 3).map((turn) => turn.turnId),
  );
  assert.deepEqual(
    anchors.items.map((item) => item.turnIndex),
    [1, 2, 3],
  );
  assert.ok(
    anchors.items.every(
      (item) => item.sourceType === "turn" && item.text.length > 0,
    ),
  );

  const recent = getSection(packet, "recent_full_transcript");
  assert.deepEqual(
    recent.items.map((item) => item.turnId),
    [fixture.turns[8].turnId],
  );
  assert.match(recent.items[0].text, /turn nine shifts into middle/i);
  assert.doesNotMatch(sectionText(packet), /stored turn ten becomes recent/i);

  const exactItems = getSection(packet, "exact_source_items").items;
  assert.deepEqual(
    exactItems.map((item) => item.sourceItemIds?.[0]),
    [fixture.items.exactTurnFour.sourceItemId],
  );
  assert.match(exactItems[0].text, /preserve exact assembly instruction/i);
  assert.doesNotMatch(
    exactItems.map((item) => item.text).join("\n"),
    /database migration should remain postponed/i,
  );

  const openQuestions = getSection(packet, "open_questions").items;
  assert.deepEqual(
    openQuestions.map((item) => item.sourceItemIds?.[0]),
    [fixture.items.openQuestion.sourceItemId],
  );
  assert.match(openQuestions[0].text, /database migration should remain/i);

  const contextBlocks = getSection(packet, "compacted_context_blocks").items;
  assert.deepEqual(
    contextBlocks.map((item) => item.contextBlockId),
    [fixture.blocks.covered.contextBlockId],
  );
  assert.deepEqual(contextBlocks[0].sourceItemIds, [
    fixture.items.coveredCompact.sourceItemId,
  ]);
  assert.match(contextBlocks[0].text, /storage because retry behavior/i);

  const renderedSourceIds = new Set(
    packet.sections
      .filter((section) => section.kind !== "expandable_sources")
      .flatMap((section) =>
        section.items.flatMap((item) => item.sourceItemIds ?? []),
      ),
  );
  assert.equal(
    renderedSourceIds.has(fixture.items.coveredCompact.sourceItemId),
    true,
  );
  assert.equal(
    renderedSourceIds.has(fixture.items.uncoveredCompact.sourceItemId),
    false,
  );
  assert.equal(
    renderedSourceIds.has(fixture.items.discarded.sourceItemId),
    false,
  );

  const expandableSources = getSection(packet, "expandable_sources").items;
  assert.ok(
    expandableSources.some((item) =>
      item.sourceItemIds?.includes(fixture.items.exactTurnFour.sourceItemId),
    ),
  );
  assert.ok(
    expandableSources.some((item) =>
      item.sourceItemIds?.includes(fixture.items.coveredCompact.sourceItemId),
    ),
  );
  assert.ok(
    expandableSources.some(
      (item) =>
        item.sourceItemIds?.includes(
          fixture.items.uncoveredCompact.sourceItemId,
        ) && /no context block/i.test(item.reason),
    ),
  );
  assert.equal(
    expandableSources.some((item) =>
      item.sourceItemIds?.includes(fixture.items.discarded.sourceItemId),
    ),
    false,
  );

  assert.deepEqual(
    packet.receipt.includedFullTurnIds,
    [1, 2, 3, 9].map((turnIndex) => fixture.turns[turnIndex - 1].turnId),
  );
  assert.deepEqual(
    packet.receipt.middleTurnIds,
    [4, 5, 6, 7, 8].map((turnIndex) => fixture.turns[turnIndex - 1].turnId),
  );
  assert.deepEqual(packet.receipt.exactSourceItemIds, [
    fixture.items.exactTurnFour.sourceItemId,
    fixture.items.openQuestion.sourceItemId,
  ]);
  assert.deepEqual(packet.receipt.contextBlockIds, [
    fixture.blocks.covered.contextBlockId,
  ]);
  assert.deepEqual(packet.receipt.discardedSourceItemIds, [
    fixture.items.discarded.sourceItemId,
  ]);
  assert.equal(packet.receipt.estimatedTokens, estimatePacketTokens(packet));
  assert.match(packet.receipt.createdAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("shifts active turn zones by turn_index", async (t) => {
  const fixture = await createAssemblyFixture(t);
  const packet = await fixture.store.assembleContext({
    threadId: fixture.threadId,
    activeTurn: 11,
  });

  assert.deepEqual(
    getSection(packet, "recent_full_transcript").items.map(
      (item) => item.turnId,
    ),
    [fixture.turns[9].turnId],
  );
  assert.match(
    sectionText(getSection(packet, "recent_full_transcript")),
    /stored turn ten becomes recent/i,
  );
  assert.deepEqual(
    packet.receipt.middleTurnIds,
    [4, 5, 6, 7, 8, 9].map((turnIndex) => fixture.turns[turnIndex - 1].turnId),
  );

  const exactSourceIds = getSection(packet, "exact_source_items").items.flatMap(
    (item) => item.sourceItemIds ?? [],
  );
  assert.ok(exactSourceIds.includes(fixture.items.exactTurnFour.sourceItemId));
  assert.ok(exactSourceIds.includes(fixture.items.exactTurnNine.sourceItemId));
  assert.doesNotMatch(sectionText(packet), /current prompt should stay out/i);
});

test("applies token budget in deterministic section order", async (t) => {
  const fixture = await createAssemblyFixture(t);
  const fullPacket = await fixture.store.assembleContext({
    threadId: fixture.threadId,
    activeTurn: 10,
  });
  const budgetThroughRecent =
    estimateItems(getSection(fullPacket, "full_transcript_anchors").items) +
    estimateItems(getSection(fullPacket, "recent_full_transcript").items);

  const firstPacket = await fixture.store.assembleContext({
    threadId: fixture.threadId,
    activeTurn: 10,
    tokenBudget: budgetThroughRecent,
  });
  const secondPacket = await fixture.store.assembleContext({
    threadId: fixture.threadId,
    activeTurn: 10,
    tokenBudget: budgetThroughRecent,
  });

  assert.equal(firstPacket.receipt.estimatedTokens, budgetThroughRecent);
  assert.equal(
    firstPacket.receipt.estimatedTokens,
    estimatePacketTokens(firstPacket),
  );
  assert.deepEqual(sectionItemKeys(firstPacket), sectionItemKeys(secondPacket));
  assert.deepEqual(
    firstPacket.receipt.includedFullTurnIds,
    [1, 2, 3, 9].map((turnIndex) => fixture.turns[turnIndex - 1].turnId),
  );
  assert.deepEqual(getSection(firstPacket, "exact_source_items").items, []);
  assert.deepEqual(getSection(firstPacket, "open_questions").items, []);
  assert.deepEqual(
    getSection(firstPacket, "compacted_context_blocks").items,
    [],
  );
  assert.deepEqual(getSection(firstPacket, "expandable_sources").items, []);
});

test("rejects invalid assembly input clearly", async (t) => {
  const { store } = await createIsolatedStore(t);

  await assert.rejects(
    async () =>
      await store.assembleContext({
        activeTurn: 1,
      }),
    /threadId|thread.*id|missing|empty/i,
  );
  await assert.rejects(
    async () =>
      await store.assembleContext({
        threadId: "thread-invalid-assembly",
        activeTurn: 0,
      }),
    /activeTurn|active.*turn|integer|positive/i,
  );
  await assert.rejects(
    async () =>
      await store.assembleContext({
        threadId: "thread-invalid-assembly",
        activeTurn: 1.5,
      }),
    /activeTurn|active.*turn|integer/i,
  );
  await assert.rejects(
    async () =>
      await store.assembleContext({
        threadId: "thread-invalid-assembly",
        activeTurn: 1,
        tokenBudget: 0,
      }),
    /tokenBudget|token.*budget|positive/i,
  );
});

async function createAssemblyFixture(t) {
  const { store } = await createIsolatedStore(t);
  const threadId = "thread-assembly";
  const turns = [];
  const itemsByTurn = [];

  async function append(turnRole, raw) {
    const turn = await store.appendTurn({ threadId, turnRole, raw });
    const items = await store.listTurnSourceItems(turn.turnId);

    turns.push(turn);
    itemsByTurn.push(items);
    return { items, turn };
  }

  await append("user", "Task: Anchor one records the original user objective.");
  await append("model", "Decision: Anchor two keeps design decision text.");
  await append(
    "user",
    ["Rules:", "- Keep CHANGELOG.md untouched for assembly tests."].join("\n"),
  );
  const turnFour = await append(
    "user",
    "Please preserve exact assembly instruction for continuity.",
  );
  const turnFive = await append(
    "model",
    "I inspected storage because retry behavior remains in progress.",
  );
  const turnSix = await append(
    "model",
    "I checked grouping because coverage remains in progress.",
  );
  const turnSeven = await append(
    "user",
    "Thanks in advance for taking a look.",
  );
  const turnEight = await append(
    "user",
    "Which database migration should remain postponed?",
  );
  const turnNine = await append(
    "model",
    "Decision: turn nine shifts into middle as exact source.",
  );
  await append(
    "user",
    "Task: stored turn ten becomes recent when active turn eleven.",
  );
  await append("user", "Task: current prompt should stay out.");

  const exactTurnFour = findItemByText(
    turnFour.items,
    "preserve exact assembly instruction",
  );
  const coveredCompact = findItemByText(
    turnFive.items,
    "storage because retry behavior",
  );
  const uncoveredCompact = findItemByText(
    turnSix.items,
    "grouping because coverage",
  );
  const discarded = findItemByText(turnSeven.items, "Thanks in advance");
  const openQuestion = findItemByText(
    turnEight.items,
    "database migration should remain",
  );
  const exactTurnNine = findItemByText(
    turnNine.items,
    "turn nine shifts into middle",
  );

  assert.equal(exactTurnFour.contextAction, "preserve_exact");
  assert.equal(coveredCompact.contextAction, "compact");
  assert.equal(uncoveredCompact.contextAction, "compact");
  assert.equal(discarded.contextAction, "discard");
  assert.equal(openQuestion.contextAction, "preserve_exact");
  assert.ok(openQuestion.labels.includes("open_question"));
  assert.equal(exactTurnNine.contextAction, "preserve_exact");

  const [covered] = await store.buildContextBlocks({
    threadId,
    groups: [{ sourceItemIds: [coveredCompact.sourceItemId] }],
  });

  return {
    blocks: {
      covered,
    },
    items: {
      coveredCompact,
      discarded,
      exactTurnFour,
      exactTurnNine,
      openQuestion,
      uncoveredCompact,
    },
    itemsByTurn,
    store,
    threadId,
    turns,
  };
}

function getSection(packet, kind) {
  const section = packet.sections.find((candidate) => candidate.kind === kind);

  assert.ok(section, `Expected section ${kind}`);
  return section;
}

function sectionText(value) {
  const sections = Array.isArray(value.sections) ? value.sections : [value];

  return sections
    .flatMap((section) => section.items)
    .map((item) => item.text)
    .join("\n");
}

function estimatePacketTokens(packet) {
  return estimateItems(packet.sections.flatMap((section) => section.items));
}

function estimateItems(items) {
  return items.reduce((total, item) => total + estimateText(item.text), 0);
}

function estimateText(text) {
  return Math.ceil(text.length / 4);
}

function sectionItemKeys(packet) {
  return packet.sections.map((section) => ({
    kind: section.kind,
    itemIds: section.items.map((item) => item.id),
  }));
}
