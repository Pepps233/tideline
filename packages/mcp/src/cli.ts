#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";
import {
  createTranscriptStore,
  resolveTidelineStorageConfig,
} from "@tideline/core";

import { createTidelineMcpServer } from "./index.js";

interface StorageConfig {
  sqlitePath: string;
  blobDir: string;
}

if (isDirectEntrypoint(import.meta.url)) {
  void runTidelineMcpCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export async function runTidelineMcpCli(
  args: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const config = parseStorageConfig(args, env);
  const store = await createTranscriptStore({
    sqlitePath: config.sqlitePath,
    blobDir: config.blobDir,
  });
  const server = createTidelineMcpServer({ store });
  const transport = new StdioServerTransport();

  installShutdownHandlers(store);
  await server.connect(transport);
}

function isDirectEntrypoint(metaUrl: string): boolean {
  const entrypoint = process.argv[1];

  return entrypoint ? pathToFileURL(entrypoint).href === metaUrl : false;
}

function parseStorageConfig(
  args: string[],
  env: NodeJS.ProcessEnv,
): StorageConfig {
  const parsed = parseArgs(args);

  return resolveTidelineStorageConfig({
    blobDir: parsed.blobDir,
    env,
    sqlitePath: parsed.sqlitePath,
  });
}

function parseArgs(args: string[]): Partial<StorageConfig> {
  const parsed: Partial<StorageConfig> = {};

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

function installShutdownHandlers(store: { close(): Promise<void> }): void {
  const closeStore = async () => {
    try {
      await store.close();
    } catch {
      process.exitCode = 1;
    }
  };

  process.once("SIGINT", () => {
    void closeStore().finally(() => process.exit(130));
  });
  process.once("SIGTERM", () => {
    void closeStore().finally(() => process.exit(143));
  });
  process.once("beforeExit", () => {
    void closeStore();
  });
}
