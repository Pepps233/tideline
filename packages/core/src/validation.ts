import type { ContextAction, TranscriptRole } from "./types.js";

const mediaTypeToken = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const mediaTypePattern = new RegExp(
  `^${mediaTypeToken}/${mediaTypeToken}(?: *; *${mediaTypeToken}=(?:${mediaTypeToken}|"[^"\\\\]*"))*$`,
);
const controlCharacterPattern = /[\u0000-\u001F\u007F]/u;

export function normalizeThreadId(threadId: string): string {
  if (typeof threadId !== "string" || threadId.trim().length === 0) {
    throw new Error("threadId must be a non-empty string");
  }

  return threadId;
}

export function normalizeTurnRole(turnRole: string): TranscriptRole {
  if (turnRole !== "user" && turnRole !== "model") {
    throw new Error("turnRole must be either user or model");
  }

  return turnRole;
}

export function normalizeRaw(raw: string | Uint8Array | ArrayBuffer): Buffer {
  if (typeof raw === "string") {
    return Buffer.from(raw, "utf8");
  }

  if (raw instanceof Uint8Array) {
    return Buffer.from(raw);
  }

  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw);
  }

  throw new Error("raw must be text or bytes");
}

export function normalizeMediaType(
  mediaType: string | undefined,
  raw: string | Uint8Array | ArrayBuffer,
): string {
  if (mediaType !== undefined) {
    const normalized = mediaType.trim();

    if (normalized.length === 0) {
      throw new Error("mediaType must not be empty");
    }

    if (
      controlCharacterPattern.test(normalized) ||
      !mediaTypePattern.test(normalized)
    ) {
      throw new Error("mediaType must be a valid media type");
    }

    return normalized;
  }

  return typeof raw === "string"
    ? "text/plain; charset=utf-8"
    : "application/octet-stream";
}

export function normalizeCreatedAt(createdAt: Date | string): string {
  const date = createdAt instanceof Date ? createdAt : new Date(createdAt);

  if (Number.isNaN(date.getTime())) {
    throw new Error("createdAt must be a valid date");
  }

  return date.toISOString();
}

export function normalizeContextAction(contextAction: string): ContextAction {
  if (
    contextAction !== "preserve_exact" &&
    contextAction !== "compact" &&
    contextAction !== "discard"
  ) {
    throw new Error(`Unsupported context action: ${contextAction}`);
  }

  return contextAction;
}

export function parseJsonStringArray(
  value: string,
  columnName: string,
): string[] {
  const parsed = JSON.parse(value) as unknown;

  if (
    !Array.isArray(parsed) ||
    !parsed.every((item) => typeof item === "string")
  ) {
    throw new Error(`${columnName} must contain a JSON string array`);
  }

  return parsed;
}
