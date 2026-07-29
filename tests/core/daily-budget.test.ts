import { test, expect } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { dailyTargetFor, committedToday, dailyRemainingFor } from '../../src/core/daily-budget.js';
import type { Settings } from '../../src/types.js';

function settings(over: Partial<Settings> = {}): Settings {
  return {
    id: 1, workday_start_hour: 8, workday_end_hour: 20, weekdays_only: 1,
    weekly_cap: 100, batch_size: 5, batches_per_day: 4, acceptance_checks_per_day: 1,
    msg_weekly_cap: 200, msg_batch_size: 5, msg_batches_per_day: 4, reply_checks_per_day: 2,
    note_quota_exhausted: 0, min_delay_ms: 20000, max_delay_ms: 90000,
    paused: 0, pause_reason: null, onboarded: 1, failure_threshold: 3, expiry_days: 0, ...over,
  };
}

test('dailyTargetFor: batches_per_day * max(1, batch_size)', () => {
  expect(dailyTargetFor(settings(), 'invite')).toBe(20);          // 4 * 5
  expect(dailyTargetFor(settings({ batch_size: 0 }), 'invite')).toBe(4); // 4 * max(1,0)
});

test('dailyTargetFor: message kind is 0 when msg_batches_per_day is 0', () => {
  expect(dailyTargetFor(settings({ msg_batches_per_day: 0 }), 'message')).toBe(0);
});

test('committedToday counts scheduled rows plus profiles sent today', () => {
  const repos = new Repos(openDatabase(':memory:'));
  const c = repos.cohorts.create('C', null, true);
  const a = repos.profiles.add(c.id, 'https://www.linkedin.com/in/a', null);
  const b = repos.profiles.add(c.id, 'https://www.linkedin.com/in/b', null);
  const now = new Date(2026, 6, 1, 12, 0); // local noon, Wed 2026-07-01
  repos.profiles.setScheduled(a.id, new Date(2026, 6, 1, 15, 0).toISOString()); // -> scheduled
  repos.profiles.setStatus(b.id, 'sent', { sent_at: new Date(2026, 6, 1, 9, 0).toISOString() });
  expect(committedToday(repos, now, 'invite')).toBe(2);
});

test('dailyRemainingFor never goes negative', () => {
  const repos = new Repos(openDatabase(':memory:'));
  const now = new Date(2026, 6, 1, 12, 0);
  expect(dailyRemainingFor(repos, settings({ batches_per_day: 0 }), now, 'invite')).toBe(0);
});

test('daily budget is computed per kind from that kind caps and rows', () => {
  const repos = new Repos(openDatabase(':memory:'));
  repos.settings.update({ batches_per_day: 2, batch_size: 3, msg_batches_per_day: 4, msg_batch_size: 5 });
  const inv = repos.cohorts.create('I', null, true);
  const msg = repos.cohorts.create('M', 'hi', true, 'message');
  const pi = repos.profiles.add(inv.id, 'https://www.linkedin.com/in/i1', null);
  const pm = repos.profiles.add(msg.id, 'https://www.linkedin.com/in/m1', null, 'message');
  repos.profiles.setScheduled(pi.id, '2026-07-28T09:00:00.000Z');
  repos.profiles.setScheduled(pm.id, '2026-07-28T09:00:00.000Z');
  const now = new Date('2026-07-28T10:00:00');
  const s = repos.settings.get();
  expect(dailyTargetFor(s, 'invite')).toBe(6);
  expect(dailyTargetFor(s, 'message')).toBe(20);
  expect(dailyRemainingFor(repos, s, now, 'invite')).toBe(5);   // 6 - 1 scheduled invite
  expect(dailyRemainingFor(repos, s, now, 'message')).toBe(19); // 20 - 1 scheduled message
});

test('committedToday excludes same-day sent rows of the other kind', () => {
  const repos = new Repos(openDatabase(':memory:'));
  const inv = repos.cohorts.create('I', null, true);
  const msg = repos.cohorts.create('M', 'hi', true, 'message');
  const pi = repos.profiles.add(inv.id, 'https://www.linkedin.com/in/i1', null);
  const pm = repos.profiles.add(msg.id, 'https://www.linkedin.com/in/m1', null, 'message');
  const now = new Date(2026, 6, 28, 12, 0); // local noon, 2026-07-28
  repos.profiles.setStatus(pi.id, 'sent', { sent_at: new Date(2026, 6, 28, 9, 0).toISOString() });
  // Message profile also sent today, but must not leak into the invite kind's count.
  repos.profiles.setStatus(pm.id, 'sent', { sent_at: new Date(2026, 6, 28, 9, 0).toISOString() });
  const s = repos.settings.get();
  expect(committedToday(repos, now, 'invite')).toBe(1);
  expect(dailyRemainingFor(repos, s, now, 'invite')).toBe(dailyTargetFor(s, 'invite') - 1);
  // Sanity: the message send is still counted on its own kind.
  expect(committedToday(repos, now, 'message')).toBe(1);
});
