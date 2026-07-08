import { randomUUID } from "node:crypto";

import type BetterSqlite3 from "better-sqlite3";

import { normalizeThreadId } from "../../validation.js";
import {
  normalizeRelationshipEntityType,
  normalizeRelationshipType,
} from "./normalizers.js";
import {
  areSameTopic,
  mentionsRefine,
  mentionsResolve,
  mentionsSupersede,
  sharedTokenCount,
} from "./text.js";
import type {
  ContextBlockWithText,
  RelationshipDraft,
  RelationshipRow,
  SourceItemWithTurn,
  StoredRelationship,
} from "./types.js";

export function insertRelationships(
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

export function createRelationshipDrafts(input: {
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
