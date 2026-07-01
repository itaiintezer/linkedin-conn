CREATE TABLE IF NOT EXISTS cohorts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  message_template TEXT,
  allow_no_note INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cohort_id INTEGER NOT NULL REFERENCES cohorts(id),
  profile_url TEXT NOT NULL UNIQUE,
  first_name TEXT,
  custom_message TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  scheduled_for TEXT,
  sent_at TEXT,
  accepted_at TEXT,
  resolved_at TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_profiles_status ON profiles(status);
CREATE INDEX IF NOT EXISTS idx_profiles_cohort ON profiles(cohort_id);

CREATE TABLE IF NOT EXISTS send_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL REFERENCES profiles(id),
  outcome TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_send_log_at ON send_log(at);

CREATE TABLE IF NOT EXISTS profile_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL REFERENCES profiles(id),
  event_type TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_type ON profile_events(event_type);

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  workday_start_hour INTEGER NOT NULL DEFAULT 8,
  workday_end_hour INTEGER NOT NULL DEFAULT 20,
  weekdays_only INTEGER NOT NULL DEFAULT 1,
  weekly_cap INTEGER NOT NULL DEFAULT 100,
  batch_size INTEGER NOT NULL DEFAULT 5,
  batches_per_day INTEGER NOT NULL DEFAULT 4,
  acceptance_checks_per_day INTEGER NOT NULL DEFAULT 1,
  account_type TEXT NOT NULL DEFAULT 'unknown',
  note_quota_exhausted INTEGER NOT NULL DEFAULT 0,
  min_delay_ms INTEGER NOT NULL DEFAULT 20000,
  max_delay_ms INTEGER NOT NULL DEFAULT 90000,
  paused INTEGER NOT NULL DEFAULT 0,
  pause_reason TEXT,
  onboarded INTEGER NOT NULL DEFAULT 0,
  failure_threshold INTEGER NOT NULL DEFAULT 3
);

INSERT OR IGNORE INTO settings (id) VALUES (1);

CREATE TABLE IF NOT EXISTS app_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  login_logged_in INTEGER NOT NULL DEFAULT 0,
  login_cookie_expiry TEXT,
  login_confirmed_at TEXT,
  guardrail_tripped INTEGER NOT NULL DEFAULT 0,
  guardrail_reason TEXT,
  guardrail_detail TEXT,
  guardrail_tripped_at TEXT,
  failure_streak INTEGER NOT NULL DEFAULT 0,
  acceptance_checked_at TEXT
);

INSERT OR IGNORE INTO app_state (id) VALUES (1);
