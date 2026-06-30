import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { FakeDriver } from '../../src/browser/driver.js';
import { refreshLoginCache } from '../../src/worker/orchestrator.js';

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
