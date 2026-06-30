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
  // Two due profiles, logged in.
  const c = repos.cohorts.create('A', 'hi', true);
  for (const slug of ['a', 'b']) {
    const p = repos.profiles.add(c.id, `https://www.linkedin.com/in/${slug}`, null);
    repos.profiles.setScheduled(p.id, '2020-01-01T00:00:00.000Z'); // far past -> always due
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
  await Promise.all([orch.runSenderTick(), orch.runSenderTick()]);

  expect(max).toBe(1); // never two concurrent sends across overlapping batches
  expect(driver.sentLog).toHaveLength(2); // each profile sent exactly once (no double-processing)
});
