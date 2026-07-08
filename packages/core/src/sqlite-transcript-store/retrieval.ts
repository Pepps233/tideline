import { createHash, randomUUID } from "node:crypto";

import type BetterSqlite3 from "better-sqlite3";

import { normalizeSourceLabel } from "../source-items/labels.js";
import type {
  AssembledContextSectionKind,
  SourceLabel,
  StoredContextBlock,
  StoredSourceItem,
} from "../types.js";
import {
  normalizeContextAction,
  normalizeCreatedAt,
  normalizeThreadId,
  parseJsonStringArray,
} from "../validation.js";
import { listThreadContextBlocks } from "./context-blocks.js";

interface SourceItemWithTurn extends StoredSourceItem {
  threadId: string;
  turnIndex: number;
}

export interface EmbeddingProvider {
  name: string;
  dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

export type RelationshipType =
  "derived_from" | "same_topic_as" | "refines" | "supersedes" | "resolved_by";

export type RelationshipEntityType = "context_block" | "source_item";

export interface StoredRelationship {
  relationshipId: string;
  threadId: string;
  relationshipType: RelationshipType;
  fromEntityType: RelationshipEntityType;
  fromEntityId: string;
  toEntityType: RelationshipEntityType;
  toEntityId: string;
  reason: string;
  createdAt: string;
}

export interface SearchContextInput {
  threadId: string;
  query: string;
  limit?: number;
}

export type SearchContextTextKind =
  | "context_block_summary"
  | "source_item_exact"
  | "source_item_uncovered_compact";

export interface SearchContextResultItem {
  entityType: RelationshipEntityType;
  entityId: string;
  textKind: SearchContextTextKind;
  preview: string;
  score: number;
  reasons: string[];
}

export interface SearchContextResult {
  threadId: string;
  query: string;
  results: SearchContextResultItem[];
}

export type AssemblyReceiptEntityType =
  "turn" | "source_item" | "context_block";

export interface AssemblyReceiptItem {
  itemIndex: number;
  entityType: AssemblyReceiptEntityType;
  entityId: string;
  sectionKind: AssembledContextSectionKind;
  included: boolean;
  estimatedTokens: number;
  score: number;
  reasons: string[];
  omitReason?: string | undefined;
}

export interface AssemblyReceipt {
  assemblyId: string;
  threadId: string;
  activeTurn: number;
  status: "assembled";
  includedFullTurnIds: string[];
  middleTurnIds: string[];
  exactSourceItemIds: string[];
  contextBlockIds: string[];
  discardedSourceItemIds: string[];
  estimatedTokens: number;
  items: AssemblyReceiptItem[];
  createdAt: string;
}

export interface StoredAssemblyReceipt extends AssemblyReceipt {}

interface SourceItemWithTurnRow {
  source_item_id: string;
  turn_id: string;
  item_index: number;
  raw_pointer_id: string;
  raw_start_byte_offset: number | null;
  raw_end_byte_offset: number | null;
  rendered_excerpt: string;
  context_action: string;
  action_reason: string;
  created_at: string;
  thread_id: string;
  turn_index: number;
}

interface SourceLabelRow {
  source_item_id: string;
  label: string;
}

interface SearchIndexEntry {
  searchIndexEntryId: string;
  threadId: string;
  entityType: RelationshipEntityType;
  entityId: string;
  textKind: SearchContextTextKind;
  embedding: number[];
  lexicalText: string;
  createdAt: string;
  updatedAt: string;
}

interface SearchIndexEntryRow {
  search_index_entry_id: string;
  thread_id: string;
  entity_type: string;
  entity_id: string;
  text_kind: string;
  embedding_json: string;
  lexical_text: string;
  created_at: string;
  updated_at: string;
}

interface RelationshipRow {
  relationship_id: string;
  thread_id: string;
  relationship_type: string;
  from_entity_type: string;
  from_entity_id: string;
  to_entity_type: string;
  to_entity_id: string;
  reason: string;
  created_at: string;
}

interface AssemblyReceiptRow {
  assembly_id: string;
  thread_id: string;
  active_turn: number;
  status: string;
  estimated_tokens: number;
  created_at: string;
}

interface AssemblyReceiptItemRow {
  assembly_id: string;
  item_index: number;
  entity_type: string;
  entity_id: string;
  section_kind: string;
  included: number;
  estimated_tokens: number;
  score: number;
  reason_json: string;
  omit_reason: string | null;
}

interface ContextBlockWithText extends StoredContextBlock {
  searchableText: string;
  earliestTurnIndex: number;
}

interface RelationshipDraft {
  relationshipType: RelationshipType;
  fromEntityType: RelationshipEntityType;
  fromEntityId: string;
  toEntityType: RelationshipEntityType;
  toEntityId: string;
  reason: string;
}

interface SearchIndexDraft {
  entityType: RelationshipEntityType;
  entityId: string;
  textKind: SearchContextTextKind;
  lexicalText: string;
}

export interface AssemblyRankingCandidate {
  key: string;
  entityType: RelationshipEntityType;
  entityId: string;
  textKind: SearchContextTextKind;
  text: string;
  labels: SourceLabel[];
  turnIndex: number;
}

export interface AssemblyRankingScore {
  score: number;
  reasons: string[];
}

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;
const DEFAULT_EMBEDDING_DIMENSIONS = 64;
const VECTOR_WEIGHT = 5;
const LEXICAL_WEIGHT = 3;
const TOKEN_PATTERN = /[a-z0-9]+/g;
const STOP_WORDS = new Set([
  "a",
  "about",
  "after",
  "all",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "because",
  "by",
  "for",
  "from",
  "has",
  "have",
  "in",
  "into",
  "is",
  "it",
  "keep",
  "of",
  "on",
  "or",
  "should",
  "that",
  "the",
  "this",
  "to",
  "was",
  "with",
]);

export function createDefaultEmbeddingProvider(): EmbeddingProvider {
  return {
    name: "local-hash",
    dimensions: DEFAULT_EMBEDDING_DIMENSIONS,
    async embed(texts) {
      return texts.map((text) =>
        hashEmbedding(text, DEFAULT_EMBEDDING_DIMENSIONS),
      );
    },
  };
}

export async function refreshThreadSearchIndex(input: {
  clock: () => Date | string;
  db: BetterSqlite3.Database;
  embeddingProvider: EmbeddingProvider;
  threadId: string;
}): Promise<void> {
  const threadId = normalizeThreadId(input.threadId);
  const now = normalizeCreatedAt(input.clock());
  const sourceItems = listThreadSourceItemsWithTurn(input.db, threadId);
  const sourceItemsById = new Map(
    sourceItems.map((item) => [item.sourceItemId, item]),
  );
  const blocks = listContextBlocksWithText(input.db, threadId, sourceItemsById);
  const indexDrafts = createSearchIndexDrafts({
    blocks,
    db: input.db,
    sourceItems,
    threadId,
  });
  const embeddings = await embedTexts(
    input.embeddingProvider,
    indexDrafts.map((draft) => draft.lexicalText),
  );
  const relationshipDrafts = createRelationshipDrafts({
    blocks,
    sourceItems,
  });

  input.db
    .transaction(() => {
      input.db
        .prepare("DELETE FROM search_index_entries WHERE thread_id = ?")
        .run(threadId);
      input.db
        .prepare("DELETE FROM relationships WHERE thread_id = ?")
        .run(threadId);
      insertSearchIndexEntries(
        input.db,
        threadId,
        now,
        indexDrafts,
        embeddings,
      );
      insertRelationships(input.db, threadId, now, relationshipDrafts);
    })
    .immediate();
}

export async function searchContext(input: {
  clock: () => Date | string;
  db: BetterSqlite3.Database;
  embeddingProvider: EmbeddingProvider;
  request: SearchContextInput;
}): Promise<SearchContextResult> {
  if (!input.request || typeof input.request !== "object") {
    throw new Error("searchContext input is required");
  }

  const threadId = normalizeThreadId(input.request.threadId);
  const query = normalizeSearchQuery(input.request.query);
  const limit = normalizeSearchLimit(input.request.limit);
  let entries = listSearchIndexEntries(input.db, threadId);

  if (entries.length === 0) {
    await refreshThreadSearchIndex({
      clock: input.clock,
      db: input.db,
      embeddingProvider: input.embeddingProvider,
      threadId,
    });
    entries = listSearchIndexEntries(input.db, threadId);
  }

  const [queryEmbedding] = await embedTexts(input.embeddingProvider, [query]);
  const scoredEntries = entries
    .map((entry) => scoreSearchEntry(entry, query, queryEmbedding ?? []))
    .sort(compareSearchResults)
    .slice(0, limit);

  return {
    threadId,
    query,
    results: scoredEntries,
  };
}

export async function rankAssemblyCandidates(input: {
  candidates: AssemblyRankingCandidate[];
  db: BetterSqlite3.Database;
  embeddingProvider: EmbeddingProvider;
  queryText: string;
  threadId: string;
}): Promise<Map<string, AssemblyRankingScore>> {
  const normalizedQuery = input.queryText.replace(/\s+/g, " ").trim();
  const scores = new Map<string, AssemblyRankingScore>();

  if (input.candidates.length === 0) {
    return scores;
  }

  if (normalizedQuery.length === 0) {
    for (const candidate of input.candidates) {
      scores.set(candidate.key, {
        score: 0,
        reasons: ["deterministic order"],
      });
    }

    return scores;
  }

  const entriesByIdentity = new Map(
    listSearchIndexEntries(input.db, input.threadId).map((entry) => [
      searchIdentity(entry),
      entry,
    ]),
  );
  const [queryEmbedding] = await embedTexts(input.embeddingProvider, [
    normalizedQuery,
  ]);
  const fallbackEmbeddings = await embedTexts(
    input.embeddingProvider,
    input.candidates
      .filter((candidate) => !entriesByIdentity.has(searchIdentity(candidate)))
      .map((candidate) => candidate.text),
  );
  const fallbackByKey = new Map<string, number[]>();
  let fallbackIndex = 0;

  for (const candidate of input.candidates) {
    if (!entriesByIdentity.has(searchIdentity(candidate))) {
      fallbackByKey.set(candidate.key, fallbackEmbeddings[fallbackIndex] ?? []);
      fallbackIndex += 1;
    }
  }

  const maxTurnIndex = Math.max(
    1,
    ...input.candidates.map((candidate) => candidate.turnIndex),
  );

  for (const candidate of input.candidates) {
    const entry = entriesByIdentity.get(searchIdentity(candidate));
    const vector = entry?.embedding ?? fallbackByKey.get(candidate.key) ?? [];
    const scored = scoreText({
      embedding: vector,
      lexicalText: candidate.text,
      query: normalizedQuery,
      queryEmbedding: queryEmbedding ?? [],
    });
    const labelBoost = scoreLabels(candidate.labels);
    const recencyBoost = Math.max(0, candidate.turnIndex / maxTurnIndex) * 0.15;
    const reasons = [...scored.reasons];
    let score = scored.score + labelBoost + recencyBoost;

    if (labelBoost > 0) {
      reasons.push("label signal");
    }

    if (recencyBoost > 0) {
      reasons.push("recency signal");
    }

    if (score === 0) {
      reasons.push("deterministic order");
    }

    scores.set(candidate.key, {
      score: roundScore(score),
      reasons,
    });
  }

  return scores;
}

export function listThreadRelationships(
  db: BetterSqlite3.Database,
  threadId: string,
): StoredRelationship[] {
  const normalizedThreadId = normalizeThreadId(threadId);
  const rows = db
    .prepare<[string], RelationshipRow>(
      `SELECT
        relationship_id,
        thread_id,
        relationship_type,
        from_entity_type,
        from_entity_id,
        to_entity_type,
        to_entity_id,
        reason,
        created_at
      FROM relationships
      WHERE thread_id = ?
      ORDER BY created_at ASC, relationship_type ASC, relationship_id ASC`,
    )
    .all(normalizedThreadId);

  return rows.map(mapRelationshipRow);
}

export function listSupersededContextBlockIds(
  db: BetterSqlite3.Database,
  threadId: string,
): Set<string> {
  const rows = db
    .prepare<[string], { to_entity_id: string }>(
      `SELECT to_entity_id
      FROM relationships
      WHERE thread_id = ?
        AND relationship_type = 'supersedes'
        AND to_entity_type = 'context_block'`,
    )
    .all(threadId);

  return new Set(rows.map((row) => row.to_entity_id));
}

export function insertAssemblyReceipt(
  db: BetterSqlite3.Database,
  receipt: AssemblyReceipt,
): void {
  db.transaction(() => {
    db.prepare(
      `INSERT INTO assembly_receipts (
        assembly_id,
        thread_id,
        active_turn,
        status,
        estimated_tokens,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      receipt.assemblyId,
      receipt.threadId,
      receipt.activeTurn,
      receipt.status,
      receipt.estimatedTokens,
      receipt.createdAt,
    );

    const insertItem = db.prepare(
      `INSERT INTO assembly_receipt_items (
        assembly_id,
        item_index,
        entity_type,
        entity_id,
        section_kind,
        included,
        estimated_tokens,
        score,
        reason_json,
        omit_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const item of receipt.items) {
      insertItem.run(
        receipt.assemblyId,
        item.itemIndex,
        item.entityType,
        item.entityId,
        item.sectionKind,
        item.included ? 1 : 0,
        item.estimatedTokens,
        item.score,
        JSON.stringify(item.reasons),
        item.omitReason ?? null,
      );
    }
  }).immediate();
}

export function getAssemblyReceipt(
  db: BetterSqlite3.Database,
  assemblyId: string,
): StoredAssemblyReceipt | undefined {
  if (typeof assemblyId !== "string" || assemblyId.trim().length === 0) {
    throw new Error("assemblyId must be a non-empty string");
  }

  const row = db
    .prepare<[string], AssemblyReceiptRow>(
      `SELECT
        assembly_id,
        thread_id,
        active_turn,
        status,
        estimated_tokens,
        created_at
      FROM assembly_receipts
      WHERE assembly_id = ?`,
    )
    .get(assemblyId);

  return row ? mapAssemblyReceiptRow(db, row) : undefined;
}

export function listThreadAssemblyReceipts(
  db: BetterSqlite3.Database,
  threadId: string,
): StoredAssemblyReceipt[] {
  const normalizedThreadId = normalizeThreadId(threadId);
  const rows = db
    .prepare<[string], AssemblyReceiptRow>(
      `SELECT
        assembly_id,
        thread_id,
        active_turn,
        status,
        estimated_tokens,
        created_at
      FROM assembly_receipts
      WHERE thread_id = ?
      ORDER BY created_at ASC, assembly_id ASC`,
    )
    .all(normalizedThreadId);

  return rows.map((row) => mapAssemblyReceiptRow(db, row));
}

function createSearchIndexDrafts(input: {
  blocks: ContextBlockWithText[];
  db: BetterSqlite3.Database;
  sourceItems: SourceItemWithTurn[];
  threadId: string;
}): SearchIndexDraft[] {
  const coveredCompactSourceItemIds = listCoveredCompactSourceItemIds(
    input.db,
    input.threadId,
  );
  const drafts: SearchIndexDraft[] = [
    ...input.blocks.map((block) => ({
      entityType: "context_block" as const,
      entityId: block.contextBlockId,
      textKind: "context_block_summary" as const,
      lexicalText: block.searchableText,
    })),
    ...input.sourceItems
      .filter((item) => item.contextAction === "preserve_exact")
      .map((item) => ({
        entityType: "source_item" as const,
        entityId: item.sourceItemId,
        textKind: "source_item_exact" as const,
        lexicalText: item.renderedExcerpt,
      })),
    ...input.sourceItems
      .filter(
        (item) =>
          item.contextAction === "compact" &&
          !coveredCompactSourceItemIds.has(item.sourceItemId),
      )
      .map((item) => ({
        entityType: "source_item" as const,
        entityId: item.sourceItemId,
        textKind: "source_item_uncovered_compact" as const,
        lexicalText: item.renderedExcerpt,
      })),
  ];

  return drafts.filter((draft) => draft.lexicalText.trim().length > 0);
}

function listCoveredCompactSourceItemIds(
  db: BetterSqlite3.Database,
  threadId: string,
): Set<string> {
  const rows = db
    .prepare<[string], { source_item_id: string }>(
      `SELECT context_block_source_items.source_item_id
      FROM context_block_source_items
      INNER JOIN source_items
        ON source_items.source_item_id =
          context_block_source_items.source_item_id
      INNER JOIN transcript_turns
        ON transcript_turns.turn_id = source_items.turn_id
      WHERE transcript_turns.thread_id = ?`,
    )
    .all(threadId);

  return new Set(rows.map((row) => row.source_item_id));
}

function insertSearchIndexEntries(
  db: BetterSqlite3.Database,
  threadId: string,
  now: string,
  drafts: SearchIndexDraft[],
  embeddings: number[][],
): void {
  const insertEntry = db.prepare(
    `INSERT INTO search_index_entries (
      search_index_entry_id,
      thread_id,
      entity_type,
      entity_id,
      text_kind,
      embedding_json,
      lexical_text,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const [index, draft] of drafts.entries()) {
    insertEntry.run(
      randomUUID(),
      threadId,
      draft.entityType,
      draft.entityId,
      draft.textKind,
      JSON.stringify(embeddings[index] ?? []),
      draft.lexicalText,
      now,
      now,
    );
  }
}

function insertRelationships(
  db: BetterSqlite3.Database,
  threadId: string,
  now: string,
  drafts: RelationshipDraft[],
): void {
  const insertRelationship = db.prepare(
    `INSERT OR IGNORE INTO relationships (
      relationship_id,
      thread_id,
      relationship_type,
      from_entity_type,
      from_entity_id,
      to_entity_type,
      to_entity_id,
      reason,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const draft of drafts) {
    insertRelationship.run(
      randomUUID(),
      threadId,
      draft.relationshipType,
      draft.fromEntityType,
      draft.fromEntityId,
      draft.toEntityType,
      draft.toEntityId,
      draft.reason,
      now,
    );
  }
}

function createRelationshipDrafts(input: {
  blocks: ContextBlockWithText[];
  sourceItems: SourceItemWithTurn[];
}): RelationshipDraft[] {
  const drafts: RelationshipDraft[] = [];
  const exactItems = input.sourceItems.filter(
    (item) => item.contextAction === "preserve_exact",
  );

  for (const block of input.blocks) {
    for (const sourceItemId of block.sourceItemIds) {
      drafts.push({
        relationshipType: "derived_from",
        fromEntityType: "context_block",
        fromEntityId: block.contextBlockId,
        toEntityType: "source_item",
        toEntityId: sourceItemId,
        reason: "context block links to source item",
      });
    }
  }

  for (let leftIndex = 0; leftIndex < input.blocks.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < input.blocks.length;
      rightIndex += 1
    ) {
      const left = input.blocks[leftIndex];
      const right = input.blocks[rightIndex];

      if (
        !left ||
        !right ||
        !areSameTopic(left.searchableText, right.searchableText)
      ) {
        continue;
      }

      drafts.push({
        relationshipType: "same_topic_as",
        fromEntityType: "context_block",
        fromEntityId: left.contextBlockId,
        toEntityType: "context_block",
        toEntityId: right.contextBlockId,
        reason: "context blocks share topic keywords",
      });
    }
  }

  for (const block of input.blocks) {
    const olderRelatedBlocks = input.blocks.filter(
      (candidate) =>
        candidate.contextBlockId !== block.contextBlockId &&
        candidate.earliestTurnIndex < block.earliestTurnIndex &&
        areSameTopic(block.searchableText, candidate.searchableText),
    );

    if (mentionsSupersede(block.searchableText)) {
      for (const olderBlock of olderRelatedBlocks) {
        drafts.push({
          relationshipType: "supersedes",
          fromEntityType: "context_block",
          fromEntityId: block.contextBlockId,
          toEntityType: "context_block",
          toEntityId: olderBlock.contextBlockId,
          reason: "explicit supersede wording",
        });
      }
    }

    if (mentionsRefine(block.searchableText)) {
      for (const olderBlock of olderRelatedBlocks) {
        drafts.push({
          relationshipType: "refines",
          fromEntityType: "context_block",
          fromEntityId: block.contextBlockId,
          toEntityType: "context_block",
          toEntityId: olderBlock.contextBlockId,
          reason: "explicit refine wording",
        });
      }
    }
  }

  for (const question of exactItems.filter((item) =>
    item.labels.includes("open_question"),
  )) {
    for (const block of input.blocks) {
      if (
        block.earliestTurnIndex <= question.turnIndex ||
        !mentionsResolve(block.searchableText) ||
        sharedTokenCount(question.renderedExcerpt, block.searchableText) === 0
      ) {
        continue;
      }

      drafts.push({
        relationshipType: "resolved_by",
        fromEntityType: "source_item",
        fromEntityId: question.sourceItemId,
        toEntityType: "context_block",
        toEntityId: block.contextBlockId,
        reason: "explicit resolve wording",
      });
    }
  }

  return dedupeRelationshipDrafts(drafts);
}

function dedupeRelationshipDrafts(
  drafts: RelationshipDraft[],
): RelationshipDraft[] {
  const seen = new Set<string>();

  return drafts.filter((draft) => {
    const key = [
      draft.relationshipType,
      draft.fromEntityType,
      draft.fromEntityId,
      draft.toEntityType,
      draft.toEntityId,
    ].join("\0");

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function listContextBlocksWithText(
  db: BetterSqlite3.Database,
  threadId: string,
  sourceItemsById: Map<string, SourceItemWithTurn>,
): ContextBlockWithText[] {
  return listThreadContextBlocks(db, threadId).map((block) => {
    const sourceItems = block.sourceItemIds
      .map((sourceItemId) => sourceItemsById.get(sourceItemId))
      .filter((item): item is SourceItemWithTurn => item !== undefined);
    const sourceText = sourceItems
      .map((item) => item.renderedExcerpt)
      .join("\n");
    const earliestTurnIndex =
      sourceItems.length > 0
        ? Math.min(...sourceItems.map((item) => item.turnIndex))
        : block.blockIndex;

    return {
      ...block,
      earliestTurnIndex,
      searchableText: [block.summary, sourceText].filter(Boolean).join("\n"),
    };
  });
}

function listThreadSourceItemsWithTurn(
  db: BetterSqlite3.Database,
  threadId: string,
): SourceItemWithTurn[] {
  const rows = db
    .prepare<[string], SourceItemWithTurnRow>(
      `SELECT
        source_items.source_item_id,
        source_items.turn_id,
        source_items.item_index,
        source_items.raw_pointer_id,
        source_items.raw_start_byte_offset,
        source_items.raw_end_byte_offset,
        source_items.rendered_excerpt,
        source_items.context_action,
        source_items.action_reason,
        source_items.created_at,
        transcript_turns.thread_id,
        transcript_turns.turn_index
      FROM source_items
      INNER JOIN transcript_turns
        ON transcript_turns.turn_id = source_items.turn_id
      WHERE transcript_turns.thread_id = ?
      ORDER BY transcript_turns.turn_index ASC, source_items.item_index ASC`,
    )
    .all(threadId);
  const labelsByItemId = getSourceLabels(
    db,
    rows.map((row) => row.source_item_id),
  );

  return rows.map((row) => ({
    sourceItemId: row.source_item_id,
    turnId: row.turn_id,
    itemIndex: row.item_index,
    rawPointerId: row.raw_pointer_id,
    rawStartByteOffset: row.raw_start_byte_offset,
    rawEndByteOffset: row.raw_end_byte_offset,
    renderedExcerpt: row.rendered_excerpt,
    contextAction: normalizeContextAction(row.context_action),
    actionReason: row.action_reason,
    labels: labelsByItemId.get(row.source_item_id) ?? [],
    createdAt: row.created_at,
    threadId: row.thread_id,
    turnIndex: row.turn_index,
  }));
}

function getSourceLabels(
  db: BetterSqlite3.Database,
  sourceItemIds: string[],
): Map<string, SourceLabel[]> {
  const labelsByItemId = new Map<string, SourceLabel[]>();

  for (const sourceItemId of sourceItemIds) {
    labelsByItemId.set(sourceItemId, []);
  }

  if (sourceItemIds.length === 0) {
    return labelsByItemId;
  }

  const placeholders = sourceItemIds.map(() => "?").join(", ");
  const rows = db
    .prepare<unknown[], SourceLabelRow>(
      `SELECT
        source_item_id,
        label
      FROM source_labels
      WHERE source_item_id IN (${placeholders})
      ORDER BY source_item_id ASC, label_index ASC, label ASC`,
    )
    .all(...sourceItemIds);

  for (const row of rows) {
    const labels = labelsByItemId.get(row.source_item_id);

    if (labels) {
      labels.push(normalizeSourceLabel(row.label));
    }
  }

  return labelsByItemId;
}

async function embedTexts(
  embeddingProvider: EmbeddingProvider,
  texts: string[],
): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }

  if (
    !Number.isInteger(embeddingProvider.dimensions) ||
    embeddingProvider.dimensions <= 0
  ) {
    throw new Error("embeddingProvider.dimensions must be a positive integer");
  }

  const embeddings = await embeddingProvider.embed(texts);

  if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
    throw new Error("embeddingProvider.embed must return one vector per text");
  }

  return embeddings.map((embedding, index) => {
    if (
      !Array.isArray(embedding) ||
      embedding.length !== embeddingProvider.dimensions ||
      !embedding.every((value) => Number.isFinite(value))
    ) {
      throw new Error(
        `embeddingProvider.embed returned an invalid vector at index ${index}`,
      );
    }

    return embedding;
  });
}

function hashEmbedding(text: string, dimensions: number): number[] {
  const vector = Array.from({ length: dimensions }, () => 0);

  for (const token of tokenize(text)) {
    const digest = createHash("sha256").update(token, "utf8").digest();
    const dimension = (digest[0] ?? 0) % dimensions;
    const sign = (digest[1] ?? 0) % 2 === 0 ? 1 : -1;

    vector[dimension] = (vector[dimension] ?? 0) + sign;
  }

  return vector;
}

function listSearchIndexEntries(
  db: BetterSqlite3.Database,
  threadId: string,
): SearchIndexEntry[] {
  const rows = db
    .prepare<[string], SearchIndexEntryRow>(
      `SELECT
        search_index_entry_id,
        thread_id,
        entity_type,
        entity_id,
        text_kind,
        embedding_json,
        lexical_text,
        created_at,
        updated_at
      FROM search_index_entries
      WHERE thread_id = ?
      ORDER BY entity_type ASC, text_kind ASC, entity_id ASC`,
    )
    .all(threadId);

  return rows.map(mapSearchIndexEntryRow);
}

function mapSearchIndexEntryRow(row: SearchIndexEntryRow): SearchIndexEntry {
  return {
    searchIndexEntryId: row.search_index_entry_id,
    threadId: row.thread_id,
    entityType: normalizeRelationshipEntityType(row.entity_type),
    entityId: row.entity_id,
    textKind: normalizeSearchContextTextKind(row.text_kind),
    embedding: normalizeEmbeddingJson(row.embedding_json),
    lexicalText: row.lexical_text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeEmbeddingJson(value: string): number[] {
  const parsed = JSON.parse(value) as unknown;

  if (
    !Array.isArray(parsed) ||
    !parsed.every((item) => Number.isFinite(item))
  ) {
    throw new Error("embedding_json must contain a JSON number array");
  }

  return parsed as number[];
}

function scoreSearchEntry(
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

function scoreText(input: {
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

function scoreLabels(labels: SourceLabel[]): number {
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

function compareSearchResults(
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

function createPreview(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();

  return normalized.length <= 240
    ? normalized
    : `${normalized.slice(0, 237).trimEnd()}...`;
}

function normalizeSearchQuery(query: string): string {
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new Error("query must be a non-empty string");
  }

  return query.trim();
}

function normalizeSearchLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_SEARCH_LIMIT;
  }

  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("limit must be a positive integer");
  }

  return Math.min(limit, MAX_SEARCH_LIMIT);
}

function mapRelationshipRow(row: RelationshipRow): StoredRelationship {
  return {
    relationshipId: row.relationship_id,
    threadId: row.thread_id,
    relationshipType: normalizeRelationshipType(row.relationship_type),
    fromEntityType: normalizeRelationshipEntityType(row.from_entity_type),
    fromEntityId: row.from_entity_id,
    toEntityType: normalizeRelationshipEntityType(row.to_entity_type),
    toEntityId: row.to_entity_id,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

function mapAssemblyReceiptRow(
  db: BetterSqlite3.Database,
  row: AssemblyReceiptRow,
): StoredAssemblyReceipt {
  const receipt: StoredAssemblyReceipt = {
    assemblyId: row.assembly_id,
    threadId: row.thread_id,
    activeTurn: row.active_turn,
    status: normalizeAssemblyStatus(row.status),
    includedFullTurnIds: [],
    middleTurnIds: [],
    exactSourceItemIds: [],
    contextBlockIds: [],
    discardedSourceItemIds: [],
    estimatedTokens: row.estimated_tokens,
    items: listAssemblyReceiptItems(db, row.assembly_id),
    createdAt: row.created_at,
  };

  for (const item of receipt.items) {
    if (!item.included) {
      continue;
    }

    if (item.entityType === "turn") {
      receipt.includedFullTurnIds.push(item.entityId);
    }

    if (
      item.entityType === "source_item" &&
      (item.sectionKind === "exact_source_items" ||
        item.sectionKind === "open_questions")
    ) {
      receipt.exactSourceItemIds.push(item.entityId);
    }

    if (
      item.entityType === "context_block" &&
      item.sectionKind === "compacted_context_blocks"
    ) {
      receipt.contextBlockIds.push(item.entityId);
    }
  }

  receipt.middleTurnIds = listReceiptMiddleTurnIds(db, row.assembly_id);
  receipt.discardedSourceItemIds = listReceiptDiscardedSourceItemIds(
    db,
    row.assembly_id,
  );

  return receipt;
}

function listAssemblyReceiptItems(
  db: BetterSqlite3.Database,
  assemblyId: string,
): AssemblyReceiptItem[] {
  const rows = db
    .prepare<[string], AssemblyReceiptItemRow>(
      `SELECT
        assembly_id,
        item_index,
        entity_type,
        entity_id,
        section_kind,
        included,
        estimated_tokens,
        score,
        reason_json,
        omit_reason
      FROM assembly_receipt_items
      WHERE assembly_id = ?
      ORDER BY item_index ASC`,
    )
    .all(assemblyId);

  return rows.map(mapAssemblyReceiptItemRow);
}

function listReceiptMiddleTurnIds(
  db: BetterSqlite3.Database,
  assemblyId: string,
): string[] {
  const rows = db
    .prepare<[string], { entity_id: string }>(
      `SELECT entity_id
      FROM assembly_receipt_items
      WHERE assembly_id = ?
        AND entity_type = 'turn'
        AND section_kind = 'expandable_sources'
        AND included = 0
        AND omit_reason = 'middle turn tracked'
      ORDER BY item_index ASC`,
    )
    .all(assemblyId);

  return rows.map((row) => row.entity_id);
}

function listReceiptDiscardedSourceItemIds(
  db: BetterSqlite3.Database,
  assemblyId: string,
): string[] {
  const rows = db
    .prepare<[string], { entity_id: string }>(
      `SELECT entity_id
      FROM assembly_receipt_items
      WHERE assembly_id = ?
        AND entity_type = 'source_item'
        AND section_kind = 'expandable_sources'
        AND included = 0
        AND omit_reason = 'discarded source item'
      ORDER BY item_index ASC`,
    )
    .all(assemblyId);

  return rows.map((row) => row.entity_id);
}

function mapAssemblyReceiptItemRow(
  row: AssemblyReceiptItemRow,
): AssemblyReceiptItem {
  const item: AssemblyReceiptItem = {
    itemIndex: row.item_index,
    entityType: normalizeAssemblyReceiptEntityType(row.entity_type),
    entityId: row.entity_id,
    sectionKind: normalizeSectionKind(row.section_kind),
    included: row.included === 1,
    estimatedTokens: row.estimated_tokens,
    score: row.score,
    reasons: parseJsonStringArray(row.reason_json, "reason_json"),
  };

  if (row.omit_reason !== null) {
    item.omitReason = row.omit_reason;
  }

  return item;
}

function normalizeAssemblyStatus(status: string): "assembled" {
  if (status !== "assembled") {
    throw new Error(`Unsupported assembly receipt status: ${status}`);
  }

  return status;
}

function normalizeAssemblyReceiptEntityType(
  entityType: string,
): AssemblyReceiptItem["entityType"] {
  if (
    entityType === "turn" ||
    entityType === "source_item" ||
    entityType === "context_block"
  ) {
    return entityType;
  }

  throw new Error(`Unsupported assembly receipt entity type: ${entityType}`);
}

function normalizeSectionKind(
  sectionKind: string,
): AssemblyReceiptItem["sectionKind"] {
  switch (sectionKind) {
    case "full_transcript_anchors":
    case "recent_full_transcript":
    case "exact_source_items":
    case "compacted_context_blocks":
    case "open_questions":
    case "expandable_sources":
      return sectionKind;
    default:
      throw new Error(
        `Unsupported assembly receipt section kind: ${sectionKind}`,
      );
  }
}

function normalizeRelationshipType(value: string): RelationshipType {
  switch (value) {
    case "derived_from":
    case "same_topic_as":
    case "refines":
    case "supersedes":
    case "resolved_by":
      return value;
    default:
      throw new Error(`Unsupported relationship type: ${value}`);
  }
}

function normalizeRelationshipEntityType(
  value: string,
): RelationshipEntityType {
  if (value === "context_block" || value === "source_item") {
    return value;
  }

  throw new Error(`Unsupported relationship entity type: ${value}`);
}

function normalizeSearchContextTextKind(value: string): SearchContextTextKind {
  switch (value) {
    case "context_block_summary":
    case "source_item_exact":
    case "source_item_uncovered_compact":
      return value;
    default:
      throw new Error(`Unsupported search text kind: ${value}`);
  }
}

function searchIdentity(input: {
  entityType: RelationshipEntityType;
  entityId: string;
  textKind: SearchContextTextKind;
}): string {
  return `${input.entityType}:${input.entityId}:${input.textKind}`;
}

function areSameTopic(left: string, right: string): boolean {
  const leftTokens = new Set(tokenize(left));
  const rightTokens = new Set(tokenize(right));
  const sharedTokens = sharedTokensFor(leftTokens, rightTokens);
  const smallerSize = Math.max(1, Math.min(leftTokens.size, rightTokens.size));

  return sharedTokens.length >= 2 || sharedTokens.length / smallerSize >= 0.25;
}

function sharedTokenCount(left: string, right: string): number {
  return sharedTokensFor(new Set(tokenize(left)), new Set(tokenize(right)))
    .length;
}

function sharedTokensFor(
  leftTokens: Set<string>,
  rightTokens: Set<string>,
): string[] {
  return [...leftTokens].filter((token) => rightTokens.has(token));
}

function mentionsSupersede(text: string): boolean {
  return /\b(?:supersedes?|replaces?|replaced|deprecates?|instead of|no longer)\b/i.test(
    text,
  );
}

function mentionsRefine(text: string): boolean {
  return /\b(?:refines?|clarifies?|narrows?|updates?)\b/i.test(text);
}

function mentionsResolve(text: string): boolean {
  return /\b(?:resolves?|resolved|answered|confirmed)\b/i.test(text);
}

function uniqueTokens(text: string): string[] {
  return [...new Set(tokenize(text))];
}

function tokenize(text: string): string[] {
  return Array.from(normalizeSearchableText(text).matchAll(TOKEN_PATTERN))
    .map((match) => match[0])
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function normalizeSearchableText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function roundScore(score: number): number {
  return Math.round(score * 1_000_000) / 1_000_000;
}
