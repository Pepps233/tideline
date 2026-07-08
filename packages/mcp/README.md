# MCP Package

This package implements the read-only Model Context Protocol surface for Tideline.
It exposes tools for assembling context, listing thread turns, listing context blocks, fetching context blocks, and expanding compacted context.

Capture remains outside MCP.
Agents write session events through the `@tideline/hooks` CLI or the reusable `@tideline/core` capture API.
