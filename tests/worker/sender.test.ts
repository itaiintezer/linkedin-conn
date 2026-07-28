import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { FakeDriver } from '../../src/browser/driver.js';
import { runSenderOnce, type SenderOptions } from '../../src/worker/sender.js';

let repos: Repos; let driver: FakeDriver;
beforeEach(() => {
  repos = new Repos(openDatabase(':memory:'));
  driver = new FakeDriver();
  repos.appState.setLogin({ loggedIn: true, cookieExpiry: null }, '2026-06-29T00:00:00.000Z');
});

// Shared call helper: injects a no-op sleep by default so the suite never actually waits
// the 20-90s the default min_delay_ms/max_delay_ms settings imply. Tests that care about
// the delay itself (below) override `sleep`/`rng` explicitly via opts.
function run(now: Date, opts: SenderOptions = {}) {
  return runSenderOnce(repos, driver, now, { sleep: async () => {}, ...opts });
}

function seedScheduled(url: string, whenIso: string, cohortId: number) {
  const p = repos.profiles.add(cohortId, url, null);
  repos.profiles.setScheduled(p.id, whenIso);
  return p;
}

test('sends due profiles, records sent status + event, respects remaining cap', async () => {
  const c = repos.cohorts.create('A', 'Hi {firstName}', true);
  seedScheduled('https://www.linkedin.com/in/a', '2026-06-29T09:00:00.000Z', c.id);
  seedScheduled('https://www.linkedin.com/in/b', '2026-06-29T09:00:00.000Z', c.id);

  const now = new Date('2026-06-29T10:00:00Z');
  await run(now);

  expect(driver.sentLog).toHaveLength(2);
  expect(driver.sentLog[0].message).toBe('Hi Test'); // driver substitutes the live name it reads ('Test')
  expect(repos.profiles.byStatus('sent')).toHaveLength(2);
  expect(repos.events.countSentSince('1970-01-01T00:00:00Z', 'invite')).toBe(2);
});

test('already-connected -> skipped with reason, not counted as sent', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  const p = seedScheduled('https://www.linkedin.com/in/a', '2026-06-29T09:00:00.000Z', c.id);
  driver.scripted.set('https://www.linkedin.com/in/a', 'already');
  await run(new Date('2026-06-29T10:00:00Z'));
  const row = repos.profiles.findById(p.id)!;
  expect(row.status).toBe('skipped');
  expect(row.skip_reason).toBe('already_connected');
  expect(row.last_error).toBeNull();
  expect(repos.events.countSentSince('1970-01-01T00:00:00Z', 'invite')).toBe(0);
});

test('email_required -> skipped with reason, terminal, no failure streak', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  const p = seedScheduled('https://www.linkedin.com/in/a', '2026-06-29T09:00:00.000Z', c.id);
  driver.scripted.set('https://www.linkedin.com/in/a', 'email_required');
  await run(new Date('2026-06-29T10:00:00Z'));
  const row = repos.profiles.findById(p.id)!;
  expect(row.status).toBe('skipped');
  expect(row.skip_reason).toBe('email_required');
  expect(row.last_error).toBeNull();
  // A per-profile verdict, not an automation failure: streak untouched, no guardrail.
  expect(repos.appState.get().failure_streak).toBe(0);
  expect(repos.appState.get().guardrail_tripped).toBe(0);
  expect(repos.events.countSentSince('1970-01-01T00:00:00Z', 'invite')).toBe(0);
});

test('not_found -> skipped with reason not_found, terminal, no failure streak', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  const p = seedScheduled('https://www.linkedin.com/in/a', '2026-06-29T09:00:00.000Z', c.id);
  driver.scripted.set('https://www.linkedin.com/in/a', 'not_found');
  await run(new Date('2026-06-29T10:00:00Z'));
  const row = repos.profiles.findById(p.id)!;
  expect(row.status).toBe('skipped');
  expect(row.skip_reason).toBe('not_found');
  expect(row.last_error).toBeNull();
  // A dead profile URL is a per-profile verdict, not an automation failure:
  // streak untouched, no guardrail (three dead imports in a row must not halt).
  expect(repos.appState.get().failure_streak).toBe(0);
  expect(repos.appState.get().guardrail_tripped).toBe(0);
  expect(repos.events.countSentSince('1970-01-01T00:00:00Z', 'invite')).toBe(0);
});

test('unavailable evidence flows into the guardrail detail when the streak trips', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  for (const slug of ['a', 'b', 'c']) {
    seedScheduled(`https://www.linkedin.com/in/${slug}`, '2026-06-29T09:00:00.000Z', c.id);
    driver.scripted.set(`https://www.linkedin.com/in/${slug}`, 'unavailable');
  }
  driver.evidence = {
    pageUrl: 'https://www.linkedin.com/preload/custom-invite/?vanityName=c',
    screenshot: '2026-07-27T15-15-08-composer-unavailable.png',
  };
  await run(new Date('2026-06-29T10:00:00Z'));
  const st = repos.appState.get();
  expect(st.guardrail_tripped).toBe(1);
  expect(st.guardrail_reason).toBe('repeated_failures');
  expect(st.guardrail_detail).toContain('/incidents/2026-07-27T15-15-08-composer-unavailable.png');
});

test('unavailable -> skipped with reason unavailable (still counts toward failure streak)', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  const p = seedScheduled('https://www.linkedin.com/in/a', '2026-06-29T09:00:00.000Z', c.id);
  driver.scripted.set('https://www.linkedin.com/in/a', 'unavailable');
  await run(new Date('2026-06-29T10:00:00Z'));
  const row = repos.profiles.findById(p.id)!;
  expect(row.status).toBe('skipped');
  expect(row.skip_reason).toBe('unavailable');
  expect(repos.appState.get().failure_streak).toBe(1);
});

test('weekly_limit -> pauses with a clear reason, requeues the profile, stops the batch', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  const p1 = seedScheduled('https://www.linkedin.com/in/a', '2026-06-29T09:00:00.000Z', c.id);
  seedScheduled('https://www.linkedin.com/in/b', '2026-06-29T09:00:00.000Z', c.id);
  driver.scripted.set('https://www.linkedin.com/in/a', 'weekly_limit');
  await run(new Date('2026-06-29T10:00:00Z'));
  // Account-level cap, not an automation failure: amber pause, no red guardrail.
  const s = repos.settings.get();
  expect(s.paused).toBe(1);
  expect(s.pause_reason).toContain('weekly invitation limit');
  expect(repos.appState.get().guardrail_tripped).toBe(0);
  expect(repos.appState.get().failure_streak).toBe(0);
  // The profile could not be sent through no fault of its own: back to the queue.
  expect(repos.profiles.findById(p1.id)!.status).toBe('queued');
  // The batch stops immediately — the next profile is never attempted.
  expect(driver.sentLog).toHaveLength(1);
});

test('checkpoint -> trips guardrail and flags needs_attention', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  seedScheduled('https://www.linkedin.com/in/a', '2026-06-29T09:00:00.000Z', c.id);
  driver.scripted.set('https://www.linkedin.com/in/a', 'checkpoint');
  await run(new Date('2026-06-29T10:00:00Z'));
  expect(repos.appState.get().guardrail_tripped).toBe(1);
  expect(repos.appState.get().guardrail_reason).toBe('checkpoint');
  expect(repos.profiles.byStatus('needs_attention')).toHaveLength(1);
  expect(repos.settings.get().paused).toBe(0); // manual pause untouched
});

test('checkpoint evidence flows into guardrail detail and last_error', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  const p = seedScheduled('https://www.linkedin.com/in/a', '2026-06-29T09:00:00.000Z', c.id);
  driver.scripted.set('https://www.linkedin.com/in/a', 'checkpoint');
  driver.evidence = {
    pageUrl: 'https://www.linkedin.com/checkpoint/challenge/z',
    matched: 'security verification',
    screenshot: '2026-07-02T13-02-44-checkpoint.png',
  };
  await run(new Date('2026-06-29T10:00:00Z'));
  const st = repos.appState.get();
  expect(st.guardrail_detail).toContain('checkpoint/challenge/z');
  expect(st.guardrail_detail).toContain('security verification');
  expect(st.guardrail_detail).toContain('/incidents/2026-07-02T13-02-44-checkpoint.png');
  expect(repos.profiles.findById(p.id)!.last_error).toContain('security verification');
});

test('guardrail trip timestamp is the moment of the trip, not batch start', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  seedScheduled('https://www.linkedin.com/in/a', '2026-06-29T09:00:00.000Z', c.id);
  driver.scripted.set('https://www.linkedin.com/in/a', 'checkpoint');
  const tripAt = new Date('2026-06-29T10:07:33.000Z');
  await run(new Date('2026-06-29T10:00:00Z'), { clock: () => tripAt });
  expect(repos.appState.get().guardrail_tripped_at).toBe('2026-06-29T10:07:33.000Z');
});

test('note_quota with allow_no_note retries bare and sends', async () => {
  const c = repos.cohorts.create('A', 'hi {firstName}', true);
  seedScheduled('https://www.linkedin.com/in/a', '2026-06-29T09:00:00.000Z', c.id);
  let calls = 0;
  driver.sendConnectionRequest = async (url, message) => {
    calls++;
    driver.sentLog.push({ url, message });
    return calls === 1 ? { result: 'note_quota', firstName: 'T' } : { result: 'sent', firstName: 'T' };
  };
  await run(new Date('2026-06-29T10:00:00Z'));
  expect(driver.sentLog[1].message).toBeNull();
  expect(repos.profiles.byStatus('sent')).toHaveLength(1);
  expect(repos.settings.get().note_quota_exhausted).toBe(1);
});

test('outside working hours: due profiles are not sent (window guard)', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  seedScheduled('https://www.linkedin.com/in/a', '2026-06-29T09:00:00.000Z', c.id);
  // local 10pm Monday — after the default 8-20 window
  await run(new Date('2026-06-29T22:00:00'));
  expect(driver.sentLog).toHaveLength(0);
  expect(driver.open).toBe(false); // never opened the browser
});

test('weekend with weekdays_only: due profiles are not sent', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  seedScheduled('https://www.linkedin.com/in/a', '2026-06-27T09:00:00.000Z', c.id);
  await run(new Date('2026-06-28T10:00:00')); // local Sunday
  expect(driver.sentLog).toHaveLength(0);
});

test('force bypasses the window guard (Run batch now)', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  seedScheduled('https://www.linkedin.com/in/a', '2026-06-29T09:00:00.000Z', c.id);
  await run(new Date('2026-06-29T22:00:00'), { force: true });
  expect(driver.sentLog).toHaveLength(1);
  expect(repos.profiles.byStatus('sent')).toHaveLength(1);
});

test('does nothing when paused', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  seedScheduled('https://www.linkedin.com/in/a', '2026-06-29T09:00:00.000Z', c.id);
  repos.settings.update({ paused: 1 });
  await run(new Date('2026-06-29T10:00:00Z'));
  expect(driver.sentLog).toHaveLength(0);
});

test('not logged in (cache): skips without sending and without tripping', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  seedScheduled('https://www.linkedin.com/in/a', '2026-06-29T09:00:00.000Z', c.id);
  repos.appState.setLogin({ loggedIn: false, cookieExpiry: null }, '2026-06-29T00:00:00.000Z');
  await run(new Date('2026-06-29T10:00:00Z'));
  expect(driver.sentLog).toHaveLength(0);
  expect(repos.appState.get().guardrail_tripped).toBe(0);
  expect(repos.settings.get().paused).toBe(0);
});

test('does nothing and never opens the browser when no profile is due', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  // scheduled in the future -> not due yet
  seedScheduled('https://www.linkedin.com/in/a', '2026-06-29T23:00:00.000Z', c.id);
  await run(new Date('2026-06-29T10:00:00Z'));
  expect(driver.sentLog).toHaveLength(0);
  expect(driver.open).toBe(false); // lazy: browser never opened
});

test('skips and trips login_lost when the live check fails despite a stale cache', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  seedScheduled('https://www.linkedin.com/in/a', '2026-06-29T09:00:00.000Z', c.id);
  driver.loggedIn = false; // cache says logged-in (from beforeEach), live read disagrees
  await run(new Date('2026-06-29T10:00:00Z'));
  expect(driver.sentLog).toHaveLength(0);
  expect(repos.appState.get().guardrail_tripped).toBe(1);
  expect(repos.appState.get().guardrail_reason).toBe('login_lost');
  expect(repos.appState.get().login_logged_in).toBe(0); // cache corrected
});

test('does nothing when guardrail is already tripped', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  seedScheduled('https://www.linkedin.com/in/a', '2026-06-29T09:00:00.000Z', c.id);
  repos.appState.trip('checkpoint', 'x', '2026-06-29T00:00:00.000Z');
  await run(new Date('2026-06-29T10:00:00Z'));
  expect(driver.sentLog).toHaveLength(0);
});

test('three consecutive errors trip repeated_failures and stop the batch', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  for (const slug of ['a', 'b', 'c', 'd']) {
    seedScheduled(`https://www.linkedin.com/in/${slug}`, '2026-06-29T09:00:00.000Z', c.id);
    driver.scripted.set(`https://www.linkedin.com/in/${slug}`, 'error');
  }
  await run(new Date('2026-06-29T10:00:00Z'));
  expect(repos.appState.get().guardrail_tripped).toBe(1);
  expect(repos.appState.get().guardrail_reason).toBe('repeated_failures');
  // tripped on the 3rd error -> 4th profile never attempted
  expect(driver.sentLog).toHaveLength(3);
});

test('a success between failures resets the streak (no trip)', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  seedScheduled('https://www.linkedin.com/in/a', '2026-06-29T09:00:00.000Z', c.id);
  seedScheduled('https://www.linkedin.com/in/b', '2026-06-29T09:00:00.000Z', c.id);
  seedScheduled('https://www.linkedin.com/in/c', '2026-06-29T09:00:00.000Z', c.id);
  driver.scripted.set('https://www.linkedin.com/in/a', 'error');
  driver.scripted.set('https://www.linkedin.com/in/b', 'sent');
  driver.scripted.set('https://www.linkedin.com/in/c', 'error');
  await run(new Date('2026-06-29T10:00:00Z'));
  expect(repos.appState.get().guardrail_tripped).toBe(0);
  expect(repos.appState.get().failure_streak).toBe(1);
});

function seedScheduledMsg(url: string, whenIso: string, cohortId: number) {
  const p = repos.profiles.add(cohortId, url, null, 'message');
  repos.profiles.setScheduled(p.id, whenIso);
  return p;
}

test('message pass: sends due message profiles, stamps full_name/thread_url, counts per kind', async () => {
  const c = repos.cohorts.create('M', 'Hey {firstName}', true, 'message');
  seedScheduledMsg('https://www.linkedin.com/in/m1', '2026-06-29T09:00:00.000Z', c.id);
  await run(new Date('2026-06-29T10:00:00Z'));
  expect(driver.msgLog).toHaveLength(1);
  expect(driver.msgLog[0].message).toBe('Hey Test');
  const [p] = repos.profiles.byStatusKind('sent', 'message');
  expect(p.full_name).toBe('Test Person');
  expect(p.thread_url).toContain('/messaging/thread/');
  expect(repos.events.countSentSince('1970-01-01T00:00:00Z', 'message')).toBe(1);
  expect(repos.events.countSentSince('1970-01-01T00:00:00Z', 'invite')).toBe(0);
});

test('message pass: not_connected is a terminal skip that never touches the failure streak', async () => {
  const c = repos.cohorts.create('M', 'hi', true, 'message');
  const p = seedScheduledMsg('https://www.linkedin.com/in/m2', '2026-06-29T09:00:00.000Z', c.id);
  driver.msgScripted.set('https://www.linkedin.com/in/m2', 'not_connected');
  await run(new Date('2026-06-29T10:00:00Z'));
  const row = repos.profiles.findById(p.id)!;
  expect(row.status).toBe('skipped');
  expect(row.skip_reason).toBe('not_connected');
  expect(repos.appState.get().failure_streak).toBe(0);
});

test('message pass: a profile without any message text goes to needs_attention, not to LinkedIn', async () => {
  const c = repos.cohorts.create('M-blank', null, true, 'message'); // no template (API forbids this; engine must still be safe)
  const p = seedScheduledMsg('https://www.linkedin.com/in/m3', '2026-06-29T09:00:00.000Z', c.id);
  await run(new Date('2026-06-29T10:00:00Z'));
  expect(repos.profiles.findById(p.id)!.status).toBe('needs_attention');
  expect(driver.msgLog).toHaveLength(0);
});

test('message pass: checkpoint trips the shared guardrail and halts', async () => {
  const c = repos.cohorts.create('M', 'hi', true, 'message');
  seedScheduledMsg('https://www.linkedin.com/in/m4', '2026-06-29T09:00:00.000Z', c.id);
  driver.msgScripted.set('https://www.linkedin.com/in/m4', 'checkpoint');
  await run(new Date('2026-06-29T10:00:00Z'));
  expect(repos.appState.get().guardrail_tripped).toBe(1);
});

test('message weekly cap is independent of the invite cap', async () => {
  repos.settings.update({ msg_weekly_cap: 1, weekly_cap: 100, msg_batch_size: 5 });
  const c = repos.cohorts.create('M', 'hi', true, 'message');
  seedScheduledMsg('https://www.linkedin.com/in/m5', '2026-06-29T09:00:00.000Z', c.id);
  seedScheduledMsg('https://www.linkedin.com/in/m6', '2026-06-29T09:00:00.000Z', c.id);
  await run(new Date('2026-06-29T10:00:00Z'));
  expect(repos.profiles.byStatusKind('sent', 'message')).toHaveLength(1);
});

// --- Task 7b: honor min_delay_ms/max_delay_ms between sends ---

test('delays are requested between sends but not before the first or after the last', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  for (const slug of ['a', 'b', 'c']) {
    seedScheduled(`https://www.linkedin.com/in/${slug}`, '2026-06-29T09:00:00.000Z', c.id);
  }
  const sleeps: number[] = [];
  await run(new Date('2026-06-29T10:00:00Z'), { sleep: async (ms) => { sleeps.push(ms); } });
  expect(driver.sentLog).toHaveLength(3);
  expect(sleeps).toHaveLength(2); // gaps between 1-2 and 2-3, none before 1 or after 3
});

test('each requested delay is within [min_delay_ms, max_delay_ms] given a stubbed rng', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  seedScheduled('https://www.linkedin.com/in/a', '2026-06-29T09:00:00.000Z', c.id);
  seedScheduled('https://www.linkedin.com/in/b', '2026-06-29T09:00:00.000Z', c.id);
  const { min_delay_ms, max_delay_ms } = repos.settings.get();

  const minSleeps: number[] = [];
  await run(new Date('2026-06-29T10:00:00Z'), {
    sleep: async (ms) => { minSleeps.push(ms); }, rng: () => 0,
  });
  expect(minSleeps).toEqual([min_delay_ms]);

  // Reset for the max case.
  repos = new Repos(openDatabase(':memory:'));
  driver = new FakeDriver();
  repos.appState.setLogin({ loggedIn: true, cookieExpiry: null }, '2026-06-29T00:00:00.000Z');
  const c2 = repos.cohorts.create('A', 'hi', true);
  seedScheduled('https://www.linkedin.com/in/a', '2026-06-29T09:00:00.000Z', c2.id);
  seedScheduled('https://www.linkedin.com/in/b', '2026-06-29T09:00:00.000Z', c2.id);
  const maxSleeps: number[] = [];
  // Just under 1: floor(rng * (range+1)) lands on the top value of the range, i.e. max.
  await run(new Date('2026-06-29T10:00:00Z'), {
    sleep: async (ms) => { maxSleeps.push(ms); }, rng: () => 0.999999999,
  });
  expect(maxSleeps).toEqual([max_delay_ms]);
});

test('a halt mid-batch (checkpoint on the 2nd of 3 profiles) sleeps once, not after the halt', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  seedScheduled('https://www.linkedin.com/in/a', '2026-06-29T09:00:00.000Z', c.id);
  seedScheduled('https://www.linkedin.com/in/b', '2026-06-29T09:00:00.000Z', c.id);
  seedScheduled('https://www.linkedin.com/in/c', '2026-06-29T09:00:00.000Z', c.id);
  driver.scripted.set('https://www.linkedin.com/in/b', 'checkpoint');
  const sleeps: number[] = [];
  await run(new Date('2026-06-29T10:00:00Z'), { sleep: async (ms) => { sleeps.push(ms); } });
  // a -> [delay] -> b (checkpoint, halts) -> c never attempted, no trailing delay.
  expect(driver.sentLog).toHaveLength(2);
  expect(sleeps).toHaveLength(1);
});

test('both passes sending in one tick pace the boundary between the last invite and the first message', async () => {
  const invCohort = repos.cohorts.create('A', 'hi', true);
  seedScheduled('https://www.linkedin.com/in/a', '2026-06-29T09:00:00.000Z', invCohort.id);
  seedScheduled('https://www.linkedin.com/in/b', '2026-06-29T09:00:00.000Z', invCohort.id);
  const msgCohort = repos.cohorts.create('M', 'hi', true, 'message');
  seedScheduledMsg('https://www.linkedin.com/in/m1', '2026-06-29T09:00:00.000Z', msgCohort.id);
  seedScheduledMsg('https://www.linkedin.com/in/m2', '2026-06-29T09:00:00.000Z', msgCohort.id);

  const sleeps: number[] = [];
  await run(new Date('2026-06-29T10:00:00Z'), { sleep: async (ms) => { sleeps.push(ms); } });
  expect(driver.sentLog).toHaveLength(2);
  expect(driver.msgLog).toHaveLength(2);
  // 1 gap within the invite pass + 1 gap between invite pass and message pass
  // + 1 gap within the message pass = 3 total.
  expect(sleeps).toHaveLength(3);
});
