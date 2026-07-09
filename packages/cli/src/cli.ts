#!/usr/bin/env node

import { runCodexHookAdapterCli } from "@tideline/hooks/codex-hook-adapter";
import { runTidelineMcpCli } from "@tideline/mcp/cli";

import {
  runCodexDoctorCommand,
  runCodexInstallCommand,
  runCodexUninstallCommand,
} from "./commands/codex-install.js";
import { PUBLIC_CLI_COMMAND } from "./commands/codex/types.js";

void main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    printRootHelp();
    return;
  }

  if (args[0] === "install") {
    await runInstallCommand(args.slice(1));
    return;
  }

  if (args[0] === "doctor") {
    await runDoctorCommand(args.slice(1));
    return;
  }

  if (args[0] === "uninstall") {
    await runUninstallCommand(args.slice(1));
    return;
  }

  if (args[0] === "mcp") {
    await runTidelineMcpCli(args.slice(1));
    return;
  }

  if (args[0] === "hook") {
    await runHookCommand(args.slice(1));
    return;
  }

  if (args[0] === "codex" && args[1] === "install") {
    await runCodexInstallCommand(args.slice(2));
    return;
  }

  throw new Error(`Unknown command: ${args.join(" ")}`);
}

async function runInstallCommand(args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    printInstallHelp();
    return;
  }

  if (args[0] === "codex") {
    await runCodexInstallCommand(args.slice(1));
    return;
  }

  throw new Error(`Unknown install target: ${args[0] ?? ""}`);
}

async function runDoctorCommand(args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    printDoctorHelp();
    return;
  }

  if (args[0] === "codex") {
    await runCodexDoctorCommand(args.slice(1));
    return;
  }

  throw new Error(`Unknown doctor target: ${args[0] ?? ""}`);
}

async function runUninstallCommand(args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    printUninstallHelp();
    return;
  }

  if (args[0] === "codex") {
    await runCodexUninstallCommand(args.slice(1));
    return;
  }

  throw new Error(`Unknown uninstall target: ${args[0] ?? ""}`);
}

async function runHookCommand(args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    printHookHelp();
    return;
  }

  if (args[0] === "codex") {
    await runCodexHookAdapterCli(args.slice(1));
    return;
  }

  throw new Error(`Unknown hook target: ${args[0] ?? ""}`);
}

function printRootHelp(): void {
  process.stdout.write(`Usage: ${PUBLIC_CLI_COMMAND} <command>

Commands:
  install codex    Install Tideline MCP and hook config for Codex
  doctor codex     Validate the Codex integration
  uninstall codex  Remove Tideline-managed Codex config
  mcp              Run the Tideline MCP server
  hook codex       Run the Codex hook adapter
`);
}

function printInstallHelp(): void {
  process.stdout.write(`Usage: ${PUBLIC_CLI_COMMAND} install <agent>

Agents:
  codex  Install Tideline MCP and hook config for Codex
`);
}

function printDoctorHelp(): void {
  process.stdout.write(`Usage: ${PUBLIC_CLI_COMMAND} doctor <agent>

Agents:
  codex  Validate the Tideline Codex integration
`);
}

function printUninstallHelp(): void {
  process.stdout.write(`Usage: ${PUBLIC_CLI_COMMAND} uninstall <agent>

Agents:
  codex  Remove Tideline-managed Codex config
`);
}

function printHookHelp(): void {
  process.stdout.write(`Usage: ${PUBLIC_CLI_COMMAND} hook <agent>

Agents:
  codex  Capture Codex hook events
`);
}
