import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { planAndAssignToday, requeueOverdue, resortSchedule } from '../../src/worker/scheduler-service.js';

let repos: Repos;
beforeEach(() => { repos = new Repos(openDatabase(':memory:')); });

const NOW = new Date('2026-08-03T08:00:00'); // a Monday, inside the 8-20 window

function addEngagement(n: number, comment: string | null = null) {
  return repos.engagements.add(
    `https://www.linkedin.com/feed/update/urn:li:activity:${n}/`,
    `urn:li:activity:${n}`, 'like', comment,
  );
}

test('queued engagements get slots inside today\'s working-hours window', () => {
  for (let i = 1; i <= 5; i++) addEngagement(i);
  planAndAssignToday(repos, NOW, () => 0.5);
  const scheduled = repos.engagements.byStatus('scheduled');
  expect(scheduled).toHaveLength(5);
  for (const e of scheduled) {
    const at = new Date(e.scheduled_for!);
    expect(at.getHours()).toBeGreaterThanOrEqual(8);
    expect(at.getHours()).toBeLessThan(20);
    expect(at.getTime()).toBeGreaterThan(NOW.getTime());
  }
});

test('the weekly cap clamps how many are scheduled', () => {
  for (let i = 1; i <= 5; i++) addEngagement(i);
  repos.settings.update({ engage_weekly_cap: 2 });
  planAndAssignToday(repos, NOW, () => 0.5);
  expect(repos.engagements.byStatus('scheduled')).toHaveLength(2);
  expect(repos.engagements.byStatus('queued')).toHaveLength(3);
});

test('the daily comment cap limits how many comment-bearing tasks are PLANNED', () => {
  repos.settings.update({ engage_comment_daily_cap: 2 });
  for (let i = 1; i <= 5; i++) addEngagement(i, 'nice post');
  planAndAssignToday(repos, NOW, () => 0.5);
  expect(repos.engagements.byStatus('scheduled')).toHaveLength(2);
});

test('the comment cap does not hold back reaction-only tasks', () => {
  repos.settings.update({ engage_comment_daily_cap: 0 });
  for (let i = 1; i <= 3; i++) addEngagement(i);          // reaction only
  for (let i = 4; i <= 6; i++) addEngagement(i, 'hi');    // with a comment
  planAndAssignToday(repos, NOW, () => 0.5);
  const scheduled = repos.engagements.byStatus('scheduled');
  expect(scheduled).toHaveLength(3);
  expect(scheduled.every((e) => e.comment_text === null)).toBe(true);
});

test('comments already posted today count against the budget', () => {
  repos.settings.update({ engage_comment_daily_cap: 2 });
  const done = addEngagement(99, 'already said');
  const todayIso = new Date('2026-08-03T09:00:00').toISOString();
  repos.engagements.setStatus(done.id, 'sent', { reacted_at: todayIso, commented_at: todayIso });
  for (let i = 1; i <= 4; i++) addEngagement(i, 'hello');
  planAndAssignToday(repos, NOW, () => 0.5);
  expect(repos.engagements.byStatus('scheduled')).toHaveLength(1);
});

/**
 * The comment budget resets at LOCAL midnight, matching the working-hours window it paces.
 * dayStartIso does setHours(0,0,0,0) then toISOString(), i.e. the UTC instant of local
 * midnight — the right thing to compare against commented_at, which is a UTC ISO string.
 * Both sides of this test are expressed in local time, so it holds in any timezone.
 */
test('a comment posted before local midnight does not spend today\'s budget', () => {
  repos.settings.update({ engage_comment_daily_cap: 1 });
  const done = addEngagement(99, 'said yesterday');
  const yesterdayIso = new Date('2026-08-02T23:00:00').toISOString();
  repos.engagements.setStatus(done.id, 'sent', { reacted_at: yesterdayIso, commented_at: yesterdayIso });
  addEngagement(1, 'hello');
  planAndAssignToday(repos, NOW, () => 0.5);
  expect(repos.engagements.byStatus('scheduled')).toHaveLength(1);
});

test('engagements route around an event reservation', () => {
  for (let i = 1; i <= 3; i++) addEngagement(i);
  repos.reservations.create(
    new Date('2026-08-03T08:00:00').toISOString(),
    new Date('2026-08-03T20:00:00').toISOString(),
    'event_invite', 1,
  );
  planAndAssignToday(repos, NOW, () => 0.5);
  expect(repos.engagements.byStatus('scheduled')).toHaveLength(0);
  expect(repos.engagements.byStatus('queued')).toHaveLength(3);
});

test('nothing is planned while paused', () => {
  addEngagement(1);
  repos.settings.update({ paused: 1 });
  planAndAssignToday(repos, NOW, () => 0.5);
  expect(repos.engagements.byStatus('queued')).toHaveLength(1);
});

/**
 * The zero-draw property, tested DIRECTLY.
 *
 * planAndAssignToday shares one rng across every queue, so a queue that plans nothing must
 * draw nothing or it shifts every later queue's schedule. plan-queue-regression.test.ts locks
 * that for invites and messages, but it CANNOT lock it for engagements: planEngagements runs
 * last, so nothing downstream would move and the snapshots stay green either way. (Verified
 * by mutation: adding an unconditional `rng()` to planEngagements leaves all four snapshots
 * passing.) Hence these two counting-rng tests — they are the only thing holding the
 * invariant for this queue, and they keep holding it if a fifth pipeline is ever appended.
 */
test('an engagement queue with no work costs zero rng draws', () => {
  let draws = 0;
  planAndAssignToday(repos, NOW, () => { draws++; return 0.5; });
  expect(draws).toBe(0);
});

test('an engagement queue held entirely by the comment cap costs zero rng draws', () => {
  repos.settings.update({ engage_comment_daily_cap: 0 });
  for (let i = 1; i <= 3; i++) addEngagement(i, 'hi');
  let draws = 0;
  planAndAssignToday(repos, NOW, () => { draws++; return 0.5; });
  expect(draws).toBe(0);
});

test('requeueOverdue returns a stale engagement slot to the queue', () => {
  const e = addEngagement(1);
  repos.engagements.setScheduled(e.id, '2026-08-03T07:00:00.000Z');
  requeueOverdue(repos, new Date('2026-08-03T09:00:00.000Z'));
  const row = repos.engagements.findById(e.id)!;
  expect(row.status).toBe('queued');
  expect(row.scheduled_for).toBeNull();
});

test('requeueOverdue leaves a slot inside the grace period alone', () => {
  const e = addEngagement(1);
  repos.engagements.setScheduled(e.id, '2026-08-03T08:58:00.000Z');
  requeueOverdue(repos, new Date('2026-08-03T09:00:00.000Z'));
  expect(repos.engagements.findById(e.id)!.status).toBe('scheduled');
});

test('resortSchedule re-flows every scheduled engagement', () => {
  for (let i = 1; i <= 4; i++) addEngagement(i);
  planAndAssignToday(repos, NOW, () => 0.5);
  const before = repos.engagements.byStatus('scheduled').map((e) => e.scheduled_for);
  resortSchedule(repos, NOW, () => 0.9);
  const after = repos.engagements.byStatus('scheduled').map((e) => e.scheduled_for);
  expect(after).toHaveLength(4);
  expect(after).not.toEqual(before);
});
