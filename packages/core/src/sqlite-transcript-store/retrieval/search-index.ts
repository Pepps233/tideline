import { randomUUID } from "node:crypto";

import type BetterSqlite3 from "better-sqlite3";

import { normalizeCreatedAt, normalizeThreadId } from "../../validation.js";
import { embedTexts } from "./embeddings.js";
import {
  normalizeRelationshipEntityType,
  normalizeSearchContextTextKind,
} from "./normalizers.js";
import {
  createRelationshipDrafts,
  insertRelationships,
} from "./relationships.js";
import {
  compareSearchResults,
  normalizeSearchLimit,
  normalizeSearchQuery,
  scoreSearchEntry,
} from "./scoring.js";
import {
  listContextBlocksWithText,
  listThreadSourceItemsWithTurn,
} from "./source-data.js";
import type {
  EmbeddingProvider,
  SearchContextInput,
  SearchContextResult,
  SearchIndexDraft,
  SearchIndexEntry,
  SearchIndexEntryRow,
  SourceItemWithTurn,
} from "./types.js";

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

export function listSearchIndexEntries(
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

function createSearchIndexDrafts(input: {
  blocks: { contextBlockId: string; searchableText: string }[];
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
