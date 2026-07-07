# Tideline

Tideline is an external context assembly layer for coding agents.
It is intended to sit beside an agent runtime and maintain the working context that the agent sees over a long session.
The project is seeded as a TypeScript monorepo for a self-host stack built around Node.js, Fastify, the MCP SDK, PostgreSQL with pgvector, MinIO, Valkey, BullMQ, Zod, Kysely, and Next.js.

This repository currently contains scaffold, documentation, and workspace configuration only.
Runtime services, schemas, migrations, Docker services, and production implementation are planned but are not included in this seed.

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

## Intended Self-Host Flow

The intended installation path starts like a normal pnpm workspace.

```sh
git clone https://github.com/Pepps233/tideline.git
cd tideline
nvm use
corepack enable
pnpm install
```

Before the first runnable release, deployment assets will be added under `infra/compose/` for PostgreSQL with pgvector, MinIO, Valkey, API services, workers, and supporting development services.
Environment setup and Compose startup instructions will be documented with those assets when they exist.

## Repository Shape

The workspace is organized around future service and package boundaries.
`apps/web` is reserved for the future Next.js admin and debug UI.
`packages/api` is reserved for the future Fastify HTTP, admin, and debug API boundary.
`packages/core` is reserved for the future context model, splitting, labeling, action selection, block construction, and assembly logic.
`packages/db` is reserved for future PostgreSQL schema, Kysely migrations, repositories, and transaction helpers.
`packages/storage` is reserved for future blob storage abstractions for MinIO and local development storage.
`packages/mcp` is reserved for future MCP tools, resources, and transport setup.
`packages/worker` is reserved for future BullMQ processors for compaction, indexing, cleanup, and model tasks.
`packages/shared` is reserved for future Zod schemas, shared types, constants, and cross-package contracts.
`infra` is reserved for self-host deployment assets.
`docs` is reserved for architecture, operations, and product concepts.
`scripts` is reserved for repository maintenance and developer automation.

## License

Tideline is licensed under the Apache License, Version 2.0.
See [LICENSE](LICENSE) for the full license text.
