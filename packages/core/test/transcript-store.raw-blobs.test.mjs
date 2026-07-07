import assert from "node:assert/strict";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";

import {
  createIsolatedStore,
  getBlobPath,
  getRawBlobRow,
  openSqlite,
  sha256,
} from "./helpers/transcript-store.mjs";

test("writes SHA-addressed raw blobs and reuses duplicate content", async (t) => {
  const { blobDir, sqlitePath, store } = await createIsolatedStore(t);
  const raw = "same transcript payload";
  const mediaType = "text/plain; charset=utf-8";
  const expectedSha = sha256(Buffer.from(raw));

  const first = await store.appendTurn({
    threadId: "thread-a",
    turnRole: "user",
    raw,
    mediaType,
  });
  const second = await store.appendTurn({
    threadId: "thread-a",
    turnRole: "model",
    raw: Buffer.from(raw),
    mediaType,
  });

  assert.equal(second.rawPointerId, first.rawPointerId);

  const rawBlob = getRawBlobRow(sqlitePath, first.rawPointerId);
  assert.equal(rawBlob.raw_pointer_id, first.rawPointerId);
  assert.equal(rawBlob.sha256, expectedSha);
  assert.equal(rawBlob.byte_length, Buffer.byteLength(raw));
  assert.equal(rawBlob.media_type, mediaType);

  const db = openSqlite(sqlitePath);

  try {
    const { count } = db
      .prepare("SELECT COUNT(*) AS count FROM raw_blobs")
      .get();
    assert.equal(count, 1);
  } finally {
    db.close();
  }

  const blobBytes = await readFile(getBlobPath(blobDir, rawBlob));
  assert.equal(sha256(blobBytes), expectedSha);
});

test("keeps separate raw pointers for different media types", async (t) => {
  const { sqlitePath, store } = await createIsolatedStore(t);
  const raw = "same bytes with different meanings";

  const textTurn = await store.appendTurn({
    threadId: "thread-a",
    turnRole: "user",
    raw,
    mediaType: "text/plain; charset=utf-8",
  });
  const binaryTurn = await store.appendTurn({
    threadId: "thread-a",
    turnRole: "model",
    raw,
    mediaType: "application/octet-stream",
  });

  assert.notEqual(binaryTurn.rawPointerId, textTurn.rawPointerId);

  const textBlob = getRawBlobRow(sqlitePath, textTurn.rawPointerId);
  const binaryBlob = getRawBlobRow(sqlitePath, binaryTurn.rawPointerId);

  assert.equal(textBlob.media_type, "text/plain; charset=utf-8");
  assert.equal(binaryBlob.media_type, "application/octet-stream");
  assert.equal(binaryBlob.storage_path, textBlob.storage_path);
});

test("reads text and binary raw content through stored turns", async (t) => {
  const { store } = await createIsolatedStore(t);
  const textTurn = await store.appendTurn({
    threadId: "thread-a",
    turnRole: "user",
    raw: "hello model",
  });
  const binary = Uint8Array.from([0, 1, 2, 250, 255]);
  const binaryTurn = await store.appendTurn({
    threadId: "thread-a",
    turnRole: "model",
    raw: binary,
    mediaType: "application/octet-stream",
  });

  const storedText = await store.readTurnRaw(textTurn.turnId);
  const storedBinary = await store.readTurnRaw(binaryTurn.turnId);

  assert.equal(Buffer.from(storedText).toString("utf8"), "hello model");
  assert.deepEqual(Buffer.from(storedBinary), Buffer.from(binary));
});

test("refuses to reuse a blob file whose contents no longer match its address", async (t) => {
  const { blobDir, sqlitePath, store } = await createIsolatedStore(t);
  const original = "uncorrupted raw turn";
  const turn = await store.appendTurn({
    threadId: "thread-a",
    turnRole: "user",
    raw: original,
  });
  const rawBlob = getRawBlobRow(sqlitePath, turn.rawPointerId);
  const blobPath = getBlobPath(blobDir, rawBlob);

  await writeFile(blobPath, "corrupted raw turn");

  await assert.rejects(
    async () =>
      await store.appendTurn({
        threadId: "thread-a",
        turnRole: "model",
        raw: original,
      }),
    /sha|checksum|corrupt|mismatch/i,
  );
});

test("reports missing and unreadable blob files clearly", async (t) => {
  const { blobDir, sqlitePath, store } = await createIsolatedStore(t);
  const missingTurn = await store.appendTurn({
    threadId: "thread-a",
    turnRole: "user",
    raw: "missing blob",
  });
  const unreadableTurn = await store.appendTurn({
    threadId: "thread-a",
    turnRole: "model",
    raw: "unreadable blob",
  });

  const missingBlob = getRawBlobRow(sqlitePath, missingTurn.rawPointerId);
  const unreadableBlob = getRawBlobRow(sqlitePath, unreadableTurn.rawPointerId);
  const missingPath = getBlobPath(blobDir, missingBlob);
  const unreadablePath = getBlobPath(blobDir, unreadableBlob);

  await rm(missingPath);
  await chmod(unreadablePath, 0o000);
  t.after(async () => {
    await chmod(unreadablePath, 0o600).catch(() => {});
  });

  await assert.rejects(
    async () => await store.readTurnRaw(missingTurn.turnId),
    /missing|not found|ENOENT/i,
  );
  await assert.rejects(
    async () => await store.readTurnRaw(unreadableTurn.turnId),
    /unreadable|permission|EACCES/i,
  );
});
