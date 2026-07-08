#!/usr/bin/env node
import {
  createTranscriptStore,
  resolveTidelineStorageConfig,
} from "@tideline/core";
import type {
  CaptureTurnEventInput,
  CaptureTurnEventKind,
} from "@tideline/core";

interface StorageConfig {
  sqlitePath: string;
  blobDir: string;
}

interface CliArgs {
  sqlitePath?: string;
  blobDir?: string;
  threadId?: string;
}

interface HookConfig extends StorageConfig {
  threadId?: string;
}

void main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const parsedArgs = parseArgs(process.argv.slice(2));
  const input = await readStdin();
  const event = parseOneJsonEvent(input);
  const config = resolveConfig(parsedArgs, process.env, event);
  const captureInput = toCaptureTurnEventInput(event, config.threadId);
  const store = await createTranscriptStore({
    sqlitePath: config.sqlitePath,
    blobDir: config.blobDir,
  });

  try {
    const receipt = await store.captureTurnEvent(captureInput);

    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } finally {
    await store.close();
  }
}

function parseArgs(args: string[]): CliArgs {
  const parsed: CliArgs = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--sqlite-path") {
      parsed.sqlitePath = readArgValue(args, (index += 1), arg);
      continue;
    }

    if (arg?.startsWith("--sqlite-path=")) {
      parsed.sqlitePath = arg.slice("--sqlite-path=".length);
      continue;
    }

    if (arg === "--blob-dir") {
      parsed.blobDir = readArgValue(args, (index += 1), arg);
      continue;
    }

    if (arg?.startsWith("--blob-dir=")) {
      parsed.blobDir = arg.slice("--blob-dir=".length);
      continue;
    }

    if (arg === "--thread-id") {
      parsed.threadId = readArgValue(args, (index += 1), arg);
      continue;
    }

    if (arg?.startsWith("--thread-id=")) {
      parsed.threadId = arg.slice("--thread-id=".length);
      continue;
    }

    throw new Error(`Unknown argument: ${arg ?? ""}`);
  }

  return parsed;
}

function readArgValue(args: string[], index: number, flag: string): string {
  const value = args[index];

  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }

  return value;
}

function resolveConfig(
  args: CliArgs,
  env: NodeJS.ProcessEnv,
  event: Record<string, unknown>,
): HookConfig {
  const storageConfig = resolveTidelineStorageConfig({
    blobDir: args.blobDir,
    env,
    sqlitePath: args.sqlitePath,
  });

  const eventThreadId = optionalStringField(event, "thread_id");
  const envThreadId = env.TIDELINE_THREAD_ID;
  const configuredThreadId = args.threadId ?? envThreadId;

  if (
    eventThreadId !== undefined &&
    args.threadId !== undefined &&
    eventThreadId !== args.threadId
  ) {
    throw new Error("Event thread_id does not match the configured thread ID.");
  }

  if (
    eventThreadId !== undefined &&
    envThreadId !== undefined &&
    eventThreadId !== envThreadId
  ) {
    throw new Error("Event thread_id does not match TIDELINE_THREAD_ID.");
  }

  const threadId = eventThreadId ?? configuredThreadId;

  if (!threadId) {
    throw new Error(
      "Thread ID is required. Provide event thread_id, --thread-id, or TIDELINE_THREAD_ID.",
    );
  }

  const config: HookConfig = storageConfig;

  if (threadId !== undefined) {
    config.threadId = threadId;
  }

  return config;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

function parseOneJsonEvent(input: string): Record<string, unknown> {
  const trimmed = input.trim();

  if (trimmed.length === 0) {
    throw new Error("stdin must contain one JSON event");
  }

  if (/\}\s*\n\s*\{/u.test(trimmed)) {
    throw new Error("stdin must contain one JSON event");
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch (error) {
    throw new Error(
      `Invalid JSON event: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("stdin must contain one JSON event object");
  }

  return parsed as Record<string, unknown>;
}

function toCaptureTurnEventInput(
  event: Record<string, unknown>,
  threadId: string | undefined,
): CaptureTurnEventInput {
  return {
    eventId: requiredStringField(event, "event_id"),
    kind: requiredStringField(event, "kind") as CaptureTurnEventKind,
    threadId: threadId ?? requiredStringField(event, "thread_id"),
    createdAt: requiredStringField(event, "created_at"),
    payload: payloadFromEvent(event),
  };
}

function payloadFromEvent(
  event: Record<string, unknown>,
): Record<string, unknown> {
  if (!Object.hasOwn(event, "payload")) {
    return {};
  }

  const payload = event.payload;

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("event payload must be an object");
  }

  return payload as Record<string, unknown>;
}

function requiredStringField(
  record: Record<string, unknown>,
  field: string,
): string {
  const value = optionalStringField(record, field);

  if (value === undefined || value.trim().length === 0) {
    throw new Error(`event ${field} must be a non-empty string`);
  }

  return value;
}

function optionalStringField(
  record: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = record[field];

  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`event ${field} must be a string`);
  }

  return value;
}
