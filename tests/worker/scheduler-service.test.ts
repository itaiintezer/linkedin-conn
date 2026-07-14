import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { planAndAssignToday, requeueOverdue, resortSchedule } from '../../src/worker/scheduler-service.js';

let repos: Repos;
beforeEach(() => { repos = new Repos(openDatabase(':memory:')); });

test('moves queued profiles to scheduled with future timestamps within today', () => {
  const c = repos.cohorts.create('A', 'hi', true);
  for (let i = 0; i < 12; i++) repos.profiles.add(c.id, `https://www.linkedin.com/in/p${i}`, null);
  const now = new Date('2026-06-29T08:00:00');
  const seq = [0.1, 0.3, 0.5, 0.7];
  planAndAssignToday(repos, now, () => seq[Math.floor(Math.random() * seq.length)]);
  const scheduled = repos.profiles.byStatus('scheduled');
  expect(scheduled.length).toBe(12);
  for (const p of scheduled) expect(p.scheduled_for).not.toBeNull();
  expect(repos.profiles.byStatus('queued')).toHaveLength(0);
});

test('does not schedule beyond remaining weekly capacity', () => {
  const c = repos.cohorts.create('A', 'hi', true);
  for (let i = 0; i < 5; i++) repos.profiles.add(c.id, `https://www.linkedin.com/in/p${i}`, null);
  repos.settings.update({ weekly_cap: 2 });
  planAndAssignToday(repos, new Date('2026-06-29T08:00:00'));
  expect(repos.profiles.byStatus('scheduled').length).toBe(2);
  expect(repos.profiles.byStatus('queued').length).toBe(3);
});

test('after working hours: leaves profiles queued (never schedules off-hours)', () => {
  const c = repos.cohorts.create('A', 'hi', true);
  repos.profiles.add(c.id, 'https://www.linkedin.com/in/p', null);
  const now = new Date('2026-06-29T23:00:00'); // Monday 11pm, after the 8-20 window
  planAndAssignToday(repos, now, () => 0.5);
  expect(repos.profiles.byStatus('scheduled')).toHaveLength(0);
  expect(repos.profiles.byStatus('queued')).toHaveLength(1);
});

test('before working hours: schedules within today\'s window', () => {
  const c = repos.cohorts.create('A', 'hi', true);
  for (let i = 0; i < 3; i++) repos.profiles.add(c.id, `https://www.linkedin.com/in/p${i}`, null);
  planAndAssignToday(repos, new Date('2026-06-29T06:00:00'), () => 0.5);
  const scheduled = repos.profiles.byStatus('scheduled');
  expect(scheduled).toHaveLength(3);
  for (const p of scheduled) {
    const h = new Date(p.scheduled_for!).getHours(); // round-trips to the same local hour
    expect(h).toBeGreaterThanOrEqual(8);
    expect(h).toBeLessThan(20);
  }
});

test('inside window with no future random slot: stays within the window, not off-hours', () => {
  const c = repos.cohorts.create('A', 'hi', true);
  repos.profiles.add(c.id, 'https://www.linkedin.com/in/p', null);
  const now = new Date('2026-06-29T15:00:00'); // 3pm
  // rng=0 => every planned slot is at 08:00 (before now) => fallback path
  planAndAssignToday(repos, now, () => 0);
  const scheduled = repos.profiles.byStatus('scheduled');
  expect(scheduled).toHaveLength(1);
  const t = new Date(scheduled[0].scheduled_for!);
  expect(t.getTime()).toBeGreaterThanOrEqual(now.getTime());
  expect(t.getHours()).toBeLessThan(20);
});

test('caps scheduling at batches_per_day * batch_size per day (default 20)', () => {
  const c = repos.cohorts.create('A', 'hi', true);
  for (let i = 0; i < 50; i++) repos.profiles.add(c.id, `https://www.linkedin.com/in/p${i}`, null);
  let i = 0; const seq = [0.1, 0.35, 0.6, 0.85]; // four distinct future slots
  planAndAssignToday(repos, new Date('2026-06-29T08:00:00'), () => seq[(i++) % seq.length]);
  expect(repos.profiles.byStatus('scheduled').length).toBe(20); // 4 batches * 5, not 50
  expect(repos.profiles.byStatus('queued').length).toBe(30);
});

test('never puts more than batch_size profiles in a single time slot', () => {
  const c = repos.cohorts.create('A', 'hi', true);
  for (let i = 0; i < 50; i++) repos.profiles.add(c.id, `https://www.linkedin.com/in/p${i}`, null);
  let i = 0; const seq = [0.1, 0.35, 0.6, 0.85];
  planAndAssignToday(repos, new Date('2026-06-29T08:00:00'), () => seq[(i++) % seq.length]);
  const counts: Record<string, number> = {};
  for (const p of repos.profiles.byStatus('scheduled')) {
    counts[p.scheduled_for!] = (counts[p.scheduled_for!] ?? 0) + 1;
  }
  for (const k of Object.keys(counts)) expect(counts[k]).toBeLessThanOrEqual(5);
});

test('a late-day run never dumps the weekly remainder onto one slot', () => {
  const c = repos.cohorts.create('A', 'hi', true);
  for (let i = 0; i < 90; i++) repos.profiles.add(c.id, `https://www.linkedin.com/in/p${i}`, null);
  // 3pm with rng=0: every planned slot lands at 08:00 (past) -> single fallback future slot.
  planAndAssignToday(repos, new Date('2026-06-29T15:00:00'), () => 0);
  const scheduled = repos.profiles.byStatus('scheduled');
  expect(scheduled.length).toBeLessThanOrEqual(5); // batch_size, not ~90
});

test('re-running the planner the same day does not exceed the daily cap', () => {
  const c = repos.cohorts.create('A', 'hi', true);
  for (let i = 0; i < 50; i++) repos.profiles.add(c.id, `https://www.linkedin.com/in/p${i}`, null);
  const run = () => {
    let i = 0; const seq = [0.1, 0.35, 0.6, 0.85];
    planAndAssignToday(repos, new Date('2026-06-29T08:00:00'), () => seq[(i++) % seq.length]);
  };
  run(); run(); run();
  expect(repos.profiles.byStatus('scheduled').length).toBe(20); // still 20, not 60
});

test('planAndAssignToday does nothing while paused', () => {
  const c = repos.cohorts.create('A', 'hi', true);
  repos.profiles.add(c.id, 'https://www.linkedin.com/in/p', null);
  repos.settings.update({ paused: 1 });
  planAndAssignToday(repos, new Date('2026-06-29T08:00:00'), () => 0.5);
  expect(repos.profiles.byStatus('scheduled')).toHaveLength(0);
  expect(repos.profiles.byStatus('queued')).toHaveLength(1);
});

test('planAndAssignToday does nothing while the guardrail is tripped', () => {
  const c = repos.cohorts.create('A', 'hi', true);
  repos.profiles.add(c.id, 'https://www.linkedin.com/in/p', null);
  repos.appState.trip('checkpoint', 'x', '2026-06-29T00:00:00.000Z');
  planAndAssignToday(repos, new Date('2026-06-29T08:00:00'), () => 0.5);
  expect(repos.profiles.byStatus('scheduled')).toHaveLength(0);
});

test('requeueOverdue returns stale scheduled profiles to queued', () => {
  const c = repos.cohorts.create('A', 'hi', true);
  const p = repos.profiles.add(c.id, 'https://www.linkedin.com/in/p', null);
  repos.profiles.setScheduled(p.id, '2026-06-29T09:00:00.000Z');
  const n = requeueOverdue(repos, new Date('2026-06-29T10:00:00Z')); // 60 min overdue > grace
  expect(n).toBe(1);
  const row = repos.profiles.findById(p.id)!;
  expect(row.status).toBe('queued');
  expect(row.scheduled_for).toBeNull();
});

test('requeueOverdue leaves items within the grace period scheduled', () => {
  const c = repos.cohorts.create('A', 'hi', true);
  const p = repos.profiles.add(c.id, 'https://www.linkedin.com/in/p', null);
  repos.profiles.setScheduled(p.id, '2026-06-29T09:00:00.000Z');
  const n = requeueOverdue(repos, new Date('2026-06-29T09:05:00Z')); // 5 min < 10 min grace
  expect(n).toBe(0);
  expect(repos.profiles.findById(p.id)!.status).toBe('scheduled');
});

test('requeueOverdue ignores future-scheduled profiles', () => {
  const c = repos.cohorts.create('A', 'hi', true);
  const p = repos.profiles.add(c.id, 'https://www.linkedin.com/in/p', null);
  repos.profiles.setScheduled(p.id, '2026-06-29T15:00:00.000Z');
  expect(requeueOverdue(repos, new Date('2026-06-29T10:00:00Z'))).toBe(0);
  expect(repos.profiles.findById(p.id)!.status).toBe('scheduled');
});

test('planAndAssignToday schedules higher-priority queued profiles first', () => {
  const c = repos.cohorts.create('Prio', null, true);
  const a = repos.profiles.add(c.id, 'https://www.linkedin.com/in/a', null);
  const b = repos.profiles.add(c.id, 'https://www.linkedin.com/in/b', null);
  repos.profiles.setPriority(b.id, -5); // b should be scheduled before a
  repos.settings.update({ weekly_cap: 1, batch_size: 1, batches_per_day: 1 });
  // 2026-07-01 is a Wednesday, mid-window (09:00) so exactly one slot exists.
  planAndAssignToday(repos, new Date('2026-07-01T09:00:00'), () => 0.5);
  expect(repos.profiles.findById(b.id)!.status).toBe('scheduled');
  expect(repos.profiles.findById(a.id)!.status).toBe('queued');
});

test('planAndAssignToday requeues stale scheduled so they do not suppress the daily budget', () => {
  const c = repos.cohorts.create('A', 'hi', true);
  // 25 stale scheduled rows (a day overdue) would inflate committedToday past the daily target (20)
  for (let i = 0; i < 25; i++) {
    const p = repos.profiles.add(c.id, `https://www.linkedin.com/in/stale${i}`, null);
    repos.profiles.setScheduled(p.id, '2026-06-28T09:00:00.000Z');
  }
  // plus fresh queued work
  for (let i = 0; i < 10; i++) repos.profiles.add(c.id, `https://www.linkedin.com/in/q${i}`, null);
  let i = 0; const seq = [0.1, 0.35, 0.6, 0.85];
  planAndAssignToday(repos, new Date('2026-06-29T09:00:00'), () => seq[(i++) % seq.length]);
  // Without the fold: committedToday=25 -> daily budget 0 -> nothing scheduled.
  // With the fold: the 25 stale rows are requeued first, so the full daily target flows.
  expect(repos.profiles.byStatus('scheduled').length).toBe(20);
});

test('resortSchedule rebuilds all scheduled slots to policy (batch size preserved)', () => {
  const c = repos.cohorts.create('A', 'hi', true);
  // 30 profiles crammed into a single future slot (a bad/legacy plan)
  for (let i = 0; i < 30; i++) {
    const p = repos.profiles.add(c.id, `https://www.linkedin.com/in/p${i}`, null);
    repos.profiles.setScheduled(p.id, '2026-06-29T18:00:00.000Z');
  }
  let i = 0; const seq = [0.1, 0.35, 0.6, 0.85];
  resortSchedule(repos, new Date('2026-06-29T08:00:00'), () => seq[(i++) % seq.length]);
  const scheduled = repos.profiles.byStatus('scheduled');
  expect(scheduled.length).toBe(20);                          // daily target: 4 batches * 5, not 30
  expect(repos.profiles.byStatus('queued').length).toBe(10);
  const counts: Record<string, number> = {};
  for (const p of scheduled) counts[p.scheduled_for!] = (counts[p.scheduled_for!] ?? 0) + 1;
  for (const k of Object.keys(counts)) expect(counts[k]).toBeLessThanOrEqual(5); // batch_size
});

test('resortSchedule preserves priority order across a rebuild', () => {
  const c = repos.cohorts.create('Prio', null, true);
  const a = repos.profiles.add(c.id, 'https://www.linkedin.com/in/a', null);
  const b = repos.profiles.add(c.id, 'https://www.linkedin.com/in/b', null);
  repos.profiles.setScheduled(a.id, '2026-07-01T09:00:00.000Z');
  repos.profiles.setScheduled(b.id, '2026-07-01T09:00:00.000Z');
  repos.profiles.setPriority(b.id, -5); // higher priority (lower number) wins the single slot
  repos.settings.update({ weekly_cap: 1, batch_size: 1, batches_per_day: 1 });
  resortSchedule(repos, new Date('2026-07-01T09:00:00'), () => 0.5);
  expect(repos.profiles.findById(b.id)!.status).toBe('scheduled');
  expect(repos.profiles.findById(a.id)!.status).toBe('queued');
});

test('resortSchedule after a mid-day restart honours sends already made today', () => {
  const c = repos.cohorts.create('A', 'hi', true);
  // 18 already sent today -> only 2 of today's target of 20 remain
  for (let i = 0; i < 18; i++) {
    const p = repos.profiles.add(c.id, `https://www.linkedin.com/in/sent${i}`, null);
    repos.profiles.setStatus(p.id, 'sent', { sent_at: new Date('2026-06-29T08:30:00').toISOString() });
  }
  for (let i = 0; i < 30; i++) repos.profiles.add(c.id, `https://www.linkedin.com/in/q${i}`, null);
  let i = 0; const seq = [0.1, 0.35, 0.6, 0.85];
  resortSchedule(repos, new Date('2026-06-29T09:00:00'), () => seq[(i++) % seq.length]);
  expect(repos.profiles.byStatus('scheduled').length).toBe(2); // 20 target - 18 sent today
});

test('resortSchedule while paused requeues everything but schedules nothing', () => {
  const c = repos.cohorts.create('A', 'hi', true);
  for (let i = 0; i < 5; i++) {
    const p = repos.profiles.add(c.id, `https://www.linkedin.com/in/p${i}`, null);
    repos.profiles.setScheduled(p.id, '2026-06-29T18:00:00.000Z');
  }
  repos.settings.update({ paused: 1 });
  resortSchedule(repos, new Date('2026-06-29T08:00:00'), () => 0.5);
  expect(repos.profiles.byStatus('scheduled')).toHaveLength(0);
  expect(repos.profiles.byStatus('queued')).toHaveLength(5);
});
