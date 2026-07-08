import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createTranscriptStore } from "@tideline/core";

const serverPath = new URL("../dist/cli.js", import.meta.url).pathname;

test("MCP reads turns and context assembled from hook capture", async (t) => {
  const fixture = await createCapturedMcpFixture(t);
  const client = await connectClient(t, {
    args: [
      serverPath,
      "--sqlite-path",
      fixture.sqlitePath,
      "--blob-dir",
      fixture.blobDir,
    ],
  });

  const turns = await client.callTool({
    name: "list_thread_turns",
    arguments: { thread_id: fixture.threadId },
  });

  assert.equal(turns.structuredContent.turns.length, 7);
  assert.deepEqual(
    turns.structuredContent.turns.map((turn) => turn.turnRole),
    ["user", "model", "user", "model", "user", "model", "user"],
  );

  const blocks = await client.callTool({
    name: "list_context_blocks",
    arguments: { thread_id: fixture.threadId },
  });

  assert.equal(blocks.structuredContent.contextBlocks.length, 1);
  assert.match(
    blocks.structuredContent.contextBlocks[0].summary,
    /hook storage/i,
  );

  const assembled = await client.callTool({
    name: "assemble_context",
    arguments: {
      thread_id: fixture.threadId,
      active_turn: 7,
      token_budget: 5000,
    },
  });

  assert.deepEqual(assembled.structuredContent.receipt.contextBlockIds, [
    blocks.structuredContent.contextBlocks[0].contextBlockId,
  ]);
  assert.equal(assembled.structuredContent.receipt.status, "assembled");
  assert.ok(Array.isArray(assembled.structuredContent.receipt.items));
  assert.deepEqual(assembled.structuredContent.receipt.includedFullTurnIds, [
    fixture.turnIds[0],
    fixture.turnIds[1],
    fixture.turnIds[2],
    fixture.turnIds[5],
  ]);
  assertToolText(assembled, /hook storage/i);
  assertToolText(assembled, /recent model because this should stay recent/i);
  assertNoToolText(assembled, /Active prompt body stays out of assembly/i);

  const search = await client.callTool({
    name: "search_context",
    arguments: {
      thread_id: fixture.threadId,
      query: "hook storage captured tool output",
      limit: 3,
    },
  });

  assert.equal(search.structuredContent.results[0].entityType, "context_block");
  assert.equal(
    search.structuredContent.results[0].entityId,
    blocks.structuredContent.contextBlocks[0].contextBlockId,
  );

  const relationships = await client.callTool({
    name: "list_relationships",
    arguments: { thread_id: fixture.threadId },
  });

  assert.ok(
    relationships.structuredContent.relationships.some(
      (relationship) =>
        relationship.relationshipType === "derived_from" &&
        relationship.fromEntityId ===
          blocks.structuredContent.contextBlocks[0].contextBlockId,
    ),
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
});

async function createCapturedMcpFixture(t) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "tideline-mcp-hooks-"));
  const sqlitePath = path.join(tempDir, "store.sqlite");
  const blobDir = path.join(tempDir, "blobs");
  const threadId = "thread-mcp-hook-capture";
  const store = await createTranscriptStore({ sqlitePath, blobDir });

  t.after(async () => {
    await rm(tempDir, { force: true, recursive: true });
  });

  try {
    await store.captureTurnEvent({
      eventId: "mcp-hook-prompt-1",
      kind: "prompt_submit",
      threadId,
      createdAt: "2026-07-08T14:00:00.000Z",
      payload: { prompt: "Task: Anchor the hook capture session." },
    });
    await store.captureTurnEvent({
      eventId: "mcp-hook-model-1",
      kind: "model_response_complete",
      threadId,
      createdAt: "2026-07-08T14:00:01.000Z",
      payload: { response: "Decision: Use hook capture for the session." },
    });
    await store.captureTurnEvent({
      eventId: "mcp-hook-prompt-2",
      kind: "prompt_submit",
      threadId,
      createdAt: "2026-07-08T14:00:02.000Z",
      payload: { prompt: "Rules:\n- Keep MCP as the read surface." },
    });
    await store.captureTurnEvent({
      eventId: "mcp-hook-tool-1",
      kind: "tool_result",
      threadId,
      createdAt: "2026-07-08T14:00:03.000Z",
      payload: {
        tool_name: "shell",
        call_id: "call-mcp-1",
        input: { command: "pnpm --filter @tideline/mcp test" },
        status: "success",
        output: "PASS hook integration",
      },
    });
    await store.captureTurnEvent({
      eventId: "mcp-hook-model-2",
      kind: "model_response_complete",
      threadId,
      createdAt: "2026-07-08T14:00:04.000Z",
      payload: {
        message: {
          role: "assistant",
          content:
            "I inspected hook storage because captured tool output remains in progress.",
        },
      },
    });
    await store.captureTurnEvent({
      eventId: "mcp-hook-prompt-3",
      kind: "prompt_submit",
      threadId,
      createdAt: "2026-07-08T14:00:05.000Z",
      payload: { prompt: "Task: Middle user turn before the recent model." },
    });
    await store.captureTurnEvent({
      eventId: "mcp-hook-model-3",
      kind: "model_response_complete",
      threadId,
      createdAt: "2026-07-08T14:00:06.000Z",
      payload: {
        response:
          "I inspected recent model because this should stay recent full fidelity.",
      },
    });
    await store.captureTurnEvent({
      eventId: "mcp-hook-prompt-4",
      kind: "prompt_submit",
      threadId,
      createdAt: "2026-07-08T14:00:07.000Z",
      payload: { prompt: "Active prompt body stays out of assembly." },
    });

    const turns = await store.listThreadTurns(threadId);

    return {
      blobDir,
      sqlitePath,
      threadId,
      turnIds: turns.map((turn) => turn.turnId),
    };
  } finally {
    await store.close();
  }
}

async function connectClient(t, options) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: options.args,
    env: cleanStorageEnv(),
  });
  const client = new Client(
    { name: "tideline-mcp-hook-test", version: "0.0.0" },
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

function assertToolText(result, expected) {
  assert.match(toolText(result), expected);
}

function assertNoToolText(result, expected) {
  assert.doesNotMatch(toolText(result), expected);
}

function toolText(result) {
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}
