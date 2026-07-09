import {
  HOOK_EVENTS,
  PUBLIC_CLI_COMMAND,
  TIDELINE_MCP_TABLE,
  type HookEventDefinition,
  type HookGroup,
  type HookHandler,
  type HooksFile,
  type McpCommandSpec,
} from "./types.js";

export function upsertTidelineMcpConfig(
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

export function removeTomlTable(content: string, tableName: string): string {
  const lines = content.length > 0 ? content.split(/\r?\n/u) : [];
  const start = lines.findIndex(
    (line) => parseTomlTableName(line) === tableName,
  );

  if (start === -1) {
    return content;
  }

  const end = findTomlTableEnd(lines, start, tableName);

  return `${[...lines.slice(0, start), ...lines.slice(end)].join("\n").trimEnd()}\n`;
}

export function assertTidelineMcpConfig(
  config: string,
  configPath: string,
): void {
  const tableLines = findTomlTableLines(config, TIDELINE_MCP_TABLE);

  if (!tableLines) {
    throw new Error(
      `Codex config is missing [${TIDELINE_MCP_TABLE}] in ${configPath}`,
    );
  }

  if (!tableLines.some((line) => /^\s*command\s*=/u.test(line))) {
    throw new Error(
      `Codex config is missing Tideline MCP command in ${configPath}`,
    );
  }
}

export function upsertTidelineHooks(
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

export function removeTidelineHooks(currentHooks: string): string {
  const hooksFile = parseHooksFile(currentHooks);
  const hooks = hooksFile.hooks ?? {};

  for (const [eventName, groups] of Object.entries(hooks)) {
    const retainedGroups = groups
      .map(removeTidelineHandlers)
      .filter((group): group is HookGroup => group.hooks.length > 0);

    if (retainedGroups.length > 0) {
      hooks[eventName] = retainedGroups;
    } else {
      delete hooks[eventName];
    }
  }

  hooksFile.hooks = hooks;
  return `${JSON.stringify(hooksFile, null, 2)}\n`;
}

export function parseHooksFile(content: string): HooksFile {
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

export function assertTidelineHooks(
  hooksFile: HooksFile,
  hooksPath: string,
): void {
  const hooks = hooksFile.hooks ?? {};

  for (const definition of HOOK_EVENTS) {
    const tidelineGroups = (hooks[definition.event] ?? []).filter((group) =>
      group.hooks.some(isTidelineHookHandler),
    );

    if (tidelineGroups.length !== 1) {
      throw new Error(
        `Codex hooks config must contain exactly one Tideline ${definition.event} hook group in ${hooksPath}`,
      );
    }
  }
}

export function shellQuote(value: string): string {
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

export function formatCommandForDisplay(command: McpCommandSpec): string {
  return [command.command, ...command.args].map(shellQuote).join(" ");
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

  const end = findTomlTableEnd(lines, start, tableName);

  return [...lines.slice(0, start), ...replacement, ...lines.slice(end)].join(
    "\n",
  );
}

function findTomlTableEnd(
  lines: string[],
  start: number,
  tableName: string,
): number {
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

  return end;
}

function parseTomlTableName(line: string | undefined): string | undefined {
  const match = line?.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/u);

  return match?.[1]?.trim();
}

function findTomlTableLines(
  content: string,
  tableName: string,
): string[] | undefined {
  const lines = content.length > 0 ? content.split(/\r?\n/u) : [];
  const start = lines.findIndex(
    (line) => parseTomlTableName(line) === tableName,
  );

  if (start === -1) {
    return undefined;
  }

  return lines.slice(start + 1, findTomlTableEnd(lines, start, tableName));
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
    handler.command.includes(" hook codex") ||
    handler.command.startsWith(`${PUBLIC_CLI_COMMAND} hook codex`) ||
    handler.command.startsWith("tideline hook codex") ||
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

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlArray(values: string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}
