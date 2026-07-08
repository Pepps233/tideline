# Hooks Package

This package provides the `tideline-hook` CLI for generic turn capture.
The CLI reads exactly one JSON event from stdin, resolves storage from flags or environment variables, writes one JSON receipt to stdout, and delegates persistence to `@tideline/core`.

Supported events are `session_start`, `prompt_submit`, `tool_result`, `model_response_complete`, and `session_stop`.
Tool results are buffered until a model completion, prompt submission, or session stop flushes them into transcript order.

By default, `tideline-hook` uses `~/.tideline/tideline.sqlite` for SQLite and `~/.tideline/blobs` for raw blob storage.
The directory is created automatically on first capture.
Use `TIDELINE_THREAD_ID`, `--thread-id`, or an event `thread_id` to choose the session thread.

```sh
tideline-hook --thread-id my-session < event.json
```

Use explicit paths only when you need custom storage.

```sh
tideline-hook --sqlite-path ./tideline.sqlite --blob-dir ./tideline-blobs < event.json
```
