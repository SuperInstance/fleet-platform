-- ═══════════════════════════════════════════════════════════
-- Fleet Platform — Master D1 Schema
-- All tables for all fleet services in one database.
-- ═══════════════════════════════════════════════════════════

-- ── ActiveLog Sessions ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  annotation_count INTEGER DEFAULT 0,
  word_count INTEGER DEFAULT 0,
  tags TEXT DEFAULT '[]',
  raw_markdown TEXT NOT NULL,
  domain TEXT DEFAULT 'generic',
  synced_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_ts ON sessions(started_at);
CREATE INDEX IF NOT EXISTS idx_sessions_domain ON sessions(domain);

-- ── Annotations (timestamps + GPS) ─────────────────────────
CREATE TABLE IF NOT EXISTS annotations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  latitude REAL,
  longitude REAL,
  speed REAL,
  heading REAL,
  depth REAL,
  water_temp REAL,
  text_before TEXT,
  text_after TEXT,
  tags TEXT DEFAULT '[]',
  important INTEGER DEFAULT 0,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ann_ts ON annotations(timestamp);
CREATE INDEX IF NOT EXISTS idx_ann_loc ON annotations(latitude, longitude);
CREATE INDEX IF NOT EXISTS idx_ann_session ON annotations(session_id);

-- ── Weather Log (OracleClaw hourly injection) ───────────────
CREATE TABLE IF NOT EXISTS weather_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  lat REAL,
  lon REAL,
  wind_speed_kts REAL,
  wind_dir TEXT,
  wave_height_ft REAL,
  visibility TEXT,
  sky TEXT,
  temp_c REAL,
  pressure_hpa REAL,
  tide_station TEXT,
  tide_stage TEXT,
  tide_height REAL,
  forecast TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_wx_ts ON weather_log(timestamp);

-- ── Vessel Observations ────────────────────────────────────
CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  depth_fm REAL,
  water_temp_c REAL,
  speed_kts REAL,
  heading_deg REAL,
  source TEXT DEFAULT 'vessel',
  data TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_obs_ts ON observations(timestamp);

-- ── Captures (mirror of boat's captures.db) ────────────────
CREATE TABLE IF NOT EXISTS captures (
  capture_id TEXT PRIMARY KEY,
  ts_utc TEXT NOT NULL,
  lat REAL,
  lon REAL,
  sog_kts REAL,
  cog_deg REAL,
  bottom_depth_fm REAL,
  blob_count_lf INTEGER,
  thermocline_count INTEGER,
  haze_blob_count INTEGER,
  feed_present INTEGER,
  vocabulary_species TEXT,
  vocabulary_confidence REAL,
  caption TEXT,
  raw_json TEXT,
  png_r2_key TEXT,
  synced_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_cap_ts ON captures(ts_utc);
CREATE INDEX IF NOT EXISTS idx_cap_loc ON captures(lat, lon);

-- ── Catch Labels ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS catch_labels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  capture_id TEXT,
  session_id TEXT,
  species TEXT NOT NULL,
  depth_fm INTEGER,
  count INTEGER,
  source TEXT DEFAULT 'fishinglog',
  confirmed_by TEXT,
  raw_text TEXT,
  synced_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_catch_species ON catch_labels(species);

-- ── Training Labels (the narrator loop) ────────────────────
CREATE TABLE IF NOT EXISTS training_labels (
  id TEXT PRIMARY KEY,
  capture_id TEXT,
  session_id TEXT,
  timestamp TEXT NOT NULL,
  label_type TEXT,
  species TEXT,
  captain_text TEXT,
  vocabulary_was_species TEXT,
  vocabulary_was_confidence REAL,
  depth_fm REAL,
  sounder_data TEXT,
  camera_available INTEGER DEFAULT 0,
  camera_depth REAL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_train_type ON training_labels(label_type);

-- ── A2A Intent Log (polyformalism communication) ──────────
CREATE TABLE IF NOT EXISTS a2a_messages (
  id TEXT PRIMARY KEY,
  sender TEXT NOT NULL,
  receiver TEXT,
  timestamp TEXT NOT NULL,
  channel_data TEXT NOT NULL,
  message TEXT,
  stakes REAL,
  precision_class TEXT,
  alignment_score REAL,
  acknowledged INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_a2a_ts ON a2a_messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_a2a_sender ON a2a_messages(sender);

-- ── Fleet Health ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fleet_health (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  status TEXT,
  response_time_ms INTEGER,
  details TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_health_ts ON fleet_health(timestamp);
