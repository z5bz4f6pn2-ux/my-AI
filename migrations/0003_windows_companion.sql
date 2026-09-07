CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL DEFAULT 'windows',
  last_seen TEXT,
  created_at TEXT NOT NULL DEFAULT current_timestamp,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_devices_user_active
  ON devices(user_id, revoked_at, last_seen);

CREATE TABLE IF NOT EXISTS device_commands (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN (
    'open_app',
    'open_url',
    'open_file',
    'volume_up',
    'volume_down',
    'volume_mute',
    'screenshot',
    'lock',
    'restart',
    'shutdown'
  )),
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN (
    'pending',
    'claimed',
    'completed',
    'failed',
    'rejected',
    'expired'
  )),
  requires_approval INTEGER NOT NULL DEFAULT 0,
  result_text TEXT,
  error_text TEXT,
  created_at TEXT NOT NULL DEFAULT current_timestamp,
  claimed_at TEXT,
  completed_at TEXT,
  FOREIGN KEY(device_id) REFERENCES devices(id)
);

CREATE INDEX IF NOT EXISTS idx_device_commands_next
  ON device_commands(device_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_device_commands_owner
  ON device_commands(user_id, id);
