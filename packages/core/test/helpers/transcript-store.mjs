import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createTranscriptStore } from "../../dist/index.js";

export { createTranscriptStore };

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function createIsolatedStore(t) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "tideline-core-"));
  const sqlitePath = path.join(tempDir, "store.sqlite");
  const blobDir = path.join(tempDir, "blobs");
  const store = await createTranscriptStore({ sqlitePath, blobDir });
  let isClosed = false;
  const closeStore = async () => {
    if (!isClosed) {
      isClosed = true;
      await store.close();
    }
  };

  t.after(async () => {
    await closeStore();
    await rm(tempDir, { force: true, recursive: true });
  });

  return { blobDir, closeStore, sqlitePath, store };
}

export function openSqlite(sqlitePath) {
  const db = new DatabaseSync(sqlitePath);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

export function getRawBlobRow(sqlitePath, rawPointerId) {
  const db = openSqlite(sqlitePath);

  try {
    const rawBlob = db
      .prepare(
        `SELECT
          raw_pointer_id,
          sha256,
          byte_length,
          media_type,
          storage_kind,
          storage_path
        FROM raw_blobs
        WHERE raw_pointer_id = ?`,
      )
      .get(rawPointerId);

    assert.ok(rawBlob, `Expected raw blob ${rawPointerId}`);
    return rawBlob;
  } finally {
    db.close();
  }
}

export function getBlobPath(blobDir, rawBlobRow) {
  assert.equal(rawBlobRow.storage_kind, "file");
  assert.equal(path.basename(rawBlobRow.storage_path), rawBlobRow.sha256);
  return path.join(blobDir, rawBlobRow.storage_path);
}

export function assertSourceItemShape(item) {
  assert.equal(typeof item.sourceItemId, "string");
  assert.equal(typeof item.turnId, "string");
  assert.equal(typeof item.itemIndex, "number");
  assert.equal(typeof item.rawPointerId, "string");
  assert.equal(typeof item.renderedExcerpt, "string");
  assert.match(item.contextAction, /^(preserve_exact|compact|discard)$/);
  assert.equal(typeof item.actionReason, "string");
  assert.ok(Array.isArray(item.labels));
  assert.equal(typeof item.createdAt, "string");
}

export function assertTextOffsets(rawBytes, item) {
  assert.equal(typeof item.rawStartByteOffset, "number");
  assert.equal(typeof item.rawEndByteOffset, "number");
  assert.ok(item.rawStartByteOffset >= 0);
  assert.ok(item.rawEndByteOffset > item.rawStartByteOffset);
  assert.ok(item.rawEndByteOffset <= rawBytes.byteLength);

  const rawSlice = Buffer.from(
    rawBytes.slice(item.rawStartByteOffset, item.rawEndByteOffset),
  ).toString("utf8");
  assert.equal(rawSlice, item.renderedExcerpt);
}

export function findItemByText(items, text) {
  const item = items.find((sourceItem) =>
    sourceItem.renderedExcerpt.includes(text),
  );

  assert.ok(item, `Expected source item containing ${text}`);
  return item;
}
