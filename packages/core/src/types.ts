export type TranscriptRole = "user" | "model";

export type ContextAction = "preserve_exact" | "compact" | "discard";

export type SourceLabel =
  | "acceptance_criterion"
  | "api_name"
  | "code_reference"
  | "command"
  | "design_decision"
  | "error_message"
  | "exact_value"
  | "external_fact"
  | "file_output"
  | "file_path"
  | "open_question"
  | "project_convention"
  | "reasoning"
  | "rule"
  | "task_state"
  | "test_result"
  | "tool_output"
  | "user_instruction"
  | "exploration";

export interface StoredTranscriptTurn {
  turnId: string;
  threadId: string;
  turnIndex: number;
  turnRole: TranscriptRole;
  rawPointerId: string;
  sourceItemIds: string[];
  derivedContextBlockIds: string[];
  createdAt: string;
}

export interface RawBlobPointer {
  rawPointerId: string;
  sha256: string;
  byteLength: number;
  mediaType: string;
  storageKind: "file";
  storagePath: string;
}

export interface StoredSourceItem {
  sourceItemId: string;
  turnId: string;
  itemIndex: number;
  rawPointerId: string;
  rawStartByteOffset: number | null;
  rawEndByteOffset: number | null;
  renderedExcerpt: string;
  contextAction: ContextAction;
  actionReason: string;
  labels: SourceLabel[];
  createdAt: string;
}

export interface StoredContextBlock {
  contextBlockId: string;
  threadId: string;
  blockIndex: number;
  summary: string;
  sourceItemIds: string[];
  labels: SourceLabel[];
  createdAt: string;
}

export interface AppendTranscriptTurnInput {
  threadId: string;
  turnRole: TranscriptRole;
  raw: string | Uint8Array | ArrayBuffer;
  mediaType?: string;
  createdAt?: Date | string;
}

export interface BuildContextBlocksInput {
  threadId: string;
  groups: Array<{
    sourceItemIds: string[];
  }>;
  createdAt?: Date | string;
}

export interface AssembleContextInput {
  threadId: string;
  activeTurn: number;
  tokenBudget?: number;
  task?: string;
  scope?: string;
}

export type AssembledContextSectionKind =
  | "full_transcript_anchors"
  | "recent_full_transcript"
  | "exact_source_items"
  | "compacted_context_blocks"
  | "open_questions"
  | "expandable_sources";

export type AssembledContextItemSourceType =
  "turn" | "source_item" | "context_block";

export interface AssembledContextItem {
  id: string;
  sourceType: AssembledContextItemSourceType;
  text: string;
  reason: string;
  labels?: SourceLabel[];
  turnId?: string;
  turnIndex?: number;
  sourceItemIds?: string[];
  contextBlockId?: string;
}

export interface AssembledContextSection {
  kind: AssembledContextSectionKind;
  title: string;
  items: AssembledContextItem[];
}

export interface AssemblyReceipt {
  assemblyId: string;
  threadId: string;
  activeTurn: number;
  includedFullTurnIds: string[];
  middleTurnIds: string[];
  exactSourceItemIds: string[];
  contextBlockIds: string[];
  discardedSourceItemIds: string[];
  estimatedTokens: number;
  createdAt: string;
}

export interface AssembledContextPacket {
  threadId: string;
  activeTurn: number;
  sections: AssembledContextSection[];
  receipt: AssemblyReceipt;
}

export interface TranscriptStore {
  appendTurn(input: AppendTranscriptTurnInput): Promise<StoredTranscriptTurn>;
  assembleContext(input: AssembleContextInput): Promise<AssembledContextPacket>;
  buildContextBlocks(
    input: BuildContextBlocksInput,
  ): Promise<StoredContextBlock[]>;
  getContextBlock(
    contextBlockId: string,
  ): Promise<StoredContextBlock | undefined>;
  getTurn(turnId: string): Promise<StoredTranscriptTurn | undefined>;
  listThreadContextBlocks(threadId: string): Promise<StoredContextBlock[]>;
  getSourceItem(sourceItemId: string): Promise<StoredSourceItem | undefined>;
  listTurnSourceItems(turnId: string): Promise<StoredSourceItem[]>;
  listThreadSourceItems(threadId: string): Promise<StoredSourceItem[]>;
  listThreadTurns(threadId: string): Promise<StoredTranscriptTurn[]>;
  readTurnRaw(turnId: string): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface CreateTranscriptStoreOptions {
  sqlitePath: string;
  blobDir: string;
  clock?: () => Date | string;
}
