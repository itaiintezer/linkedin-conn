import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { FakeDriver } from '../../src/browser/driver.js';
import { runRosterSync } from '../../src/worker/roster-sync.js';

let repos: Repos; let driver: FakeDriver;
const NOW = new Date('2026-07-31T12:00:00.000Z');

beforeEach(() => {
  repos = new Repos(openDatabase(':memory:'));
  driver = new FakeDriver();
  repos.appState.setLogin({ loggedIn: true, cookieExpiry: null }, '2026-07-31T00:00:00.000Z');
});

test('upserts every card read and stamps roster_synced_at', async () => {
  driver.connectionCards = [
    { url: 'https://www.linkedin.com/in/ada', name: 'Ada Lovelace' },
    { url: 'https://www.linkedin.com/in/grace', name: 'Grace Hopper' },
  ];

  const r = await runRosterSync(repos, driver, NOW);

  expect(r).toMatchObject({ ran: true, seen: 2, discovered: 2 });
  expect(repos.connections.count()).toBe(2);
  expect(repos.connections.findByUrl('https://www.linkedin.com/in/ada')!.full_name).toBe('Ada Lovelace');
  expect(repos.connections.findByUrl('https://www.linkedin.com/in/ada')!.source).toBe('scrape');
  expect(repos.appState.get().roster_synced_at).toBe(NOW.toISOString());
});

test('a second pass over the same people discovers nothing new but advances last_seen_at', async () => {
  driver.connectionCards = [{ url: 'https://www.linkedin.com/in/ada', name: 'Ada Lovelace' }];
  await runRosterSync(repos, driver, NOW);

  const later = new Date('2026-08-01T12:00:00.000Z');
  const r = await runRosterSync(repos, driver, later);

  expect(r).toMatchObject({ ran: true, seen: 1, discovered: 0 });
  expect(repos.connections.count()).toBe(1);
  expect(repos.connections.findByUrl('https://www.linkedin.com/in/ada')!.last_seen_at).toBe(later.toISOString());
});

test('never invents connected_on for a scrape-discovered connection', async () => {
  driver.connectionCards = [{ url: 'https://www.linkedin.com/in/ada', name: 'Ada Lovelace' }];
  await runRosterSync(repos, driver, NOW);
  expect(repos.connections.findByUrl('https://www.linkedin.com/in/ada')!.connected_on).toBeNull();
});

test('an empty read changes nothing and does not stamp roster_synced_at', async () => {
  driver.connectionCards = [];
  const r = await runRosterSync(repos, driver, NOW);
  expect(r).toMatchObject({ ran: false, reason: 'empty_read', discovered: 0 });
  expect(repos.connections.count()).toBe(0);
  expect(repos.appState.get().roster_synced_at).toBeNull();
});

test('a read error records a failure and does not stamp roster_synced_at', async () => {
  driver.connectionCardsError = 'checkpoint detected during roster sync';
  const r = await runRosterSync(repos, driver, NOW);
  expect(r).toMatchObject({ ran: false, reason: 'read_error' });
  expect(repos.appState.get().roster_synced_at).toBeNull();
  expect(repos.appState.get().guardrail_tripped).toBe(1); // checkpoint text trips immediately
});

test('runs even with nothing pending acceptance — the roster is not hostage to the invite funnel', async () => {
  expect(repos.profiles.byStatus('sent')).toHaveLength(0);
  driver.connectionCards = [{ url: 'https://www.linkedin.com/in/ada', name: 'Ada Lovelace' }];
  await expect(runRosterSync(repos, driver, NOW)).resolves.toMatchObject({ ran: true });
});

test('paused blocks a scheduled pass but force overrides it', async () => {
  repos.settings.update({ paused: 1 });
  driver.connectionCards = [{ url: 'https://www.linkedin.com/in/ada', name: 'Ada' }];

  expect(await runRosterSync(repos, driver, NOW)).toMatchObject({ ran: false, reason: 'paused' });
  expect(await runRosterSync(repos, driver, NOW, { force: true })).toMatchObject({ ran: true });
});

test('a tripped guardrail blocks even a forced pass', async () => {
  repos.appState.trip('checkpoint', 'captcha', NOW.toISOString());
  driver.connectionCards = [{ url: 'https://www.linkedin.com/in/ada', name: 'Ada' }];
  expect(await runRosterSync(repos, driver, NOW, { force: true })).toMatchObject({ ran: false, reason: 'guardrail' });
});

test('a lost session trips login_lost and writes nothing', async () => {
  driver.loggedIn = false;
  driver.connectionCards = [{ url: 'https://www.linkedin.com/in/ada', name: 'Ada' }];
  const r = await runRosterSync(repos, driver, NOW);
  expect(r).toMatchObject({ ran: false, reason: 'login_lost' });
  expect(repos.connections.count()).toBe(0);
});

test('a card with no readable name still becomes a roster row', async () => {
  driver.connectionCards = [{ url: 'https://www.linkedin.com/in/anon', name: null }];
  await runRosterSync(repos, driver, NOW);
  const c = repos.connections.findByUrl('https://www.linkedin.com/in/anon')!;
  expect(c.full_name).toBeNull();
  expect(c.enrich_status).toBe('pending');
});
