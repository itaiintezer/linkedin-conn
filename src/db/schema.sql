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
  expiry_days INTEGER NOT NULL DEFAULT 0,
  -- Event-invite pipeline. Its own caps: an event invite is a different LinkedIn quota
  -- from a connection request, and 500 of them would instantly blow weekly_cap if pooled.
  events_per_day INTEGER NOT NULL DEFAULT 1,
  event_invite_cap INTEGER NOT NULL DEFAULT 500,
  event_bucket_ceiling INTEGER NOT NULL DEFAULT 10,
  event_run_budget_minutes INTEGER NOT NULL DEFAULT 20,
  -- The picker hard-caps at 1000 rows in a stable order, so anything past it is
  -- permanently invisible under that filter. Buckets at/over this get sub-sharded.
  event_shard_threshold INTEGER NOT NULL DEFAULT 900,
  -- Post engagements. Own caps, with deliberately bigger batches than an invite: a
  -- reaction is a far cheaper action than a connection request. 15 x 6 = 90/day.
  engage_weekly_cap INTEGER NOT NULL DEFAULT 500,
  engage_batch_size INTEGER NOT NULL DEFAULT 15,
  engage_batches_per_day INTEGER NOT NULL DEFAULT 6,
  -- Comments are capped separately and far lower: 90 published comments a day under the
  -- operator's own name is a materially different risk from 90 likes.
  engage_comment_daily_cap INTEGER NOT NULL DEFAULT 10
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
  -- Automatic enrichment halted itself (bad key, billing, repeated errors). A latch, so the
  -- 60s drain tick reports the problem once instead of retrying it 1,440 times a day.
  enrich_halted INTEGER NOT NULL DEFAULT 0,
  enrich_halt_reason TEXT,
  enrich_halt_detail TEXT,
  enrich_halted_at TEXT,
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

-- ============================================================================
-- Event invites (2026-08-01). The third pipeline: invite 1st-degree connections
-- to a LinkedIn event, sharded by location.
--
-- Deliberately NOT modelled as a CampaignKind. The sender's per-profile model
-- (batch_size, weekly_cap, one send per tick) does not describe a 500-person
-- modal operation, and `profiles` has UNIQUE(profile_url, kind) — which would
-- forbid inviting the same person to two different events. Separate tables;
-- shared pause / guardrail / working-hours / browser-mutex rails.
-- ============================================================================

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_url TEXT NOT NULL UNIQUE,       -- canonical https://www.linkedin.com/events/<id>/
  event_urn TEXT,                       -- the numeric id out of the URL
  title TEXT,
  -- Parsed from the event top card. LinkedIn renders it in the viewer's local time
  -- ("Thu, Sep 10, 2026, 6:15 PM ... (your local time)") and offers no JSON-LD, no
  -- <time> element and no meta tag, so this is scraped from prose. Once it is in the
  -- past the campaign is closed: inviting people to a finished event is pointless.
  starts_at TEXT,
  status TEXT NOT NULL DEFAULT 'draft', -- draft|armed|running|done|stopped|failed
  invite_cap INTEGER NOT NULL DEFAULT 500,     -- LIFETIME cap for this event
  bucket_ceiling INTEGER NOT NULL DEFAULT 10,  -- max location buckets per run
  bucket_cursor INTEGER NOT NULL DEFAULT 0,    -- rank to resume from on the next run
  attended INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  armed_at TEXT,
  closed_at TEXT,
  close_reason TEXT
);

-- One row per location we will filter by, ranked by how many of THIS event's
-- invitees fall in it. `roster_count` is the different number that decides sharding:
-- the picker hard-caps at 1000 rows, so a bucket whose roster count exceeds the
-- threshold is expanded into child geos plus the parent.
CREATE TABLE IF NOT EXISTS event_buckets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id),
  rank INTEGER NOT NULL,
  label TEXT NOT NULL,          -- display: "California (US state)"
  geo_label TEXT NOT NULL,      -- EXACT typeahead hit text: "California, United States"
  -- JSON array of exact labels to try, in order. Our stored country names come from
  -- Apify and do not always match LinkedIn's geo vocabulary ("Russian Federation" vs
  -- "Russia"), and a name that never matches silently costs the whole bucket.
  geo_candidates TEXT,
  geo_urn TEXT,                 -- cached geoUrn-<id> value once resolved
  kind TEXT NOT NULL,           -- country | us_state | region
  target_count INTEGER NOT NULL DEFAULT 0,  -- invitees expected here (ranks the list)
  roster_count INTEGER NOT NULL DEFAULT 0,  -- connections LinkedIn will list (caps at 1000)
  parent_bucket_id INTEGER REFERENCES event_buckets(id),
  status TEXT NOT NULL DEFAULT 'pending',   -- pending|done|skipped|failed
  UNIQUE (event_id, geo_label)
);
CREATE INDEX IF NOT EXISTS idx_event_buckets_event ON event_buckets(event_id);

CREATE TABLE IF NOT EXISTS event_invitees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id),
  connection_id INTEGER REFERENCES connections(id),
  -- The join key that actually matters. The picker's checkbox id embeds this
  -- (i18n_checkbox-invitee-suggestion-ACoAA...) and it equals connections.linkedin_id
  -- exactly — verified 1000/1000. Never match on name: 37 roster names are duplicated.
  member_urn TEXT,
  profile_url TEXT NOT NULL,
  full_name TEXT,
  bucket_id INTEGER REFERENCES event_buckets(id),
  status TEXT NOT NULL DEFAULT 'pending',  -- pending|invited|unreachable|failed
  invited_at TEXT,
  -- Reserved: v1 does not scrape the attendee list, but adding that later should be a
  -- worker plus a column read, not a migration.
  responded_at TEXT,
  note TEXT,
  UNIQUE (event_id, profile_url)
);
CREATE INDEX IF NOT EXISTS idx_event_invitees_event ON event_invitees(event_id, status);
CREATE INDEX IF NOT EXISTS idx_event_invitees_urn ON event_invitees(member_urn);

CREATE TABLE IF NOT EXISTS event_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id),
  mode TEXT NOT NULL DEFAULT 'live',    -- dry | live
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  reserved_from TEXT,
  reserved_to TEXT,
  invited_count INTEGER NOT NULL DEFAULT 0,
  outcome TEXT,                         -- completed|ceiling|cap|exhausted|halted|failed
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_event_runs_event ON event_runs(event_id, started_at);

-- Live progress. Written as the run proceeds so the UI can show "Israel — 840 rows
-- scanned, 3 of 4 matched" rather than 20 opaque minutes.
CREATE TABLE IF NOT EXISTS event_run_buckets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES event_runs(id),
  bucket_id INTEGER NOT NULL REFERENCES event_buckets(id),
  rows_loaded INTEGER NOT NULL DEFAULT 0,
  matched INTEGER NOT NULL DEFAULT 0,
  ticked INTEGER NOT NULL DEFAULT 0,
  submitted INTEGER NOT NULL DEFAULT 0,
  outcome TEXT,                         -- done|early_exit|capped|no_geo|failed
  error TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (run_id, bucket_id)
);

-- Generic held-open windows the planner must not schedule sends into. Kept generic
-- rather than event-specific: anything that needs exclusive use of the single browser
-- for a stretch can claim one.
CREATE TABLE IF NOT EXISTS reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_ts TEXT NOT NULL,
  to_ts TEXT NOT NULL,
  purpose TEXT NOT NULL,                -- 'event_invite'
  ref_id INTEGER,                       -- events.id for purpose='event_invite'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_reservations_window ON reservations(from_ts, to_ts);

-- Search index over the enriched corpus (phase 2 fills it; phase 3 queries it).
-- A plain FTS5 table keyed by connection id, not contentless-external: external content
-- would couple every connections write to fts rowid bookkeeping, and one text document per
-- person is small enough that the duplication is not worth that coupling.
CREATE VIRTUAL TABLE IF NOT EXISTS connections_fts USING fts5(doc);

-- ============================================================================
-- Post engagements (2026-08-02). The fourth pipeline: react to a LinkedIn post,
-- optionally with a comment.
--
-- Deliberately NOT a CampaignKind. `profiles` is person-shaped — first_name,
-- accepted_at, thread_url — and a post is not a person. The hard blocker is
-- profiles.cohort_id: NOT NULL REFERENCES cohorts(id), and an engagement has
-- no cohort to belong to. Note that UNIQUE(profile_url, kind) is NOT the
-- obstacle here that it is for event invites: one post, one engagement is
-- precisely what that constraint would give us. The FK is what rules it out.
-- Separate table; shared pause / guardrail / working-hours / browser-mutex
-- rails, and drained by the SAME sender tick as invites and messages (unlike
-- event invites, which need a reserved window of their own).
--
-- CAREFUL: CREATE TABLE IF NOT EXISTS back-fills the whole table on every
-- openDatabase, but it is a no-op once the table exists. A column added here
-- LATER is silently absent on existing databases and needs its own guarded
-- ALTER in runMigrations — the same trap documented for event_buckets.
-- ============================================================================
CREATE TABLE IF NOT EXISTS engagements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Canonical https://www.linkedin.com/feed/update/<urn>/ — display and navigation only.
  post_url TEXT NOT NULL,
  -- THE identity. The same post is reachable as /feed/update/, /posts/<slug>-activity-…
  -- and ?updateId=…, so deduping on post_url would dedupe nothing.
  post_urn TEXT NOT NULL UNIQUE,
  -- Always present. LinkedIn permits exactly one reaction per member per post, which is
  -- the same rule the UNIQUE above enforces.
  reaction TEXT NOT NULL,
  -- Optional. When set it is ALWAYS delivered alongside the reaction — there is no
  -- comment-only engagement.
  comment_text TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  -- not_found | unavailable | comments_disabled | dismissed
  skip_reason TEXT,
  scheduled_for TEXT,
  -- Partial progress, deliberately NOT one sent_at: the task does two things in sequence
  -- and a retry after a failed comment must not re-drive the reaction.
  --
  -- The CHECKs pin the exact shape toISOString() produces (YYYY-MM-DDTHH:MM:SS.sssZ), NULL
  -- still allowed. This is a scar, not decoration. countReactedSince / countCommentedSince
  -- compare these columns with `>= ?` against an ISO string, and TEXT >= TEXT is only a
  -- chronological comparison while EVERY value is that one fixed-width shape. send_log.at
  -- is the live proof of what happens otherwise: it is written by the datetime('now')
  -- default, so it holds '2026-07-31 16:50:00', and EventRepo.countSentSince compares it to
  -- windowStartIso() -> '2026-07-25T16:50:00.000Z'. Byte 10 is ' ' (0x20) vs 'T' (0x54), so
  -- on a shared date prefix the comparison is silently FALSE and real sends vanish from the
  -- weekly counter. A CHECK cannot be added by ALTER TABLE in SQLite, so it had to land
  -- before this table existed in anyone's database.
  reacted_at TEXT CHECK (
    reacted_at IS NULL
    OR reacted_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
  commented_at TEXT CHECK (
    commented_at IS NULL
    OR commented_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_engagements_status ON engagements(status);
CREATE INDEX IF NOT EXISTS idx_engagements_reacted ON engagements(reacted_at);
