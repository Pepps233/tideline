<img width="2710" height="1040" alt="tideline" src="https://github.com/user-attachments/assets/59518cde-0566-4e7c-bf07-4350592130b2" />

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

## License

Tideline is licensed under the Apache License, Version 2.0.
See [LICENSE](LICENSE) for the full license text.

