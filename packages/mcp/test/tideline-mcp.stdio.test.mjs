import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
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

test("serves tools over stdio with text and structured content", async (t) => {
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
    "assemble_current_context",
    "expand_context_block",
    "get_assembly_receipt",
    "get_context_block",
    "get_current_session",
    "get_session_status",
    "list_assembly_receipts",
    "list_context_blocks",
    "list_recent_messages",
    "list_relationships",
    "list_sessions",
    "list_thread_turns",
    "search_context",
  ]);

  const sessions = await client.callTool({
    name: "list_sessions",
    arguments: {},
  });

  assert.deepEqual(
    sessions.structuredContent.sessions.map((session) => session.threadId),
    [fixture.threadId],
  );
  assert.equal(sessions.structuredContent.sessions[0].turnCount, 6);
  assert.equal(
    sessions.structuredContent.sessions[0].nextActiveTurn,
    fixture.turns.length + 1,
  );
  assert.deepEqual(
    sessions.structuredContent.sessions[0].firstUserMessagePreview,
    {
      text: "Task: Anchor the original session objective.",
      role: "user",
      turnIndex: 1,
      createdAt: fixture.turns[0].createdAt,
      truncated: false,
    },
  );
  assert.deepEqual(
    sessions.structuredContent.sessions[0].latestUserMessagePreview,
    {
      text: "Current prompt body stays out of timeline resources.",
      role: "user",
      turnIndex: 6,
      createdAt: fixture.turns[5].createdAt,
      truncated: false,
    },
  );
  assertNoRawPointerFields(sessions.structuredContent.sessions[0]);

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

  const sessions = await client.readResource({
    uri: "memory://sessions",
  });

  assertResourceText(sessions, fixture.threadId);
  assertResourceText(sessions, "nextActiveTurn");

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

test("selects the current session from env hints before latest activity", async (t) => {
  const fixture = await createMcpErgonomicsFixture(t);
  const client = await connectClient(t, {
    args: [
      serverPath,
      "--sqlite-path",
      fixture.sqlitePath,
      "--blob-dir",
      fixture.blobDir,
    ],
    env: {
      CODEX_CONVERSATION_ID: fixture.latestThreadId,
      CODEX_SESSION_ID: fixture.latestThreadId,
      CODEX_THREAD_ID: fixture.latestThreadId,
      TIDELINE_THREAD_ID: fixture.currentThreadId,
    },
  });

  const current = await client.callTool({
    name: "get_current_session",
    arguments: {},
  });

  assert.equal(current.structuredContent.selectionSource, "TIDELINE_THREAD_ID");
  assert.equal(
    current.structuredContent.session.threadId,
    fixture.currentThreadId,
  );
  assert.equal(current.structuredContent.nextActiveTurn, 11);
  assert.deepEqual(current.structuredContent.latestTurn, {
    turnId: fixture.currentTurns[9].turnId,
    threadId: fixture.currentThreadId,
    turnIndex: 10,
    turnRole: "model",
    sourceItemIds: fixture.currentTurns[9].sourceItemIds,
    derivedContextBlockIds: [],
    createdAt: fixture.currentTurns[9].createdAt,
  });
  assert.deepEqual(current.structuredContent.latestUserMessagePreview, {
    text: "current latest user preview message",
    role: "user",
    turnIndex: 9,
    createdAt: fixture.currentTurns[8].createdAt,
    truncated: false,
  });
  assertTextContent(current, "TIDELINE_THREAD_ID");
});

test("falls back to the latest active session without env hints", async (t) => {
  const fixture = await createMcpErgonomicsFixture(t);
  const client = await connectClient(t, {
    args: [
      serverPath,
      "--sqlite-path",
      fixture.sqlitePath,
      "--blob-dir",
      fixture.blobDir,
    ],
  });

  const current = await client.callTool({
    name: "get_current_session",
    arguments: {},
  });

  assert.equal(
    current.structuredContent.selectionSource,
    "latest_active_session",
  );
  assert.equal(
    current.structuredContent.session.threadId,
    fixture.latestThreadId,
  );
  assert.equal(current.structuredContent.nextActiveTurn, 3);
  assert.equal(
    current.structuredContent.latestUserMessagePreview.text,
    "latest session user turn",
  );
});

test("lists recent messages with bounded text in chronological order", async (t) => {
  const fixture = await createMcpErgonomicsFixture(t);
  const client = await connectClient(t, {
    args: [
      serverPath,
      "--sqlite-path",
      fixture.sqlitePath,
      "--blob-dir",
      fixture.blobDir,
    ],
  });

  const recent = await client.callTool({
    name: "list_recent_messages",
    arguments: {
      max_text_length: 36,
      thread_id: fixture.currentThreadId,
    },
  });

  assert.equal(recent.structuredContent.threadId, fixture.currentThreadId);
  assert.deepEqual(
    recent.structuredContent.messages.map((message) => message.turnIndex),
    [3, 4, 5, 6, 7, 8, 9, 10],
  );
  assert.deepEqual(
    recent.structuredContent.messages.map((message) => message.role),
    ["user", "model", "user", "model", "user", "model", "user", "model"],
  );

  const longMessage = recent.structuredContent.messages.find(
    (message) => message.turnIndex === 5,
  );
  assert.ok(longMessage);
  assert.equal(longMessage.truncated, true);
  assert.ok(longMessage.text.length <= 36);

  const binaryMessage = recent.structuredContent.messages.find(
    (message) => message.turnIndex === 6,
  );
  assert.ok(binaryMessage);
  assert.equal(binaryMessage.truncated, false);
  assert.match(binaryMessage.text, /non-text/i);
  assert.match(binaryMessage.text, /application\/octet-stream/i);

  const latestMessage = recent.structuredContent.messages.at(-1);
  assert.equal(latestMessage.text, "current model 10 latest");
  assert.equal(latestMessage.createdAt, fixture.currentTurns[9].createdAt);
  assertTextContent(recent, "current latest user preview");
});

test("reports session status before and after pending tool flush", async (t) => {
  const fixture = await createMcpStatusFixture(t);
  const client = await connectClient(t, {
    args: [
      serverPath,
      "--sqlite-path",
      fixture.sqlitePath,
      "--blob-dir",
      fixture.blobDir,
    ],
  });

  const pending = await client.callTool({
    name: "get_session_status",
    arguments: { thread_id: fixture.threadId },
  });

  assert.equal(pending.structuredContent.threadId, fixture.threadId);
  assert.equal(
    pending.structuredContent.storage.sqlitePath,
    fixture.sqlitePath,
  );
  assert.equal(pending.structuredContent.storage.blobDir, fixture.blobDir);
  assert.equal(pending.structuredContent.turnCount, 1);
  assert.equal(pending.structuredContent.processedEventCount, 3);
  assert.equal(pending.structuredContent.pendingToolEventCount, 1);
  assert.equal(pending.structuredContent.captureState.pendingToolEvents, 1);
  assert.equal(
    pending.structuredContent.captureState.hookTrustVerification,
    "not_checked",
  );
  assert.equal(
    pending.structuredContent.captureState.hookInstallVerification,
    "not_checked",
  );
  assert.equal(
    pending.structuredContent.captureState.doctorCommand,
    "tideline-context doctor codex",
  );
  assert.equal(
    pending.structuredContent.latestStoredMessagePreview.text,
    "status prompt before pending tool",
  );

  await flushPendingStatusTool(fixture);

  const flushed = await client.callTool({
    name: "get_session_status",
    arguments: { thread_id: fixture.threadId },
  });

  assert.equal(flushed.structuredContent.turnCount, 2);
  assert.equal(flushed.structuredContent.processedEventCount, 4);
  assert.equal(flushed.structuredContent.pendingToolEventCount, 0);
  assert.equal(flushed.structuredContent.captureState.pendingToolEvents, 0);
  assert.equal(
    flushed.structuredContent.latestActivityAt,
    fixture.flushCreatedAt,
  );
  assert.equal(
    flushed.structuredContent.latestStoredMessagePreview.role,
    "model",
  );
  assert.match(
    flushed.structuredContent.latestStoredMessagePreview.text,
    /Model processed pending shell output/i,
  );
});

test("assembles current context with current-session defaults and overrides", async (t) => {
  const fixture = await createMcpFixture(t);
  const client = await connectClient(t, {
    args: [
      serverPath,
      "--sqlite-path",
      fixture.sqlitePath,
      "--blob-dir",
      fixture.blobDir,
    ],
    env: {
      TIDELINE_THREAD_ID: fixture.threadId,
    },
  });

  const assembled = await client.callTool({
    name: "assemble_current_context",
    arguments: {
      scope: "mcp",
      task: "Continue the integration",
    },
  });

  assert.equal(assembled.structuredContent.threadId, fixture.threadId);
  assert.equal(
    assembled.structuredContent.activeTurn,
    fixture.turns.length + 1,
  );
  assert.equal(
    assembled.structuredContent.receipt.activeTurn,
    fixture.turns.length + 1,
  );
  assert.equal(
    assembled.structuredContent.currentSession.selectionSource,
    "TIDELINE_THREAD_ID",
  );
  assert.equal(assembled.structuredContent.request.tokenBudget, 6000);
  assertTextContent(assembled, fixture.block.summary);

  const overridden = await client.callTool({
    name: "assemble_current_context",
    arguments: {
      active_turn: 6,
      token_budget: 5000,
    },
  });

  assert.equal(overridden.structuredContent.activeTurn, 6);
  assert.equal(overridden.structuredContent.request.tokenBudget, 5000);
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

test("uses default storage under the home directory for stdio startup", async (t) => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "tideline-mcp-home-"));
  const sqlitePath = path.join(homeDir, ".tideline", "tideline.sqlite");
  const blobDir = path.join(homeDir, ".tideline", "blobs");

  t.after(async () => {
    await rm(homeDir, { force: true, recursive: true });
  });

  const client = await connectClient(t, {
    args: [serverPath],
    env: {
      HOME: homeDir,
    },
  });

  const turns = await client.callTool({
    name: "list_thread_turns",
    arguments: { thread_id: "thread-default-empty" },
  });

  assert.deepEqual(turns.structuredContent.turns, []);
  assert.equal((await stat(path.dirname(sqlitePath))).isDirectory(), true);
  assert.equal((await stat(blobDir)).isDirectory(), true);
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

async function createMcpErgonomicsFixture(t) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "tideline-mcp-ergo-"));
  const sqlitePath = path.join(tempDir, "store.sqlite");
  const blobDir = path.join(tempDir, "blobs");
  const currentThreadId = "thread-current-session";
  const latestThreadId = "thread-latest-session";
  const store = await createTranscriptStore({ sqlitePath, blobDir });

  t.after(async () => {
    await rm(tempDir, { force: true, recursive: true });
  });

  try {
    const currentTurns = [];
    const currentRaw = [
      ["user", "current user 1 first preview"],
      ["model", "current model 2"],
      ["user", "current user 3"],
      ["model", "current model 4"],
      ["user", `current user 5 ${"x".repeat(120)}`],
      [
        "model",
        new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
        "application/octet-stream",
      ],
      ["user", "current user 7"],
      ["model", "current model 8"],
      ["user", "current latest user preview message"],
      ["model", "current model 10 latest"],
    ];

    for (const [index, item] of currentRaw.entries()) {
      const [turnRole, raw, mediaType] = item;
      currentTurns.push(
        await store.appendTurn({
          threadId: currentThreadId,
          turnRole,
          raw,
          mediaType,
          createdAt: `2026-07-08T12:${String(index + 1).padStart(2, "0")}:00.000Z`,
        }),
      );
    }

    await store.appendTurn({
      threadId: latestThreadId,
      turnRole: "user",
      raw: "latest session user turn",
      createdAt: "2026-07-08T12:20:00.000Z",
    });
    await store.appendTurn({
      threadId: latestThreadId,
      turnRole: "model",
      raw: "latest session model turn",
      createdAt: "2026-07-08T12:21:00.000Z",
    });

    return {
      blobDir,
      currentThreadId,
      currentTurns,
      latestThreadId,
      sqlitePath,
    };
  } finally {
    await store.close();
  }
}

async function createMcpStatusFixture(t) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "tideline-mcp-status-"));
  const sqlitePath = path.join(tempDir, "store.sqlite");
  const blobDir = path.join(tempDir, "blobs");
  const threadId = "thread-status-session";
  const flushCreatedAt = "2026-07-08T13:03:00.000Z";
  const store = await createTranscriptStore({ sqlitePath, blobDir });

  t.after(async () => {
    await rm(tempDir, { force: true, recursive: true });
  });

  try {
    await store.captureTurnEvent({
      eventId: "status-session-start",
      kind: "session_start",
      threadId,
      createdAt: "2026-07-08T13:00:00.000Z",
      payload: {},
    });
    await store.captureTurnEvent({
      eventId: "status-prompt",
      kind: "prompt_submit",
      threadId,
      createdAt: "2026-07-08T13:01:00.000Z",
      payload: { prompt: "status prompt before pending tool" },
    });
    await store.captureTurnEvent({
      eventId: "status-tool",
      kind: "tool_result",
      threadId,
      createdAt: "2026-07-08T13:02:00.000Z",
      payload: {
        tool_name: "shell",
        call_id: "call-status",
        input: { command: "pnpm --filter @tideline/mcp test" },
        output: "status tool output",
        status: "success",
      },
    });

    return { blobDir, flushCreatedAt, sqlitePath, threadId };
  } finally {
    await store.close();
  }
}

async function flushPendingStatusTool(fixture) {
  const store = await createTranscriptStore({
    blobDir: fixture.blobDir,
    sqlitePath: fixture.sqlitePath,
  });

  try {
    await store.captureTurnEvent({
      eventId: "status-model",
      kind: "model_response_complete",
      threadId: fixture.threadId,
      createdAt: fixture.flushCreatedAt,
      payload: {
        response: "Model processed pending shell output.",
      },
    });
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
  delete env.TIDELINE_HOME;
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

function assertNoRawPointerFields(value) {
  if (!value || typeof value !== "object") {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    assert.notEqual(key, "rawPointerId");
    assert.notEqual(key, "raw_pointer_id");
    assertNoRawPointerFields(child);
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
