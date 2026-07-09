export interface CodexInstallArgs {
  configPath?: string;
  dryRun: boolean;
  hookCommand?: string;
  hooksPath?: string;
  json: boolean;
  mcpCommand?: string;
  repoRoot?: string;
  yes: boolean;
}

export interface ParsedCodexInstallArgs extends CodexInstallArgs {
  help: boolean;
}

export interface CodexMaintenanceArgs {
  configPath?: string;
  hooksPath?: string;
  json: boolean;
  yes: boolean;
}

export interface ParsedCodexMaintenanceArgs extends CodexMaintenanceArgs {
  help: boolean;
}

export function parseCodexInstallArgs(args: string[]): ParsedCodexInstallArgs {
  const parsed: ParsedCodexInstallArgs = {
    dryRun: false,
    help: false,
    json: false,
    yes: false,
  };

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

    if (arg === "--json") {
      parsed.json = true;
      continue;
    }

    if (arg === "--yes" || arg === "-y") {
      parsed.yes = true;
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

export function parseCodexMaintenanceArgs(
  args: string[],
  commandName: "doctor" | "uninstall",
): ParsedCodexMaintenanceArgs {
  const parsed: ParsedCodexMaintenanceArgs = {
    help: false,
    json: false,
    yes: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }

    if (arg === "--json") {
      parsed.json = true;
      continue;
    }

    if (arg === "--yes" || arg === "-y") {
      parsed.yes = true;
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

    throw new Error(`Unknown ${commandName} argument: ${arg ?? ""}`);
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
