import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

interface CodexInstallArgs {
  configPath?: string;
  dryRun: boolean;
  hookCommand?: string;
  hooksPath?: string;
  mcpCommand?: string;
  repoRoot?: string;
}

interface ParsedCodexInstallArgs extends CodexInstallArgs {
  help: boolean;
}

interface McpCommandSpec {
  args: string[];
  command: string;
}

interface HookHandler {
  command: string;
  statusMessage?: string;
  timeout?: number;
  type: "command";
  [key: string]: unknown;
}

interface HookGroup {
  hooks: HookHandler[];
  matcher?: string;
  [key: string]: unknown;
}

interface HooksFile {
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

interface HookEventDefinition {
  event: "SessionStart" | "UserPromptSubmit" | "PostToolUse" | "Stop";
  matcher?: string;
  statusMessage: string;
}

const TIDELINE_MCP_TABLE = "mcp_servers.tideline";
const HOOK_EVENTS: HookEventDefinition[] = [
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

export async function runCodexInstallCommand(args: string[]): Promise<void> {
  const installArgs = parseCodexInstallArgs(args);

  if (installArgs.help) {
    printCodexInstallHelp();
    return;
  }

  await installCodexIntegration(installArgs);
}

async function installCodexIntegration(args: CodexInstallArgs): Promise<void> {
  const repoRoot = resolveRepoRoot(args.repoRoot);
  const configPath = path.resolve(
    expandHomePath(args.configPath ?? "~/.codex/config.toml"),
  );
  const hooksPath = path.resolve(
    expandHomePath(args.hooksPath ?? "~/.codex/hooks.json"),
  );
  const mcpCommand = resolveMcpCommand(args, repoRoot);
  const hookCommand = resolveHookCommand(args, repoRoot);
  const currentConfig = await readTextIfExists(configPath);
  const currentHooks = await readTextIfExists(hooksPath);
  const nextConfig = upsertTidelineMcpConfig(currentConfig, mcpCommand);
  const nextHooks = upsertTidelineHooks(currentHooks, hookCommand);

  if (args.dryRun) {
    process.stdout.write(
      [
        "Tideline Codex integration dry run.",
        `Would update config: ${configPath}`,
        `Would update hooks: ${hooksPath}`,
        `MCP command: ${formatCommandForDisplay(mcpCommand)}`,
        `Hook command: ${hookCommand}`,
      ].join("\n") + "\n",
    );
    return;
  }

  await mkdir(path.dirname(configPath), { recursive: true });
  await mkdir(path.dirname(hooksPath), { recursive: true });
  await writeFile(configPath, nextConfig, "utf8");
  await writeFile(hooksPath, nextHooks, "utf8");

  process.stdout.write(
    [
      "Installed Tideline Codex integration.",
      `Updated config: ${configPath}`,
      `Updated hooks: ${hooksPath}`,
      "Restart Codex, then run /hooks to review and trust the Tideline hooks.",
    ].join("\n") + "\n",
  );
}

function parseCodexInstallArgs(args: string[]): ParsedCodexInstallArgs {
  const parsed: ParsedCodexInstallArgs = { dryRun: false, help: false };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }

    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }

    if (arg === "--config-path") {
      parsed.configPath = readArgValue(args, (index += 1), arg);
      continue;
    }

    if (arg?.startsWith("--config-path=")) {
      parsed.configPath = arg.slice("--config-path=".length);
      continue;
    }

    if (arg === "--hooks-path") {
      parsed.hooksPath = readArgValue(args, (index += 1), arg);
      continue;
    }

    if (arg?.startsWith("--hooks-path=")) {
      parsed.hooksPath = arg.slice("--hooks-path=".length);
      continue;
    }

    if (arg === "--repo-root") {
      parsed.repoRoot = readArgValue(args, (index += 1), arg);
      continue;
    }

    if (arg?.startsWith("--repo-root=")) {
      parsed.repoRoot = arg.slice("--repo-root=".length);
      continue;
    }

    if (arg === "--mcp-command") {
      parsed.mcpCommand = readArgValue(args, (index += 1), arg);
      continue;
    }

    if (arg?.startsWith("--mcp-command=")) {
      parsed.mcpCommand = arg.slice("--mcp-command=".length);
      continue;
    }

    if (arg === "--hook-command") {
      parsed.hookCommand = readArgValue(args, (index += 1), arg);
      continue;
    }

    if (arg?.startsWith("--hook-command=")) {
      parsed.hookCommand = arg.slice("--hook-command=".length);
      continue;
    }

    throw new Error(`Unknown argument: ${arg ?? ""}`);
  }

  return parsed;
}

function readArgValue(args: string[], index: number, flag: string): string {
  const value = args[index];

  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }

  return value;
}

function resolveMcpCommand(
  args: CodexInstallArgs,
  repoRoot: string | undefined,
): McpCommandSpec {
  if (args.mcpCommand) {
    return { args: [], command: args.mcpCommand };
  }

  const mcpScript = repoRoot
    ? path.join(repoRoot, "packages", "mcp", "dist", "cli.js")
    : undefined;

  if (mcpScript && existsSync(mcpScript)) {
    return { args: [mcpScript], command: process.execPath };
  }

  return { args: [], command: "tideline-mcp" };
}

function resolveHookCommand(
  args: CodexInstallArgs,
  repoRoot: string | undefined,
): string {
  if (args.hookCommand) {
    return args.hookCommand;
  }

  const hookScript = repoRoot
    ? path.join(repoRoot, "packages", "hooks", "dist", "codex-hook-adapter.js")
    : undefined;

  if (hookScript && existsSync(hookScript)) {
    return `${shellQuote(process.execPath)} ${shellQuote(hookScript)}`;
  }

  return "tideline-codex-hook";
}

function resolveRepoRoot(repoRootArg: string | undefined): string | undefined {
  if (repoRootArg) {
    return path.resolve(expandHomePath(repoRootArg));
  }

  let current = process.cwd();

  while (true) {
    if (
      existsSync(path.join(current, "package.json")) &&
      existsSync(path.join(current, "packages", "mcp")) &&
      existsSync(path.join(current, "packages", "hooks"))
    ) {
      return current;
    }

    const parent = path.dirname(current);

    if (parent === current) {
      return undefined;
    }

    current = parent;
  }
}

function upsertTidelineMcpConfig(
  currentConfig: string,
  command: McpCommandSpec,
): string {
  const tableBody = [
    `command = ${tomlString(command.command)}`,
    ...(command.args.length > 0 ? [`args = ${tomlArray(command.args)}`] : []),
    "enabled = true",
    "startup_timeout_sec = 20",
    "tool_timeout_sec = 60",
  ].join("\n");

  return (
    upsertTomlTable(currentConfig, TIDELINE_MCP_TABLE, tableBody).trimEnd() +
    "\n"
  );
}

function upsertTomlTable(
  content: string,
  tableName: string,
  tableBody: string,
): string {
  const lines = content.length > 0 ? content.split(/\r?\n/u) : [];
  const tableHeader = `[${tableName}]`;
  const start = lines.findIndex(
    (line) => parseTomlTableName(line) === tableName,
  );
  const replacement = [tableHeader, tableBody, ""];

  if (start === -1) {
    const base = lines.filter(
      (line, index) => index !== lines.length - 1 || line.length > 0,
    );

    return [...base, ...(base.length > 0 ? [""] : []), ...replacement].join(
      "\n",
    );
  }

  let end = start + 1;

  while (end < lines.length) {
    const foundTableName = parseTomlTableName(lines[end]);

    if (
      foundTableName &&
      foundTableName !== tableName &&
      !foundTableName.startsWith(`${tableName}.`)
    ) {
      break;
    }

    end += 1;
  }

  return [...lines.slice(0, start), ...replacement, ...lines.slice(end)].join(
    "\n",
  );
}

function parseTomlTableName(line: string | undefined): string | undefined {
  const match = line?.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/u);

  return match?.[1]?.trim();
}

function upsertTidelineHooks(
  currentHooks: string,
  hookCommand: string,
): string {
  const hooksFile = parseHooksFile(currentHooks);
  const hooks = hooksFile.hooks ?? {};

  for (const definition of HOOK_EVENTS) {
    const existingGroups = hooks[definition.event] ?? [];
    const retainedGroups = existingGroups
      .map(removeTidelineHandlers)
      .filter((group): group is HookGroup => group.hooks.length > 0);

    hooks[definition.event] = [
      ...retainedGroups,
      createTidelineHookGroup(definition, hookCommand),
    ];
  }

  hooksFile.hooks = hooks;
  return `${JSON.stringify(hooksFile, null, 2)}\n`;
}

function parseHooksFile(content: string): HooksFile {
  if (content.trim().length === 0) {
    return { hooks: {} };
  }

  const parsed = JSON.parse(content) as unknown;

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Codex hooks file must contain a JSON object.");
  }

  const hooksFile = parsed as HooksFile;

  if (
    hooksFile.hooks !== undefined &&
    (!hooksFile.hooks ||
      typeof hooksFile.hooks !== "object" ||
      Array.isArray(hooksFile.hooks))
  ) {
    throw new Error("Codex hooks file hooks field must be an object.");
  }

  return hooksFile;
}

function removeTidelineHandlers(group: HookGroup): HookGroup {
  return {
    ...group,
    hooks: group.hooks.filter((handler) => !isTidelineHookHandler(handler)),
  };
}

function isTidelineHookHandler(handler: HookHandler): boolean {
  return (
    handler.command.includes("tideline-codex-hook") ||
    handler.command.includes("codex-hook-adapter.js") ||
    handler.statusMessage?.startsWith("Capturing Tideline ") === true
  );
}

function createTidelineHookGroup(
  definition: HookEventDefinition,
  hookCommand: string,
): HookGroup {
  const group: HookGroup = {
    hooks: [
      {
        command: `${hookCommand} --event ${definition.event}`,
        statusMessage: definition.statusMessage,
        timeout: 30,
        type: "command",
      },
    ],
  };

  if (definition.matcher) {
    group.matcher = definition.matcher;
  }

  return group;
}

async function readTextIfExists(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return "";
    }

    throw error;
  }
}

function expandHomePath(value: string): string {
  if (value === "~") {
    return homedir();
  }

  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(homedir(), value.slice(2));
  }

  return value;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlArray(values: string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

function shellQuote(value: string): string {
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

function formatCommandForDisplay(command: McpCommandSpec): string {
  return [command.command, ...command.args].map(shellQuote).join(" ");
}

function printCodexInstallHelp(): void {
  process.stdout.write(`Usage: tideline codex install [options]

Writes Tideline MCP configuration to Codex config.toml and Tideline capture
hooks to Codex hooks.json. Existing non-Tideline config is preserved.

Options:
  --config-path <path>  Codex config.toml path
  --hooks-path <path>   Codex hooks.json path
  --repo-root <path>    Tideline checkout root for local dist commands
  --mcp-command <cmd>   Use a PATH command for the MCP server
  --hook-command <cmd>  Use a PATH or shell command for Codex hooks
  --dry-run            Print the planned install without writing files
`);
}
