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
  expect(s.msg_weekly_cap).toBe(200);
  expect(s.msg_batch_size).toBe(5);
  expect(s.msg_batches_per_day).toBe(4);
  expect(s.reply_checks_per_day).toBe(2);
  const a = db.prepare('SELECT * FROM app_state WHERE id = 1').get() as any;
  expect(a.replies_checked_at).toBeNull();
});
