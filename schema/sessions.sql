-- Sessions schema (for activelog-app D1)
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  annotation_count INTEGER DEFAULT 0,
  word_count INTEGER DEFAULT 0,
  tags TEXT DEFAULT '[]',
  raw_markdown TEXT NOT NULL,
  synced_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_ts ON sessions(started_at);

CREATE TABLE IF NOT EXISTS annotations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  latitude REAL,
  longitude REAL,
  speed REAL,
  heading REAL,
  text_before TEXT,
  text_after TEXT,
  tags TEXT DEFAULT '[]',
  important INTEGER DEFAULT 0,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ann_ts ON annotations(timestamp);
CREATE INDEX IF NOT EXISTS idx_ann_session ON annotations(session_id);
