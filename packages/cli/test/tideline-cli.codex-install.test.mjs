import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const cliPath = new URL("../dist/cli.js", import.meta.url).pathname;
const repoRoot = path.resolve(new URL("../../..", import.meta.url).pathname);

test("installs Codex MCP and hooks config idempotently", async (t) => {
  const fixture = await createCliFixture(t);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await runTidelineCli([
      "install",
      "codex",
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
      new RegExp(`cli\\.js" hook codex --event ${event}$`),
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
    "install",
    "codex",
    "--config-path",
    fixture.configPath,
    "--hooks-path",
    fixture.hooksPath,
    "--mcp-command",
    "tideline",
    "--hook-command",
    "tideline hook codex",
  ]);

  assert.equal(result.exit.code, 0, result.stderr);

  const config = await readFile(fixture.configPath, "utf8");
  const hooks = JSON.parse(await readFile(fixture.hooksPath, "utf8"));

  assert.match(config, /\[model_providers\.local]/);
  assert.match(config, /\[mcp_servers\.other]/);
  assert.equal(countOccurrences(config, "old-tideline-mcp"), 0);
  assert.match(config, /command = "tideline"/);
  assert.equal(countOccurrences(config, "[mcp_servers.tideline]"), 1);
  assert.equal(hooks.hooks.PreToolUse[0].hooks[0].command, "echo keep");
  assert.equal(hooks.hooks.UserPromptSubmit.length, 1);
  assert.equal(
    hooks.hooks.UserPromptSubmit[0].hooks[0].command,
    "tideline hook codex --event UserPromptSubmit",
  );
});

test("supports dry runs without writing files", async (t) => {
  const fixture = await createCliFixture(t);
  const result = await runTidelineCli([
    "install",
    "codex",
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

test("installs Codex through the public command using a temp home", async (t) => {
  const fixture = await createCliFixture(t);
  const result = await runTidelineCli(
    ["install", "codex", "--repo-root", repoRoot, "--yes"],
    { env: cleanCliEnv(fixture.homePath) },
  );

  assert.equal(result.exit.code, 0, result.stderr);
  assert.match(result.stdout, /Installed Tideline Codex integration/);
  assert.match(result.stdout, /Restart Codex/);
  assert.match(result.stdout, /\/hooks/);

  await assertPathExists(fixture.storagePath);
  await assertPathExists(fixture.sqlitePath);
  await assertPathExists(fixture.blobDir);
  await assertPathExists(fixture.logsDir);

  const installRecord = await readJson(fixture.installPath);

  assert.equal(installRecord.version, 1);
  assert.equal(installRecord.agents.codex.installed, true);
  assert.equal(installRecord.agents.codex.configPath, fixture.configPath);
  assert.equal(installRecord.agents.codex.hooksPath, fixture.hooksPath);

  const config = await readFile(fixture.configPath, "utf8");
  const hooks = await readJson(fixture.hooksPath);

  assert.match(config, /\[mcp_servers\.tideline]/);
  assert.match(
    config,
    new RegExp(escapeRegExp(`command = "${process.execPath}"`)),
  );
  assert.match(
    config,
    new RegExp(escapeRegExp(`args = ["${cliPath}", "mcp"]`)),
  );

  for (const event of [
    "SessionStart",
    "UserPromptSubmit",
    "PostToolUse",
    "Stop",
  ]) {
    assert.equal(hooks.hooks[event].length, 1);
    assert.match(
      hooks.hooks[event][0].hooks[0].command,
      new RegExp(`cli\\.js" hook codex --event ${event}$`),
    );
  }
});

test("doctor validates Codex install and uninstall removes managed config", async (t) => {
  const fixture = await createCliFixture(t);
  const env = cleanCliEnv(fixture.homePath);

  await fixture.writeConfig(`[mcp_servers.other]
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
        },
      },
      null,
      2,
    ),
  );

  const install = await runTidelineCli(
    ["install", "codex", "--repo-root", repoRoot, "--yes"],
    { env },
  );

  assert.equal(install.exit.code, 0, install.stderr);

  const doctor = await runTidelineCli(["doctor", "codex"], { env });

  assert.equal(doctor.exit.code, 0, doctor.stderr);
  assert.match(doctor.stdout, /Tideline doctor: Codex/);
  assert.match(doctor.stdout, /OK storage:/);
  assert.match(doctor.stdout, /OK sqlite:/);
  assert.match(doctor.stdout, /OK mcp config:/);
  assert.match(doctor.stdout, /OK hooks config:/);
  assert.match(doctor.stdout, /OK hook stdout: empty/);
  assert.match(
    doctor.stdout,
    /OK synthetic capture: thread tideline-doctor-codex/,
  );
  assert.match(doctor.stdout, /OK mcp tools: list_sessions/);
  assert.match(doctor.stdout, /Restart Codex/);
  assert.match(doctor.stdout, /\/hooks/);

  const uninstall = await runTidelineCli(["uninstall", "codex", "--yes"], {
    env,
  });

  assert.equal(uninstall.exit.code, 0, uninstall.stderr);
  assert.match(uninstall.stdout, /Uninstalled Tideline Codex integration/);

  const config = await readFile(fixture.configPath, "utf8");
  const hooks = await readJson(fixture.hooksPath);
  const installRecord = await readJson(fixture.installPath);

  assert.match(config, /\[mcp_servers\.other]/);
  assert.doesNotMatch(config, /\[mcp_servers\.tideline]/);
  assert.equal(hooks.hooks.PreToolUse[0].hooks[0].command, "echo keep");

  for (const event of [
    "SessionStart",
    "UserPromptSubmit",
    "PostToolUse",
    "Stop",
  ]) {
    assert.equal(hooks.hooks[event]?.length ?? 0, 0);
  }

  assert.equal(installRecord.agents.codex, undefined);
});

async function createCliFixture(t) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "tideline-cli-"));
  const fixture = {
    blobDir: path.join(tempDir, ".tideline", "blobs"),
    configPath: path.join(tempDir, ".codex", "config.toml"),
    homePath: tempDir,
    hooksPath: path.join(tempDir, ".codex", "hooks.json"),
    installPath: path.join(tempDir, ".tideline", "install.json"),
    logsDir: path.join(tempDir, ".tideline", "logs"),
    sqlitePath: path.join(tempDir, ".tideline", "tideline.sqlite"),
    storagePath: path.join(tempDir, ".tideline"),
    async writeConfig(content) {
      await mkdir(path.dirname(this.configPath), { recursive: true });
      await writeFile(this.configPath, content, "utf8");
    },
    async writeHooks(content) {
      await mkdir(path.dirname(this.hooksPath), { recursive: true });
      await writeFile(this.hooksPath, content, "utf8");
    },
  };

  t.after(async () => {
    await rm(tempDir, { force: true, recursive: true });
  });

  return fixture;
}

async function runTidelineCli(args, options = {}) {
  const child = spawn(process.execPath, [cliPath, ...args], {
    env: {
      ...process.env,
      ...(options.env ?? {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdoutChunks = [];
  const stderrChunks = [];

  child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
  child.stdin.end(options.input ?? "");

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

async function assertPathExists(filePath) {
  await assert.doesNotReject(stat(filePath));
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function countOccurrences(value, needle) {
  return value.split(needle).length - 1;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanCliEnv(homePath) {
  const env = { ...process.env, HOME: homePath, USERPROFILE: homePath };

  delete env.CODEX_CONVERSATION_ID;
  delete env.CODEX_SESSION_ID;
  delete env.CODEX_THREAD_ID;
  delete env.TIDELINE_BLOB_DIR;
  delete env.TIDELINE_HOME;
  delete env.TIDELINE_SQLITE_PATH;
  delete env.TIDELINE_THREAD_ID;
  return env;
}
