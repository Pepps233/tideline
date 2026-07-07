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

export interface AppendTranscriptTurnInput {
  threadId: string;
  turnRole: TranscriptRole;
  raw: string | Uint8Array | ArrayBuffer;
  mediaType?: string;
  createdAt?: Date | string;
}

export interface TranscriptStore {
  appendTurn(input: AppendTranscriptTurnInput): Promise<StoredTranscriptTurn>;
  getTurn(turnId: string): Promise<StoredTranscriptTurn | undefined>;
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
