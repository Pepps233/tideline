---
name: tideline
description: Use Tideline MCP to discover captured Codex sessions and assemble compact context from local Tideline storage.
---

# Tideline

Use Tideline first when the user asks for prior Codex conversation context, memory, stored turns, session status, hook health, compacted context, or context assembly.

Start with `get_current_session` when the user is referring to the active Codex conversation.
Use `get_session_status` when the user asks about storage paths, latest captured activity, pending tool events, capture health, hook trust, or hook installation.
Use `list_recent_messages` when the last few stored turns may answer the question without assembling broader context.
Start with `list_sessions` when the user asks to browse available sessions or when current-session detection is not enough.
Use each session's `nextActiveTurn` as the default `active_turn` for `assemble_context`.
Use `assemble_current_context` when the active Codex conversation needs compact context and no explicit `thread_id` is provided.
Use `search_context` when the user asks for a specific decision, file, command, or previous result.
Use `expand_context_block` when the assembled packet contains a compact block but exact source detail is needed.

Tideline stores local data under `~/.tideline` by default.
The Codex hook integration captures prompts, tool results, and response checkpoints into that storage.
If no sessions appear or hook health is unclear, ask the user to run `tideline-context doctor codex`.
If doctor reports missing hooks, ask the user to run `tideline-context install codex`, restart Codex, and trust the Tideline hooks with `/hooks`.
