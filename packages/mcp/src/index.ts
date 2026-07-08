import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type {
  AssembleContextInput,
  StoredTranscriptTurn,
  TranscriptStore,
} from "@tideline/core";

export interface CreateTidelineMcpServerOptions {
  store: TranscriptStore;
  name?: string;
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

interface TurnMetadata {
  turnId: string;
  threadId: string;
  turnIndex: number;
  turnRole: StoredTranscriptTurn["turnRole"];
  sourceItemIds: string[];
  derivedContextBlockIds: string[];
  createdAt: string;
}

interface TimelinePayload {
  sessionId: string;
  threadId: string;
  turns: TurnMetadata[];
  contextBlocks: ContextBlocksPayload["contextBlocks"];
}

const DEFAULT_EXPANSION_TOKEN_BUDGET = 5000;
const MAX_EXPANSION_TOKEN_BUDGET = 15000;

export function createTidelineMcpServer(
  options: CreateTidelineMcpServerOptions,
): McpServer {
  const server = new McpServer({
    name: options.name ?? "tideline-mcp",
    version: options.version ?? "0.0.0",
  });
  const { store } = options;

  registerTools(server, store);
  registerResources(server, store);

  return server;
}

function registerTools(server: McpServer, store: TranscriptStore): void {
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
}

function registerResources(server: McpServer, store: TranscriptStore): void {
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
