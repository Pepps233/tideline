import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { resolveTidelineStorageConfig } from "../dist/index.js";

test("resolves default storage under the home directory", () => {
  const homeDir = path.join("tmp", "tideline-home");
  const storage = resolveTidelineStorageConfig({
    env: {
      HOME: homeDir,
    },
  });

  assert.deepEqual(storage, {
    sqlitePath: path.join(homeDir, ".tideline", "tideline.sqlite"),
    blobDir: path.join(homeDir, ".tideline", "blobs"),
  });
});

test("prefers explicit storage paths over environment paths", () => {
  const storage = resolveTidelineStorageConfig({
    sqlitePath: path.join("tmp", "explicit.sqlite"),
    blobDir: path.join("tmp", "explicit-blobs"),
    env: {
      HOME: path.join("tmp", "tideline-home"),
      TIDELINE_SQLITE_PATH: path.join("tmp", "env.sqlite"),
      TIDELINE_BLOB_DIR: path.join("tmp", "env-blobs"),
    },
  });

  assert.deepEqual(storage, {
    sqlitePath: path.join("tmp", "explicit.sqlite"),
    blobDir: path.join("tmp", "explicit-blobs"),
  });
});

test("uses TIDELINE_HOME for default storage paths", () => {
  const homeDir = path.join("tmp", "tideline-home");
  const storage = resolveTidelineStorageConfig({
    env: {
      HOME: homeDir,
      TIDELINE_HOME: "~/tideline-data",
    },
  });

  assert.deepEqual(storage, {
    sqlitePath: path.join(homeDir, "tideline-data", "tideline.sqlite"),
    blobDir: path.join(homeDir, "tideline-data", "blobs"),
  });
});
