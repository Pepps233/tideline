# Hooks Package

This package provides the `tideline-hook` CLI for generic turn capture.
The CLI reads exactly one JSON event from stdin, resolves storage from flags or environment variables, writes one JSON receipt to stdout, and delegates persistence to `@tideline/core`.

Supported events are `session_start`, `prompt_submit`, `tool_result`, `model_response_complete`, and `session_stop`.
Tool results are buffered until a model completion, prompt submission, or session stop flushes them into transcript order.

```sh
tideline-hook --sqlite-path ./tideline.sqlite --blob-dir ./tideline-blobs < event.json
```
