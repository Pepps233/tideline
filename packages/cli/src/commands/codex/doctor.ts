import { spawn } from "node:child_process";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import type { TidelineStoragePaths } from "./types.js";

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
}

export async function assertHookStdoutEmpty(
  storage: TidelineStoragePaths,
): Promise<void> {
  const result = await runCurrentCli(
    ["hook", "codex", "--event", "UserPromptSubmit"],
    storage,
    JSON.stringify({
      event_id: "tideline-doctor-hook-stdout",
      prompt: "Tideline doctor hook stdout check.",
      session_id: "tideline-doctor-codex",
      timestamp: "2026-07-09T00:00:00.000Z",
    }),
  );

  if (result.code !== 0) {
    throw new Error(`Tideline hook stdout check failed: ${result.stderr}`);
  }

  if (result.stdout.length > 0) {
    throw new Error("Tideline hook wrote stdout in normal mode.");
  }
}

export async function captureSyntheticHook(
  storage: TidelineStoragePaths,
): Promise<{ threadId: string }> {
  const result = await runCurrentCli(
    ["hook", "codex", "--event", "UserPromptSubmit", "--print-receipt"],
    storage,
    JSON.stringify({
      event_id: "tideline-doctor-synthetic-capture",
      prompt: "Tideline doctor synthetic capture.",
      session_id: "tideline-doctor-codex",
      timestamp: "2026-07-09T00:00:01.000Z",
    }),
  );

  if (result.code !== 0) {
    throw new Error(`Tideline synthetic capture failed: ${result.stderr}`);
  }

  const receipt = JSON.parse(result.stdout) as { threadId?: unknown };

  if (receipt.threadId !== "tideline-doctor-codex") {
    throw new Error("Tideline synthetic capture returned the wrong thread.");
  }

  return { threadId: receipt.threadId };
}

export async function assertMcpTools(
  storage: TidelineStoragePaths,
): Promise<string> {
  const client = new Client(
    { name: "tideline-doctor", version: "0.0.0" },
    { capabilities: {} },
  );
  const transport = new StdioClientTransport({
    args: [currentCliPath(), "mcp"],
    command: process.execPath,
    env: storageEnv(storage),
  });

  await client.connect(transport);

  try {
    const tools = await client.listTools();
    const hasListSessions = tools.tools.some(
      (tool) => tool.name === "list_sessions",
    );

    if (!hasListSessions) {
      throw new Error("Tideline MCP server did not expose list_sessions.");
    }

    return "list_sessions";
  } finally {
    await client.close();
  }
}

async function runCurrentCli(
  args: string[],
  storage: TidelineStoragePaths,
  input: string,
): Promise<ChildResult> {
  const child = spawn(process.execPath, [currentCliPath(), ...args], {
    env: storageEnv(storage),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
  child.stdin.end(input);

  const exit = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });

  return {
    code: exit.code,
    signal: exit.signal,
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
  };
}

function currentCliPath(): string {
  const entrypoint = process.argv[1];

  if (!entrypoint) {
    throw new Error("Could not resolve the current Tideline CLI path.");
  }

  return path.resolve(entrypoint);
}

function storageEnv(storage: TidelineStoragePaths): Record<string, string> {
  return stripUndefinedEnv({
    ...process.env,
    TIDELINE_BLOB_DIR: storage.blobDir,
    TIDELINE_SQLITE_PATH: storage.sqlitePath,
  });
}

function stripUndefinedEnv(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const entries = Object.entries(env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );

  return Object.fromEntries(entries);
}
