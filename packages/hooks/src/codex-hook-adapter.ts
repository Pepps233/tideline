#!/usr/bin/env node
import { createHash } from "node:crypto";

import {
  createTranscriptStore,
  resolveTidelineStorageConfig,
} from "@tideline/core";
import type {
  CaptureTurnEventInput,
  CaptureTurnEventKind,
} from "@tideline/core";

interface CliArgs {
  blobDir?: string;
  eventName?: string;
  printReceipt: boolean;
  sqlitePath?: string;
  strict: boolean;
  threadId?: string;
}

interface CodexHookHandlerInput {
  args: CliArgs;
  env: NodeJS.ProcessEnv;
  rawInput: string;
}

const THREAD_ID_KEYS = new Set([
  "codexconversationid",
  "codexsessionid",
  "conversationid",
  "sessionid",
  "threadid",
]);
const EVENT_NAME_KEYS = new Set([
  "codexevent",
  "event",
  "eventname",
  "hookevent",
  "hookeventname",
  "name",
]);
const EVENT_ID_KEYS = new Set(["eventid", "hookeventid"]);
const CREATED_AT_KEYS = new Set([
  "createdat",
  "eventtime",
  "time",
  "timestamp",
]);
const PROMPT_KEYS = new Set([
  "input",
  "message",
  "prompt",
  "text",
  "userprompt",
]);
const RESPONSE_KEYS = new Set([
  "assistantmessage",
  "assistantresponse",
  "content",
  "lastresponse",
  "message",
  "response",
  "text",
]);
const TOOL_NAME_KEYS = new Set(["name", "tool", "toolname"]);
const TOOL_CALL_ID_KEYS = new Set([
  "callid",
  "invocationid",
  "toolcallid",
  "tooluseid",
]);
const TOOL_INPUT_KEYS = new Set([
  "arguments",
  "args",
  "input",
  "parameters",
  "params",
]);
const TOOL_OUTPUT_KEYS = new Set([
  "content",
  "error",
  "output",
  "result",
  "stderr",
  "stdout",
]);

void run();

async function run(): Promise<void> {
  let strict = false;

  try {
    const args = parseArgs(process.argv.slice(2));
    strict = args.strict;

    if (args.eventName === "help") {
      printHelp();
      return;
    }

    await handleCodexHook({
      args,
      env: process.env,
      rawInput: await readStdin(),
    });
  } catch (error) {
    process.stderr.write(
      `[tideline-codex-hook] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = strict ? 1 : 0;
  }
}

async function handleCodexHook(input: CodexHookHandlerInput): Promise<void> {
  const trimmed = input.rawInput.trim();

  if (trimmed.length === 0) {
    return reportSkipped("stdin did not contain a Codex hook event");
  }

  const codexEvent = parseCodexEvent(trimmed);
  const captureInput = toCaptureTurnEventInput(
    input.args,
    input.env,
    codexEvent,
    trimmed,
  );

  if (!captureInput) {
    return;
  }

  const config = resolveTidelineStorageConfig({
    blobDir: input.args.blobDir,
    env: input.env,
    sqlitePath: input.args.sqlitePath,
  });
  const store = await createTranscriptStore({
    blobDir: config.blobDir,
    sqlitePath: config.sqlitePath,
  });

  try {
    const receipt = await store.captureTurnEvent(captureInput);

    if (input.args.printReceipt) {
      process.stdout.write(`${JSON.stringify(receipt)}\n`);
    }
  } finally {
    await store.close();
  }
}

function parseArgs(args: string[]): CliArgs {
  const parsed: CliArgs = { printReceipt: false, strict: false };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--help" || arg === "-h") {
      parsed.eventName = "help";
      continue;
    }

    if (arg === "--strict") {
      parsed.strict = true;
      continue;
    }

    if (arg === "--print-receipt") {
      parsed.printReceipt = true;
      continue;
    }

    if (arg === "--event") {
      parsed.eventName = readArgValue(args, (index += 1), arg);
      continue;
    }

    if (arg?.startsWith("--event=")) {
      parsed.eventName = arg.slice("--event=".length);
      continue;
    }

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

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

function parseCodexEvent(input: string): Record<string, unknown> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(input) as unknown;
  } catch (error) {
    throw new Error(
      `Invalid Codex hook JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Codex hook JSON must be an object");
  }

  return parsed as Record<string, unknown>;
}

function toCaptureTurnEventInput(
  args: CliArgs,
  env: NodeJS.ProcessEnv,
  codexEvent: Record<string, unknown>,
  rawInput: string,
): CaptureTurnEventInput | undefined {
  const eventName =
    args.eventName ?? findStringByKeys(codexEvent, EVENT_NAME_KEYS, 5);

  if (!eventName) {
    reportSkipped("could not resolve Codex hook event name");
    return undefined;
  }

  const kind = toCaptureTurnEventKind(eventName);

  if (!kind) {
    reportSkipped(`unsupported Codex hook event: ${eventName}`);
    return undefined;
  }

  const threadId = resolveThreadId(args, env, codexEvent);

  if (!threadId) {
    reportSkipped(
      "could not resolve a Tideline thread id from Codex hook payload or environment",
    );
    return undefined;
  }

  const createdAt = resolveCreatedAt(codexEvent);

  return {
    eventId: resolveEventId(codexEvent, rawInput, eventName, threadId),
    kind,
    threadId,
    createdAt,
    payload: payloadForKind(kind, eventName, codexEvent),
  };
}

function toCaptureTurnEventKind(
  eventName: string,
): CaptureTurnEventKind | undefined {
  switch (normalizeKey(eventName)) {
    case "sessionstart":
      return "session_start";
    case "userpromptsubmit":
    case "promptsubmit":
      return "prompt_submit";
    case "posttooluse":
    case "toolresult":
      return "tool_result";
    case "stop":
    case "modelresponsecomplete":
      return "model_response_complete";
    case "sessionstop":
      return "session_stop";
    default:
      return undefined;
  }
}

function resolveThreadId(
  args: CliArgs,
  env: NodeJS.ProcessEnv,
  codexEvent: Record<string, unknown>,
): string | undefined {
  return firstNonEmpty(
    args.threadId,
    findStringByKeys(codexEvent, THREAD_ID_KEYS, 6),
    env.TIDELINE_THREAD_ID,
    env.CODEX_THREAD_ID,
    env.CODEX_SESSION_ID,
    env.CODEX_CONVERSATION_ID,
  );
}

function resolveCreatedAt(codexEvent: Record<string, unknown>): string {
  const timestamp = findValueByKeys(codexEvent, CREATED_AT_KEYS, 5);
  const parsed = dateFromValue(timestamp);

  return (parsed ?? new Date()).toISOString();
}

function resolveEventId(
  codexEvent: Record<string, unknown>,
  rawInput: string,
  eventName: string,
  threadId: string,
): string {
  const directId =
    stringField(codexEvent, "event_id") ??
    stringField(codexEvent, "eventId") ??
    stringField(codexEvent, "id");
  const nestedId = directId ?? findStringByKeys(codexEvent, EVENT_ID_KEYS, 4);

  if (nestedId) {
    return nestedId;
  }

  return [
    "codex",
    normalizeKey(eventName),
    stableIdPart(threadId),
    hashText(rawInput).slice(0, 16),
  ].join("-");
}

function payloadForKind(
  kind: CaptureTurnEventKind,
  eventName: string,
  codexEvent: Record<string, unknown>,
): Record<string, unknown> {
  switch (kind) {
    case "prompt_submit":
      return promptPayload(codexEvent);
    case "tool_result":
      return toolPayload(codexEvent);
    case "model_response_complete":
      return modelPayload(codexEvent);
    case "session_start":
      return sessionPayload(eventName, codexEvent);
    case "session_stop":
      return sessionStopPayload(codexEvent);
    default:
      return assertNever(kind);
  }
}

function promptPayload(
  codexEvent: Record<string, unknown>,
): Record<string, unknown> {
  return {
    prompt:
      findStringByKeys(codexEvent, PROMPT_KEYS, 6) ?? stringifyJson(codexEvent),
    raw_codex_event: codexEvent,
  };
}

function toolPayload(
  codexEvent: Record<string, unknown>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    output:
      findStringByKeys(codexEvent, TOOL_OUTPUT_KEYS, 6) ??
      stringifyJson(codexEvent),
    raw_codex_event: codexEvent,
    status: resolveToolStatus(codexEvent),
    tool_name: findStringByKeys(codexEvent, TOOL_NAME_KEYS, 5) ?? "unknown",
  };
  const callId = findStringByKeys(codexEvent, TOOL_CALL_ID_KEYS, 5);
  const toolInput = findValueByKeys(codexEvent, TOOL_INPUT_KEYS, 5);

  if (callId) {
    payload.call_id = callId;
  }

  if (toolInput !== undefined) {
    payload.input = toolInput;
  }

  return payload;
}

function modelPayload(
  codexEvent: Record<string, unknown>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    raw_codex_event: codexEvent,
  };
  const response = findStringByKeys(codexEvent, RESPONSE_KEYS, 6);

  if (response) {
    payload.response = response;
  }

  return payload;
}

function sessionPayload(
  eventName: string,
  codexEvent: Record<string, unknown>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    codex_event: eventName,
    raw_codex_event: codexEvent,
  };
  const source = findStringByKeys(
    codexEvent,
    new Set(["source", "startsource"]),
    3,
  );

  if (source) {
    payload.source = source;
  }

  return payload;
}

function sessionStopPayload(
  codexEvent: Record<string, unknown>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    raw_codex_event: codexEvent,
  };
  const checkpoint = findStringByKeys(codexEvent, RESPONSE_KEYS, 6);

  if (checkpoint) {
    payload.checkpoint = checkpoint;
  }

  return payload;
}

function resolveToolStatus(codexEvent: Record<string, unknown>): string {
  const directStatus = findStringByKeys(
    codexEvent,
    new Set(["status", "state"]),
    4,
  );

  if (directStatus) {
    return directStatus;
  }

  const success = findValueByKeys(codexEvent, new Set(["success"]), 4);

  if (typeof success === "boolean") {
    return success ? "success" : "failure";
  }

  const exitCode = findValueByKeys(
    codexEvent,
    new Set(["code", "exitcode"]),
    4,
  );

  if (typeof exitCode === "number") {
    return exitCode === 0 ? "success" : "failure";
  }

  return "unknown";
}

function findStringByKeys(
  value: unknown,
  keys: Set<string>,
  maxDepth: number,
): string | undefined {
  if (maxDepth < 0 || !value || typeof value !== "object") {
    return undefined;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStringByKeys(item, keys, maxDepth - 1);

      if (found !== undefined) {
        return found;
      }
    }

    return undefined;
  }

  const record = value as Record<string, unknown>;

  for (const [key, candidate] of Object.entries(record)) {
    if (keys.has(normalizeKey(key))) {
      const found = textFromValue(candidate);

      if (found !== undefined) {
        return found;
      }
    }
  }

  for (const candidate of Object.values(record)) {
    const found = findStringByKeys(candidate, keys, maxDepth - 1);

    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
}

function findValueByKeys(
  value: unknown,
  keys: Set<string>,
  maxDepth: number,
): unknown {
  if (maxDepth < 0 || !value || typeof value !== "object") {
    return undefined;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findValueByKeys(item, keys, maxDepth - 1);

      if (found !== undefined) {
        return found;
      }
    }

    return undefined;
  }

  const record = value as Record<string, unknown>;

  for (const [key, candidate] of Object.entries(record)) {
    if (keys.has(normalizeKey(key)) && hasUsableValue(candidate)) {
      return candidate;
    }
  }

  for (const candidate of Object.values(record)) {
    const found = findValueByKeys(candidate, keys, maxDepth - 1);

    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
}

function hasUsableValue(value: unknown): boolean {
  return (
    value !== undefined &&
    value !== null &&
    (typeof value !== "string" || value.trim().length > 0)
  );
}

function textFromValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim().length > 0 ? value : undefined;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((item) => textFromValue(item))
      .filter((part): part is string => part !== undefined);

    return parts.length > 0 ? parts.join("\n") : undefined;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;

    return (
      stringField(record, "content") ??
      stringField(record, "text") ??
      stringField(record, "message")
    );
  }

  return undefined;
}

function stringField(
  record: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = record[field];

  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function dateFromValue(value: unknown): Date | undefined {
  if (typeof value === "string" || typeof value === "number") {
    const date =
      typeof value === "number" && value < 1_000_000_000_000
        ? new Date(value * 1000)
        : new Date(value);

    return Number.isNaN(date.valueOf()) ? undefined : date;
  }

  return undefined;
}

function firstNonEmpty(
  ...values: Array<string | undefined>
): string | undefined {
  return values.find((value) => value !== undefined && value.trim().length > 0);
}

function normalizeKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function stableIdPart(value: string): string {
  return hashText(value).slice(0, 12);
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stringifyJson(value: unknown): string {
  const json = JSON.stringify(value, null, 2);

  return json === undefined ? "null" : json;
}

function reportSkipped(reason: string): void {
  process.stderr.write(`[tideline-codex-hook] Skipped capture: ${reason}.\n`);
}

function printHelp(): void {
  process.stdout.write(`Usage: tideline-codex-hook --event <CodexEvent>

Reads one Codex hook JSON object from stdin and captures the corresponding
Tideline event. Supported Codex events are SessionStart, UserPromptSubmit,
PostToolUse, Stop, and SessionStop.

Options:
  --event <name>        Codex hook event name
  --thread-id <id>     Override the Tideline thread id
  --sqlite-path <path> Override SQLite storage path
  --blob-dir <path>    Override raw blob storage directory
  --print-receipt      Print the Tideline capture receipt for manual testing
  --strict             Exit non-zero when capture fails
`);
}

function assertNever(value: never): never {
  throw new Error(`Unsupported capture event kind: ${String(value)}`);
}
