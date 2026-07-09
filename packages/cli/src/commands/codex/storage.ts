import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import {
  createTranscriptStore,
  resolveTidelineStorageConfig,
} from "@tideline/core";

import type { CodexMaintenanceArgs } from "./args.js";
import {
  CODEX_AGENT_ID,
  TIDELINE_INSTALL_VERSION,
  type CodexInstallRecord,
  type CodexPaths,
  type InstallRecord,
  type TidelineStoragePaths,
} from "./types.js";

export function resolveCodexPaths(args: {
  configPath?: string;
  hooksPath?: string;
}): CodexPaths {
  return {
    configPath: path.resolve(
      expandHomePath(args.configPath ?? "~/.codex/config.toml"),
    ),
    hooksPath: path.resolve(
      expandHomePath(args.hooksPath ?? "~/.codex/hooks.json"),
    ),
  };
}

export function resolveCodexPathsFromRecord(
  args: CodexMaintenanceArgs,
  record: InstallRecord,
): CodexPaths {
  const codexRecord = record.agents[CODEX_AGENT_ID];

  return {
    configPath: path.resolve(
      expandHomePath(
        args.configPath ?? codexRecord?.configPath ?? "~/.codex/config.toml",
      ),
    ),
    hooksPath: path.resolve(
      expandHomePath(
        args.hooksPath ?? codexRecord?.hooksPath ?? "~/.codex/hooks.json",
      ),
    ),
  };
}

export function resolveInstallStorage(
  args: { configPath?: string; hooksPath?: string },
  paths: CodexPaths,
): TidelineStoragePaths {
  const env = { ...process.env };
  const derivedHome = deriveHomeFromCustomCodexPaths(args, paths);

  if (derivedHome && !hasExplicitStorageEnv(env)) {
    env.HOME = derivedHome;
    env.USERPROFILE = derivedHome;
  }

  const storage = resolveTidelineStorageConfig({ env });
  const storagePath = path.dirname(storage.sqlitePath);

  return {
    blobDir: path.resolve(storage.blobDir),
    installPath: path.join(storagePath, "install.json"),
    logsDir: path.join(storagePath, "logs"),
    sqlitePath: path.resolve(storage.sqlitePath),
    storagePath: path.resolve(storagePath),
  };
}

export async function ensureTidelineStorage(
  storage: TidelineStoragePaths,
): Promise<void> {
  await mkdir(storage.storagePath, { recursive: true });
  await mkdir(storage.blobDir, { recursive: true });
  await mkdir(storage.logsDir, { recursive: true });

  const store = await createTranscriptStore({
    blobDir: storage.blobDir,
    sqlitePath: storage.sqlitePath,
  });

  await store.close();
}

export async function assertStorageReady(
  storage: TidelineStoragePaths,
): Promise<void> {
  await ensureTidelineStorage(storage);

  const writableProbePath = path.join(
    storage.blobDir,
    `.tideline-doctor-${process.pid}.tmp`,
  );

  await writeFile(writableProbePath, "ok", "utf8");
  await rm(writableProbePath, { force: true });
}

export async function upsertInstallRecord(
  installPath: string,
  codexRecord: CodexInstallRecord,
): Promise<void> {
  const existing = await readInstallRecord(installPath);
  const nextRecord: InstallRecord = {
    agents: {
      ...existing.agents,
      [CODEX_AGENT_ID]: codexRecord,
    },
    installedAt: existing.installedAt || new Date().toISOString(),
    version: TIDELINE_INSTALL_VERSION,
  };

  await mkdir(path.dirname(installPath), { recursive: true });
  await writeJsonFile(installPath, nextRecord);
}

export async function removeCodexInstallRecord(
  installPath: string,
): Promise<void> {
  const existing = await readInstallRecord(installPath);
  const nextAgents = { ...existing.agents };

  delete nextAgents[CODEX_AGENT_ID];

  await mkdir(path.dirname(installPath), { recursive: true });
  await writeJsonFile(installPath, {
    agents: nextAgents,
    installedAt: existing.installedAt || new Date().toISOString(),
    version: TIDELINE_INSTALL_VERSION,
  });
}

export async function readInstallRecord(
  installPath: string,
): Promise<InstallRecord> {
  const emptyRecord = (): InstallRecord => ({
    agents: {},
    installedAt: new Date().toISOString(),
    version: TIDELINE_INSTALL_VERSION,
  });

  let content: string;

  try {
    content = await readFile(installPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return emptyRecord();
    }

    throw error;
  }

  const parsed = JSON.parse(content) as unknown;

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Tideline install record must be a JSON object: ${installPath}`,
    );
  }

  const record = parsed as Partial<InstallRecord>;

  return {
    agents:
      record.agents &&
      typeof record.agents === "object" &&
      !Array.isArray(record.agents)
        ? { ...record.agents }
        : {},
    installedAt:
      typeof record.installedAt === "string"
        ? record.installedAt
        : new Date().toISOString(),
    version:
      typeof record.version === "number"
        ? record.version
        : TIDELINE_INSTALL_VERSION,
  };
}

export async function readTextIfExists(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return "";
    }

    throw error;
  }
}

export function expandHomePath(value: string): string {
  if (value === "~") {
    return homedir();
  }

  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(homedir(), value.slice(2));
  }

  return value;
}

function deriveHomeFromCustomCodexPaths(
  args: { configPath?: string; hooksPath?: string },
  paths: CodexPaths,
): string | undefined {
  if (!args.configPath || !args.hooksPath) {
    return undefined;
  }

  const configDir = path.dirname(paths.configPath);
  const hooksDir = path.dirname(paths.hooksPath);

  if (configDir !== hooksDir || path.basename(configDir) !== ".codex") {
    return undefined;
  }

  return path.dirname(configDir);
}

function hasExplicitStorageEnv(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env.TIDELINE_HOME?.trim() ||
    env.TIDELINE_SQLITE_PATH?.trim() ||
    env.TIDELINE_BLOB_DIR?.trim(),
  );
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && "code" in error);
}
