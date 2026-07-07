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
  `);
}
