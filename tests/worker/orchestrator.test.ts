import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { FakeDriver } from '../../src/browser/driver.js';
import { refreshLoginCache, Orchestrator } from '../../src/worker/orchestrator.js';

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

  const orch = new Orchestrator(repos, driver);
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
