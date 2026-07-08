# Core Package

This package contains the runtime transcript store used by the context model.
It persists raw turns, source items, labels, context blocks, hook receipts, and pending hook tool events in SQLite.
It also owns source item splitting, context block construction, context assembly, context block expansion, and transactional hook capture through `captureTurnEvent`.

Hook capture accepts client-agnostic session events and normalizes assistant responses into internal `model` turns.
Prompt and session-stop events automatically compact eligible middle-zone source items through the existing context block builder.
