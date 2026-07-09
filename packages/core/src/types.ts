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

export interface AppendTranscriptTurnInput {
  threadId: string;
  turnRole: TranscriptRole;
  raw: string | Uint8Array | ArrayBuffer;
  mediaType?: string;
  createdAt?: Date | string;
}

export type CaptureTurnEventKind =
  | "session_start"
  | "prompt_submit"
  | "tool_result"
  | "model_response_complete"
  | "session_stop";

export interface CaptureTurnEventInput {
  eventId: string;
  kind: CaptureTurnEventKind;
  threadId: string;
  createdAt: Date | string;
  payload?: Record<string, unknown>;
}

export interface CaptureTurnEventReceipt {
  eventId: string;
  kind: CaptureTurnEventKind;
  threadId: string;
  createdAt: string;
  appendedTurnIds: string[];
  flushedToolEventIds: string[];
  contextBlockIds: string[];
  timeline: {
    turns: StoredTranscriptTurn[];
    contextBlocks: StoredContextBlock[];
  };
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

export interface ExpandContextBlockInput {
  contextBlockId: string;
  tokenBudget?: number;
}

export interface SearchContextInput {
  threadId: string;
  query: string;
  limit?: number;
}

export interface ListSessionsInput {
  limit?: number;
}

export interface ListRecentMessagesInput {
  threadId: string;
  limit?: number;
  maxTextLength?: number;
}

export interface GetSessionStatusInput {
  threadId: string;
}

export interface StoredMessagePreview {
  text: string;
  role: TranscriptRole;
  turnIndex: number;
  createdAt: string;
  truncated: boolean;
}

export interface StoredSessionSummary {
  threadId: string;
  turnCount: number;
  latestTurnIndex: number;
  nextActiveTurn: number;
  contextBlockCount: number;
  assemblyReceiptCount: number;
  processedEventCount: number;
  pendingToolEventCount: number;
  firstActivityAt: string;
  latestActivityAt: string;
  firstUserMessagePreview: StoredMessagePreview | null;
  latestUserMessagePreview: StoredMessagePreview | null;
}

export interface StoredTurnMetadata {
  turnId: string;
  threadId: string;
  turnIndex: number;
  turnRole: TranscriptRole;
  sourceItemIds: string[];
  derivedContextBlockIds: string[];
  createdAt: string;
}

export type CurrentSessionSelectionSource =
  | "TIDELINE_THREAD_ID"
  | "CODEX_THREAD_ID"
  | "CODEX_SESSION_ID"
  | "CODEX_CONVERSATION_ID"
  | "latest_active_session";

export interface CurrentSessionPayload {
  session: StoredSessionSummary;
  selectionSource: CurrentSessionSelectionSource;
  nextActiveTurn: number;
  latestTurn: StoredTurnMetadata | null;
  latestUserMessagePreview: StoredMessagePreview | null;
}

export interface SessionStatusStorage {
  sqlitePath: string;
  blobDir: string;
}

export interface SessionCaptureState {
  pendingToolEvents: number;
  hookTrustVerification: "not_checked";
  hookInstallVerification: "not_checked";
  doctorCommand: "tideline-context doctor codex";
}

export interface SessionStatus {
  threadId: string;
  storage: SessionStatusStorage;
  latestActivityAt: string | null;
  turnCount: number;
  processedEventCount: number;
  pendingToolEventCount: number;
  latestStoredMessagePreview: StoredMessagePreview | null;
  captureState: SessionCaptureState;
}

export type SearchContextEntityType = RelationshipEntityType;

export type SearchContextTextKind =
  | "context_block_summary"
  | "source_item_exact"
  | "source_item_uncovered_compact";

export interface SearchContextResultItem {
  entityType: SearchContextEntityType;
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

export interface AssembledContextPacket {
  threadId: string;
  activeTurn: number;
  sections: AssembledContextSection[];
  receipt: AssemblyReceipt;
}

export interface ExpandedContextBlockSource {
  sourceItem: StoredSourceItem;
  turn: StoredTranscriptTurn;
  mediaType: string;
  rawByteLength: number;
  excerpt: string;
  excerptStartByteOffset: number | null;
  excerptEndByteOffset: number | null;
  truncated: boolean;
  usedRenderedExcerpt: boolean;
}

export interface ExpandedContextBlock {
  contextBlock: StoredContextBlock;
  sources: ExpandedContextBlockSource[];
  tokenBudget: number;
  estimatedTokens: number;
  truncated: boolean;
}

export interface TranscriptStore {
  appendTurn(input: AppendTranscriptTurnInput): Promise<StoredTranscriptTurn>;
  captureTurnEvent(
    input: CaptureTurnEventInput,
  ): Promise<CaptureTurnEventReceipt>;
  assembleContext(input: AssembleContextInput): Promise<AssembledContextPacket>;
  buildContextBlocks(
    input: BuildContextBlocksInput,
  ): Promise<StoredContextBlock[]>;
  expandContextBlock(
    input: ExpandContextBlockInput,
  ): Promise<ExpandedContextBlock | undefined>;
  getContextBlock(
    contextBlockId: string,
  ): Promise<StoredContextBlock | undefined>;
  getAssemblyReceipt(
    assemblyId: string,
  ): Promise<StoredAssemblyReceipt | undefined>;
  getTurn(turnId: string): Promise<StoredTranscriptTurn | undefined>;
  getSessionStatus(input: GetSessionStatusInput): Promise<SessionStatus>;
  listRecentMessages(
    input: ListRecentMessagesInput,
  ): Promise<StoredMessagePreview[]>;
  listThreadAssemblyReceipts(
    threadId: string,
  ): Promise<StoredAssemblyReceipt[]>;
  listThreadContextBlocks(threadId: string): Promise<StoredContextBlock[]>;
  listThreadRelationships(threadId: string): Promise<StoredRelationship[]>;
  getSourceItem(sourceItemId: string): Promise<StoredSourceItem | undefined>;
  listSessions(input?: ListSessionsInput): Promise<StoredSessionSummary[]>;
  listTurnSourceItems(turnId: string): Promise<StoredSourceItem[]>;
  listThreadSourceItems(threadId: string): Promise<StoredSourceItem[]>;
  listThreadTurns(threadId: string): Promise<StoredTranscriptTurn[]>;
  refreshThreadSearchIndex(threadId: string): Promise<void>;
  searchContext(input: SearchContextInput): Promise<SearchContextResult>;
  readTurnRaw(turnId: string): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface CreateTranscriptStoreOptions {
  sqlitePath: string;
  blobDir: string;
  clock?: () => Date | string;
  embeddingProvider?: EmbeddingProvider;
}
