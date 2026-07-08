import type BetterSqlite3 from "better-sqlite3";

export function createSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS raw_blobs (
      raw_pointer_id TEXT PRIMARY KEY,
      sha256 TEXT NOT NULL,
      byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
      media_type TEXT NOT NULL CHECK (length(media_type) > 0),
      storage_kind TEXT NOT NULL CHECK (storage_kind = 'file'),
      storage_path TEXT NOT NULL CHECK (length(storage_path) > 0),
      created_at TEXT NOT NULL,
      UNIQUE (sha256, byte_length, media_type)
    );

    CREATE TABLE IF NOT EXISTS transcript_turns (
      turn_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL CHECK (length(trim(thread_id)) > 0),
      turn_index INTEGER NOT NULL CHECK (turn_index > 0),
      turn_role TEXT NOT NULL CHECK (turn_role IN ('user', 'model')),
      raw_pointer_id TEXT NOT NULL,
      source_item_ids TEXT NOT NULL DEFAULT '[]'
        CHECK (
          json_valid(source_item_ids)
          AND json_type(source_item_ids) = 'array'
        ),
      derived_context_block_ids TEXT NOT NULL DEFAULT '[]'
        CHECK (
          json_valid(derived_context_block_ids)
          AND json_type(derived_context_block_ids) = 'array'
        ),
      created_at TEXT NOT NULL,
      UNIQUE (thread_id, turn_index),
      FOREIGN KEY (raw_pointer_id)
        REFERENCES raw_blobs(raw_pointer_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS transcript_turns_thread_order_idx
      ON transcript_turns(thread_id, turn_index);

    CREATE TABLE IF NOT EXISTS source_items (
      source_item_id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL,
      item_index INTEGER NOT NULL CHECK (item_index >= 0),
      raw_pointer_id TEXT NOT NULL,
      raw_start_byte_offset INTEGER
        CHECK (raw_start_byte_offset IS NULL OR raw_start_byte_offset >= 0),
      raw_end_byte_offset INTEGER
        CHECK (raw_end_byte_offset IS NULL OR raw_end_byte_offset >= 0),
      rendered_excerpt TEXT NOT NULL,
      context_action TEXT NOT NULL
        CHECK (context_action IN ('preserve_exact', 'compact', 'discard')),
      action_reason TEXT NOT NULL CHECK (length(action_reason) > 0),
      created_at TEXT NOT NULL,
      UNIQUE (turn_id, item_index),
      CHECK (
        (
          raw_start_byte_offset IS NULL
          AND raw_end_byte_offset IS NULL
        )
        OR (
          raw_start_byte_offset IS NOT NULL
          AND raw_end_byte_offset IS NOT NULL
          AND raw_end_byte_offset > raw_start_byte_offset
        )
      ),
      FOREIGN KEY (turn_id)
        REFERENCES transcript_turns(turn_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT,
      FOREIGN KEY (raw_pointer_id)
        REFERENCES raw_blobs(raw_pointer_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS source_items_turn_order_idx
      ON source_items(turn_id, item_index);

    CREATE INDEX IF NOT EXISTS source_items_raw_pointer_idx
      ON source_items(raw_pointer_id);

    CREATE TABLE IF NOT EXISTS source_labels (
      source_item_id TEXT NOT NULL,
      label TEXT NOT NULL CHECK (length(label) > 0),
      label_index INTEGER NOT NULL DEFAULT 0 CHECK (label_index >= 0),
      PRIMARY KEY (source_item_id, label),
      UNIQUE (source_item_id, label_index),
      FOREIGN KEY (source_item_id)
        REFERENCES source_items(source_item_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS source_labels_item_order_idx
      ON source_labels(source_item_id, label_index);

    CREATE TABLE IF NOT EXISTS context_blocks (
      context_block_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL CHECK (length(trim(thread_id)) > 0),
      block_index INTEGER NOT NULL CHECK (block_index > 0),
      source_item_signature TEXT NOT NULL
        CHECK (length(source_item_signature) > 0),
      summary TEXT NOT NULL CHECK (length(trim(summary)) > 0),
      created_at TEXT NOT NULL,
      UNIQUE (thread_id, block_index),
      UNIQUE (thread_id, source_item_signature)
    );

    CREATE INDEX IF NOT EXISTS context_blocks_thread_order_idx
      ON context_blocks(thread_id, block_index);

    CREATE TABLE IF NOT EXISTS context_block_labels (
      context_block_id TEXT NOT NULL,
      label TEXT NOT NULL CHECK (length(label) > 0),
      label_index INTEGER NOT NULL CHECK (label_index >= 0),
      PRIMARY KEY (context_block_id, label),
      UNIQUE (context_block_id, label_index),
      FOREIGN KEY (context_block_id)
        REFERENCES context_blocks(context_block_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS context_block_labels_block_order_idx
      ON context_block_labels(context_block_id, label_index);

    CREATE TABLE IF NOT EXISTS context_block_source_items (
      context_block_id TEXT NOT NULL,
      source_item_id TEXT NOT NULL,
      source_item_index INTEGER NOT NULL CHECK (source_item_index >= 0),
      PRIMARY KEY (context_block_id, source_item_id),
      UNIQUE (context_block_id, source_item_index),
      FOREIGN KEY (context_block_id)
        REFERENCES context_blocks(context_block_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT,
      FOREIGN KEY (source_item_id)
        REFERENCES source_items(source_item_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS context_block_source_items_block_order_idx
      ON context_block_source_items(context_block_id, source_item_index);

    CREATE INDEX IF NOT EXISTS context_block_source_items_source_item_idx
      ON context_block_source_items(source_item_id);

    CREATE TABLE IF NOT EXISTS search_index_entries (
      search_index_entry_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL CHECK (length(trim(thread_id)) > 0),
      entity_type TEXT NOT NULL
        CHECK (entity_type IN ('context_block', 'source_item')),
      entity_id TEXT NOT NULL CHECK (length(trim(entity_id)) > 0),
      text_kind TEXT NOT NULL CHECK (
        text_kind IN (
          'context_block_summary',
          'source_item_exact',
          'source_item_uncovered_compact'
        )
      ),
      embedding_json TEXT NOT NULL
        CHECK (
          json_valid(embedding_json)
          AND json_type(embedding_json) = 'array'
        ),
      lexical_text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (thread_id, entity_type, entity_id, text_kind)
    );

    CREATE INDEX IF NOT EXISTS search_index_entries_thread_idx
      ON search_index_entries(thread_id, entity_type, text_kind);

    CREATE INDEX IF NOT EXISTS search_index_entries_entity_idx
      ON search_index_entries(entity_type, entity_id);

    CREATE TABLE IF NOT EXISTS relationships (
      relationship_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL CHECK (length(trim(thread_id)) > 0),
      relationship_type TEXT NOT NULL CHECK (
        relationship_type IN (
          'derived_from',
          'same_topic_as',
          'refines',
          'supersedes',
          'resolved_by'
        )
      ),
      from_entity_type TEXT NOT NULL
        CHECK (from_entity_type IN ('context_block', 'source_item')),
      from_entity_id TEXT NOT NULL CHECK (length(trim(from_entity_id)) > 0),
      to_entity_type TEXT NOT NULL
        CHECK (to_entity_type IN ('context_block', 'source_item')),
      to_entity_id TEXT NOT NULL CHECK (length(trim(to_entity_id)) > 0),
      reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
      created_at TEXT NOT NULL,
      UNIQUE (
        thread_id,
        relationship_type,
        from_entity_type,
        from_entity_id,
        to_entity_type,
        to_entity_id
      )
    );

    CREATE INDEX IF NOT EXISTS relationships_thread_idx
      ON relationships(thread_id, relationship_type, from_entity_type);

    CREATE INDEX IF NOT EXISTS relationships_to_entity_idx
      ON relationships(to_entity_type, to_entity_id, relationship_type);

    CREATE TABLE IF NOT EXISTS assembly_receipts (
      assembly_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL CHECK (length(trim(thread_id)) > 0),
      active_turn INTEGER NOT NULL CHECK (active_turn > 0),
      status TEXT NOT NULL CHECK (status IN ('assembled')),
      estimated_tokens INTEGER NOT NULL CHECK (estimated_tokens >= 0),
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS assembly_receipts_thread_order_idx
      ON assembly_receipts(thread_id, created_at, assembly_id);

    CREATE TABLE IF NOT EXISTS assembly_receipt_items (
      assembly_id TEXT NOT NULL,
      item_index INTEGER NOT NULL CHECK (item_index >= 0),
      entity_type TEXT NOT NULL
        CHECK (entity_type IN ('turn', 'source_item', 'context_block')),
      entity_id TEXT NOT NULL CHECK (length(trim(entity_id)) > 0),
      section_kind TEXT NOT NULL CHECK (
        section_kind IN (
          'full_transcript_anchors',
          'recent_full_transcript',
          'exact_source_items',
          'compacted_context_blocks',
          'open_questions',
          'expandable_sources'
        )
      ),
      included INTEGER NOT NULL CHECK (included IN (0, 1)),
      estimated_tokens INTEGER NOT NULL CHECK (estimated_tokens >= 0),
      score REAL NOT NULL,
      reason_json TEXT NOT NULL
        CHECK (
          json_valid(reason_json)
          AND json_type(reason_json) = 'array'
        ),
      omit_reason TEXT,
      PRIMARY KEY (assembly_id, item_index),
      FOREIGN KEY (assembly_id)
        REFERENCES assembly_receipts(assembly_id)
        ON UPDATE RESTRICT
        ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS hook_processed_events (
      event_id TEXT PRIMARY KEY CHECK (length(trim(event_id)) > 0),
      thread_id TEXT NOT NULL CHECK (length(trim(thread_id)) > 0),
      kind TEXT NOT NULL CHECK (
        kind IN (
          'session_start',
          'prompt_submit',
          'tool_result',
          'model_response_complete',
          'session_stop'
        )
      ),
      receipt_json TEXT NOT NULL
        CHECK (
          json_valid(receipt_json)
          AND json_type(receipt_json) = 'object'
        ),
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS hook_processed_events_thread_idx
      ON hook_processed_events(thread_id, created_at, event_id);

    CREATE TABLE IF NOT EXISTS hook_pending_tool_events (
      event_id TEXT PRIMARY KEY CHECK (length(trim(event_id)) > 0),
      thread_id TEXT NOT NULL CHECK (length(trim(thread_id)) > 0),
      created_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
        CHECK (
          json_valid(payload_json)
          AND json_type(payload_json) = 'object'
        )
    );

    CREATE INDEX IF NOT EXISTS hook_pending_tool_events_thread_order_idx
      ON hook_pending_tool_events(thread_id, created_at, event_id);
  `);
}
