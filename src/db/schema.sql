CREATE TABLE IF NOT EXISTS cohorts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'invite',
  message_template TEXT,
  allow_no_note INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cohort_id INTEGER NOT NULL REFERENCES cohorts(id),
  kind TEXT NOT NULL DEFAULT 'invite',
  profile_url TEXT NOT NULL,
  first_name TEXT,
  full_name TEXT,
  custom_message TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  -- Why a skipped profile was skipped: already_connected | email_required |
  -- unavailable | dismissed | not_found | not_connected. NULL for legacy rows.
  skip_reason TEXT,
  scheduled_for TEXT,
  sent_at TEXT,
  accepted_at TEXT,
  replied_at TEXT,
  resolved_at TEXT,
  thread_url TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (profile_url, kind)
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
  msg_weekly_cap INTEGER NOT NULL DEFAULT 250,
  msg_batch_size INTEGER NOT NULL DEFAULT 5,
  msg_batches_per_day INTEGER NOT NULL DEFAULT 6,
  -- Reply-check passes per day (messages funnel), same slot mechanism as acceptance.
  reply_checks_per_day INTEGER NOT NULL DEFAULT 2,
  -- Roster syncs per day, same slot mechanism as acceptance/reply checks.
  roster_sync_per_day INTEGER NOT NULL DEFAULT 2,
  -- Apify credential. Write-only over HTTP: GET /api/settings never returns it.
  apify_api_key TEXT,
  -- Re-enrich a connection this many days after its last successful scrape.
  enrich_ttl_days INTEGER NOT NULL DEFAULT 180,
  -- Concurrent Apify runs. No LinkedIn risk — bounded only by your Apify plan.
  enrich_concurrency INTEGER NOT NULL DEFAULT 8,
  note_quota_exhausted INTEGER NOT NULL DEFAULT 0,
  min_delay_ms INTEGER NOT NULL DEFAULT 20000,
  max_delay_ms INTEGER NOT NULL DEFAULT 90000,
  paused INTEGER NOT NULL DEFAULT 0,
  pause_reason TEXT,
  onboarded INTEGER NOT NULL DEFAULT 0,
  failure_threshold INTEGER NOT NULL DEFAULT 3,
  -- Age-based expiry backstop (days). 0 = disabled: invites are never expired by age.
  -- Expiry is NEVER inferred from list scrapes; only this deterministic age check.
  expiry_days INTEGER NOT NULL DEFAULT 0
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
  acceptance_checked_at TEXT,
  replies_checked_at TEXT,
  roster_synced_at TEXT,
  connections_seeded_at TEXT
);

INSERT OR IGNORE INTO app_state (id) VALUES (1);

-- The connection roster. One row per person you are connected to, independent of any
-- cohort or campaign. Append-only: nothing in this app removes a connection (see the
-- 2026-07-31 design doc — removals are deliberately not tracked).
CREATE TABLE IF NOT EXISTS connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_url TEXT NOT NULL UNIQUE,   -- normalizeProfileUrl()
  linkedin_id TEXT,                   -- stable id from Apify; merge key for slug changes
  public_identifier TEXT,
  full_name TEXT,
  first_name TEXT,
  last_name TEXT,
  headline TEXT,
  location_raw TEXT,
  location_city TEXT,
  location_region TEXT,
  location_country TEXT,
  location_country_code TEXT,         -- ISO-3166 alpha-2, straight from Apify's parsed location
  current_title TEXT,
  current_company TEXT,
  -- ISO date. ONLY from the CSV export or a known accepted_at. Never inferred from
  -- first_seen_at: "when we first saw them" is not "when you connected".
  connected_on TEXT,
  source TEXT NOT NULL,               -- csv | urls | scrape | migration
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  enrich_status TEXT NOT NULL DEFAULT 'pending',
  enrich_attempts INTEGER NOT NULL DEFAULT 0,
  enrich_error TEXT,
  enriched_at TEXT,
  raw_json TEXT,                      -- cherry-picked Apify payload (phase 2)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_connections_enrich ON connections(enrich_status);
CREATE INDEX IF NOT EXISTS idx_connections_linkedin_id ON connections(linkedin_id);

-- Old profile URLs kept after a slug-change merge, so a stale link still resolves.
CREATE TABLE IF NOT EXISTS connection_aliases (
  profile_url TEXT PRIMARY KEY,
  connection_id INTEGER NOT NULL REFERENCES connections(id)
);

-- Search index over the enriched corpus (phase 2 fills it; phase 3 queries it).
-- A plain FTS5 table keyed by connection id, not contentless-external: external content
-- would couple every connections write to fts rowid bookkeeping, and one text document per
-- person is small enough that the duplication is not worth that coupling.
CREATE VIRTUAL TABLE IF NOT EXISTS connections_fts USING fts5(doc);
