import type {
  AssembleContextInput,
  AssembledContextPacket,
  BuildContextBlocksInput as CoreBuildContextBlocksInput,
  StoredContextBlock as CoreStoredContextBlock,
  TranscriptStore as CoreTranscriptStore,
} from "./types.js";

export { createTranscriptStore } from "./sqlite-transcript-store.js";
export type {
  AppendTranscriptTurnInput,
  AssembleContextInput,
  AssembledContextItem,
  AssembledContextPacket,
  AssembledContextSection,
  AssemblyReceipt,
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
  assembleContext(input: AssembleContextInput): Promise<AssembledContextPacket>;
  buildContextBlocks(
    input: BuildContextBlocksInput,
  ): Promise<StoredContextBlock[]>;
  getContextBlock(
    contextBlockId: string,
  ): Promise<StoredContextBlock | undefined>;
  listThreadContextBlocks(threadId: string): Promise<StoredContextBlock[]>;
}
