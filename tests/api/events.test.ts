import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { FakeDriver } from '../../src/browser/driver.js';
import { buildServer } from '../../src/api/server.js';

let app: ReturnType<typeof buildServer>;
let repos: Repos;
let driver: FakeDriver;

beforeEach(() => {
  repos = new Repos(openDatabase(':memory:'));
  driver = new FakeDriver();
  app = buildServer(repos, driver);
  repos.appState.setLogin({ loggedIn: true, cookieExpiry: null }, '2026-08-03T00:00:00.000Z');
});

const EVENT = 'https://www.linkedin.com/events/7486088214579982336/';

function conn(slug: string, o: { country?: string; cc?: string } = {}): string {
  const url = `https://www.linkedin.com/in/${slug}`;
  const iso = '2026-08-03T00:00:00.000Z';
  repos.db.prepare(`
    INSERT INTO connections
      (profile_url, linkedin_id, full_name, location_country, location_country_code,
       source, first_seen_at, last_seen_at, enrich_status)
    VALUES (?, ?, ?, ?, ?, 'scrape', ?, ?, 'enriched')
  `).run(url, `ACoAA${slug}`, slug, o.country ?? 'Israel', o.cc ?? 'IL', iso, iso);
  return url;
}

const post = (url: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url, payload });

test('creates a campaign from a list of profile URLs', async () => {
  const u = conn('keren');
  const r = await post('/api/events', { event_url: EVENT, profile_urls: [u] });
  expect(r.statusCode).toBe(201);
  const body = r.json();
  expect(body.added).toBe(1);
  expect(body.event.status).toBe('draft');
  expect(body.buckets).toHaveLength(1);
  expect(body.buckets[0].geo_label).toBe('Israel');
});

test('creates a campaign from a pasted blob', async () => {
  conn('keren');
  const r = await post('/api/events', {
    event_url: EVENT,
    text: 'see https://www.linkedin.com/in/keren and maybe others',
  });
  expect(r.statusCode).toBe(201);
  expect(r.json().added).toBe(1);
});

test('names the URLs it could not use rather than failing later', async () => {
  const known = conn('keren');
  const r = await post('/api/events', {
    event_url: EVENT, profile_urls: [known, 'https://www.linkedin.com/in/stranger'],
  });
  expect(r.json().rejected).toEqual([
    { url: 'https://www.linkedin.com/in/stranger', reason: 'not_a_connection' },
  ]);
});

test('rejects a bad event url and an empty list', async () => {
  expect((await post('/api/events', { event_url: 'nope', profile_urls: ['x'] })).statusCode).toBe(400);
  expect((await post('/api/events', { event_url: EVENT, profile_urls: [] })).statusCode).toBe(400);
});

test('refuses a duplicate campaign for the same event', async () => {
  const u = conn('keren');
  await post('/api/events', { event_url: EVENT, profile_urls: [u] });
  const again = await post('/api/events', { event_url: EVENT, profile_urls: [u] });
  expect(again.statusCode).toBe(400);
  expect(again.json().error).toMatch(/already has a campaign/);
});

test('arming reserves a window and freezes the bucket plan', async () => {
  const urls = [conn('keren'), conn('uk0', { country: 'United Kingdom', cc: 'GB' })];
  const created = (await post('/api/events', { event_url: EVENT, profile_urls: urls })).json();
  const id = created.event.id;

  const armed = await post(`/api/events/${id}/arm`, {});
  expect(armed.statusCode).toBe(200);
  expect(armed.json().event.status).toBe('armed');

  const blocked = await post(`/api/events/${id}/buckets/remove`, { ranks: [0] });
  expect(blocked.statusCode).toBe(409);
});

test('a draft bucket can be dropped and the ranks close up', async () => {
  const urls = [
    conn('il0'), conn('il1'),
    conn('uk0', { country: 'United Kingdom', cc: 'GB' }),
  ];
  const created = (await post('/api/events', { event_url: EVENT, profile_urls: urls })).json();
  expect(created.buckets.map((b: { label: string }) => b.label)).toEqual(['Israel', 'United Kingdom']);
  const after = await post(`/api/events/${created.event.id}/buckets/remove`, { ranks: [0] });
  const buckets = after.json().buckets;
  expect(buckets).toHaveLength(1);
  expect(buckets[0].label).toBe('United Kingdom');
  expect(buckets[0].rank).toBe(0);
});

test('stop closes the campaign and releases its window', async () => {
  const created = (await post('/api/events', { event_url: EVENT, profile_urls: [conn('keren')] })).json();
  const id = created.event.id;
  await post(`/api/events/${id}/arm`, {});
  const stopped = await post(`/api/events/${id}/stop`, {});
  expect(stopped.json().event.status).toBe('stopped');
  expect(stopped.json().reservation).toBeNull();
});

test('run-now refuses a campaign that is not armed', async () => {
  const created = (await post('/api/events', { event_url: EVENT, profile_urls: [conn('keren')] })).json();
  const r = await post(`/api/events/${created.event.id}/run-now`, {});
  expect(r.statusCode).toBe(409);
});

test('run-now and dry-run refuse when logged out', async () => {
  const created = (await post('/api/events', { event_url: EVENT, profile_urls: [conn('keren')] })).json();
  await post(`/api/events/${created.event.id}/arm`, {});
  repos.appState.setLogin({ loggedIn: false, cookieExpiry: null }, '2026-08-03T00:00:00.000Z');
  expect((await post(`/api/events/${created.event.id}/run-now`, {})).statusCode).toBe(409);
  expect((await post(`/api/events/${created.event.id}/dry-run`, {})).statusCode).toBe(409);
});

test('404s for an unknown event', async () => {
  expect((await app.inject({ method: 'GET', url: '/api/events/999' })).statusCode).toBe(404);
  expect((await post('/api/events/999/stop', {})).statusCode).toBe(404);
});

test('lists campaigns with their counts', async () => {
  await post('/api/events', { event_url: EVENT, profile_urls: [conn('keren'), conn('or')] });
  const list = (await app.inject({ method: 'GET', url: '/api/events' })).json();
  expect(list).toHaveLength(1);
  expect(list[0].counts.pending).toBe(2);
});

test('exposes the event settings and accepts updates', async () => {
  const s = (await app.inject({ method: 'GET', url: '/api/settings' })).json();
  expect(s.events_per_day).toBe(1);
  expect(s.event_invite_cap).toBe(500);
  expect(s.event_bucket_ceiling).toBe(10);
  expect(s.event_run_budget_minutes).toBe(20);

  const updated = (await post('/api/settings', { event_invite_cap: 250, event_bucket_ceiling: 6 })).json();
  expect(updated.event_invite_cap).toBe(250);
  expect(updated.event_bucket_ceiling).toBe(6);
});

test('a new campaign inherits the current caps from settings', async () => {
  await post('/api/settings', { event_invite_cap: 42, event_bucket_ceiling: 3 });
  const created = (await post('/api/events', { event_url: EVENT, profile_urls: [conn('keren')] })).json();
  expect(created.event.invite_cap).toBe(42);
  expect(created.event.bucket_ceiling).toBe(3);
});
