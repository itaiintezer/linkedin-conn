import { test, expect } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { dailyTargetFor, committedToday, dailyRemainingFor } from '../../src/core/daily-budget.js';
import type { Settings } from '../../src/types.js';

function settings(over: Partial<Settings> = {}): Settings {
  return {
    id: 1, workday_start_hour: 8, workday_end_hour: 20, weekdays_only: 1,
    weekly_cap: 100, batch_size: 5, batches_per_day: 4, acceptance_checks_per_day: 1,
    account_type: 'unknown', note_quota_exhausted: 0, min_delay_ms: 20000, max_delay_ms: 90000,
    paused: 0, pause_reason: null, onboarded: 1, failure_threshold: 3, expiry_days: 0, ...over,
  };
}

test('dailyTargetFor: batches_per_day * max(1, batch_size)', () => {
  expect(dailyTargetFor(settings())).toBe(20);          // 4 * 5
  expect(dailyTargetFor(settings({ batch_size: 0 }))).toBe(4); // 4 * max(1,0)
});

test('committedToday counts scheduled rows plus profiles sent today', () => {
  const repos = new Repos(openDatabase(':memory:'));
  const c = repos.cohorts.create('C', null, true);
  const a = repos.profiles.add(c.id, 'https://www.linkedin.com/in/a', null);
  const b = repos.profiles.add(c.id, 'https://www.linkedin.com/in/b', null);
  const now = new Date(2026, 6, 1, 12, 0); // local noon, Wed 2026-07-01
  repos.profiles.setScheduled(a.id, new Date(2026, 6, 1, 15, 0).toISOString()); // -> scheduled
  repos.profiles.setStatus(b.id, 'sent', { sent_at: new Date(2026, 6, 1, 9, 0).toISOString() });
  expect(committedToday(repos, now)).toBe(2);
});

test('dailyRemainingFor never goes negative', () => {
  const repos = new Repos(openDatabase(':memory:'));
  const now = new Date(2026, 6, 1, 12, 0);
  expect(dailyRemainingFor(repos, settings({ batches_per_day: 0 }), now)).toBe(0);
});
