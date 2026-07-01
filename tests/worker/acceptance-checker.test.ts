import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { FakeDriver } from '../../src/browser/driver.js';
import { runAcceptanceCheck } from '../../src/worker/acceptance-checker.js';

let repos: Repos; let driver: FakeDriver;
beforeEach(() => {
  repos = new Repos(openDatabase(':memory:'));
  driver = new FakeDriver();
  repos.appState.setLogin({ loggedIn: true, cookieExpiry: null }, '2026-06-29T00:00:00.000Z');
});

function seedSent(url: string, cohortId: number, sentAt = '2026-06-20T00:00:00Z') {
  const p = repos.profiles.add(cohortId, url, null);
  repos.profiles.setStatus(p.id, 'sent', { sent_at: sentAt });
  return p;
}

test('promotes only profiles found in the connections list; absence never expires', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  const a = seedSent('https://www.linkedin.com/in/a', c.id);
  const b = seedSent('https://www.linkedin.com/in/b', c.id);
  const cc = seedSent('https://www.linkedin.com/in/c', c.id);

  driver.connections = ['https://www.linkedin.com/in/b'];

  const now = new Date('2026-06-29T12:00:00Z');
  await runAcceptanceCheck(repos, driver, now);

  const accepted = repos.profiles.byStatus('accepted');
  expect(accepted.map((p) => p.id)).toEqual([b.id]);
  expect(accepted[0].accepted_at).toBe(now.toISOString());
  // a and c are simply not in connections -> they stay pending, NOT expired.
  expect(repos.profiles.byStatus('sent').map((p) => p.id).sort()).toEqual([a.id, cc.id].sort());
  expect(repos.profiles.byStatus('expired')).toHaveLength(0);
});

test('an empty connections read changes nothing (fail-safe) and does not stamp checked_at', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  const a = seedSent('https://www.linkedin.com/in/a', c.id);
  driver.connections = []; // suspiciously empty read
  await runAcceptanceCheck(repos, driver, new Date('2026-06-29T12:00:00Z'));
  expect(repos.profiles.byStatus('sent').map((p) => p.id)).toEqual([a.id]);
  expect(repos.profiles.byStatus('expired')).toHaveLength(0);
  expect(repos.appState.get().acceptance_checked_at).toBeNull();
});

test('age-based expiry backstop: expires unaccepted invites older than expiry_days', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  const old = seedSent('https://www.linkedin.com/in/old', c.id, '2026-05-01T00:00:00Z'); // 59d
  const fresh = seedSent('https://www.linkedin.com/in/fresh', c.id, '2026-06-27T00:00:00Z'); // 2d
  repos.settings.update({ expiry_days: 42 });
  driver.connections = ['https://www.linkedin.com/in/someone-else']; // non-empty read

  await runAcceptanceCheck(repos, driver, new Date('2026-06-29T12:00:00Z'));

  expect(repos.profiles.byStatus('expired').map((p) => p.id)).toEqual([old.id]);
  expect(repos.profiles.byStatus('sent').map((p) => p.id)).toEqual([fresh.id]);
});

test('acceptance wins over age expiry for the same profile', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  const old = seedSent('https://www.linkedin.com/in/old', c.id, '2026-05-01T00:00:00Z');
  repos.settings.update({ expiry_days: 42 });
  driver.connections = ['https://www.linkedin.com/in/old']; // they accepted, even though old

  await runAcceptanceCheck(repos, driver, new Date('2026-06-29T12:00:00Z'));

  expect(repos.profiles.findById(old.id)!.status).toBe('accepted');
  expect(repos.profiles.byStatus('expired')).toHaveLength(0);
});

test('skips when paused', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  seedSent('https://www.linkedin.com/in/a', c.id);
  repos.settings.update({ paused: 1 });
  driver.connections = ['https://www.linkedin.com/in/a'];
  await runAcceptanceCheck(repos, driver, new Date());
  expect(repos.profiles.byStatus('accepted')).toHaveLength(0);
});

test('does not open the browser when there are no sent profiles', async () => {
  await runAcceptanceCheck(repos, driver, new Date('2026-06-29T12:00:00Z'));
  expect(driver.open).toBe(false);
});

test('skips when guardrail tripped', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  seedSent('https://www.linkedin.com/in/a', c.id);
  repos.appState.trip('checkpoint', 'x', '2026-06-29T00:00:00.000Z');
  driver.connections = ['https://www.linkedin.com/in/a'];
  await runAcceptanceCheck(repos, driver, new Date('2026-06-29T12:00:00Z'));
  expect(repos.profiles.byStatus('accepted')).toHaveLength(0);
});

test('a checkpoint thrown during the connections read trips the guardrail', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  seedSent('https://www.linkedin.com/in/a', c.id);
  driver.readRecentConnections = async () => { throw new Error('checkpoint detected during connections read'); };
  await runAcceptanceCheck(repos, driver, new Date('2026-06-29T12:00:00Z'));
  expect(repos.appState.get().guardrail_tripped).toBe(1);
  expect(repos.appState.get().guardrail_reason).toBe('checkpoint');
});

test('login lost on the live check trips login_lost and reads nothing', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  seedSent('https://www.linkedin.com/in/a', c.id);
  driver.loggedIn = false;
  driver.connections = ['https://www.linkedin.com/in/a'];
  await runAcceptanceCheck(repos, driver, new Date('2026-06-29T12:00:00Z'));
  expect(repos.appState.get().guardrail_reason).toBe('login_lost');
  expect(repos.profiles.byStatus('accepted')).toHaveLength(0);
});

test('stamps acceptance_checked_at after a clean, non-empty read', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  seedSent('https://www.linkedin.com/in/a', c.id);
  driver.connections = ['https://www.linkedin.com/in/a'];
  const now = new Date('2026-06-29T12:00:00Z');
  await runAcceptanceCheck(repos, driver, now);
  expect(repos.appState.get().acceptance_checked_at).toBe(now.toISOString());
});

test('does not stamp acceptance_checked_at when there is nothing to verify', async () => {
  await runAcceptanceCheck(repos, driver, new Date('2026-06-29T12:00:00Z'));
  expect(repos.appState.get().acceptance_checked_at).toBeNull();
});
