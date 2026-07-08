import type {
  AssemblyReceiptItem,
  RelationshipEntityType,
  RelationshipType,
  SearchContextTextKind,
} from "./types.js";

export function normalizeAssemblyStatus(status: string): "assembled" {
  if (status !== "assembled") {
    throw new Error(`Unsupported assembly receipt status: ${status}`);
  }

  return status;
}

export function normalizeAssemblyReceiptEntityType(
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

export function normalizeSectionKind(
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

export function normalizeRelationshipType(value: string): RelationshipType {
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

export function normalizeRelationshipEntityType(
  value: string,
): RelationshipEntityType {
  if (value === "context_block" || value === "source_item") {
    return value;
  }

  throw new Error(`Unsupported relationship entity type: ${value}`);
}

export function normalizeSearchContextTextKind(
  value: string,
): SearchContextTextKind {
  switch (value) {
    case "context_block_summary":
    case "source_item_exact":
    case "source_item_uncovered_compact":
      return value;
    default:
      throw new Error(`Unsupported search text kind: ${value}`);
  }
}
