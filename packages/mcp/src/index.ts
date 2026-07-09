import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type {
  AssembleContextInput,
  CurrentSessionPayload as CoreCurrentSessionPayload,
  CurrentSessionSelectionSource,
  SearchContextInput,
  StoredMessagePreview,
  StoredSessionSummary,
  StoredTurnMetadata,
  StoredTranscriptTurn,
  TranscriptStore,
} from "@tideline/core";

export interface CurrentThreadEnvHints {
  TIDELINE_THREAD_ID?: string;
  CODEX_THREAD_ID?: string;
  CODEX_SESSION_ID?: string;
  CODEX_CONVERSATION_ID?: string;
}

export interface TidelineMcpStorageConfig {
  sqlitePath: string;
  blobDir: string;
}

export interface CreateTidelineMcpServerOptions {
  store: TranscriptStore;
  currentThreadEnv?: CurrentThreadEnvHints;
  name?: string;
  storageConfig?: TidelineMcpStorageConfig;
  version?: string;
}

interface ThreadTurnsPayload {
  threadId: string;
  turns: TurnMetadata[];
}

interface ContextBlocksPayload {
  threadId: string;
  contextBlocks: Awaited<
    ReturnType<TranscriptStore["listThreadContextBlocks"]>
  >;
}

interface SessionsPayload {
  sessions: Awaited<ReturnType<TranscriptStore["listSessions"]>>;
}

type TurnMetadata = StoredTurnMetadata;

interface CurrentSessionPayload extends CoreCurrentSessionPayload {
  latestTurn: TurnMetadata | null;
}

interface RecentMessagesPayload {
  threadId: string;
  messages: StoredMessagePreview[];
}

interface TimelinePayload {
  sessionId: string;
  threadId: string;
  turns: TurnMetadata[];
  contextBlocks: ContextBlocksPayload["contextBlocks"];
}

const DEFAULT_EXPANSION_TOKEN_BUDGET = 5000;
const DEFAULT_CURRENT_CONTEXT_TOKEN_BUDGET = 6000;
const MAX_EXPANSION_TOKEN_BUDGET = 15000;
const CURRENT_THREAD_ENV_ORDER = [
  "TIDELINE_THREAD_ID",
  "CODEX_THREAD_ID",
  "CODEX_SESSION_ID",
  "CODEX_CONVERSATION_ID",
] as const;

export function createTidelineMcpServer(
  options: CreateTidelineMcpServerOptions,
): McpServer {
  const server = new McpServer({
    name: options.name ?? "tideline-mcp",
    version: options.version ?? "0.0.0",
  });
  const { store } = options;

  registerTools(server, store, options);
  registerResources(server, store);

  return server;
}

function registerTools(
  server: McpServer,
  store: TranscriptStore,
  options: CreateTidelineMcpServerOptions,
): void {
  server.registerTool(
    "list_sessions",
    {
      description:
        "List discoverable Tideline sessions ordered by latest activity.",
      inputSchema: {
        limit: z.number().int().positive().optional(),
      },
    },
    async (input) =>
      withToolErrors(async () => {
        const payload: SessionsPayload = {
          sessions: await store.listSessions(
            input.limit === undefined ? undefined : { limit: input.limit },
          ),
        };

        return toolResult(payload);
      }),
  );

  server.registerTool(
    "get_current_session",
    {
      description:
        "Get the current Tideline session from env hints or latest activity.",
      inputSchema: {},
    },
    async () =>
      withToolErrors(async () => {
        const currentSession = await resolveCurrentSession(
          store,
          options.currentThreadEnv ?? {},
        );

        if (!currentSession) {
          return toolError("No Tideline sessions found");
        }

        return toolResult(currentSession);
      }),
  );

  server.registerTool(
    "list_recent_messages",
    {
      description:
        "List recent stored Tideline messages with bounded text previews.",
      inputSchema: {
        thread_id: z.string().min(1).optional(),
        limit: z.number().int().positive().optional(),
        max_text_length: z.number().int().positive().optional(),
      },
    },
    async (input) =>
      withToolErrors(async () => {
        const threadId =
          input.thread_id ??
          (await requireCurrentSession(store, options.currentThreadEnv ?? {}))
            .session.threadId;
        const messages = await store.listRecentMessages({
          threadId,
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          ...(input.max_text_length === undefined
            ? {}
            : { maxTextLength: input.max_text_length }),
        });
        const payload: RecentMessagesPayload = {
          threadId,
          messages,
        };

        return toolResult(payload);
      }),
  );

  server.registerTool(
    "get_session_status",
    {
      description:
        "Report Tideline storage, latest activity, and hook capture state.",
      inputSchema: {
        thread_id: z.string().min(1).optional(),
      },
    },
    async (input) =>
      withToolErrors(async () => {
        const threadId =
          input.thread_id ??
          (await requireCurrentSession(store, options.currentThreadEnv ?? {}))
            .session.threadId;
        const status = await store.getSessionStatus({ threadId });

        return toolResult({
          ...status,
          storage: options.storageConfig ?? status.storage,
        });
      }),
  );

  server.registerTool(
    "assemble_context",
    {
      description: "Assemble compact Tideline context for a thread.",
      inputSchema: {
        thread_id: z.string().min(1),
        active_turn: z.number().int().positive(),
        task: z.string().optional(),
        scope: z.string().optional(),
        token_budget: z.number().positive().optional(),
      },
    },
    async (input) =>
      withToolErrors(async () => {
        const request: AssembleContextInput = {
          threadId: input.thread_id,
          activeTurn: input.active_turn,
        };

        if (input.task !== undefined) {
          request.task = input.task;
        }

        if (input.scope !== undefined) {
          request.scope = input.scope;
        }

        if (input.token_budget !== undefined) {
          request.tokenBudget = input.token_budget;
        }

        const packet = await store.assembleContext(request);

        return toolResult(packet);
      }),
  );

  server.registerTool(
    "assemble_current_context",
    {
      description:
        "Assemble compact Tideline context for the current detected session.",
      inputSchema: {
        active_turn: z.number().int().positive().optional(),
        task: z.string().optional(),
        scope: z.string().optional(),
        token_budget: z.number().positive().optional(),
      },
    },
    async (input) =>
      withToolErrors(async () => {
        const currentSession = await requireCurrentSession(
          store,
          options.currentThreadEnv ?? {},
        );
        const activeTurn = input.active_turn ?? currentSession.nextActiveTurn;
        const tokenBudget =
          input.token_budget ?? DEFAULT_CURRENT_CONTEXT_TOKEN_BUDGET;
        const request: AssembleContextInput = {
          threadId: currentSession.session.threadId,
          activeTurn,
          tokenBudget,
        };

        if (input.task !== undefined) {
          request.task = input.task;
        }

        if (input.scope !== undefined) {
          request.scope = input.scope;
        }

        const packet = await store.assembleContext(request);

        return toolResult({
          ...packet,
          currentSession,
          request: {
            threadId: request.threadId,
            activeTurn: request.activeTurn,
            tokenBudget: request.tokenBudget,
            ...(request.task === undefined ? {} : { task: request.task }),
            ...(request.scope === undefined ? {} : { scope: request.scope }),
          },
        });
      }),
  );

  server.registerTool(
    "get_context_block",
    {
      description: "Get a Tideline context block by ID.",
      inputSchema: {
        context_block_id: z.string().min(1),
      },
    },
    async (input) =>
      withToolErrors(async () => {
        const block = await store.getContextBlock(input.context_block_id);

        if (!block) {
          return toolError(
            `Context block not found: ${input.context_block_id}`,
          );
        }

        return toolResult(block);
      }),
  );

  server.registerTool(
    "expand_context_block",
    {
      description:
        "Expand a compact Tideline context block into source excerpts.",
      inputSchema: {
        context_block_id: z.string().min(1),
        token_budget: z.number().int().positive().optional(),
      },
    },
    async (input) =>
      withToolErrors(async () => {
        const tokenBudget =
          input.token_budget ?? DEFAULT_EXPANSION_TOKEN_BUDGET;

        if (tokenBudget > MAX_EXPANSION_TOKEN_BUDGET) {
          return toolError(
            `token_budget must be less than or equal to ${MAX_EXPANSION_TOKEN_BUDGET}`,
          );
        }

        const expanded = await store.expandContextBlock({
          contextBlockId: input.context_block_id,
          tokenBudget,
        });

        if (!expanded) {
          return toolError(
            `Context block not found: ${input.context_block_id}`,
          );
        }

        return toolResult(expanded);
      }),
  );

  server.registerTool(
    "list_thread_turns",
    {
      description: "List Tideline turn metadata for a thread.",
      inputSchema: {
        thread_id: z.string().min(1),
      },
    },
    async (input) =>
      withToolErrors(async () => {
        const turns = await store.listThreadTurns(input.thread_id);
        const payload: ThreadTurnsPayload = {
          threadId: input.thread_id,
          turns: turns.map(toTurnMetadata),
        };

        return toolResult(payload);
      }),
  );

  server.registerTool(
    "list_context_blocks",
    {
      description: "List Tideline context blocks for a thread.",
      inputSchema: {
        thread_id: z.string().min(1),
      },
    },
    async (input) =>
      withToolErrors(async () => {
        const contextBlocks = await store.listThreadContextBlocks(
          input.thread_id,
        );
        const payload: ContextBlocksPayload = {
          threadId: input.thread_id,
          contextBlocks,
        };

        return toolResult(payload);
      }),
  );

  server.registerTool(
    "search_context",
    {
      description: "Search indexed Tideline context for a thread.",
      inputSchema: {
        thread_id: z.string().min(1),
        query: z.string().min(1),
        limit: z.number().int().positive().optional(),
      },
    },
    async (input) =>
      withToolErrors(async () => {
        await store.refreshThreadSearchIndex(input.thread_id);

        const request: SearchContextInput = {
          threadId: input.thread_id,
          query: input.query,
        };

        if (input.limit !== undefined) {
          request.limit = input.limit;
        }

        return toolResult(await store.searchContext(request));
      }),
  );

  server.registerTool(
    "list_relationships",
    {
      description: "List Tideline relationship edges for a thread.",
      inputSchema: {
        thread_id: z.string().min(1),
      },
    },
    async (input) =>
      withToolErrors(async () => {
        await store.refreshThreadSearchIndex(input.thread_id);

        const relationships = await store.listThreadRelationships(
          input.thread_id,
        );

        return toolResult({
          threadId: input.thread_id,
          relationships,
        });
      }),
  );

  server.registerTool(
    "get_assembly_receipt",
    {
      description: "Get a Tideline assembly receipt by ID.",
      inputSchema: {
        assembly_id: z.string().min(1),
      },
    },
    async (input) =>
      withToolErrors(async () => {
        const receipt = await store.getAssemblyReceipt(input.assembly_id);

        if (!receipt) {
          return toolError(`Assembly receipt not found: ${input.assembly_id}`);
        }

        return toolResult(receipt);
      }),
  );

  server.registerTool(
    "list_assembly_receipts",
    {
      description: "List Tideline assembly receipts for a thread.",
      inputSchema: {
        thread_id: z.string().min(1),
      },
    },
    async (input) =>
      withToolErrors(async () =>
        toolResult({
          threadId: input.thread_id,
          assemblyReceipts: await store.listThreadAssemblyReceipts(
            input.thread_id,
          ),
        }),
      ),
  );
}

function registerResources(server: McpServer, store: TranscriptStore): void {
  server.registerResource(
    "sessions",
    "memory://sessions",
    {
      title: "Tideline sessions",
      description:
        "Tideline session summaries ordered by latest activity for discovery.",
      mimeType: "application/json",
    },
    async (uri) => {
      const payload: SessionsPayload = {
        sessions: await store.listSessions(),
      };

      return resourceResult(uri.href, payload);
    },
  );

  server.registerResource(
    "session-timeline",
    new ResourceTemplate("memory://session/{session_id}/timeline", {
      list: undefined,
    }),
    {
      title: "Tideline session timeline",
      description: "Tideline turn and context block metadata for a session.",
      mimeType: "application/json",
    },
    async (uri, params) => {
      const sessionId = getTemplateParam(params, "session_id");
      const turns = await store.listThreadTurns(sessionId);
      const contextBlocks = await store.listThreadContextBlocks(sessionId);

      if (turns.length === 0 && contextBlocks.length === 0) {
        throw new Error(`Session timeline not found: ${sessionId}`);
      }

      const payload: TimelinePayload = {
        sessionId,
        threadId: sessionId,
        turns: turns.map(toTurnMetadata),
        contextBlocks,
      };

      return resourceResult(uri.href, payload);
    },
  );

  server.registerResource(
    "context-block",
    new ResourceTemplate("memory://context-block/{context_block_id}", {
      list: undefined,
    }),
    {
      title: "Tideline context block",
      description: "Tideline compact context block metadata.",
      mimeType: "application/json",
    },
    async (uri, params) => {
      const contextBlockId = getTemplateParam(params, "context_block_id");
      const block = await store.getContextBlock(contextBlockId);

      if (!block) {
        throw new Error(`Context block not found: ${contextBlockId}`);
      }

      return resourceResult(uri.href, block);
    },
  );

  server.registerResource(
    "context-block-source",
    new ResourceTemplate("memory://context-block/{context_block_id}/source", {
      list: undefined,
    }),
    {
      title: "Tideline context block source",
      description: "Tideline bounded source excerpts for a context block.",
      mimeType: "application/json",
    },
    async (uri, params) => {
      const contextBlockId = getTemplateParam(params, "context_block_id");
      const expanded = await store.expandContextBlock({
        contextBlockId,
        tokenBudget: DEFAULT_EXPANSION_TOKEN_BUDGET,
      });

      if (!expanded) {
        throw new Error(`Context block not found: ${contextBlockId}`);
      }

      return resourceResult(uri.href, expanded);
    },
  );
}

async function requireCurrentSession(
  store: TranscriptStore,
  currentThreadEnv: CurrentThreadEnvHints,
): Promise<CurrentSessionPayload> {
  const currentSession = await resolveCurrentSession(store, currentThreadEnv);

  if (!currentSession) {
    throw new Error("No Tideline sessions found");
  }

  return currentSession;
}

async function resolveCurrentSession(
  store: TranscriptStore,
  currentThreadEnv: CurrentThreadEnvHints,
): Promise<CurrentSessionPayload | undefined> {
  const sessions = await store.listSessions();
  const sessionsByThreadId = new Map(
    sessions.map((session) => [session.threadId, session]),
  );

  for (const selectionSource of CURRENT_THREAD_ENV_ORDER) {
    const threadId = readCurrentThreadHint(currentThreadEnv, selectionSource);

    if (!threadId) {
      continue;
    }

    const session = sessionsByThreadId.get(threadId);

    if (session) {
      return buildCurrentSessionPayload(store, session, selectionSource);
    }
  }

  const [latestSession] = sessions;

  return latestSession
    ? buildCurrentSessionPayload(store, latestSession, "latest_active_session")
    : undefined;
}

async function buildCurrentSessionPayload(
  store: TranscriptStore,
  session: StoredSessionSummary,
  selectionSource: CurrentSessionSelectionSource,
): Promise<CurrentSessionPayload> {
  const turns = await store.listThreadTurns(session.threadId);
  const latestTurn = turns.length > 0 ? turns[turns.length - 1] : undefined;

  return {
    session,
    selectionSource,
    nextActiveTurn: session.nextActiveTurn,
    latestTurn: latestTurn ? toTurnMetadata(latestTurn) : null,
    latestUserMessagePreview: session.latestUserMessagePreview,
  };
}

function readCurrentThreadHint(
  currentThreadEnv: CurrentThreadEnvHints,
  key: (typeof CURRENT_THREAD_ENV_ORDER)[number],
): string | undefined {
  const value = currentThreadEnv[key];

  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : undefined;
}

async function withToolErrors<T>(
  callback: () => Promise<T>,
): Promise<T | ReturnType<typeof toolError>> {
  try {
    return await callback();
  } catch (error) {
    return toolError(error instanceof Error ? error.message : String(error));
  }
}

function toolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: renderJson(value) }],
    structuredContent: toStructuredContent(value),
  };
}

function toolError(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

function resourceResult(uri: string, value: unknown) {
  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: renderJson(value),
      },
    ],
  };
}

function toStructuredContent(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function renderJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function toTurnMetadata(turn: StoredTranscriptTurn): TurnMetadata {
  return {
    turnId: turn.turnId,
    threadId: turn.threadId,
    turnIndex: turn.turnIndex,
    turnRole: turn.turnRole,
    sourceItemIds: turn.sourceItemIds,
    derivedContextBlockIds: turn.derivedContextBlockIds,
    createdAt: turn.createdAt,
  };
}

function getTemplateParam(
  params: Record<string, string | string[]>,
  key: string,
): string {
  const value = params[key];

  if (Array.isArray(value)) {
    const first = value[0];

    if (first !== undefined) {
      return first;
    }
  }

  if (typeof value === "string") {
    return value;
  }

  throw new Error(`Missing resource parameter: ${key}`);
}
