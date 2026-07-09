import type {
  AssembleContextInput,
  AssembledContextPacket,
  BuildContextBlocksInput as CoreBuildContextBlocksInput,
  CaptureTurnEventInput,
  CaptureTurnEventReceipt,
  GetSessionStatusInput,
  EmbeddingProvider,
  ExpandContextBlockInput,
  ExpandedContextBlock,
  ListRecentMessagesInput,
  ListSessionsInput,
  SearchContextInput,
  SearchContextResult,
  SessionStatus,
  StoredAssemblyReceipt,
  StoredContextBlock as CoreStoredContextBlock,
  StoredMessagePreview,
  StoredRelationship,
  StoredSessionSummary,
  TranscriptStore as CoreTranscriptStore,
} from "./types.js";

export { createTranscriptStore } from "./sqlite-transcript-store.js";
export { resolveTidelineStorageConfig } from "./storage-config.js";
export type {
  AppendTranscriptTurnInput,
  AssembleContextInput,
  AssembledContextItem,
  AssembledContextPacket,
  AssembledContextSection,
  AssemblyReceipt,
  CaptureTurnEventInput,
  CaptureTurnEventKind,
  CaptureTurnEventReceipt,
  ContextAction,
  CreateTranscriptStoreOptions,
  CurrentSessionPayload,
  CurrentSessionSelectionSource,
  EmbeddingProvider,
  ExpandContextBlockInput,
  ExpandedContextBlock,
  ExpandedContextBlockSource,
  GetSessionStatusInput,
  ListRecentMessagesInput,
  RawBlobPointer,
  RelationshipEntityType,
  RelationshipType,
  ListSessionsInput,
  SearchContextInput,
  SearchContextResult,
  SessionCaptureState,
  SessionStatus,
  SessionStatusStorage,
  SourceLabel,
  StoredAssemblyReceipt,
  StoredMessagePreview,
  StoredRelationship,
  StoredSessionSummary,
  StoredSourceItem,
  StoredTurnMetadata,
  StoredTranscriptTurn,
  TranscriptRole,
} from "./types.js";
export type {
  ResolveTidelineStorageConfigInput,
  TidelineStorageConfig,
} from "./storage-config.js";

export interface StoredContextBlock extends CoreStoredContextBlock {}

export interface BuildContextBlocksInput extends CoreBuildContextBlocksInput {}

export interface TranscriptStore extends CoreTranscriptStore {
  assembleContext(input: AssembleContextInput): Promise<AssembledContextPacket>;
  buildContextBlocks(
    input: BuildContextBlocksInput,
  ): Promise<StoredContextBlock[]>;
  captureTurnEvent(
    input: CaptureTurnEventInput,
  ): Promise<CaptureTurnEventReceipt>;
  expandContextBlock(
    input: ExpandContextBlockInput,
  ): Promise<ExpandedContextBlock | undefined>;
  getContextBlock(
    contextBlockId: string,
  ): Promise<StoredContextBlock | undefined>;
  getAssemblyReceipt(
    assemblyId: string,
  ): Promise<StoredAssemblyReceipt | undefined>;
  getSessionStatus(input: GetSessionStatusInput): Promise<SessionStatus>;
  listThreadAssemblyReceipts(
    threadId: string,
  ): Promise<StoredAssemblyReceipt[]>;
  listThreadContextBlocks(threadId: string): Promise<StoredContextBlock[]>;
  listThreadRelationships(threadId: string): Promise<StoredRelationship[]>;
  listRecentMessages(
    input: ListRecentMessagesInput,
  ): Promise<StoredMessagePreview[]>;
  listSessions(input?: ListSessionsInput): Promise<StoredSessionSummary[]>;
  refreshThreadSearchIndex(threadId: string): Promise<void>;
  searchContext(input: SearchContextInput): Promise<SearchContextResult>;
}
