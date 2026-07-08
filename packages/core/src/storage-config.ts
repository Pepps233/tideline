import { homedir } from "node:os";
import path from "node:path";

export interface TidelineStorageConfig {
  sqlitePath: string;
  blobDir: string;
}

export interface ResolveTidelineStorageConfigInput {
  sqlitePath?: string | undefined;
  blobDir?: string | undefined;
  env?: Record<string, string | undefined> | undefined;
}

const DEFAULT_STORAGE_DIR_NAME = ".tideline";
const DEFAULT_SQLITE_FILE_NAME = "tideline.sqlite";
const DEFAULT_BLOB_DIR_NAME = "blobs";

export function resolveTidelineStorageConfig(
  input: ResolveTidelineStorageConfigInput = {},
): TidelineStorageConfig {
  const env = input.env ?? process.env;
  const defaultStorageDir = resolveDefaultStorageDir(env);

  return {
    sqlitePath:
      input.sqlitePath ??
      env.TIDELINE_SQLITE_PATH ??
      path.join(defaultStorageDir, DEFAULT_SQLITE_FILE_NAME),
    blobDir:
      input.blobDir ??
      env.TIDELINE_BLOB_DIR ??
      path.join(defaultStorageDir, DEFAULT_BLOB_DIR_NAME),
  };
}

function resolveDefaultStorageDir(
  env: Record<string, string | undefined>,
): string {
  const defaultHome =
    firstNonEmpty(env.HOME, env.USERPROFILE) ?? firstNonEmpty(homedir());

  if (env.TIDELINE_HOME?.trim()) {
    return expandHomePrefix(env.TIDELINE_HOME.trim(), defaultHome);
  }

  if (!defaultHome) {
    throw new Error(
      "Could not resolve a home directory for Tideline storage. Set TIDELINE_HOME, TIDELINE_SQLITE_PATH, or TIDELINE_BLOB_DIR.",
    );
  }

  return path.join(defaultHome, DEFAULT_STORAGE_DIR_NAME);
}

function firstNonEmpty(
  ...values: Array<string | undefined>
): string | undefined {
  return values.find((value) => value !== undefined && value.trim().length > 0);
}

function expandHomePrefix(value: string, homeDir: string | undefined): string {
  if (value === "~") {
    return requireHomeDir(value, homeDir);
  }

  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(requireHomeDir(value, homeDir), value.slice(2));
  }

  return value;
}

function requireHomeDir(value: string, homeDir: string | undefined): string {
  if (!homeDir) {
    throw new Error(
      `Could not expand ${value} because no home directory is available.`,
    );
  }

  return homeDir;
}
