CREATE TABLE IF NOT EXISTS ledger (
  id TEXT PRIMARY KEY CHECK (id = 'primary'),
  version INTEGER NOT NULL CHECK (version > 0),
  object_key TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
