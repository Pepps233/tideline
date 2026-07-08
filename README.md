<img width="2710" height="1040" alt="tideline" src="https://github.com/user-attachments/assets/59518cde-0566-4e7c-bf07-4350592130b2" />

# Tideline

Tideline is an external context assembly layer for coding agents.
It is intended to sit beside an agent runtime and maintain the working context that the agent sees over a long session.
The project is seeded as a TypeScript monorepo for a self-host stack built around Node.js, Fastify, the MCP SDK, PostgreSQL with pgvector, MinIO, Valkey, BullMQ, Zod, Kysely, and Next.js.

The repository now includes a SQLite-backed core transcript store, a read-only MCP server, and a generic hook capture CLI.
It also includes a Codex hook adapter and installer that wire Codex to Tideline storage.
Runtime service packages, PostgreSQL schemas, migrations, Docker services, and durable memory layers remain outside this initial implementation.

## Why Tideline

Coding agents accumulate long transcripts, tool outputs, source snippets, review notes, and implementation decisions.
Keeping every token in the live prompt makes sessions expensive and brittle.
Dropping older context makes agents lose the reasons behind decisions and repeat previous work.

Tideline is designed around continuous compaction and reversible expansion.
Older context can be represented compactly during normal work, while exact source items remain available for later expansion when the agent needs more detail.
The goal is not to replace the transcript.
The goal is to assemble the right working context from the transcript, durable source items, context blocks, and explicit receipts.

## Context Model

Tideline uses a sliding transcript model at the product level.
The first three turns are preserved as anchors because they often define the task, constraints, and initial intent.
The previous turn is preserved at full fidelity because it usually contains the freshest instructions, tool results, or correction from the user.
Older middle turns are represented by preserved exact source items plus compact context blocks.

Source items are exact durable records of important inputs, outputs, snippets, decisions, and observations.
Context blocks are compact summaries or structured records built from source items.
Expansion retrieves the source items behind a block when the agent needs the original detail again.
Assembly receipts record why a block or source item was included in a context assembly.

This model is meant to make compaction reversible.
A compact block can keep the active prompt small, and the receipt can point back to the source material that justified it.

## Deferred Durable Memory

Tideline distinguishes session context from durable memory.
Session context supports the current task, branch, and conversation.
Durable memory is planned as a later layer for stable project facts, preferences, and reusable knowledge.

The seed focuses on the repository shape needed for session context assembly.
Durable memory is intentionally deferred so the initial architecture can keep source items, context blocks, receipts, and expansion behavior clear.

## Workspace Packages

`@tideline/core` owns the transcript store, raw blob persistence, source item splitting, context block construction, expansion, assembly, and hook capture transactions.
It keeps transcript roles normalized to `user` and `model`.

`@tideline/hooks` provides the `tideline-hook` CLI.
The CLI reads one JSON event from stdin, writes one JSON receipt to stdout, and stores captured turns through `@tideline/core`.
By default, it writes to `~/.tideline/tideline.sqlite` and `~/.tideline/blobs`.
It also ships `tideline-codex-hook`, which adapts Codex lifecycle hook payloads into Tideline capture events.

`@tideline/mcp` exposes the read surface for agents.
It lists turns and context blocks, expands context blocks, and assembles sliding context without adding capture tools.
By default, it reads from the same `~/.tideline` storage directory.

`@tideline/cli` provides setup commands for local integrations.
The first command is `tideline codex install`, which writes Tideline MCP and hook configuration into Codex config files.

The repo also includes a local Codex plugin scaffold at `plugins/tideline-codex`.
The plugin bundles the Tideline MCP server definition, Codex hook definitions, and a small usage skill.

## Intended Self-Host Flow

The intended installation path starts like a normal pnpm workspace.

```sh
git clone https://github.com/Pepps233/tideline.git
cd tideline
nvm use
corepack enable
pnpm install
```

For local use, both CLIs work without storage flags.
The first run creates `~/.tideline`.

```sh
tideline-hook --thread-id my-session < event.json
tideline-mcp
```

For Codex integration from a checkout, build the workspace and run the installer.
The installer is idempotent and preserves non-Tideline Codex config.

```sh
pnpm build
node packages/cli/dist/cli.js codex install
```

Restart Codex after installation.
Then run `/hooks` and trust the Tideline hook definitions before expecting automatic capture.

## License

Tideline is licensed under the Apache License, Version 2.0.
See [LICENSE](LICENSE) for the full license text.
