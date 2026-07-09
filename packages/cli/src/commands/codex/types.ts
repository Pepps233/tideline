export interface CodexPaths {
  configPath: string;
  hooksPath: string;
}

export interface McpCommandSpec {
  args: string[];
  command: string;
}

export interface TidelineStoragePaths {
  blobDir: string;
  installPath: string;
  logsDir: string;
  sqlitePath: string;
  storagePath: string;
}

export interface CodexInstallRecord {
  configPath: string;
  hooksPath: string;
  installed: true;
}

export interface InstallRecord {
  agents: Record<string, CodexInstallRecord>;
  installedAt: string;
  version: number;
}

export interface HookHandler {
  command: string;
  statusMessage?: string;
  timeout?: number;
  type: "command";
  [key: string]: unknown;
}

export interface HookGroup {
  hooks: HookHandler[];
  matcher?: string;
  [key: string]: unknown;
}

export interface HooksFile {
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

export interface HookEventDefinition {
  event: "SessionStart" | "UserPromptSubmit" | "PostToolUse" | "Stop";
  matcher?: string;
  statusMessage: string;
}

export const CODEX_AGENT_ID = "codex";
export const PUBLIC_CLI_COMMAND = "tideline-context";
export const TIDELINE_INSTALL_VERSION = 1;
export const TIDELINE_MCP_TABLE = "mcp_servers.tideline";

export const HOOK_EVENTS: HookEventDefinition[] = [
  {
    event: "SessionStart",
    matcher: "startup|resume|clear|compact",
    statusMessage: "Capturing Tideline session",
  },
  {
    event: "UserPromptSubmit",
    statusMessage: "Capturing Tideline prompt",
  },
  {
    event: "PostToolUse",
    matcher: "*",
    statusMessage: "Capturing Tideline tool output",
  },
  {
    event: "Stop",
    statusMessage: "Capturing Tideline response",
  },
];
