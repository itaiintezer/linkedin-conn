/**
 * Schema-level coverage for the Posts feed: the new tables and columns exist, the
 * settings defaults match the spec, and the `posted_at` CHECK rejects the shape the
 * retention prune cannot safely compare as TEXT. Task 2 adds TrackedProfileRepo and,
 * with it, coverage for its reactivating `add`, soft-delete via `deactivate`, and the
 * per-profile sweep stamps (`markSwept` / `markSweepError`). Task 3 adds PostRepo and
 * the behavioural tests this file doesn't yet have: URN dedupe, the retention prune
 * itself, and engagement_id surviving a URN reconcile.
 */
import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';

let repos: Repos;
beforeEach(() => { repos = new Repos(openDatabase(':memory:')); });

test('the new tables and columns exist', () => {
  const tables = (repos.db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('tracked_profiles','posts')",
  ).all() as { name: string }[]).map((r) => r.name).sort();
  expect(tables).toEqual(['posts', 'tracked_profiles']);

  const settings = (repos.db.prepare('PRAGMA table_info(settings)').all() as { name: string }[])
    .map((c) => c.name);
  expect(settings).toContain('posts_sweep_per_day');
  expect(settings).toContain('posts_max_per_sweep');
  expect(settings).toContain('posts_sweep_batch_size');
  expect(settings).toContain('posts_retention_days');
  expect(settings).toContain('tracked_profile_cap');

  const app = (repos.db.prepare('PRAGMA table_info(app_state)').all() as { name: string }[])
    .map((c) => c.name);
  expect(app).toContain('posts_swept_at');
  expect(app).toContain('posts_halted');
});

test('settings defaults match the spec', () => {
  const s = repos.settings.get() as unknown as Record<string, number>;
  expect(s.posts_sweep_per_day).toBe(1);
  expect(s.posts_max_per_sweep).toBe(3);
  expect(s.posts_sweep_batch_size).toBe(200);
  expect(s.posts_retention_days).toBe(30);
  expect(s.tracked_profile_cap).toBe(200);
});

test('posted_at rejects a non-ISO shape, because the prune compares it as TEXT', () => {
  repos.db.prepare(
    "INSERT INTO tracked_profiles (profile_url, source) VALUES ('https://www.linkedin.com/in/a', 'urls')",
  ).run();
  // Space-separated, no timezone — the exact shape datetime('now') produces, and the
  // exact shape the send_log scar (see schema.sql) was written to reject.
  const bad = () => repos.db.prepare(
    `INSERT INTO posts (post_urn, post_url, tracked_profile_id, posted_at, first_seen_at)
     VALUES ('urn:li:activity:1', 'https://x', 1, '2026-08-04 10:00:00', '2026-08-04T10:00:00.000Z')`,
  ).run();
  // Anchor on the CHECK's own text so this fails loudly if a FK or NOT NULL violation
  // ever reached it first instead — SQLite's message reproduces the failing constraint
  // expression verbatim, which for this column starts with 'posted_at IS NULL'.
  expect(bad).toThrow(/CHECK constraint failed: posted_at IS NULL/);

  // Sibling proof: the identical INSERT with only the timestamp shape corrected succeeds,
  // which pins the timestamp shape as the sole variable between the two outcomes.
  const good = () => repos.db.prepare(
    `INSERT INTO posts (post_urn, post_url, tracked_profile_id, posted_at, first_seen_at)
     VALUES ('urn:li:activity:2', 'https://x', 1, '2026-08-04T10:00:00.000Z', '2026-08-04T10:00:00.000Z')`,
  ).run();
  expect(good).not.toThrow();
});

const URL_A = 'https://www.linkedin.com/in/ada-lovelace';
const URL_B = 'https://www.linkedin.com/in/grace-hopper';

test('add is idempotent and reactivates a previously untracked profile', () => {
  const first = repos.trackedProfiles.add(URL_A, null, 'urls');
  const again = repos.trackedProfiles.add(URL_A, null, 'urls');
  expect(again.id).toBe(first.id);

  repos.trackedProfiles.deactivate(first.id);
  expect(repos.trackedProfiles.findByUrl(URL_A)!.active).toBe(0);

  // Re-adding the same URL reactivates rather than duplicating, so re-tracking someone
  // you removed neither creates a second row nor re-bills their first sweep.
  const back = repos.trackedProfiles.add(URL_A, null, 'urls');
  expect(back.id).toBe(first.id);
  expect(back.active).toBe(1);
});

test('activeProfiles and countActive exclude soft-deleted rows', () => {
  const a = repos.trackedProfiles.add(URL_A, null, 'urls');
  repos.trackedProfiles.add(URL_B, null, 'search');
  expect(repos.trackedProfiles.countActive()).toBe(2);

  repos.trackedProfiles.deactivate(a.id);
  expect(repos.trackedProfiles.countActive()).toBe(1);
  expect(repos.trackedProfiles.activeProfiles().map((p) => p.profile_url)).toEqual([URL_B]);
});

test('markSwept clears a previous error; markSweepError leaves last_swept_at alone', () => {
  const a = repos.trackedProfiles.add(URL_A, null, 'urls');

  repos.trackedProfiles.markSweepError(a.id, 'run failed');
  expect(repos.trackedProfiles.findById(a.id)!.last_sweep_error).toBe('run failed');
  // A failed sweep must not advance last_swept_at, or the next pass would treat this
  // profile as fresh and use the narrow 24h window it never actually got.
  expect(repos.trackedProfiles.findById(a.id)!.last_swept_at).toBeNull();

  repos.trackedProfiles.markSwept(a.id, '2026-08-04T10:00:00.000Z');
  const row = repos.trackedProfiles.findById(a.id)!;
  expect(row.last_swept_at).toBe('2026-08-04T10:00:00.000Z');
  expect(row.last_sweep_error).toBeNull();
});
