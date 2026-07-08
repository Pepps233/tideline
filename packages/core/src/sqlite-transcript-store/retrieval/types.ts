import type {
  AssembledContextSectionKind,
  SourceLabel,
  StoredContextBlock,
  StoredSourceItem,
} from "../../types.js";

export interface SourceItemWithTurn extends StoredSourceItem {
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

export interface SourceItemWithTurnRow {
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

export interface SourceLabelRow {
  source_item_id: string;
  label: string;
}

export interface SearchIndexEntry {
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

export interface SearchIndexEntryRow {
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

export interface RelationshipRow {
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

export interface AssemblyReceiptRow {
  assembly_id: string;
  thread_id: string;
  active_turn: number;
  status: string;
  estimated_tokens: number;
  created_at: string;
}

export interface AssemblyReceiptItemRow {
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

export interface ContextBlockWithText extends StoredContextBlock {
  searchableText: string;
  earliestTurnIndex: number;
}

export interface RelationshipDraft {
  relationshipType: RelationshipType;
  fromEntityType: RelationshipEntityType;
  fromEntityId: string;
  toEntityType: RelationshipEntityType;
  toEntityId: string;
  reason: string;
}

export interface SearchIndexDraft {
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
