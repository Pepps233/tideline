import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createTranscriptStore } from "@tideline/core";

const serverPath = new URL("../dist/cli.js", import.meta.url).pathname;

test("exports the MCP server factory", async () => {
  const declarations = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../dist/index.d.ts", import.meta.url), "utf8"),
  );
  const module = await import("../dist/index.js");

  assert.equal(typeof module.createTidelineMcpServer, "function");
  assert.match(declarations, /\bcreateTidelineMcpServer\b/);
});

test.skip("serves tools over stdio with text and structured content", async (t) => {
  const fixture = await createMcpFixture(t);
  const client = await connectClient(t, {
    args: [
      serverPath,
      "--sqlite-path",
      fixture.sqlitePath,
      "--blob-dir",
      fixture.blobDir,
    ],
  });

  const tools = await client.listTools();

  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
    "assemble_context",
    "expand_context_block",
    "get_assembly_receipt",
    "get_context_block",
    "list_assembly_receipts",
    "list_context_blocks",
    "list_relationships",
    "list_thread_turns",
    "search_context",
  ]);

  const turns = await client.callTool({
    name: "list_thread_turns",
    arguments: { thread_id: fixture.threadId },
  });

  assertTextContent(turns, fixture.threadId);
  assert.equal(turns.structuredContent.threadId, fixture.threadId);
  assert.equal(turns.structuredContent.turns.length, fixture.turns.length);
  assert.equal(turns.structuredContent.turns[0].rawPointerId, undefined);
  assert.equal(turns.structuredContent.turns[0].turnRole, "user");

  const blocks = await client.callTool({
    name: "list_context_blocks",
    arguments: { thread_id: fixture.threadId },
  });

  assertTextContent(blocks, fixture.block.contextBlockId);
  assert.deepEqual(blocks.structuredContent.contextBlocks, [fixture.block]);

  const block = await client.callTool({
    name: "get_context_block",
    arguments: { context_block_id: fixture.block.contextBlockId },
  });

  assertTextContent(block, fixture.block.summary);
  assert.deepEqual(block.structuredContent, fixture.block);

  const assembled = await client.callTool({
    name: "assemble_context",
    arguments: {
      thread_id: fixture.threadId,
      active_turn: 6,
      task: "Continue the integration",
      scope: "mcp",
      token_budget: 5000,
    },
  });

  assertTextContent(assembled, fixture.block.summary);
  assert.equal(assembled.structuredContent.threadId, fixture.threadId);
  assert.equal(assembled.structuredContent.receipt.status, "assembled");
  assert.ok(Array.isArray(assembled.structuredContent.receipt.items));
  assert.deepEqual(assembled.structuredContent.receipt.contextBlockIds, [
    fixture.block.contextBlockId,
  ]);

  const search = await client.callTool({
    name: "search_context",
    arguments: {
      thread_id: fixture.threadId,
      query: "recover exact source spans",
      limit: 3,
    },
  });

  assert.equal(search.structuredContent.threadId, fixture.threadId);
  assert.equal(search.structuredContent.results[0].entityType, "context_block");
  assert.equal(
    search.structuredContent.results[0].entityId,
    fixture.block.contextBlockId,
  );

  const relationships = await client.callTool({
    name: "list_relationships",
    arguments: { thread_id: fixture.threadId },
  });

  assert.ok(
    relationships.structuredContent.relationships.some(
      (relationship) =>
        relationship.relationshipType === "derived_from" &&
        relationship.fromEntityId === fixture.block.contextBlockId &&
        relationship.toEntityId === fixture.item.sourceItemId,
    ),
  );

  const receipt = await client.callTool({
    name: "get_assembly_receipt",
    arguments: {
      assembly_id: assembled.structuredContent.receipt.assemblyId,
    },
  });

  assert.deepEqual(
    receipt.structuredContent,
    assembled.structuredContent.receipt,
  );

  const receipts = await client.callTool({
    name: "list_assembly_receipts",
    arguments: { thread_id: fixture.threadId },
  });

  assert.deepEqual(
    receipts.structuredContent.assemblyReceipts.map(
      (assemblyReceipt) => assemblyReceipt.assemblyId,
    ),
    [assembled.structuredContent.receipt.assemblyId],
  );

  const expanded = await client.callTool({
    name: "expand_context_block",
    arguments: {
      context_block_id: fixture.block.contextBlockId,
      token_budget: 5000,
    },
  });

  assertTextContent(expanded, "recover exact source spans");
  assert.equal(
    expanded.structuredContent.contextBlock.contextBlockId,
    fixture.block.contextBlockId,
  );
  assert.equal(expanded.structuredContent.sources.length, 1);
  assert.equal(
    expanded.structuredContent.sources[0].sourceItem.sourceItemId,
    fixture.item.sourceItemId,
  );
});

test("serves registered resources over stdio", async (t) => {
  const fixture = await createMcpFixture(t);
  const client = await connectClient(t, {
    args: [
      serverPath,
      "--sqlite-path",
      fixture.sqlitePath,
      "--blob-dir",
      fixture.blobDir,
    ],
  });

  const timeline = await client.readResource({
    uri: `memory://session/${fixture.threadId}/timeline`,
  });

  assertResourceText(timeline, fixture.threadId);
  assertResourceText(timeline, fixture.block.contextBlockId);
  assertNoResourceText(timeline, "Current prompt body stays out of timeline");

  const block = await client.readResource({
    uri: `memory://context-block/${fixture.block.contextBlockId}`,
  });

  assertResourceText(block, fixture.block.contextBlockId);
  assertResourceText(block, fixture.block.summary);

  const source = await client.readResource({
    uri: `memory://context-block/${fixture.block.contextBlockId}/source`,
  });

  assertResourceText(source, "recover exact source spans");
  assertResourceText(source, fixture.item.sourceItemId);

  await assert.rejects(
    async () =>
      await client.readResource({
        uri: "memory://context-block/missing-block/source",
      }),
    /missing-block|not found/i,
  );
});

test("returns MCP tool errors for user-correctable not found and budget errors", async (t) => {
  const fixture = await createMcpFixture(t);
  const client = await connectClient(t, {
    args: [
      serverPath,
      "--sqlite-path",
      fixture.sqlitePath,
      "--blob-dir",
      fixture.blobDir,
    ],
  });

  const missing = await client.callTool({
    name: "get_context_block",
    arguments: { context_block_id: "missing-block" },
  });

  assert.equal(missing.isError, true);
  assertTextContent(missing, "Context block not found");

  const overBudget = await client.callTool({
    name: "expand_context_block",
    arguments: {
      context_block_id: fixture.block.contextBlockId,
      token_budget: 15001,
    },
  });

  assert.equal(overBudget.isError, true);
  assertTextContent(overBudget, "token_budget");
});

test("uses storage environment fallbacks for stdio startup", async (t) => {
  const fixture = await createMcpFixture(t);
  const client = await connectClient(t, {
    args: [serverPath],
    env: {
      TIDELINE_BLOB_DIR: fixture.blobDir,
      TIDELINE_SQLITE_PATH: fixture.sqlitePath,
    },
  });

  const blocks = await client.callTool({
    name: "list_context_blocks",
    arguments: { thread_id: fixture.threadId },
  });

  assert.deepEqual(blocks.structuredContent.contextBlocks, [fixture.block]);
});

test("fails fast when storage configuration is absent", async () => {
  const child = spawn(process.execPath, [serverPath], {
    env: cleanStorageEnv(),
    stdio: ["ignore", "ignore", "pipe"],
  });
  const stderrChunks = [];

  child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

  const exit = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  const stderr = Buffer.concat(stderrChunks).toString("utf8");

  assert.notEqual(exit.code, 0);
  assert.equal(exit.signal, null);
  assert.match(stderr, /--sqlite-path|TIDELINE_SQLITE_PATH/i);
  assert.match(stderr, /--blob-dir|TIDELINE_BLOB_DIR/i);
});

async function createMcpFixture(t) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "tideline-mcp-"));
  const sqlitePath = path.join(tempDir, "store.sqlite");
  const blobDir = path.join(tempDir, "blobs");
  const threadId = "thread-mcp-stdio";
  const store = await createTranscriptStore({ sqlitePath, blobDir });

  t.after(async () => {
    await rm(tempDir, { force: true, recursive: true });
  });

  try {
    const turns = [];

    async function append(turnRole, raw) {
      const turn = await store.appendTurn({ threadId, turnRole, raw });

      turns.push(turn);
      return turn;
    }

    await append("user", "Task: Anchor the original session objective.");
    await append("model", "Decision: Use the stdio MCP adapter.");
    await append("user", "Rules:\n- Keep generated changelogs untouched.");
    const compactTurn = await append(
      "model",
      [
        "I inspected recover exact source spans because the compacted block still needs expansion through MCP.",
        "The source payload should be retrievable through a resource without exposing unrelated transcript bodies.",
      ].join("\n"),
    );
    await append("user", "Task: Recent turn before the active prompt.");
    await append(
      "user",
      "Current prompt body stays out of timeline resources.",
    );

    const [item] = (await store.listTurnSourceItems(compactTurn.turnId)).filter(
      (sourceItem) => sourceItem.contextAction === "compact",
    );

    assert.ok(item);

    const [block] = await store.buildContextBlocks({
      threadId,
      groups: [{ sourceItemIds: [item.sourceItemId] }],
    });

    return { blobDir, block, item, sqlitePath, threadId, turns };
  } finally {
    await store.close();
  }
}

async function connectClient(t, options) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: options.args,
    env: {
      ...cleanStorageEnv(),
      ...(options.env ?? {}),
    },
  });
  const client = new Client(
    { name: "tideline-mcp-test", version: "0.0.0" },
    { capabilities: {} },
  );

  await client.connect(transport);
  t.after(async () => {
    await client.close();
  });

  return client;
}

function cleanStorageEnv() {
  const env = { ...process.env };

  delete env.TIDELINE_SQLITE_PATH;
  delete env.TIDELINE_BLOB_DIR;
  return env;
}

function assertTextContent(result, expected) {
  const text = result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");

  assert.match(text, new RegExp(escapeRegExp(expected), "i"));
}

function assertResourceText(result, expected) {
  const text = result.contents
    .filter((item) => typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");

  assert.match(text, new RegExp(escapeRegExp(expected), "i"));
}

function assertNoResourceText(result, expected) {
  const text = result.contents
    .filter((item) => typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");

  assert.doesNotMatch(text, new RegExp(escapeRegExp(expected), "i"));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
