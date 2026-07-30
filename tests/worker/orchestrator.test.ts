import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { FakeDriver } from '../../src/browser/driver.js';
import { refreshLoginCache, Orchestrator, acceptanceSlot } from '../../src/worker/orchestrator.js';

let repos: Repos; let driver: FakeDriver;
const NOW = new Date('2026-06-30T10:00:00.000Z');
beforeEach(() => { repos = new Repos(openDatabase(':memory:')); driver = new FakeDriver(); });

test('does nothing when the browser is not open (never opens it)', async () => {
  driver.open = false;
  await refreshLoginCache(repos, driver, NOW);
  expect(driver.open).toBe(false);
  expect(repos.appState.get().login_confirmed_at).toBeNull();
});

test('refreshes the cache from the live cookie while the browser is open', async () => {
  driver.open = true;
  driver.loggedIn = true;
  driver.cookieExpiry = '2027-01-01T00:00:00.000Z';
  await refreshLoginCache(repos, driver, NOW);
  const s = repos.appState.get();
  expect(s.login_logged_in).toBe(1);
  expect(s.login_cookie_expiry).toBe('2027-01-01T00:00:00.000Z');
  expect(s.login_confirmed_at).toBe(NOW.toISOString());
});

test('records a logged-out cache when the cookie is gone', async () => {
  driver.open = true;
  driver.loggedIn = false;
  await refreshLoginCache(repos, driver, NOW);
  expect(repos.appState.get().login_logged_in).toBe(0);
});

test('overlapping sender ticks never run two batches against the browser at once', async () => {
  // Two due profiles, logged in. Due 5 min ago: recent enough to survive the
  // overdue re-queue (grace 10 min) yet already due for sending.
  const c = repos.cohorts.create('A', 'hi', true);
  for (const slug of ['a', 'b']) {
    const p = repos.profiles.add(c.id, `https://www.linkedin.com/in/${slug}`, null);
    repos.profiles.setScheduled(p.id, new Date(NOW.getTime() - 5 * 60 * 1000).toISOString());
  }
  repos.appState.setLogin({ loggedIn: true, cookieExpiry: null }, '2020-01-01T00:00:00.000Z');

  // Each send blocks briefly; track how many sends run concurrently.
  let active = 0;
  let max = 0;
  driver.sendConnectionRequest = async (url, message) => {
    active++;
    max = Math.max(max, active);
    await new Promise((r) => setTimeout(r, 15));
    active--;
    driver.sentLog.push({ url, message });
    return { result: 'sent', firstName: 'T' };
  };

  // No-op sleep: this batch has 2 due profiles (1 inter-send gap), and this test must not
  // actually wait the real min_delay_ms/max_delay_ms (20-90s by default).
  const orch = new Orchestrator(repos, driver, undefined, { sleep: async () => {} });
  // Fire two sender ticks concurrently (the 60s timer firing mid-batch, or Run-now
  // overlapping the timer). The guard must drop the second so only one batch runs.
  await Promise.all([orch.runSenderTick(NOW), orch.runSenderTick(NOW)]);

  expect(max).toBe(1); // never two concurrent sends across overlapping batches
  expect(driver.sentLog).toHaveLength(2); // each profile sent exactly once (no double-processing)
});

// A browser error in a periodic tick must be caught — an unhandled rejection here
// crashes the whole Node process (this happened live: launchPersistentContext failed
// because the profile was in use, and the rejection took down the app).
function seedDue(): void {
  const c = repos.cohorts.create('A', 'hi', true);
  const p = repos.profiles.add(c.id, 'https://www.linkedin.com/in/x', null);
  // due 5 min ago: within the overdue grace, so the tick still tries to send it
  repos.profiles.setScheduled(p.id, new Date(NOW.getTime() - 5 * 60 * 1000).toISOString());
  repos.appState.setLogin({ loggedIn: true, cookieExpiry: null }, '2020-01-01T00:00:00.000Z');
}

test('a sender-tick browser error is caught and never rejects the tick', async () => {
  seedDue();
  driver.readLoginState = async () => { throw new Error('some transient browser failure'); };
  const orch = new Orchestrator(repos, driver);
  await expect(orch.runSenderTick(NOW)).resolves.toBeUndefined();
});

test('a "profile in use" launch failure pauses the engine with a clear reason', async () => {
  seedDue();
  driver.readLoginState = async () => {
    throw new Error('browserType.launchPersistentContext: Opening in existing browser session.');
  };
  const orch = new Orchestrator(repos, driver);
  await orch.runSenderTick(NOW);
  const s = repos.settings.get();
  expect(s.paused).toBe(1);
  expect(s.pause_reason).toMatch(/another browser|profile/i);
});

test('an ordinary browser error does not pause the engine (only logs)', async () => {
  seedDue();
  driver.readLoginState = async () => { throw new Error('net::ERR_TIMED_OUT'); };
  const orch = new Orchestrator(repos, driver);
  await orch.runSenderTick(NOW);
  expect(repos.settings.get().paused).toBe(0);
});

test('a stale slot is re-queued by the tick instead of being sent late', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  const p = repos.profiles.add(c.id, 'https://www.linkedin.com/in/stale', null);
  repos.profiles.setScheduled(p.id, new Date(NOW.getTime() - 60 * 60 * 1000).toISOString()); // 1h overdue
  repos.appState.setLogin({ loggedIn: true, cookieExpiry: null }, '2020-01-01T00:00:00.000Z');
  const orch = new Orchestrator(repos, driver);
  await orch.runSenderTick(NOW);
  expect(driver.sentLog).toHaveLength(0);
  expect(repos.profiles.findById(p.id)!.status).toBe('queued');
});

test('start() rebuilds the whole scheduled backlog, not just overdue slots', () => {
  const c = repos.cohorts.create('A', 'hi', true);
  const p = repos.profiles.add(c.id, 'https://www.linkedin.com/in/future', null);
  // A far-future slot: planAndAssignToday's overdue-requeue would leave it alone (not overdue),
  // so this distinguishes the startup call. resortSchedule requeues EVERY scheduled row
  // unconditionally, clearing this slot regardless of the real wall clock -> time-independent.
  const futureIso = '2099-01-01T09:00:00.000Z';
  repos.profiles.setScheduled(p.id, futureIso);
  const orch = new Orchestrator(repos, driver);
  orch.start();
  orch.stop(); // clear the timers start() registered so the test process exits
  expect(repos.profiles.findById(p.id)!.scheduled_for).not.toBe(futureIso);
});

/* ---------- acceptance cadence ----------
   Slots are computed in LOCAL time (the operator thinks in local days), so these tests
   build dates with the local constructor to stay timezone-independent. */

test('one check per day: every hour of the same day is the same slot', () => {
  expect(acceptanceSlot(new Date(2026, 6, 28, 0, 5), 1))
    .toBe(acceptanceSlot(new Date(2026, 6, 28, 23, 55), 1));
});

test('two checks per day: the day splits at noon', () => {
  const morning = acceptanceSlot(new Date(2026, 6, 28, 9, 0), 2);
  const noon = acceptanceSlot(new Date(2026, 6, 28, 12, 0), 2);
  const evening = acceptanceSlot(new Date(2026, 6, 28, 23, 0), 2);
  expect(morning).not.toBe(noon);
  expect(noon).toBe(evening);
});

test('slots never collide across days', () => {
  expect(acceptanceSlot(new Date(2026, 6, 28, 9, 0), 2))
    .not.toBe(acceptanceSlot(new Date(2026, 6, 29, 9, 0), 2));
});

test('a nonsensical checks-per-day falls back to one check per day', () => {
  for (const n of [0, -3, NaN]) {
    expect(acceptanceSlot(new Date(2026, 6, 28, 1, 0), n))
      .toBe(acceptanceSlot(new Date(2026, 6, 28, 22, 0), n));
  }
});

/** One pending invite, logged in — enough for a real acceptance pass to run. */
function seedPending(slug: string): number {
  const c = repos.cohorts.getOrCreate('A', 'hi', true);
  const p = repos.profiles.add(c.id, `https://www.linkedin.com/in/${slug}`, null);
  repos.profiles.setStatus(p.id, 'sent', { sent_at: '2026-07-01T00:00:00.000Z' });
  repos.appState.setLogin({ loggedIn: true, cookieExpiry: null }, '2026-07-01T00:00:00.000Z');
  return p.id;
}

// THE BUG: the old tick marked the day done BEFORE attempting, so a pass that bailed out
// (logged out, read error, empty read) cost a full day of detection with no retry.
test('a pass that bailed out is retried on the next tick, not tomorrow', async () => {
  const id = seedPending('a');
  const orch = new Orchestrator(repos, driver);

  driver.connections = []; // empty read -> fail-safe, changes nothing, stamps nothing
  await orch.runAcceptanceTick(new Date(2026, 6, 28, 9, 0));
  expect(repos.profiles.findById(id)!.status).toBe('sent');

  driver.connections = ['https://www.linkedin.com/in/a']; // next tick, 30 min later: page renders
  await orch.runAcceptanceTick(new Date(2026, 6, 28, 9, 30));
  expect(repos.profiles.findById(id)!.status).toBe('accepted');
});

test('a successful pass is not repeated within the same slot', async () => {
  seedPending('a');
  driver.connections = ['https://www.linkedin.com/in/a'];
  const orch = new Orchestrator(repos, driver);
  await orch.runAcceptanceTick(new Date(2026, 6, 28, 9, 0));

  // Someone else accepts moments later; the next tick in the same slot must stay dark.
  const late = seedPending('b');
  driver.connections = ['https://www.linkedin.com/in/a', 'https://www.linkedin.com/in/b'];
  await orch.runAcceptanceTick(new Date(2026, 6, 28, 9, 30));
  expect(repos.profiles.findById(late)!.status).toBe('sent');
});

test('acceptance_checks_per_day=2 runs a second pass after noon', async () => {
  repos.settings.update({ acceptance_checks_per_day: 2 });
  seedPending('a');
  driver.connections = ['https://www.linkedin.com/in/a'];
  const orch = new Orchestrator(repos, driver);
  await orch.runAcceptanceTick(new Date(2026, 6, 28, 9, 0));

  const afternoon = seedPending('b');
  driver.connections = ['https://www.linkedin.com/in/a', 'https://www.linkedin.com/in/b'];
  await orch.runAcceptanceTick(new Date(2026, 6, 28, 14, 0));
  expect(repos.profiles.findById(afternoon)!.status).toBe('accepted');
});

test('acceptance_checks_per_day=1 does not run a second pass later the same day', async () => {
  repos.settings.update({ acceptance_checks_per_day: 1 });
  seedPending('a');
  driver.connections = ['https://www.linkedin.com/in/a'];
  const orch = new Orchestrator(repos, driver);
  await orch.runAcceptanceTick(new Date(2026, 6, 28, 9, 0));

  const later = seedPending('b');
  driver.connections = ['https://www.linkedin.com/in/a', 'https://www.linkedin.com/in/b'];
  await orch.runAcceptanceTick(new Date(2026, 6, 28, 22, 0));
  expect(repos.profiles.findById(later)!.status).toBe('sent');
});

test('a new day re-opens the first slot', async () => {
  seedPending('a');
  driver.connections = ['https://www.linkedin.com/in/a'];
  const orch = new Orchestrator(repos, driver);
  await orch.runAcceptanceTick(new Date(2026, 6, 28, 9, 0));

  const tomorrow = seedPending('b');
  driver.connections = ['https://www.linkedin.com/in/a', 'https://www.linkedin.com/in/b'];
  await orch.runAcceptanceTick(new Date(2026, 6, 29, 9, 0));
  expect(repos.profiles.findById(tomorrow)!.status).toBe('accepted');
});

test('an acceptance-tick browser error is caught and never rejects the tick', async () => {
  seedPending('a');
  driver.readLoginState = async () => { throw new Error('some transient browser failure'); };
  const orch = new Orchestrator(repos, driver);
  await expect(orch.runAcceptanceTick(new Date(2026, 6, 28, 9, 0))).resolves.toBeUndefined();
});

/* ---------- reply cadence ---------- */

test('reply tick runs at most once per slot and stamps replies_checked_at on success', async () => {
  repos.appState.setLogin({ loggedIn: true, cookieExpiry: null }, '2026-07-28T00:00:00.000Z');
  const c = repos.cohorts.create('M', 'hi', true, 'message');
  const p = repos.profiles.add(c.id, 'https://www.linkedin.com/in/k', null, 'message');
  repos.profiles.setStatus(p.id, 'sent', { sent_at: '2026-07-27T10:00:00.000Z', full_name: 'Keren Tevet' });
  driver.inboxRows = [{ name: 'Keren Tevet', snippet: 'Keren: hey', youSentLast: false }];

  const orch = new Orchestrator(repos, driver);
  const morning = new Date(2026, 6, 28, 9, 0);
  await orch.runReplyTick(morning);
  expect(repos.profiles.findById(p.id)!.status).toBe('replied');
  expect(repos.appState.get().replies_checked_at).not.toBeNull();

  // Same slot again: must not re-read (make a second read fail loudly if attempted).
  driver.inboxError = 'should not be called';
  await orch.runReplyTick(new Date(2026, 6, 28, 9, 20));
  expect(repos.appState.get().failure_streak).toBe(0);
});

test('start() recovers a profile stranded in sending by a mid-send crash', () => {
  const c = repos.cohorts.create('A', 'hi', true);
  const p = repos.profiles.add(c.id, 'https://www.linkedin.com/in/mid', null);
  // Simulate the sender marking it 'sending' (attempts++) before the process was killed.
  repos.profiles.setStatus(p.id, 'sending', { attempts: 1 });
  const orch = new Orchestrator(repos, driver);
  orch.start();
  orch.stop();
  // Startup recovery returned it to the queue (then possibly re-scheduled): never left stuck.
  expect(repos.profiles.findById(p.id)!.status).not.toBe('sending');
});

// Local-component Date constructors: acceptanceSlot slices the LOCAL day, so building
// these from a UTC ISO string would make the slot boundary timezone-dependent.
const localAt = (h: number, m = 0) => new Date(2026, 6, 31, h, m, 0, 0);

test('roster tick runs once per slot and retries after a failed pass', async () => {
  repos.appState.setLogin({ loggedIn: true, cookieExpiry: null }, '2026-07-31T00:00:00.000Z');
  repos.settings.update({ roster_sync_per_day: 2 });
  const orch = new Orchestrator(repos, driver);

  // First pass fails (empty read) -> nothing stamped, so the slot is NOT burned.
  driver.connectionCards = [];
  await orch.runRosterSyncTick(localAt(9));
  expect(repos.appState.get().roster_synced_at).toBeNull();

  // Retry in the same slot succeeds.
  driver.connectionCards = [{ url: 'https://www.linkedin.com/in/ada', name: 'Ada' }];
  await orch.runRosterSyncTick(localAt(9, 30));
  expect(repos.appState.get().roster_synced_at).toBe(localAt(9, 30).toISOString());

  // Same slot again -> no-op, the new card is not picked up yet.
  driver.connectionCards = [{ url: 'https://www.linkedin.com/in/grace', name: 'Grace' }];
  await orch.runRosterSyncTick(localAt(10));
  expect(repos.connections.count()).toBe(1);

  // Next slot (2/day => boundary at local noon) -> runs again.
  await orch.runRosterSyncTick(localAt(15));
  expect(repos.connections.count()).toBe(2);
});

test('roster tick is a no-op while paused or halted', async () => {
  repos.appState.setLogin({ loggedIn: true, cookieExpiry: null }, '2026-07-31T00:00:00.000Z');
  driver.connectionCards = [{ url: 'https://www.linkedin.com/in/ada', name: 'Ada' }];
  const orch = new Orchestrator(repos, driver);

  repos.settings.update({ paused: 1 });
  await orch.runRosterSyncTick(localAt(9));
  expect(repos.connections.count()).toBe(0);

  repos.settings.update({ paused: 0 });
  repos.appState.trip('checkpoint', 'captcha', '2026-07-31T08:00:00.000Z');
  await orch.runRosterSyncTick(localAt(9));
  expect(repos.connections.count()).toBe(0);
});
