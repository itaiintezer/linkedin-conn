import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { FakeDriver } from '../../src/browser/driver.js';
import { refreshLoginCache, Orchestrator, daySlot } from '../../src/worker/orchestrator.js';

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
  expect(daySlot(new Date(2026, 6, 28, 0, 5), 1))
    .toBe(daySlot(new Date(2026, 6, 28, 23, 55), 1));
});

test('two checks per day: the day splits at noon', () => {
  const morning = daySlot(new Date(2026, 6, 28, 9, 0), 2);
  const noon = daySlot(new Date(2026, 6, 28, 12, 0), 2);
  const evening = daySlot(new Date(2026, 6, 28, 23, 0), 2);
  expect(morning).not.toBe(noon);
  expect(noon).toBe(evening);
});

test('slots never collide across days', () => {
  expect(daySlot(new Date(2026, 6, 28, 9, 0), 2))
    .not.toBe(daySlot(new Date(2026, 6, 29, 9, 0), 2));
});

test('a nonsensical checks-per-day falls back to one check per day', () => {
  for (const n of [0, -3, NaN]) {
    expect(daySlot(new Date(2026, 6, 28, 1, 0), n))
      .toBe(daySlot(new Date(2026, 6, 28, 22, 0), n));
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

// Post-cutover (2026-07-31) the acceptance tick is a pure DB read against the roster, so
// the old once-per-slot gate is gone entirely. These tests pin the replacement contract:
// it runs every tick, costs nothing, and stays subject to pause/halt.
function rosterHas(...slugs: string[]): void {
  for (const sl of slugs) {
    repos.connections.upsert({ profile_url: `https://www.linkedin.com/in/${sl}` }, 'scrape', '2026-07-28T00:00:00.000Z');
  }
}

test('acceptance runs on EVERY tick — no slot gate, because it costs nothing', async () => {
  const a = seedPending('a');
  const orch = new Orchestrator(repos, driver);

  rosterHas('a');
  await orch.runAcceptanceTick(new Date(2026, 6, 28, 9, 0));
  expect(repos.profiles.findById(a)!.status).toBe('accepted');

  // Someone else is discovered moments later, still inside what used to be one slot.
  // The old gate would have made this wait until the afternoon.
  const b = seedPending('b');
  rosterHas('b');
  await orch.runAcceptanceTick(new Date(2026, 6, 28, 9, 1));
  expect(repos.profiles.findById(b)!.status).toBe('accepted');
});

test('acceptance tick never opens the browser', async () => {
  seedPending('a');
  rosterHas('a');
  await new Orchestrator(repos, driver).runAcceptanceTick(new Date(2026, 6, 28, 9, 0));
  expect(driver.open).toBe(false);
});

test('acceptance tick stays dark while paused or halted', async () => {
  const a = seedPending('a');
  rosterHas('a');
  const orch = new Orchestrator(repos, driver);

  repos.settings.update({ paused: 1 });
  await orch.runAcceptanceTick(new Date(2026, 6, 28, 9, 0));
  expect(repos.profiles.findById(a)!.status).toBe('sent');

  repos.settings.update({ paused: 0 });
  repos.appState.trip('checkpoint', 'captcha', '2026-07-28T08:00:00.000Z');
  await orch.runAcceptanceTick(new Date(2026, 6, 28, 9, 0));
  expect(repos.profiles.findById(a)!.status).toBe('sent');
});

test('an empty roster still changes nothing', async () => {
  const a = seedPending('a');
  await new Orchestrator(repos, driver).runAcceptanceTick(new Date(2026, 6, 28, 9, 0));
  expect(repos.profiles.findById(a)!.status).toBe('sent');
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

test('start() recovers engagements stranded in sending, each by what its timestamps prove', () => {
  // All three branches, driven through start() rather than the function directly — the
  // question is not only "does it decide correctly" but "does anything in start() undo it".
  // resortSchedule runs immediately after and requeues every SCHEDULED engagement, so the
  // parked and completed rows must be out of its reach by the time it runs.
  const before = repos.engagements.add('u1', 'urn:li:activity:1', 'like', 'hi');
  repos.engagements.setStatus(before.id, 'sending', { attempts: 1 });

  const reactedOnly = repos.engagements.add('u2', 'urn:li:activity:2', 'like', null);
  repos.engagements.setStatus(reactedOnly.id, 'sending', { reacted_at: '2026-06-30T09:00:00.000Z' });

  const midComment = repos.engagements.add('u3', 'urn:li:activity:3', 'like', 'hi');
  repos.engagements.setStatus(midComment.id, 'sending', { reacted_at: '2026-06-30T09:00:00.000Z' });

  const orch = new Orchestrator(repos, driver);
  orch.start();
  orch.stop();

  // Requeued, then handed to the planner by the same startup pass — never left in 'sending'.
  expect(['queued', 'scheduled']).toContain(repos.engagements.findById(before.id)!.status);
  expect(repos.engagements.findById(before.id)!.attempts).toBe(1); // the attempt was consumed
  expect(repos.engagements.findById(reactedOnly.id)!.status).toBe('sent');
  expect(repos.engagements.findById(midComment.id)!.status).toBe('needs_attention');
});

// Local-component Date constructors: daySlot slices the LOCAL day, so building
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

test('startup recovers rows stranded in enriching by a hard kill', () => {
  repos.connections.upsert({ profile_url: 'https://www.linkedin.com/in/a' }, 'csv', '2026-07-01T00:00:00.000Z');
  repos.connections.upsert({ profile_url: 'https://www.linkedin.com/in/b' }, 'csv', '2026-07-01T00:00:00.000Z');
  repos.connections.claimForEnrichment(2); // simulate a run that never reached its finally

  const orch = new Orchestrator(repos, driver);
  orch.start();
  orch.stop();

  // Without this, both rows sit in `enriching` forever and never appear in search.
  expect(repos.connections.countsByEnrichStatus()).toMatchObject({ pending: 2, enriching: 0 });
});
