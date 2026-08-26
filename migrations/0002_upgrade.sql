CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT current_timestamp
);

CREATE INDEX IF NOT EXISTS idx_usage_events_created
ON usage_events(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_usage_events_user_created
ON usage_events(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS user_profiles (
  user_id TEXT PRIMARY KEY,
  email TEXT,
  display_name TEXT,
  created_at TEXT NOT NULL DEFAULT current_timestamp,
  updated_at TEXT NOT NULL DEFAULT current_timestamp
);
