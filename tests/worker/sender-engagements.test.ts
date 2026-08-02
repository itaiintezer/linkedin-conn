import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { FakeDriver } from '../../src/browser/driver.js';
import { runSenderOnce, type SenderOptions } from '../../src/worker/sender.js';
import { recoverOrphanedEngagements, resortSchedule } from '../../src/worker/scheduler-service.js';

let repos: Repos; let driver: FakeDriver;
beforeEach(() => {
  repos = new Repos(openDatabase(':memory:'));
  driver = new FakeDriver();
  repos.appState.setLogin({ loggedIn: true, cookieExpiry: null }, '2026-08-03T00:00:00.000Z');
});

function run(now: Date, opts: SenderOptions = {}) {
  return runSenderOnce(repos, driver, now, { sleep: async () => {}, ...opts });
}

// Local-clock 10:00 on a Monday, so the working-hours guard passes in any timezone.
const NOW = new Date('2026-08-03T10:00:00');
// Due times are derived from NOW rather than written as a literal UTC instant: a literal
// would be "an hour ago" only on a machine near UTC, and would fall AFTER now (i.e. not due,
// and the whole file silently green-for-nothing) anywhere east of it.
const DUE = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
const REACTED_EARLIER = new Date(NOW.getTime() - 30 * 60 * 1000).toISOString();

function seed(n: number, comment: string | null = null, reaction = 'insightful') {
  const url = `https://www.linkedin.com/feed/update/urn:li:activity:${n}/`;
  const e = repos.engagements.add(url, `urn:li:activity:${n}`, reaction as never, comment);
  repos.engagements.setScheduled(e.id, DUE);
  return { ...e, url };
}

test('a reaction-only task reacts, is marked sent, and stamps reacted_at', async () => {
  const e = seed(1);
  await run(NOW);
  expect(driver.reactLog).toEqual([{ url: e.url, reaction: 'insightful' }]);
  const row = repos.engagements.findById(e.id)!;
  expect(row.status).toBe('sent');
  expect(row.reacted_at).not.toBeNull();
  expect(row.commented_at).toBeNull();
  expect(row.attempts).toBe(1);
});

test('a comment task reacts FIRST, then comments, and stamps both', async () => {
  const e = seed(1, 'great post');
  await run(NOW);
  expect(driver.reactLog).toHaveLength(1);
  expect(driver.commentLog).toEqual([{ url: e.url, text: 'great post' }]);
  const row = repos.engagements.findById(e.id)!;
  expect(row.status).toBe('sent');
  expect(row.reacted_at).not.toBeNull();
  expect(row.commented_at).not.toBeNull();
});

test('the reaction and the comment are paced apart — two LinkedIn contacts', async () => {
  seed(1, 'hi');
  let sleeps = 0;
  await run(NOW, { sleep: async () => { sleeps++; }, rng: () => 0.5 });
  expect(sleeps).toBe(1);
});

test('already: the existing reaction is kept, not replaced, and the task completes', async () => {
  const e = seed(1);
  driver.reactScripted.set(e.url, 'already');
  driver.existingReaction = 'celebrate';
  await run(NOW);
  const row = repos.engagements.findById(e.id)!;
  expect(row.status).toBe('sent');
  expect(row.reacted_at).not.toBeNull();
  expect(row.reaction).toBe('insightful'); // the row is not rewritten
});

test('not_found: terminal skip, no failure streak', async () => {
  const e = seed(1);
  driver.reactScripted.set(e.url, 'not_found');
  await run(NOW);
  const row = repos.engagements.findById(e.id)!;
  expect(row.status).toBe('skipped');
  expect(row.skip_reason).toBe('not_found');
  expect(repos.appState.get().failure_streak).toBe(0);
});

test('unavailable: skip that DOES count toward the failure streak', async () => {
  const e = seed(1);
  driver.reactScripted.set(e.url, 'unavailable');
  await run(NOW);
  const row = repos.engagements.findById(e.id)!;
  expect(row.status).toBe('skipped');
  expect(row.skip_reason).toBe('unavailable');
  expect(repos.appState.get().failure_streak).toBe(1);
});

test('comments_disabled: the reaction is kept and reported, the task skips', async () => {
  const e = seed(1, 'hello');
  driver.commentScripted.set(e.url, 'comments_disabled');
  await run(NOW);
  const row = repos.engagements.findById(e.id)!;
  expect(row.status).toBe('skipped');
  expect(row.skip_reason).toBe('comments_disabled');
  expect(row.reacted_at).not.toBeNull();   // the reaction landed and is not lost
  expect(row.commented_at).toBeNull();
  expect(repos.appState.get().failure_streak).toBe(0);
});

test('an unverified comment parks for the operator and is never auto-retried', async () => {
  const e = seed(1, 'hello');
  driver.commentScripted.set(e.url, 'unverified');
  await run(NOW);
  const row = repos.engagements.findById(e.id)!;
  expect(row.status).toBe('needs_attention');
  expect(row.reacted_at).not.toBeNull();
  expect(row.commented_at).toBeNull();
  expect(row.last_error).toMatch(/may have posted/);
});

test('a checkpoint during a reaction trips the shared guardrail and halts', async () => {
  const e = seed(1);
  driver.reactScripted.set(e.url, 'checkpoint');
  await run(NOW);
  expect(repos.appState.get().guardrail_tripped).toBe(1);
  expect(repos.engagements.findById(e.id)!.status).toBe('needs_attention');
});

test('the weekly cap clamps the batch', async () => {
  for (let i = 1; i <= 4; i++) seed(i);
  repos.settings.update({ engage_weekly_cap: 2 });
  await run(NOW);
  expect(driver.reactLog).toHaveLength(2);
});

test('the daily comment cap holds a comment task WHOLE — it does not react alone', async () => {
  repos.settings.update({ engage_comment_daily_cap: 0 });
  const e = seed(1, 'hi');
  await run(NOW);
  expect(driver.reactLog).toHaveLength(0);
  expect(driver.commentLog).toHaveLength(0);
  expect(repos.engagements.findById(e.id)!.status).toBe('scheduled');
});

test('a retried task whose reaction already landed does not react twice', async () => {
  const e = seed(1, 'hi');
  repos.engagements.setStatus(e.id, 'scheduled', { reacted_at: REACTED_EARLIER });
  await run(NOW);
  expect(driver.reactLog).toHaveLength(0);
  expect(driver.commentLog).toHaveLength(1);
  expect(repos.engagements.findById(e.id)!.status).toBe('sent');
});

test('the row is reconciled to the URN the live post reports', async () => {
  const e = seed(1);
  driver.observedUrn = 'urn:li:activity:9999999999999999999';
  await run(NOW);
  expect(repos.engagements.findById(e.id)!.post_urn).toBe('urn:li:activity:9999999999999999999');
});

test('a row that reconciles onto an already-engaged post is retired, not engaged twice', async () => {
  const canonical = repos.engagements.add('u-canon', 'urn:li:activity:5555', 'like', null);
  repos.engagements.setStatus(canonical.id, 'sent', { reacted_at: REACTED_EARLIER });
  const dupe = seed(1, 'hi');
  driver.observedUrn = 'urn:li:activity:5555';
  await run(NOW);
  const row = repos.engagements.findById(dupe.id)!;
  expect(row.status).toBe('skipped');
  expect(row.skip_reason).toBe('dismissed');
  expect(driver.commentLog).toHaveLength(0); // never got as far as commenting
});

test('engagements run AFTER invites and messages in one tick', async () => {
  const c = repos.cohorts.create('A', 'hi', true, 'invite');
  const p = repos.profiles.add(c.id, 'https://www.linkedin.com/in/a', null, 'invite');
  repos.profiles.setScheduled(p.id, DUE);
  seed(1);
  await run(NOW);
  expect(driver.sentLog).toHaveLength(1);
  expect(driver.reactLog).toHaveLength(1);
});

test('a halt in the invite pass stops engagements from running at all', async () => {
  const c = repos.cohorts.create('A', 'hi', true, 'invite');
  const p = repos.profiles.add(c.id, 'https://www.linkedin.com/in/a', null, 'invite');
  repos.profiles.setScheduled(p.id, DUE);
  driver.scripted.set('https://www.linkedin.com/in/a', 'checkpoint');
  seed(1);
  await run(NOW);
  expect(driver.reactLog).toHaveLength(0);
  expect(repos.engagements.findById(1)!.status).toBe('scheduled');
});

test('a halt in the MESSAGE pass stops engagements from running', async () => {
  // The message pass's return value was previously discarded — nothing followed it. With a
  // third pass behind it, a checkpoint there must stop the tick, not just that pass.
  const c = repos.cohorts.create('M', 'hi', true, 'message');
  const p = repos.profiles.add(c.id, 'https://www.linkedin.com/in/m', null, 'message');
  repos.profiles.setScheduled(p.id, DUE);
  driver.msgScripted.set('https://www.linkedin.com/in/m', 'checkpoint');
  seed(1);
  await run(NOW);
  expect(driver.msgLog).toHaveLength(1);
  expect(driver.reactLog).toHaveLength(0);
  expect(repos.engagements.findById(1)!.status).toBe('scheduled');
});

test('nothing due in any pipeline: the browser is never opened', async () => {
  await run(NOW);
  expect(driver.browserOpen()).toBe(false);
});

test('nothing runs while paused', async () => {
  seed(1);
  repos.settings.update({ paused: 1 });
  await run(NOW);
  expect(driver.reactLog).toHaveLength(0);
});

// --- Pacing: a task that never contacts LinkedIn must not cost a delay -----------------
// Mirrors the "message row with no text" case in sender.test.ts: the pacing guarantee is
// about consecutive LinkedIn CONTACTS, so a step we skip (a reaction already landed on an
// earlier tick) must not be paced as though it happened.

test('a reaction-only task whose reaction already landed completes without contacting LinkedIn', async () => {
  const e = seed(1);
  repos.engagements.setStatus(e.id, 'scheduled', { reacted_at: REACTED_EARLIER });
  const other = seed(2);
  let sleeps = 0;
  await run(NOW, { sleep: async () => { sleeps++; } });
  expect(driver.reactLog).toEqual([{ url: other.url, reaction: 'insightful' }]);
  expect(repos.engagements.findById(e.id)!.status).toBe('sent');
  // Row 1 touched nothing, so the only contact in the tick is row 2's reaction: no gap.
  expect(sleeps).toBe(0);
});

test('a resumed comment does not pay the reaction gap it never spent', async () => {
  const e = seed(1, 'hi');
  repos.engagements.setStatus(e.id, 'scheduled', { reacted_at: REACTED_EARLIER });
  let sleeps = 0;
  await run(NOW, { sleep: async () => { sleeps++; } });
  expect(driver.commentLog).toHaveLength(1);
  expect(sleeps).toBe(0); // the comment is the tick's first contact — nothing to pace from
});

test('a no-op engagement does not reset a live failure streak', async () => {
  // recordSuccess clears the guardrail's failure streak. A row that completed without
  // touching LinkedIn is no evidence the browser is healthy, so it must not clear it.
  const e = seed(1);
  repos.engagements.setStatus(e.id, 'scheduled', { reacted_at: REACTED_EARLIER });
  repos.appState.incFailureStreak();
  repos.appState.incFailureStreak();
  await run(NOW);
  expect(repos.engagements.findById(e.id)!.status).toBe('sent');
  expect(repos.appState.get().failure_streak).toBe(2);
});

test('a genuine reaction DOES reset the failure streak', async () => {
  seed(1);
  repos.appState.incFailureStreak();
  repos.appState.incFailureStreak();
  await run(NOW);
  expect(repos.appState.get().failure_streak).toBe(0);
});

// --- Crash recovery --------------------------------------------------------------------
// The sender marks a row 'sending' before driving the browser, so an abrupt exit strands it
// there forever. Recovery has to GUESS from the timestamps, and the guess is three-way
// because a duplicate Like is free while a duplicate published comment is not.

test('crash before the reaction: requeue — a repeated Like is idempotent', () => {
  const e = seed(1, 'hi');
  repos.engagements.setStatus(e.id, 'sending', {});
  recoverOrphanedEngagements(repos);
  const row = repos.engagements.findById(e.id)!;
  expect(row.status).toBe('queued');
  expect(row.scheduled_for).toBeNull();
});

test('crash after a reaction-only task reacted: it provably finished', () => {
  const e = seed(1);
  repos.engagements.setStatus(e.id, 'sending', { reacted_at: REACTED_EARLIER });
  recoverOrphanedEngagements(repos);
  expect(repos.engagements.findById(e.id)!.status).toBe('sent');
});

test('crash straddling the comment: park, never requeue', () => {
  const e = seed(1, 'hi');
  repos.engagements.setStatus(e.id, 'sending', { reacted_at: REACTED_EARLIER });
  recoverOrphanedEngagements(repos);
  const row = repos.engagements.findById(e.id)!;
  expect(row.status).toBe('needs_attention');
  expect(row.last_error).toMatch(/may have posted/);
});

test('crash after everything landed: mark sent', () => {
  const e = seed(1, 'hi');
  repos.engagements.setStatus(e.id, 'sending', {
    reacted_at: REACTED_EARLIER, commented_at: REACTED_EARLIER,
  });
  recoverOrphanedEngagements(repos);
  expect(repos.engagements.findById(e.id)!.status).toBe('sent');
});

test('rows not in sending are untouched', () => {
  const e = seed(1);
  recoverOrphanedEngagements(repos);
  expect(repos.engagements.findById(e.id)!.status).toBe('scheduled');
});

test('the requeued attempt is not refunded — attempts stays where the sender left it', () => {
  // Mirrors recoverOrphanedSending: the attempt WAS consumed, so the count must not be
  // rewound. Rewinding it would hide a crash-loop from the attention view entirely.
  const e = seed(1);
  repos.engagements.setStatus(e.id, 'sending', { attempts: 1 });
  recoverOrphanedEngagements(repos);
  const row = repos.engagements.findById(e.id)!;
  expect(row.status).toBe('queued');
  expect(row.attempts).toBe(1);
});

test('a requeued row is re-planned into a slot rather than left stranded in queued', () => {
  // Recovery only returns the row to the queue; something must then give it a slot, or the
  // rescue is cosmetic. resortSchedule is what start() runs immediately afterwards.
  const e = seed(1);
  repos.engagements.setStatus(e.id, 'sending', {});
  recoverOrphanedEngagements(repos);
  resortSchedule(repos, NOW, () => 0.5);
  const row = repos.engagements.findById(e.id)!;
  expect(row.status).toBe('scheduled');
  expect(row.scheduled_for).not.toBeNull();
});

test('resortSchedule cannot undo a parked recovery', () => {
  // resortSchedule requeues EVERY scheduled row. A parked (or completed) recovery must be
  // out of its reach, or the startup re-sort would hand a maybe-published comment straight
  // back to the sender.
  const parked = seed(1, 'hi');
  repos.engagements.setStatus(parked.id, 'sending', { reacted_at: REACTED_EARLIER });
  const done = seed(2);
  repos.engagements.setStatus(done.id, 'sending', { reacted_at: REACTED_EARLIER });
  recoverOrphanedEngagements(repos);
  resortSchedule(repos, NOW, () => 0.5);
  expect(repos.engagements.findById(parked.id)!.status).toBe('needs_attention');
  expect(repos.engagements.findById(done.id)!.status).toBe('sent');
});

test('the unreachable fourth state (commented but never reacted) requeues without re-commenting', async () => {
  // Nothing writes commented_at without reacted_at today. If a future path ever did, the
  // reacted_at===null branch claims it — and that is the safe landing: the sender's own
  // comment guard is `commented_at === null`, so the replay reacts and stops.
  const e = seed(1, 'hi');
  repos.engagements.setStatus(e.id, 'sending', { commented_at: REACTED_EARLIER });
  recoverOrphanedEngagements(repos);
  expect(repos.engagements.findById(e.id)!.status).toBe('queued');
  repos.engagements.setScheduled(e.id, DUE); // stand in for the planner, minus its slot maths
  await run(NOW);
  expect(driver.reactLog).toHaveLength(1);
  expect(driver.commentLog).toHaveLength(0); // never re-published
});
