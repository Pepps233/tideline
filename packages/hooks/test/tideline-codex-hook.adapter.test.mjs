import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createTranscriptStore } from "@tideline/core";

const adapterPath = new URL("../dist/codex-hook-adapter.js", import.meta.url)
  .pathname;

test("captures Codex prompts, tools, and stop events into one thread", async (t) => {
  const fixture = await createCodexFixture(t);
  const threadId = "codex-session-1";
  const storageEnv = {
    TIDELINE_BLOB_DIR: fixture.blobDir,
    TIDELINE_SQLITE_PATH: fixture.sqlitePath,
  };
  const events = [
    {
      args: ["--event", "SessionStart"],
      input: {
        session_id: threadId,
        source: "startup",
        timestamp: "2026-07-08T15:00:00.000Z",
      },
    },
    {
      args: ["--event", "UserPromptSubmit"],
      input: {
        session_id: threadId,
        prompt: "Task: Capture Codex hook prompts.",
        timestamp: "2026-07-08T15:00:01.000Z",
      },
    },
    {
      args: ["--event", "PostToolUse"],
      input: {
        session_id: threadId,
        tool_name: "Bash",
        call_id: "call-codex-1",
        input: { command: "pnpm test" },
        output: "PASS codex hook adapter",
        status: "success",
        timestamp: "2026-07-08T15:00:02.000Z",
      },
    },
    {
      args: ["--event", "Stop"],
      input: {
        session_id: threadId,
        response: "I captured the Codex hook output.",
        timestamp: "2026-07-08T15:00:03.000Z",
      },
    },
  ];

  for (const event of events) {
    const result = await runCodexAdapter({
      args: [
        ...event.args,
        "--sqlite-path",
        fixture.sqlitePath,
        "--blob-dir",
        fixture.blobDir,
      ],
      env: storageEnv,
      input: JSON.stringify(event.input),
    });

    assert.equal(result.exit.code, 0, result.stderr);
    assert.equal(result.stdout, "");
  }

  const store = await createTranscriptStore({
    blobDir: fixture.blobDir,
    sqlitePath: fixture.sqlitePath,
  });

  try {
    const turns = await store.listThreadTurns(threadId);

    assert.deepEqual(
      turns.map((turn) => turn.turnRole),
      ["user", "model"],
    );
    assert.equal(turns[0].turnIndex, 1);
    assert.equal(turns[1].turnIndex, 2);

    const sessions = await store.listSessions();

    assert.deepEqual(
      sessions.map((session) => session.threadId),
      [threadId],
    );
  } finally {
    await store.close();
  }
});

test("skips Codex events without a resolvable session id", async (t) => {
  const fixture = await createCodexFixture(t);
  const result = await runCodexAdapter({
    args: [
      "--event",
      "UserPromptSubmit",
      "--sqlite-path",
      fixture.sqlitePath,
      "--blob-dir",
      fixture.blobDir,
    ],
    input: JSON.stringify({
      prompt: "Task: Missing session id should not break Codex.",
    }),
  });

  assert.equal(result.exit.code, 0);
  assert.match(result.stderr, /Skipped capture/i);
  assert.equal(result.stdout, "");
});

test("prints capture receipts only when requested", async (t) => {
  const fixture = await createCodexFixture(t);
  const result = await runCodexAdapter({
    args: [
      "--event",
      "UserPromptSubmit",
      "--print-receipt",
      "--sqlite-path",
      fixture.sqlitePath,
      "--blob-dir",
      fixture.blobDir,
    ],
    input: JSON.stringify({
      prompt: "Task: Print this capture receipt.",
      session_id: "codex-session-print-receipt",
    }),
  });

  assert.equal(result.exit.code, 0, result.stderr);

  const receipt = JSON.parse(result.stdout);

  assert.equal(receipt.kind, "prompt_submit");
  assert.equal(receipt.threadId, "codex-session-print-receipt");
});

test("can fail strictly for invalid hook JSON", async (t) => {
  const fixture = await createCodexFixture(t);
  const result = await runCodexAdapter({
    args: [
      "--strict",
      "--event",
      "UserPromptSubmit",
      "--sqlite-path",
      fixture.sqlitePath,
      "--blob-dir",
      fixture.blobDir,
    ],
    input: "{not-json",
  });

  assert.notEqual(result.exit.code, 0);
  assert.match(result.stderr, /Invalid Codex hook JSON/i);
  assert.equal(result.stdout, "");
});

async function createCodexFixture(t) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "tideline-codex-hook-"));
  const fixture = {
    blobDir: path.join(tempDir, "blobs"),
    sqlitePath: path.join(tempDir, "store.sqlite"),
  };

  t.after(async () => {
    await rm(tempDir, { force: true, recursive: true });
  });

  return fixture;
}

async function runCodexAdapter(options) {
  const child = spawn(
    process.execPath,
    [adapterPath, ...(options.args ?? [])],
    {
      env: {
        ...cleanHookEnv(),
        ...(options.env ?? {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
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
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
  };
}

function cleanHookEnv() {
  const env = { ...process.env };

  delete env.CODEX_CONVERSATION_ID;
  delete env.CODEX_SESSION_ID;
  delete env.CODEX_THREAD_ID;
  delete env.TIDELINE_BLOB_DIR;
  delete env.TIDELINE_HOME;
  delete env.TIDELINE_SQLITE_PATH;
  delete env.TIDELINE_THREAD_ID;
  return env;
}
