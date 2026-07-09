import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  type CodexInstallArgs,
  type CodexMaintenanceArgs,
  parseCodexInstallArgs,
  parseCodexMaintenanceArgs,
} from "./codex/args.js";
import {
  assertTidelineHooks,
  assertTidelineMcpConfig,
  formatCommandForDisplay,
  parseHooksFile,
  removeTidelineHooks,
  removeTomlTable,
  shellQuote,
  upsertTidelineHooks,
  upsertTidelineMcpConfig,
} from "./codex/config-files.js";
import {
  assertHookStdoutEmpty,
  assertMcpTools,
  captureSyntheticHook,
} from "./codex/doctor.js";
import {
  assertStorageReady,
  ensureTidelineStorage,
  expandHomePath,
  readInstallRecord,
  readTextIfExists,
  removeCodexInstallRecord,
  resolveCodexPaths,
  resolveCodexPathsFromRecord,
  resolveInstallStorage,
  upsertInstallRecord,
} from "./codex/storage.js";
import {
  CODEX_AGENT_ID,
  PUBLIC_CLI_COMMAND,
  TIDELINE_MCP_TABLE,
  type CodexPaths,
  type McpCommandSpec,
  type TidelineStoragePaths,
} from "./codex/types.js";

export async function runCodexInstallCommand(args: string[]): Promise<void> {
  const installArgs = parseCodexInstallArgs(args);

  if (installArgs.help) {
    printCodexInstallHelp();
    return;
  }

  await installCodexIntegration(installArgs);
}

export async function runCodexDoctorCommand(args: string[]): Promise<void> {
  const doctorArgs = parseCodexMaintenanceArgs(args, "doctor");

  if (doctorArgs.help) {
    printCodexDoctorHelp();
    return;
  }

  await doctorCodexIntegration(doctorArgs);
}

export async function runCodexUninstallCommand(args: string[]): Promise<void> {
  const uninstallArgs = parseCodexMaintenanceArgs(args, "uninstall");

  if (uninstallArgs.help) {
    printCodexUninstallHelp();
    return;
  }

  await uninstallCodexIntegration(uninstallArgs);
}

async function installCodexIntegration(args: CodexInstallArgs): Promise<void> {
  const repoRoot = resolveRepoRoot(args.repoRoot);
  const paths = resolveCodexPaths(args);
  const storage = resolveInstallStorage(args, paths);
  const mcpCommand = resolveMcpCommand(args, repoRoot);
  const hookCommand = resolveHookCommand(args, repoRoot);
  const currentConfig = await readTextIfExists(paths.configPath);
  const currentHooks = await readTextIfExists(paths.hooksPath);
  const nextConfig = upsertTidelineMcpConfig(currentConfig, mcpCommand);
  const nextHooks = upsertTidelineHooks(currentHooks, hookCommand);

  if (args.dryRun) {
    writeInstallDryRun({
      args,
      hookCommand,
      mcpCommand,
      paths,
      storage,
    });
    return;
  }

  await ensureTidelineStorage(storage);
  await mkdir(path.dirname(paths.configPath), { recursive: true });
  await mkdir(path.dirname(paths.hooksPath), { recursive: true });
  await writeFile(paths.configPath, nextConfig, "utf8");
  await writeFile(paths.hooksPath, nextHooks, "utf8");
  await upsertInstallRecord(storage.installPath, {
    configPath: paths.configPath,
    hooksPath: paths.hooksPath,
    installed: true,
  });

  if (args.json) {
    writeJson({
      agent: CODEX_AGENT_ID,
      configPath: paths.configPath,
      hooksPath: paths.hooksPath,
      installPath: storage.installPath,
      sqlitePath: storage.sqlitePath,
      status: "installed",
      storagePath: storage.storagePath,
    });
    return;
  }

  process.stdout.write(
    [
      "Installed Tideline Codex integration.",
      `Updated config: ${paths.configPath}`,
      `Updated hooks: ${paths.hooksPath}`,
      `Initialized storage: ${storage.storagePath}`,
      "Restart Codex, then run /hooks to review and trust the Tideline hooks.",
    ].join("\n") + "\n",
  );
}

async function doctorCodexIntegration(
  args: CodexMaintenanceArgs,
): Promise<void> {
  const storage = resolveInstallStorage(args, resolveCodexPaths(args));
  const installRecord = await readInstallRecord(storage.installPath);
  const paths = resolveCodexPathsFromRecord(args, installRecord);
  const checks: string[] = [];

  await assertStorageReady(storage);
  checks.push(`OK storage: ${storage.storagePath}`);
  checks.push(`OK sqlite: ${storage.sqlitePath}`);

  const config = await readTextIfExists(paths.configPath);
  assertTidelineMcpConfig(config, paths.configPath);
  checks.push(`OK mcp config: ${paths.configPath}`);

  const hooks = parseHooksFile(await readTextIfExists(paths.hooksPath));
  assertTidelineHooks(hooks, paths.hooksPath);
  checks.push(`OK hooks config: ${paths.hooksPath}`);

  await assertHookStdoutEmpty(storage);
  checks.push("OK hook stdout: empty");

  const receipt = await captureSyntheticHook(storage);
  checks.push(`OK synthetic capture: thread ${receipt.threadId}`);

  const toolName = await assertMcpTools(storage);
  checks.push(`OK mcp tools: ${toolName}`);

  if (args.json) {
    writeJson({
      checks,
      status: "ok",
    });
    return;
  }

  process.stdout.write(
    [
      "Tideline doctor: Codex",
      "",
      ...checks,
      "",
      "Next:",
      "  Restart Codex",
      "  Run /hooks and trust Tideline hooks",
    ].join("\n") + "\n",
  );
}

async function uninstallCodexIntegration(
  args: CodexMaintenanceArgs,
): Promise<void> {
  const storage = resolveInstallStorage(args, resolveCodexPaths(args));
  const installRecord = await readInstallRecord(storage.installPath);
  const paths = resolveCodexPathsFromRecord(args, installRecord);
  const currentConfig = await readTextIfExists(paths.configPath);
  const currentHooks = await readTextIfExists(paths.hooksPath);

  if (currentConfig.length > 0) {
    await writeFile(
      paths.configPath,
      removeTomlTable(currentConfig, TIDELINE_MCP_TABLE),
      "utf8",
    );
  }

  if (currentHooks.length > 0) {
    await writeFile(paths.hooksPath, removeTidelineHooks(currentHooks), "utf8");
  }

  await removeCodexInstallRecord(storage.installPath);

  if (args.json) {
    writeJson({
      agent: CODEX_AGENT_ID,
      configPath: paths.configPath,
      hooksPath: paths.hooksPath,
      status: "uninstalled",
    });
    return;
  }

  process.stdout.write(
    [
      "Uninstalled Tideline Codex integration.",
      `Updated config: ${paths.configPath}`,
      `Updated hooks: ${paths.hooksPath}`,
      "Tideline stored data was left in place.",
    ].join("\n") + "\n",
  );
}

function resolveMcpCommand(
  args: CodexInstallArgs,
  repoRoot: string | undefined,
): McpCommandSpec {
  if (args.mcpCommand) {
    return { args: [], command: args.mcpCommand };
  }

  const cliScript = resolveLocalCliScript(repoRoot);

  if (cliScript) {
    return { args: [cliScript, "mcp"], command: process.execPath };
  }

  return { args: ["mcp"], command: PUBLIC_CLI_COMMAND };
}

function resolveHookCommand(
  args: CodexInstallArgs,
  repoRoot: string | undefined,
): string {
  if (args.hookCommand) {
    return args.hookCommand;
  }

  const cliScript = resolveLocalCliScript(repoRoot);

  if (cliScript) {
    return `${shellQuote(process.execPath)} ${shellQuote(cliScript)} hook codex`;
  }

  return `${PUBLIC_CLI_COMMAND} hook codex`;
}

function resolveLocalCliScript(
  repoRoot: string | undefined,
): string | undefined {
  if (!repoRoot) {
    return undefined;
  }

  const cliScript = path.join(repoRoot, "packages", "cli", "dist", "cli.js");

  if (!existsSync(cliScript)) {
    throw new Error(
      `Local Tideline CLI build was not found at ${cliScript}. Run pnpm --filter @tideline/cli build first.`,
    );
  }

  return cliScript;
}

function resolveRepoRoot(repoRootArg: string | undefined): string | undefined {
  return repoRootArg ? path.resolve(expandHomePath(repoRootArg)) : undefined;
}

function writeInstallDryRun(input: {
  args: CodexInstallArgs;
  hookCommand: string;
  mcpCommand: McpCommandSpec;
  paths: CodexPaths;
  storage: TidelineStoragePaths;
}): void {
  if (input.args.json) {
    writeJson({
      configPath: input.paths.configPath,
      dryRun: true,
      hookCommand: input.hookCommand,
      hooksPath: input.paths.hooksPath,
      mcpCommand: input.mcpCommand,
      storagePath: input.storage.storagePath,
    });
    return;
  }

  process.stdout.write(
    [
      "Tideline Codex integration dry run.",
      `Would update config: ${input.paths.configPath}`,
      `Would update hooks: ${input.paths.hooksPath}`,
      `Would initialize storage: ${input.storage.storagePath}`,
      `MCP command: ${formatCommandForDisplay(input.mcpCommand)}`,
      `Hook command: ${input.hookCommand}`,
    ].join("\n") + "\n",
  );
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printCodexInstallHelp(): void {
  process.stdout.write(`Usage: ${PUBLIC_CLI_COMMAND} install codex [options]

Writes Tideline MCP configuration to Codex config.toml, Tideline capture hooks
to Codex hooks.json, and an install record to Tideline storage.
Existing non-Tideline config is preserved.

Options:
  --config-path <path>  Codex config.toml path
  --hooks-path <path>   Codex hooks.json path
  --repo-root <path>    Tideline checkout root for local dist commands
  --mcp-command <cmd>   Use a PATH command for the MCP server
  --hook-command <cmd>  Use a PATH or shell command for Codex hooks
  --dry-run             Print the planned install without writing files
  --json                Print machine-readable output
  --yes                 Run noninteractively
`);
}

function printCodexDoctorHelp(): void {
  process.stdout.write(`Usage: ${PUBLIC_CLI_COMMAND} doctor codex [options]

Validates Tideline storage, Codex MCP config, Codex hooks, synthetic capture,
and MCP tool exposure.

Options:
  --config-path <path>  Codex config.toml path
  --hooks-path <path>   Codex hooks.json path
  --json                Print machine-readable output
`);
}

function printCodexUninstallHelp(): void {
  process.stdout.write(`Usage: ${PUBLIC_CLI_COMMAND} uninstall codex [options]

Removes only Tideline-managed MCP and hook config.
Stored Tideline data is left in place.

Options:
  --config-path <path>  Codex config.toml path
  --hooks-path <path>   Codex hooks.json path
  --json                Print machine-readable output
  --yes                 Run noninteractively
`);
}
