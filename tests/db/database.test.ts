import { test, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, runMigrations } from '../../src/db/database.js';

import { test as mtest, expect as mexpect } from 'vitest';

mtest('runMigrations adds profiles.priority to a pre-existing profiles table', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE profiles (id INTEGER PRIMARY KEY, cohort_id INTEGER, profile_url TEXT, status TEXT DEFAULT 'queued');`);
  runMigrations(db);
  const cols = (db.prepare('PRAGMA table_info(profiles)').all() as { name: string }[]).map((c) => c.name);
  mexpect(cols).toContain('priority');
});

test('fresh db seeds onboarded = 0', () => {
  const db = openDatabase(':memory:');
  const s = db.prepare('SELECT onboarded FROM settings WHERE id = 1').get() as any;
  expect(s.onboarded).toBe(0);
});

test('runMigrations adds onboarded to a legacy settings table and back-fills configured users', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), account_type TEXT NOT NULL DEFAULT 'unknown');`);
  db.exec(`INSERT INTO settings (id, account_type) VALUES (1, 'premium');`);
  runMigrations(db);
  const cols = (db.prepare('PRAGMA table_info(settings)').all() as any[]).map((c) => c.name);
  expect(cols).toContain('onboarded');
  expect((db.prepare('SELECT onboarded FROM settings WHERE id = 1').get() as any).onboarded).toBe(1);
});

test('runMigrations leaves unknown-account users not onboarded', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), account_type TEXT NOT NULL DEFAULT 'unknown');`);
  db.exec(`INSERT INTO settings (id, account_type) VALUES (1, 'unknown');`);
  runMigrations(db);
  expect((db.prepare('SELECT onboarded FROM settings WHERE id = 1').get() as any).onboarded).toBe(0);
});

test('runMigrations drops the legacy account_type column', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), weekly_cap INTEGER NOT NULL DEFAULT 100, account_type TEXT NOT NULL DEFAULT 'unknown');`);
  db.exec(`INSERT INTO settings (id, account_type) VALUES (1, 'premium');`);
  runMigrations(db);
  const cols = (db.prepare('PRAGMA table_info(settings)').all() as any[]).map((c) => c.name);
  expect(cols).not.toContain('account_type');
  // Dropping the dead column must not disturb the settings that matter.
  expect((db.prepare('SELECT weekly_cap FROM settings WHERE id = 1').get() as any).weekly_cap).toBe(100);
});

test('runMigrations is idempotent once account_type is gone', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), account_type TEXT NOT NULL DEFAULT 'unknown');`);
  db.exec(`INSERT INTO settings (id, account_type) VALUES (1, 'free');`);
  runMigrations(db);
  expect(() => runMigrations(db)).not.toThrow();
  const cols = (db.prepare('PRAGMA table_info(settings)').all() as any[]).map((c) => c.name);
  expect(cols).not.toContain('account_type');
});

test('a fresh settings table has no account_type column', () => {
  const db = openDatabase(':memory:');
  const cols = (db.prepare('PRAGMA table_info(settings)').all() as any[]).map((c) => c.name);
  expect(cols).not.toContain('account_type');
});

test('opens in-memory db and creates all tables', () => {
  const db = openDatabase(':memory:');
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as { name: string }[];
  const names = rows.map((r) => r.name);
  expect(names).toEqual(
    expect.arrayContaining(['app_state', 'cohorts', 'profiles', 'send_log', 'profile_events', 'settings']),
  );
});

test('seeds a single settings row with defaults', () => {
  const db = openDatabase(':memory:');
  const s = db.prepare('SELECT * FROM settings WHERE id = 1').get() as any;
  expect(s.weekly_cap).toBe(100);
  expect(s.batch_size).toBe(5);
  expect(s.workday_start_hour).toBe(8);
  expect(s.workday_end_hour).toBe(20);
});

test('fresh db creates app_state with a seeded single row', () => {
  const db = openDatabase(':memory:');
  const row = db.prepare('SELECT * FROM app_state WHERE id = 1').get() as any;
  expect(row).toBeDefined();
  expect(row.login_logged_in).toBe(0);
  expect(row.guardrail_tripped).toBe(0);
  expect(row.failure_streak).toBe(0);
  expect(row.login_cookie_expiry).toBeNull();
});

test('fresh db seeds settings.failure_threshold = 3', () => {
  const db = openDatabase(':memory:');
  const s = db.prepare('SELECT failure_threshold FROM settings WHERE id = 1').get() as any;
  expect(s.failure_threshold).toBe(3);
});

test('fresh db seeds settings.expiry_days = 0 (age-based expiry disabled by default)', () => {
  const db = openDatabase(':memory:');
  const s = db.prepare('SELECT expiry_days FROM settings WHERE id = 1').get() as any;
  expect(s.expiry_days).toBe(0);
});

test('runMigrations adds expiry_days to a legacy settings table (default 0)', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), account_type TEXT NOT NULL DEFAULT 'unknown');`);
  db.exec(`INSERT INTO settings (id) VALUES (1);`);
  runMigrations(db);
  const cols = (db.prepare('PRAGMA table_info(settings)').all() as any[]).map((c) => c.name);
  expect(cols).toContain('expiry_days');
  expect((db.prepare('SELECT expiry_days FROM settings WHERE id = 1').get() as any).expiry_days).toBe(0);
});

test('runMigrations adds profiles.skip_reason and rewrites already_connected rows', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE profiles (id INTEGER PRIMARY KEY, cohort_id INTEGER, profile_url TEXT, status TEXT DEFAULT 'queued');`);
  db.exec(`INSERT INTO profiles (id, cohort_id, profile_url, status) VALUES
    (1, 1, 'https://www.linkedin.com/in/a', 'already_connected'),
    (2, 1, 'https://www.linkedin.com/in/b', 'skipped'),
    (3, 1, 'https://www.linkedin.com/in/c', 'sent');`);
  runMigrations(db);
  const cols = (db.prepare('PRAGMA table_info(profiles)').all() as { name: string }[]).map((c) => c.name);
  expect(cols).toContain('skip_reason');
  const rows = db.prepare('SELECT id, status, skip_reason FROM profiles ORDER BY id').all() as any[];
  expect(rows[0]).toMatchObject({ status: 'skipped', skip_reason: 'already_connected' });
  expect(rows[1]).toMatchObject({ status: 'skipped', skip_reason: null }); // legacy skip keeps NULL reason
  expect(rows[2]).toMatchObject({ status: 'sent', skip_reason: null });
  // Idempotent: a second run must not throw or change anything.
  runMigrations(db);
  expect((db.prepare("SELECT COUNT(*) c FROM profiles WHERE status='already_connected'").get() as any).c).toBe(0);
});

test('fresh db has profiles.skip_reason', () => {
  const db = openDatabase(':memory:');
  const cols = (db.prepare('PRAGMA table_info(profiles)').all() as { name: string }[]).map((c) => c.name);
  expect(cols).toContain('skip_reason');
});

test('runMigrations adds failure_threshold to a legacy settings table', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), account_type TEXT NOT NULL DEFAULT 'unknown');`);
  db.exec(`INSERT INTO settings (id) VALUES (1);`);
  runMigrations(db);
  const cols = (db.prepare('PRAGMA table_info(settings)').all() as any[]).map((c) => c.name);
  expect(cols).toContain('failure_threshold');
  expect((db.prepare('SELECT failure_threshold FROM settings WHERE id = 1').get() as any).failure_threshold).toBe(3);
});

test('migrates a pre-kind database: adds kind columns and rebuilds profiles uniqueness', () => {
  const db = new DatabaseSync(':memory:');
  // Minimal pre-messaging schema (what a 2026-07 production DB looks like).
  db.exec(`
    CREATE TABLE cohorts (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
      message_template TEXT, allow_no_note INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE profiles (id INTEGER PRIMARY KEY AUTOINCREMENT,
      cohort_id INTEGER NOT NULL REFERENCES cohorts(id), profile_url TEXT NOT NULL UNIQUE,
      first_name TEXT, custom_message TEXT, status TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, skip_reason TEXT,
      scheduled_for TEXT, sent_at TEXT, accepted_at TEXT, resolved_at TEXT,
      priority INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO cohorts (name) VALUES ('old');
    INSERT INTO profiles (cohort_id, profile_url, status) VALUES (1, 'https://www.linkedin.com/in/x', 'accepted');
  `);
  runMigrations(db);
  const cohortCols = (db.prepare('PRAGMA table_info(cohorts)').all() as { name: string }[]).map((c) => c.name);
  expect(cohortCols).toContain('kind');
  const profCols = (db.prepare('PRAGMA table_info(profiles)').all() as { name: string }[]).map((c) => c.name);
  for (const col of ['kind', 'full_name', 'thread_url', 'replied_at']) expect(profCols).toContain(col);
  // Row survived the rebuild with its id and status, defaulted to kind 'invite'.
  const row = db.prepare('SELECT * FROM profiles WHERE id = 1').get() as any;
  expect(row.status).toBe('accepted');
  expect(row.kind).toBe('invite');
  // Same URL is now insertable under kind 'message', but not twice under 'invite'.
  db.prepare("INSERT INTO profiles (cohort_id, profile_url, kind) VALUES (1, 'https://www.linkedin.com/in/x', 'message')").run();
  expect(() =>
    db.prepare("INSERT INTO profiles (cohort_id, profile_url, kind) VALUES (1, 'https://www.linkedin.com/in/x', 'invite')").run(),
  ).toThrow();
});

test('fresh database has message settings defaults and replies_checked_at', () => {
  const db = openDatabase(':memory:');
  const s = db.prepare('SELECT * FROM settings WHERE id = 1').get() as any;
  expect(s.msg_weekly_cap).toBe(250);
  expect(s.msg_batch_size).toBe(5);
  expect(s.msg_batches_per_day).toBe(6);
  expect(s.reply_checks_per_day).toBe(2);
  const a = db.prepare('SELECT * FROM app_state WHERE id = 1').get() as any;
  expect(a.replies_checked_at).toBeNull();
});

test('profiles rebuild preserves send_log FK integrity', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE cohorts (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
      message_template TEXT, allow_no_note INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE profiles (id INTEGER PRIMARY KEY AUTOINCREMENT,
      cohort_id INTEGER NOT NULL REFERENCES cohorts(id), profile_url TEXT NOT NULL UNIQUE,
      first_name TEXT, custom_message TEXT, status TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, skip_reason TEXT,
      scheduled_for TEXT, sent_at TEXT, accepted_at TEXT, resolved_at TEXT,
      priority INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE send_log (id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES profiles(id), outcome TEXT NOT NULL,
      at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO cohorts (name) VALUES ('old');
    INSERT INTO profiles (cohort_id, profile_url, status) VALUES (1, 'https://www.linkedin.com/in/x', 'accepted');
    INSERT INTO send_log (profile_id, outcome) VALUES (1, 'sent');
  `);
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations(db);
  const joined = db
    .prepare('SELECT send_log.id AS log_id, profiles.id AS profile_id FROM send_log JOIN profiles ON profiles.id = send_log.profile_id')
    .all();
  expect(joined).toHaveLength(1);
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

test('runMigrations recovers from a stale profiles_new left by an interrupted rebuild', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE cohorts (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
      message_template TEXT, allow_no_note INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE profiles (id INTEGER PRIMARY KEY AUTOINCREMENT,
      cohort_id INTEGER NOT NULL REFERENCES cohorts(id), profile_url TEXT NOT NULL UNIQUE,
      first_name TEXT, custom_message TEXT, status TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, skip_reason TEXT,
      scheduled_for TEXT, sent_at TEXT, accepted_at TEXT, resolved_at TEXT,
      priority INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    -- Simulate a crash right after CREATE TABLE profiles_new in a prior migration attempt.
    CREATE TABLE profiles_new (id INTEGER PRIMARY KEY);
    INSERT INTO cohorts (name) VALUES ('old');
    INSERT INTO profiles (cohort_id, profile_url, status) VALUES (1, 'https://www.linkedin.com/in/x', 'accepted');
  `);
  expect(() => runMigrations(db)).not.toThrow();
  const row = db.prepare('SELECT * FROM profiles WHERE id = 1').get() as any;
  expect(row.status).toBe('accepted');
  expect(row.kind).toBe('invite');
});

test('runMigrations restores PRAGMA foreign_keys = ON after the profiles rebuild', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE cohorts (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
      message_template TEXT, allow_no_note INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE profiles (id INTEGER PRIMARY KEY AUTOINCREMENT,
      cohort_id INTEGER NOT NULL REFERENCES cohorts(id), profile_url TEXT NOT NULL UNIQUE,
      first_name TEXT, custom_message TEXT, status TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, skip_reason TEXT,
      scheduled_for TEXT, sent_at TEXT, accepted_at TEXT, resolved_at TEXT,
      priority INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO cohorts (name) VALUES ('old');
    INSERT INTO profiles (cohort_id, profile_url, status) VALUES (1, 'https://www.linkedin.com/in/x', 'accepted');
  `);
  runMigrations(db);
  const fk = db.prepare('PRAGMA foreign_keys').get() as any;
  expect(fk.foreign_keys).toBe(1);
});

test('migrates a pre-connections database: adds roster columns, creates connections tables', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), weekly_cap INTEGER NOT NULL DEFAULT 100);
    INSERT INTO settings (id) VALUES (1);
    CREATE TABLE app_state (id INTEGER PRIMARY KEY CHECK (id = 1), failure_streak INTEGER NOT NULL DEFAULT 0);
    INSERT INTO app_state (id) VALUES (1);
  `);

  runMigrations(db);

  const settingsCols = (db.prepare('PRAGMA table_info(settings)').all() as { name: string }[]).map((c) => c.name);
  expect(settingsCols).toContain('roster_sync_per_day');
  const appCols = (db.prepare('PRAGMA table_info(app_state)').all() as { name: string }[]).map((c) => c.name);
  expect(appCols).toContain('roster_synced_at');
  expect(appCols).toContain('connections_seeded_at');

  // Idempotent: a second pass must not throw.
  expect(() => runMigrations(db)).not.toThrow();
});

test('a fresh database has the connections tables with a unique profile_url', () => {
  const db = openDatabase(':memory:');
  db.exec("INSERT INTO connections (profile_url, source, first_seen_at, last_seen_at) VALUES ('https://www.linkedin.com/in/a','csv','2026-07-31T00:00:00Z','2026-07-31T00:00:00Z')");
  expect(() =>
    db.exec("INSERT INTO connections (profile_url, source, first_seen_at, last_seen_at) VALUES ('https://www.linkedin.com/in/a','csv','2026-07-31T00:00:00Z','2026-07-31T00:00:00Z')"),
  ).toThrow();
  expect((db.prepare('SELECT enrich_status s FROM connections').get() as { s: string }).s).toBe('pending');
});

test('migrates a pre-enrichment database: adds enrichment columns and the FTS table', () => {
  const db = openDatabase(':memory:');
  const cols = (db.prepare('PRAGMA table_info(connections)').all() as { name: string }[]).map((c) => c.name);
  expect(cols).toContain('location_country_code');
  const scols = (db.prepare('PRAGMA table_info(settings)').all() as { name: string }[]).map((c) => c.name);
  expect(scols).toEqual(expect.arrayContaining(['apify_api_key', 'enrich_ttl_days', 'enrich_concurrency']));
  // FTS5 must be usable — node:sqlite ships it (verified 2026-07-31).
  db.exec("INSERT INTO connections_fts (rowid, doc) VALUES (1, 'seattle security engineer')");
  const hit = db.prepare("SELECT rowid FROM connections_fts WHERE connections_fts MATCH 'securit*'").get();
  expect(hit).toBeTruthy();
});

test('drops acceptance_checks_per_day, a setting nothing reads since the cutover', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1),
      weekly_cap INTEGER NOT NULL DEFAULT 100,
      acceptance_checks_per_day INTEGER NOT NULL DEFAULT 2);
    INSERT INTO settings (id) VALUES (1);
    CREATE TABLE app_state (id INTEGER PRIMARY KEY CHECK (id = 1), failure_streak INTEGER NOT NULL DEFAULT 0);
    INSERT INTO app_state (id) VALUES (1);
  `);

  runMigrations(db);

  const cols = (db.prepare('PRAGMA table_info(settings)').all() as { name: string }[]).map((c) => c.name);
  expect(cols).not.toContain('acceptance_checks_per_day');
  expect(cols).toContain('weekly_cap');   // the rest of the row survives
  expect(() => runMigrations(db)).not.toThrow();
});

// --- Event invites ---------------------------------------------------------------
// CREATE TABLE IF NOT EXISTS back-fills a whole missing table but is a no-op once the
// table exists — so a column declared on an event table AFTER that table shipped is
// silently absent, and every read of it quietly returns undefined instead of failing.
// geo_candidates is the first such column; these pin the guard that covers it.

test('runMigrations adds event_buckets.geo_candidates to a table that predates it', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE event_buckets (
    id INTEGER PRIMARY KEY, event_id INTEGER, rank INTEGER, label TEXT,
    geo_label TEXT, geo_urn TEXT, kind TEXT, target_count INTEGER,
    roster_count INTEGER, parent_bucket_id INTEGER, status TEXT);`);
  runMigrations(db);
  const cols = (db.prepare('PRAGMA table_info(event_buckets)').all() as { name: string }[]).map((c) => c.name);
  expect(cols).toContain('geo_candidates');
});

test('runMigrations leaves an already-current event_buckets untouched', () => {
  const db = openDatabase(':memory:');
  const before = (db.prepare('PRAGMA table_info(event_buckets)').all() as { name: string }[]).map((c) => c.name);
  runMigrations(db); // idempotent — a second pass must not throw or duplicate
  const after = (db.prepare('PRAGMA table_info(event_buckets)').all() as { name: string }[]).map((c) => c.name);
  expect(after).toEqual(before);
  expect(after.filter((c) => c === 'geo_candidates')).toHaveLength(1);
});

test('runMigrations skips the event guard entirely when the table is absent', () => {
  // Isolated migration tests operate on partial databases; table_info returns [] then.
  const db = new DatabaseSync(':memory:');
  expect(() => runMigrations(db)).not.toThrow();
});

test('a fresh db gets every event settings column', () => {
  const db = openDatabase(':memory:');
  const cols = (db.prepare('PRAGMA table_info(settings)').all() as { name: string }[]).map((c) => c.name);
  for (const c of ['events_per_day', 'event_invite_cap', 'event_bucket_ceiling',
    'event_run_budget_minutes', 'event_shard_threshold']) {
    expect(cols).toContain(c);
  }
});

test('runMigrations adds the event settings columns to a legacy settings table', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), weekly_cap INTEGER NOT NULL DEFAULT 100);');
  db.exec('INSERT INTO settings (id) VALUES (1);');
  runMigrations(db);
  const row = db.prepare('SELECT * FROM settings WHERE id = 1').get() as Record<string, unknown>;
  expect(row.events_per_day).toBe(1);
  expect(row.event_invite_cap).toBe(500);
  expect(row.event_bucket_ceiling).toBe(10);
  expect(row.event_run_budget_minutes).toBe(20);
  expect(row.event_shard_threshold).toBe(900);
});

// --- Post engagements ------------------------------------------------------------

test('a fresh database has the engagements table with the expected shape', () => {
  const db = openDatabase(':memory:');
  const cols = (db.prepare('PRAGMA table_info(engagements)').all() as { name: string }[])
    .map((c) => c.name);
  // Exact, not arrayContaining: PRAGMA table_info returns declaration order, so this is
  // stable — and it must fail when a 15th column appears. That is the tripwire for the
  // trap schema.sql documents above the table: CREATE TABLE IF NOT EXISTS back-fills a
  // missing table but is a no-op once it exists, so a column added here later is silently
  // absent on every existing database until someone writes it a guarded ALTER.
  expect(cols).toEqual([
    'id', 'post_url', 'post_urn', 'reaction', 'comment_text', 'status', 'attempts',
    'last_error', 'skip_reason', 'scheduled_for', 'reacted_at', 'commented_at',
    'priority', 'created_at',
  ]);
});

test('one engagement per post is a hard constraint', () => {
  const db = openDatabase(':memory:');
  const ins = "INSERT INTO engagements (post_url, post_urn, reaction) VALUES ('u', 'urn:li:activity:1', 'like')";
  db.exec(ins);
  expect(() => db.exec(ins)).toThrow(/UNIQUE/);
});

test('post_url is deliberately NOT unique — the urn is the identity', () => {
  const db = openDatabase(':memory:');
  // Same display url, two different posts. Re-shares depend on this being legal, and
  // post_url is display/navigation only — adding UNIQUE to it would break them silently.
  db.exec("INSERT INTO engagements (post_url, post_urn, reaction) VALUES ('u', 'urn:li:activity:1', 'like')");
  expect(() =>
    db.exec("INSERT INTO engagements (post_url, post_urn, reaction) VALUES ('u', 'urn:li:activity:2', 'love')"),
  ).not.toThrow();
  expect((db.prepare('SELECT COUNT(*) c FROM engagements').get() as { c: number }).c).toBe(2);
});

test('the engage_* settings columns exist with their documented defaults', () => {
  const db = openDatabase(':memory:');
  const s = db.prepare('SELECT * FROM settings WHERE id = 1').get() as unknown as Record<string, number>;
  expect(s.engage_weekly_cap).toBe(500);
  expect(s.engage_batch_size).toBe(15);
  expect(s.engage_batches_per_day).toBe(6);
  expect(s.engage_comment_daily_cap).toBe(10);
});

// Asserts all four defaults, so the ALTERs in runMigrations are pinned independently of
// the ones declared in schema.sql — the two are separate literals and can drift.
test('a settings table predating the engage_* columns is migrated', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), weekly_cap INTEGER NOT NULL DEFAULT 100);');
  db.exec('INSERT INTO settings (id) VALUES (1);');
  runMigrations(db);
  const s = db.prepare('SELECT * FROM settings WHERE id = 1').get() as Record<string, unknown>;
  expect(s.engage_weekly_cap).toBe(500);
  expect(s.engage_batch_size).toBe(15);
  expect(s.engage_batches_per_day).toBe(6);
  expect(s.engage_comment_daily_cap).toBe(10);
});

test('runMigrations is idempotent', () => {
  const db = openDatabase(':memory:');
  expect(() => { runMigrations(db); runMigrations(db); }).not.toThrow();
});
