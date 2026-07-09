---
name: tideline
description: Use Tideline MCP to discover captured Codex sessions and assemble compact context from local Tideline storage.
---

# Tideline

Use Tideline when the user asks for prior Codex session context, compacted context, stored turns, or context blocks.

Start with `list_sessions` when the user does not provide a `thread_id`.
Use each session's `nextActiveTurn` as the default `active_turn` for `assemble_context`.
Use `search_context` when the user asks for a specific decision, file, command, or previous result.
Use `expand_context_block` when the assembled packet contains a compact block but exact source detail is needed.

Tideline stores local data under `~/.tideline` by default.
The Codex hook integration captures prompts, tool results, and response checkpoints into that storage.
If no sessions appear, ask the user to run `tideline-context install codex`, restart Codex, and trust the Tideline hooks with `/hooks`.
