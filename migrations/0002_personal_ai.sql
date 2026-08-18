-- Additive migration: existing conversations and memories are left untouched.
ALTER TABLE memories ADD COLUMN embedding_json TEXT;
ALTER TABLE memories ADD COLUMN updated_at TEXT;
UPDATE memories SET updated_at = created_at WHERE updated_at IS NULL;

CREATE TABLE IF NOT EXISTS profiles (
  user_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT '',
  preferences_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT current_timestamp
);

CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  input_chars INTEGER NOT NULL DEFAULT 0,
  output_chars INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT current_timestamp
);

CREATE INDEX IF NOT EXISTS idx_usage_events_created
ON usage_events(created_at DESC);
