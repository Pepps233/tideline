import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createTranscriptStore } from "@tideline/core";

const cliPath = new URL("../dist/cli.js", import.meta.url).pathname;

test("reads one JSON event from stdin and writes one JSON receipt", async (t) => {
  const fixture = await createHookFixture(t);
  const event = {
    event_id: "cli-prompt-1",
    kind: "prompt_submit",
    thread_id: "thread-cli-flags",
    created_at: "2026-07-08T13:00:00.000Z",
    payload: {
      prompt: "Task: Capture from hook CLI flags.",
    },
  };
  const result = await runHookCli({
    args: ["--sqlite-path", fixture.sqlitePath, "--blob-dir", fixture.blobDir],
    input: JSON.stringify(event),
  });

  assert.equal(result.exit.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.trim().split("\n").length, 1);

  const receipt = JSON.parse(result.stdout);

  assert.equal(receipt.eventId, "cli-prompt-1");
  assert.equal(receipt.kind, "prompt_submit");
  assert.equal(receipt.threadId, "thread-cli-flags");
  assert.equal(receipt.appendedTurnIds.length, 1);

  const store = await createTranscriptStore({
    sqlitePath: fixture.sqlitePath,
    blobDir: fixture.blobDir,
  });

  try {
    const turns = await store.listThreadTurns("thread-cli-flags");

    assert.equal(turns.length, 1);
    assert.equal(turns[0].turnRole, "user");
  } finally {
    await store.close();
  }
});

test("uses env storage and thread fallbacks", async (t) => {
  const fixture = await createHookFixture(t);
  const event = {
    event_id: "cli-env-prompt",
    kind: "prompt_submit",
    created_at: "2026-07-08T13:01:00.000Z",
    payload: {
      prompt: "Task: Capture from hook CLI env.",
    },
  };
  const result = await runHookCli({
    env: {
      TIDELINE_SQLITE_PATH: fixture.sqlitePath,
      TIDELINE_BLOB_DIR: fixture.blobDir,
      TIDELINE_THREAD_ID: "thread-cli-env",
    },
    input: JSON.stringify(event),
  });

  assert.equal(result.exit.code, 0, result.stderr);

  const receipt = JSON.parse(result.stdout);

  assert.equal(receipt.threadId, "thread-cli-env");
});

test("rejects mismatched event and configured thread ids", async (t) => {
  const fixture = await createHookFixture(t);
  const result = await runHookCli({
    args: [
      "--sqlite-path",
      fixture.sqlitePath,
      "--blob-dir",
      fixture.blobDir,
      "--thread-id",
      "thread-cli-flag",
    ],
    env: {
      TIDELINE_THREAD_ID: "thread-cli-env",
    },
    input: JSON.stringify({
      event_id: "cli-mismatch",
      kind: "prompt_submit",
      thread_id: "thread-cli-event",
      created_at: "2026-07-08T13:02:00.000Z",
      payload: {
        prompt: "Task: This should fail.",
      },
    }),
  });

  assert.notEqual(result.exit.code, 0);
  assert.match(result.stderr, /thread/i);
  assert.equal(result.stdout, "");
});

test("fails for invalid input and storage configuration errors", async (t) => {
  const fixture = await createHookFixture(t);
  const invalidJson = await runHookCli({
    args: [
      "--sqlite-path",
      fixture.sqlitePath,
      "--blob-dir",
      fixture.blobDir,
      "--thread-id",
      "thread-cli-invalid",
    ],
    input: "{not-json",
  });

  assert.notEqual(invalidJson.exit.code, 0);
  assert.match(invalidJson.stderr, /json/i);
  assert.equal(invalidJson.stdout, "");

  const multipleEvents = await runHookCli({
    args: [
      "--sqlite-path",
      fixture.sqlitePath,
      "--blob-dir",
      fixture.blobDir,
      "--thread-id",
      "thread-cli-invalid",
    ],
    input: [
      JSON.stringify({
        event_id: "cli-one",
        kind: "session_start",
        created_at: "2026-07-08T13:03:00.000Z",
        payload: {},
      }),
      JSON.stringify({
        event_id: "cli-two",
        kind: "session_start",
        created_at: "2026-07-08T13:03:01.000Z",
        payload: {},
      }),
    ].join("\n"),
  });

  assert.notEqual(multipleEvents.exit.code, 0);
  assert.match(multipleEvents.stderr, /one JSON event|single JSON event/i);

  const missingStorage = await runHookCli({
    env: {
      TIDELINE_THREAD_ID: "thread-cli-invalid",
    },
    input: JSON.stringify({
      event_id: "cli-missing-storage",
      kind: "session_start",
      created_at: "2026-07-08T13:03:02.000Z",
      payload: {},
    }),
  });

  assert.notEqual(missingStorage.exit.code, 0);
  assert.match(missingStorage.stderr, /--sqlite-path|TIDELINE_SQLITE_PATH/i);
  assert.match(missingStorage.stderr, /--blob-dir|TIDELINE_BLOB_DIR/i);
});

test("returns the original receipt for duplicate event ids", async (t) => {
  const fixture = await createHookFixture(t);
  const event = {
    event_id: "cli-duplicate-prompt",
    kind: "prompt_submit",
    thread_id: "thread-cli-duplicate",
    created_at: "2026-07-08T13:04:00.000Z",
    payload: {
      prompt: "Task: Capture duplicate prompt once.",
    },
  };
  const first = await runHookCli({
    args: ["--sqlite-path", fixture.sqlitePath, "--blob-dir", fixture.blobDir],
    input: JSON.stringify(event),
  });
  const second = await runHookCli({
    args: ["--sqlite-path", fixture.sqlitePath, "--blob-dir", fixture.blobDir],
    input: JSON.stringify(event),
  });

  assert.equal(first.exit.code, 0, first.stderr);
  assert.equal(second.exit.code, 0, second.stderr);
  assert.deepEqual(JSON.parse(second.stdout), JSON.parse(first.stdout));

  const store = await createTranscriptStore({
    sqlitePath: fixture.sqlitePath,
    blobDir: fixture.blobDir,
  });

  try {
    assert.equal(
      (await store.listThreadTurns("thread-cli-duplicate")).length,
      1,
    );
  } finally {
    await store.close();
  }
});

test("captured CLI sessions assemble searchable relationship-backed receipts", async (t) => {
  const fixture = await createHookFixture(t);
  const threadId = "thread-cli-retrieval";
  const storageEnv = {
    TIDELINE_SQLITE_PATH: fixture.sqlitePath,
    TIDELINE_BLOB_DIR: fixture.blobDir,
  };
  const events = [
    {
      event_id: "cli-retrieval-prompt-1",
      kind: "prompt_submit",
      thread_id: threadId,
      created_at: "2026-07-08T13:05:00.000Z",
      payload: { prompt: "Task: Anchor the hook retrieval session." },
    },
    {
      event_id: "cli-retrieval-model-1",
      kind: "model_response_complete",
      thread_id: threadId,
      created_at: "2026-07-08T13:05:01.000Z",
      payload: { response: "Decision: Use hook CLI capture." },
    },
    {
      event_id: "cli-retrieval-prompt-2",
      kind: "prompt_submit",
      thread_id: threadId,
      created_at: "2026-07-08T13:05:02.000Z",
      payload: { prompt: "Rules:\n- Keep receipt rows raw-free." },
    },
    {
      event_id: "cli-retrieval-model-2",
      kind: "model_response_complete",
      thread_id: threadId,
      created_at: "2026-07-08T13:05:03.000Z",
      payload: {
        response:
          "I inspected hook storage retrieval because captured context remains in progress.",
      },
    },
    {
      event_id: "cli-retrieval-prompt-3",
      kind: "prompt_submit",
      thread_id: threadId,
      created_at: "2026-07-08T13:05:04.000Z",
      payload: { prompt: "Task: Middle user turn before recent model." },
    },
    {
      event_id: "cli-retrieval-model-3",
      kind: "model_response_complete",
      thread_id: threadId,
      created_at: "2026-07-08T13:05:05.000Z",
      payload: {
        response:
          "I inspected recent hook model because this should stay recent.",
      },
    },
    {
      event_id: "cli-retrieval-prompt-4",
      kind: "prompt_submit",
      thread_id: threadId,
      created_at: "2026-07-08T13:05:06.000Z",
      payload: { prompt: "Task: Assemble hook retrieval context." },
    },
  ];

  for (const event of events) {
    const result = await runHookCli({
      env: storageEnv,
      input: JSON.stringify(event),
    });

    assert.equal(result.exit.code, 0, result.stderr);
  }

  const store = await createTranscriptStore({
    sqlitePath: fixture.sqlitePath,
    blobDir: fixture.blobDir,
  });

  try {
    await store.refreshThreadSearchIndex(threadId);

    const search = await store.searchContext({
      threadId,
      query: "hook storage retrieval captured context",
      limit: 3,
    });

    assert.equal(search.results[0].entityType, "context_block");
    assert.match(search.results[0].preview, /hook storage retrieval/i);

    const relationships = await store.listThreadRelationships(threadId);

    assert.ok(
      relationships.some(
        (relationship) => relationship.relationshipType === "derived_from",
      ),
    );

    const packet = await store.assembleContext({
      threadId,
      activeTurn: 7,
      task: "Continue hook storage retrieval",
      tokenBudget: 5000,
    });

    assert.equal(packet.receipt.status, "assembled");
    assert.equal(packet.receipt.contextBlockIds.length, 1);

    const receipts = await store.listThreadAssemblyReceipts(threadId);

    assert.deepEqual(
      receipts.map((assemblyReceipt) => assemblyReceipt.assemblyId),
      [packet.receipt.assemblyId],
    );
  } finally {
    await store.close();
  }
});

async function createHookFixture(t) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "tideline-hooks-"));
  const fixture = {
    blobDir: path.join(tempDir, "blobs"),
    sqlitePath: path.join(tempDir, "store.sqlite"),
  };

  t.after(async () => {
    await rm(tempDir, { force: true, recursive: true });
  });

  return fixture;
}

async function runHookCli(options) {
  const child = spawn(process.execPath, [cliPath, ...(options.args ?? [])], {
    env: {
      ...cleanHookEnv(),
      ...(options.env ?? {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdoutChunks = [];
  const stderrChunks = [];

  child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
  child.stdin.end(options.input);

  const exit = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });

  return {
    exit,
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
  };
}

function cleanHookEnv() {
  const env = { ...process.env };

  delete env.TIDELINE_SQLITE_PATH;
  delete env.TIDELINE_BLOB_DIR;
  delete env.TIDELINE_THREAD_ID;
  return env;
}
