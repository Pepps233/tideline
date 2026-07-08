import type { SourceLabel } from "../../types.js";
import type {
  RelationshipEntityType,
  SearchContextResultItem,
  SearchContextTextKind,
  SearchIndexEntry,
} from "./types.js";
import { normalizeSearchableText, tokenize, uniqueTokens } from "./text.js";

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;
const VECTOR_WEIGHT = 5;
const LEXICAL_WEIGHT = 3;

export function scoreSearchEntry(
  entry: SearchIndexEntry,
  query: string,
  queryEmbedding: number[],
): SearchContextResultItem {
  const scored = scoreText({
    embedding: entry.embedding,
    lexicalText: entry.lexicalText,
    query,
    queryEmbedding,
  });

  return {
    entityType: entry.entityType,
    entityId: entry.entityId,
    textKind: entry.textKind,
    preview: createPreview(entry.lexicalText),
    score: scored.score,
    reasons:
      scored.reasons.length > 0 ? scored.reasons : ["deterministic ordering"],
  };
}

export function scoreText(input: {
  embedding: number[];
  lexicalText: string;
  query: string;
  queryEmbedding: number[];
}): { score: number; reasons: string[] } {
  const vectorSimilarity = cosineSimilarity(
    input.queryEmbedding,
    input.embedding,
  );
  const lexicalScore = scoreLexicalMatch(input.query, input.lexicalText);
  const reasons: string[] = [];
  let score = 0;

  if (vectorSimilarity > 0) {
    score += vectorSimilarity * VECTOR_WEIGHT;
    reasons.push("vector similarity");
  }

  if (lexicalScore > 0) {
    score += lexicalScore * LEXICAL_WEIGHT;
    reasons.push("lexical keyword match");
  }

  return {
    score: roundScore(score),
    reasons,
  };
}

export function scoreLabels(labels: SourceLabel[]): number {
  let score = 0;

  if (labels.includes("task_state")) {
    score += 0.2;
  }

  if (labels.includes("open_question")) {
    score += 0.15;
  }

  if (labels.includes("design_decision") || labels.includes("rule")) {
    score += 0.1;
  }

  if (labels.includes("exact_value")) {
    score += 0.05;
  }

  return score;
}

export function compareSearchResults(
  left: SearchContextResultItem,
  right: SearchContextResultItem,
): number {
  return (
    right.score - left.score ||
    compareEntityType(left.entityType, right.entityType) ||
    left.textKind.localeCompare(right.textKind) ||
    left.entityId.localeCompare(right.entityId)
  );
}

export function createPreview(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();

  return normalized.length <= 240
    ? normalized
    : `${normalized.slice(0, 237).trimEnd()}...`;
}

export function normalizeSearchQuery(query: string): string {
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new Error("query must be a non-empty string");
  }

  return query.trim();
}

export function normalizeSearchLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_SEARCH_LIMIT;
  }

  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("limit must be a positive integer");
  }

  return Math.min(limit, MAX_SEARCH_LIMIT);
}

export function searchIdentity(input: {
  entityType: RelationshipEntityType;
  entityId: string;
  textKind: SearchContextTextKind;
}): string {
  return `${input.entityType}:${input.entityId}:${input.textKind}`;
}

export function roundScore(score: number): number {
  return Math.round(score * 1_000_000) / 1_000_000;
}

function scoreLexicalMatch(query: string, text: string): number {
  const queryTokens = uniqueTokens(query);

  if (queryTokens.length === 0) {
    return 0;
  }

  const textTokenSet = new Set(tokenize(text));
  const matchedTokens = queryTokens.filter((token) => textTokenSet.has(token));
  const phraseBoost = normalizeSearchableText(text).includes(
    normalizeSearchableText(query),
  )
    ? 0.25
    : 0;

  return Math.min(1, matchedTokens.length / queryTokens.length + phraseBoost);
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) {
    return 0;
  }

  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;

    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 0;
  }

  return Math.max(0, dot / Math.sqrt(leftMagnitude * rightMagnitude));
}

function compareEntityType(
  left: RelationshipEntityType,
  right: RelationshipEntityType,
): number {
  const order: Record<RelationshipEntityType, number> = {
    context_block: 0,
    source_item: 1,
  };

  return (order[left] ?? 0) - (order[right] ?? 0);
}
