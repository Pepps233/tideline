# MCP Package

This package implements the read-only Model Context Protocol surface for Tideline.
It exposes tools for assembling context, listing thread turns, listing context blocks, fetching context blocks, and expanding compacted context.

By default, `tideline-mcp` uses `~/.tideline/tideline.sqlite` for SQLite and `~/.tideline/blobs` for raw blob storage.
The directory is created automatically when the server starts.
Use `--sqlite-path` and `--blob-dir`, or `TIDELINE_SQLITE_PATH` and `TIDELINE_BLOB_DIR`, only when you need custom storage paths.
Use `TIDELINE_HOME` to move the whole Tideline storage directory while keeping the default filenames.

```sh
tideline-mcp
```

Capture remains outside MCP.
Agents write session events through the `@tideline/hooks` CLI or the reusable `@tideline/core` capture API.
