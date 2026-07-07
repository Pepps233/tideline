import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

import { isNodeError, messageFromError } from "./errors.js";

export function readBlobFile(blobPath: string, rawPointerId: string): Buffer {
  let stats;

  try {
    stats = statSync(blobPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(
        `Raw blob missing for raw pointer ${rawPointerId}: ${blobPath}`,
      );
    }

    throw new Error(
      `Raw blob unreadable for raw pointer ${rawPointerId}: ${messageFromError(error)}`,
    );
  }

  if (!stats.isFile()) {
    throw new Error(
      `Raw blob unreadable for raw pointer ${rawPointerId}: not a file`,
    );
  }

  if ((stats.mode & 0o444) === 0) {
    throw new Error(
      `Raw blob unreadable for raw pointer ${rawPointerId}: permission denied`,
    );
  }

  try {
    return readFileSync(blobPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(
        `Raw blob missing for raw pointer ${rawPointerId}: ${blobPath}`,
      );
    }

    throw new Error(
      `Raw blob unreadable for raw pointer ${rawPointerId}: ${messageFromError(error)}`,
    );
  }
}

export function verifyExistingBlob(
  blobPath: string,
  storagePath: string,
  expectedSha: string,
  expectedByteLength: number,
): void {
  const existing = readBlobFile(blobPath, storagePath);
  if (
    existing.byteLength !== expectedByteLength ||
    hashBytes(existing) !== expectedSha
  ) {
    throw new Error(`Raw blob SHA mismatch at ${storagePath}`);
  }
}

export function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
