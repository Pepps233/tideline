import type {
  BuildContextBlocksInput as CoreBuildContextBlocksInput,
  StoredContextBlock as CoreStoredContextBlock,
  TranscriptStore as CoreTranscriptStore,
} from "./types.js";

export { createTranscriptStore } from "./sqlite-transcript-store.js";
export type {
  AppendTranscriptTurnInput,
  ContextAction,
  CreateTranscriptStoreOptions,
  RawBlobPointer,
  SourceLabel,
  StoredSourceItem,
  StoredTranscriptTurn,
  TranscriptRole,
} from "./types.js";

export interface StoredContextBlock extends CoreStoredContextBlock {}

export interface BuildContextBlocksInput extends CoreBuildContextBlocksInput {}

export interface TranscriptStore extends CoreTranscriptStore {
  buildContextBlocks(
    input: BuildContextBlocksInput,
  ): Promise<StoredContextBlock[]>;
  getContextBlock(
    contextBlockId: string,
  ): Promise<StoredContextBlock | undefined>;
  listThreadContextBlocks(threadId: string): Promise<StoredContextBlock[]>;
}
