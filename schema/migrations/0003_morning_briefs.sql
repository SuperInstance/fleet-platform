-- ═══════════════════════════════════════════════════════════
-- Migration 0003: Morning Briefs
-- Daily 03:00 UTC intelligence brief for the captain.
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS morning_briefs (
  date TEXT PRIMARY KEY,                  -- YYYY-MM-DD (the day being summarized)
  markdown TEXT NOT NULL,                 -- full rendered brief
  vessel_lat REAL,                        -- vessel position at generation time
  vessel_lon REAL,
  weather_json TEXT,                      -- cached weather snapshot (JSON)
  tide_json TEXT,                         -- cached tide snapshot (JSON)
  sessions_count INTEGER DEFAULT 0,
  captures_count INTEGER DEFAULT 0,
  observations_count INTEGER DEFAULT 0,
  corrections_count INTEGER DEFAULT 0,
  narrator_notes TEXT,                    -- 2-3 sentence narrator summary
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_brief_created ON morning_briefs(created_at);
