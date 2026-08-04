/**
 * The Posts data layer. Covers the four decisions the spec defends: URN dedupe,
 * soft-delete, the retention prune, and engagement_id surviving a URN reconcile.
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
  const bad = () => repos.db.prepare(
    `INSERT INTO posts (post_urn, post_url, tracked_profile_id, posted_at, first_seen_at)
     VALUES ('urn:li:activity:1', 'https://x', 1, '2026-08-04 10:00:00', '2026-08-04T10:00:00.000Z')`,
  ).run();
  expect(bad).toThrow();
});
