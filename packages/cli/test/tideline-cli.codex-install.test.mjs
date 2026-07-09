import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const cliPath = new URL("../dist/cli.js", import.meta.url).pathname;
const repoRoot = path.resolve(new URL("../../..", import.meta.url).pathname);

test("installs Codex MCP and hooks config idempotently", async (t) => {
  const fixture = await createCliFixture(t);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await runTidelineCli([
      "codex",
      "install",
      "--config-path",
      fixture.configPath,
      "--hooks-path",
      fixture.hooksPath,
      "--repo-root",
      repoRoot,
    ]);

    assert.equal(result.exit.code, 0, result.stderr);
    assert.match(result.stdout, /Installed Tideline Codex integration/);
  }

  const config = await readFile(fixture.configPath, "utf8");
  const hooks = JSON.parse(await readFile(fixture.hooksPath, "utf8"));

  assert.match(config, /\[mcp_servers\.tideline]/);
  assert.match(
    config,
    new RegExp(escapeRegExp(`command = "${process.execPath}"`)),
  );
  assert.match(config, /startup_timeout_sec = 20/);
  assert.equal(countOccurrences(config, "[mcp_servers.tideline]"), 1);

  for (const event of [
    "SessionStart",
    "UserPromptSubmit",
    "PostToolUse",
    "Stop",
  ]) {
    assert.equal(hooks.hooks[event].length, 1);
    assert.match(
      hooks.hooks[event][0].hooks[0].command,
      new RegExp(`codex-hook-adapter\\.js" --event ${event}$`),
    );
  }
});

test("preserves unrelated Codex config and hooks", async (t) => {
  const fixture = await createCliFixture(t);

  await fixture.writeConfig(`[model_providers.local]
name = "local"

[mcp_servers.tideline]
command = "old-tideline-mcp"

[mcp_servers.other]
command = "other-mcp"
`);
  await fixture.writeHooks(
    JSON.stringify(
      {
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [
                {
                  command: "echo keep",
                  type: "command",
                },
              ],
            },
          ],
          UserPromptSubmit: [
            {
              hooks: [
                {
                  command: "tideline-codex-hook --event UserPromptSubmit",
                  statusMessage: "Capturing Tideline prompt",
                  type: "command",
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    ),
  );

  const result = await runTidelineCli([
    "codex",
    "install",
    "--config-path",
    fixture.configPath,
    "--hooks-path",
    fixture.hooksPath,
    "--mcp-command",
    "tideline-mcp",
    "--hook-command",
    "tideline-codex-hook",
  ]);

  assert.equal(result.exit.code, 0, result.stderr);

  const config = await readFile(fixture.configPath, "utf8");
  const hooks = JSON.parse(await readFile(fixture.hooksPath, "utf8"));

  assert.match(config, /\[model_providers\.local]/);
  assert.match(config, /\[mcp_servers\.other]/);
  assert.equal(countOccurrences(config, "old-tideline-mcp"), 0);
  assert.equal(countOccurrences(config, "[mcp_servers.tideline]"), 1);
  assert.equal(hooks.hooks.PreToolUse[0].hooks[0].command, "echo keep");
  assert.equal(hooks.hooks.UserPromptSubmit.length, 1);
});

test("supports dry runs without writing files", async (t) => {
  const fixture = await createCliFixture(t);
  const result = await runTidelineCli([
    "codex",
    "install",
    "--config-path",
    fixture.configPath,
    "--hooks-path",
    fixture.hooksPath,
    "--mcp-command",
    "tideline-mcp",
    "--hook-command",
    "tideline-codex-hook",
    "--dry-run",
  ]);

  assert.equal(result.exit.code, 0, result.stderr);
  assert.match(result.stdout, /dry run/i);

  await assert.rejects(readFile(fixture.configPath, "utf8"), /ENOENT/);
  await assert.rejects(readFile(fixture.hooksPath, "utf8"), /ENOENT/);
});

async function createCliFixture(t) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "tideline-cli-"));
  const fixture = {
    configPath: path.join(tempDir, ".codex", "config.toml"),
    hooksPath: path.join(tempDir, ".codex", "hooks.json"),
    async writeConfig(content) {
      await import("node:fs/promises").then(({ mkdir, writeFile }) =>
        mkdir(path.dirname(this.configPath), { recursive: true }).then(() =>
          writeFile(this.configPath, content, "utf8"),
        ),
      );
    },
    async writeHooks(content) {
      await import("node:fs/promises").then(({ mkdir, writeFile }) =>
        mkdir(path.dirname(this.hooksPath), { recursive: true }).then(() =>
          writeFile(this.hooksPath, content, "utf8"),
        ),
      );
    },
  };

  t.after(async () => {
    await rm(tempDir, { force: true, recursive: true });
  });

  return fixture;
}

async function runTidelineCli(args) {
  const child = spawn(process.execPath, [cliPath, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdoutChunks = [];
  const stderrChunks = [];

  child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

  const exit = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });

  return {
    exit,
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
  };
}

function countOccurrences(value, needle) {
  return value.split(needle).length - 1;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
