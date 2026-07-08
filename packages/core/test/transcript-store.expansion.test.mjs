import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createIsolatedStore } from "./helpers/transcript-store.mjs";

test("exports context block expansion public types and store method", async () => {
  const declarations = await readFile(
    new URL("../dist/index.d.ts", import.meta.url),
    "utf8",
  );
  const typeDeclarations = await readFile(
    new URL("../dist/types.d.ts", import.meta.url),
    "utf8",
  );
  const compactDeclarations = declarations.replace(/\s+/g, " ");
  const compactTypeDeclarations = typeDeclarations.replace(/\s+/g, " ");

  assert.match(compactDeclarations, /\bExpandContextBlockInput\b/);
  assert.match(compactDeclarations, /\bExpandedContextBlock\b/);
  assert.match(compactDeclarations, /\bExpandedContextBlockSource\b/);
  assert.match(
    compactTypeDeclarations,
    /excerptStartByteOffset: number \| null/,
  );
  assert.match(compactTypeDeclarations, /usedRenderedExcerpt: boolean/);
  assert.match(
    compactDeclarations,
    /expandContextBlock\(input: ExpandContextBlockInput\): Promise<ExpandedContextBlock \| undefined>/,
  );
});

test("expands context block source text from raw byte offsets", async (t) => {
  const { store } = await createIsolatedStore(t);
  const raw = [
    "Intro line before source material.",
    "",
    "I inspected byte offsets because the context block expansion must recover the exact source span.",
    "The expansion should include only the compact item text, not the surrounding transcript prefix or suffix.",
    "",
    "Suffix line after source material.",
  ].join("\n");
  const { block, item, turn } = await appendCompactBlock(store, {
    raw,
    threadId: "thread-expand-byte-offsets",
  });
  const rawBytes = await store.readTurnRaw(turn.turnId);
  const expectedExcerpt = Buffer.from(
    rawBytes.slice(item.rawStartByteOffset, item.rawEndByteOffset),
  ).toString("utf8");

  const expanded = await store.expandContextBlock({
    contextBlockId: block.contextBlockId,
  });
  const updatedTurn = await store.getTurn(turn.turnId);

  assert.ok(expanded);
  assert.deepEqual(expanded.contextBlock, block);
  assert.equal(expanded.tokenBudget, 5000);
  assert.equal(expanded.truncated, false);
  assert.equal(expanded.sources.length, 1);

  const [source] = expanded.sources;
  assert.deepEqual(source.sourceItem, item);
  assert.deepEqual(source.turn, updatedTurn);
  assert.deepEqual(source.turn.derivedContextBlockIds, [block.contextBlockId]);
  assert.equal(source.mediaType, "text/plain; charset=utf-8");
  assert.equal(source.rawByteLength, rawBytes.byteLength);
  assert.equal(source.excerpt, expectedExcerpt);
  assert.equal(source.excerptStartByteOffset, item.rawStartByteOffset);
  assert.equal(source.excerptEndByteOffset, item.rawEndByteOffset);
  assert.equal(source.truncated, false);
  assert.equal(source.usedRenderedExcerpt, false);
  assert.doesNotMatch(source.excerpt, /Intro line/);
  assert.doesNotMatch(source.excerpt, /Suffix line/);
});

test("falls back to rendered excerpt for non-text source items", async (t) => {
  const { store } = await createIsolatedStore(t);
  const turn = await store.appendTurn({
    threadId: "thread-expand-non-text",
    turnRole: "model",
    raw: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]),
    mediaType: "image/png",
  });
  const [item] = await store.listTurnSourceItems(turn.turnId);

  assert.equal(item.contextAction, "compact");
  assert.equal(item.rawStartByteOffset, null);
  assert.equal(item.rawEndByteOffset, null);

  const [block] = await store.buildContextBlocks({
    threadId: "thread-expand-non-text",
    groups: [{ sourceItemIds: [item.sourceItemId] }],
  });

  const expanded = await store.expandContextBlock({
    contextBlockId: block.contextBlockId,
  });

  assert.ok(expanded);
  assert.equal(expanded.sources.length, 1);
  assert.equal(expanded.sources[0].excerpt, item.renderedExcerpt);
  assert.equal(expanded.sources[0].excerptStartByteOffset, null);
  assert.equal(expanded.sources[0].excerptEndByteOffset, null);
  assert.equal(expanded.sources[0].mediaType, "image/png");
  assert.equal(expanded.sources[0].truncated, false);
  assert.equal(expanded.sources[0].usedRenderedExcerpt, true);
});

test("truncates expansion output to the token budget", async (t) => {
  const { store } = await createIsolatedStore(t);
  const raw = [
    "I inspected the verbose cache trace because expansion remains in progress and needs a bounded excerpt for compacted blocks.",
    "The expansion should keep the useful investigation path while avoiding every intermediate diagnostic sentence.",
    "The terminal marker should not fit into the deliberately small expansion budget.",
  ].join("\n");
  const { block, item } = await appendCompactBlock(store, {
    raw,
    threadId: "thread-expand-budget",
  });

  const expanded = await store.expandContextBlock({
    contextBlockId: block.contextBlockId,
    tokenBudget: 10,
  });

  assert.ok(expanded);
  assert.equal(expanded.tokenBudget, 10);
  assert.equal(expanded.truncated, true);
  assert.equal(expanded.sources.length, 1);
  assert.equal(expanded.sources[0].truncated, true);
  assert.ok(expanded.sources[0].excerpt.length <= 40);
  assert.equal(
    expanded.sources[0].excerptStartByteOffset,
    item.rawStartByteOffset,
  );
  assert.ok(expanded.sources[0].excerptEndByteOffset < item.rawEndByteOffset);
  assert.doesNotMatch(expanded.sources[0].excerpt, /terminal marker/i);
  assert.equal(
    expanded.estimatedTokens,
    estimateText(expanded.sources[0].excerpt),
  );
  assert.ok(expanded.estimatedTokens <= 10);
});

test("returns undefined for missing context blocks and rejects invalid budgets", async (t) => {
  const { store } = await createIsolatedStore(t);

  assert.equal(
    await store.expandContextBlock({
      contextBlockId: "missing-context-block",
    }),
    undefined,
  );

  await assert.rejects(
    async () =>
      await store.expandContextBlock({
        contextBlockId: "missing-context-block",
        tokenBudget: 0,
      }),
    /tokenBudget|token.*budget|positive/i,
  );
});

async function appendCompactBlock(store, input) {
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

  const [block] = await store.buildContextBlocks({
    threadId: input.threadId,
    groups: [{ sourceItemIds: [compactItems[0].sourceItemId] }],
  });

  return { block, item: compactItems[0], turn };
}

function estimateText(text) {
  return Math.ceil(text.length / 4);
}
