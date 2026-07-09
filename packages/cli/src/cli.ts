#!/usr/bin/env node

import { runCodexInstallCommand } from "./commands/codex-install.js";

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

  if (args[0] !== "codex" || args[1] !== "install") {
    throw new Error(`Unknown command: ${args.join(" ")}`);
  }

  await runCodexInstallCommand(args.slice(2));
}

function printRootHelp(): void {
  process.stdout.write(`Usage: tideline <command>

Commands:
  codex install  Install Tideline MCP and hook config for Codex
`);
}
