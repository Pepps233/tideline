# MCP Package

This package implements the read-only Model Context Protocol surface for Tideline.
It exposes tools for finding the current session, reading recent messages, checking session status, assembling context, listing thread turns, listing context blocks, fetching context blocks, and expanding compacted context.
It also exposes `list_sessions` and `memory://sessions` so agents can discover available `thread_id` values before calling thread-scoped tools.

By default, `tideline-mcp` uses `~/.tideline/tideline.sqlite` for SQLite and `~/.tideline/blobs` for raw blob storage.
The directory is created automatically when the server starts.
Use `--sqlite-path` and `--blob-dir`, or `TIDELINE_SQLITE_PATH` and `TIDELINE_BLOB_DIR`, only when you need custom storage paths.
Use `TIDELINE_HOME` to move the whole Tideline storage directory while keeping the default filenames.

```sh
tideline-mcp
```

Agents should call `list_sessions` first when they do not already know a thread ID.
Each session summary includes `nextActiveTurn`, which can be passed as `active_turn` when calling `assemble_context`.
Agents should call `get_current_session` first for prior conversation, memory, session status, hook health, or context assembly questions in the active Codex conversation.
Use `list_recent_messages` before assembling full context when the last few stored turns are enough.
Use `get_session_status` to inspect storage paths, latest activity, pending tool events, and hook verification guidance.
Use `assemble_current_context` when the current session should be detected from `TIDELINE_THREAD_ID`, `CODEX_THREAD_ID`, `CODEX_SESSION_ID`, `CODEX_CONVERSATION_ID`, or latest activity.

Capture remains outside MCP.
Agents write session events through the `@tideline/hooks` CLI or the reusable `@tideline/core` capture API.
