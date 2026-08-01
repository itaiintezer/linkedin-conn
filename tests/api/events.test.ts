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

/* ---------- adding people to a draft (the Connections screen's "Invite to event") ------- */

test('adds people to a draft and re-ranks the whole plan', async () => {
  // One Israeli, so Israel leads. Then three Brits arrive and the ladder must reorder —
  // slotting newcomers into the existing buckets would leave the run working the wrong
  // location first for the rest of the campaign's life.
  const created = (await post('/api/events', { event_url: EVENT, profile_urls: [conn('il0')] })).json();
  const id = created.event.id;
  expect(created.buckets.map((b: { label: string }) => b.label)).toEqual(['Israel']);

  const uk = ['uk0', 'uk1', 'uk2'].map((s) => conn(s, { country: 'United Kingdom', cc: 'GB' }));
  const r = await post(`/api/events/${id}/invitees`, { profile_urls: uk });
  expect(r.statusCode).toBe(200);
  expect(r.json().added).toBe(3);
  expect(r.json().buckets.map((b: { label: string }) => b.label))
    .toEqual(['United Kingdom', 'Israel']);
  expect(r.json().counts.pending).toBe(4);
});

test('adding accepts a pasted blob and re-reports who is not a connection', async () => {
  const created = (await post('/api/events', { event_url: EVENT, profile_urls: [conn('il0')] })).json();
  const r = await post(`/api/events/${created.event.id}/invitees`, {
    text: 'https://www.linkedin.com/in/uk0 and https://www.linkedin.com/in/stranger',
  });
  conn('uk0', { country: 'United Kingdom', cc: 'GB' }); // added AFTER the call, so it is a stranger too
  expect(r.json().rejected.map((x: { url: string }) => x.url)).toEqual([
    'https://www.linkedin.com/in/uk0', 'https://www.linkedin.com/in/stranger',
  ]);
  expect(r.json().added).toBe(0);
});

test('adding re-scores a previously unreachable person who is now bucketable', async () => {
  // No country on record -> unreachable at creation. Enriching them later and re-adding
  // must put them back on the list, not leave them parked forever.
  const url = 'https://www.linkedin.com/in/nowhere';
  const iso = '2026-08-03T00:00:00.000Z';
  repos.db.prepare(`
    INSERT INTO connections (profile_url, linkedin_id, full_name, source,
      first_seen_at, last_seen_at, enrich_status)
    VALUES (?, 'ACoAAnowhere', 'nowhere', 'scrape', ?, ?, 'enriched')
  `).run(url, iso, iso);
  const created = (await post('/api/events', { event_url: EVENT, profile_urls: [url, conn('il0')] })).json();
  expect(created.counts.unreachable).toBe(1);

  repos.db.prepare('UPDATE connections SET location_country = ?, location_country_code = ? WHERE profile_url = ?')
    .run('United Kingdom', 'GB', url);
  const r = await post(`/api/events/${created.event.id}/invitees`, { profile_urls: [url] });
  expect(r.json().added).toBe(0);                    // already on the list
  expect(r.json().counts.unreachable).toBeUndefined();
  expect(r.json().counts.pending).toBe(2);
});

test('adding is refused once the campaign is armed', async () => {
  const created = (await post('/api/events', { event_url: EVENT, profile_urls: [conn('il0')] })).json();
  await post(`/api/events/${created.event.id}/arm`, {});
  const r = await post(`/api/events/${created.event.id}/invitees`, { profile_urls: [conn('il1')] });
  expect(r.statusCode).toBe(409);
  expect(r.json().error).toMatch(/draft/);
});

test('adding 404s for an unknown campaign and 400s for an empty list', async () => {
  expect((await post('/api/events/999/invitees', { profile_urls: ['x'] })).statusCode).toBe(404);
  const created = (await post('/api/events', { event_url: EVENT, profile_urls: [conn('il0')] })).json();
  expect((await post(`/api/events/${created.event.id}/invitees`, { profile_urls: [] })).statusCode).toBe(400);
});

/* ---------- what the dashboard and the queue read ---------- */

test('/api/status carries an event summary, and it is quiet when unused', async () => {
  const fresh = (await app.inject({ method: 'GET', url: '/api/status' })).json().event;
  expect(fresh.campaigns).toBe(0);       // 0 is what collapses the dashboard conveyor
  expect(fresh.next_run).toBeNull();
  expect(fresh.events_per_day).toBe(1);

  const created = (await post('/api/events', {
    event_url: EVENT,
    profile_urls: [conn('il0'), conn('il1'), conn('uk0', { country: 'United Kingdom', cc: 'GB' })],
  })).json();
  await post(`/api/events/${created.event.id}/arm`, {});

  const s = (await app.inject({ method: 'GET', url: '/api/status' })).json().event;
  expect(s.campaigns).toBe(1);
  expect(s.open).toBe(1);
  expect(s.listed).toBe(3);
  expect(s.up_next).toBe(3);             // both buckets fit under the default ceiling of 10
  expect(s.locations_next).toBe(2);
  expect(s.locations_left).toBe(0);
  expect(s.next_run.event_id).toBe(created.event.id);
  expect(s.running).toBeNull();
});

test('the next run only counts the locations one run will reach', async () => {
  await post('/api/settings', { event_bucket_ceiling: 1 });
  const created = (await post('/api/events', {
    event_url: EVENT,
    profile_urls: [conn('il0'), conn('il1'), conn('uk0', { country: 'United Kingdom', cc: 'GB' })],
  })).json();
  await post(`/api/events/${created.event.id}/arm`, {});

  const s = (await app.inject({ method: 'GET', url: '/api/status' })).json().event;
  expect(s.listed).toBe(3);              // everyone is still on the list...
  expect(s.up_next).toBe(2);             // ...but one run reaches Israel only
  expect(s.locations_next).toBe(1);
  expect(s.locations_left).toBe(1);
});

test('an armed campaign appears in the queue as locations, not profiles', async () => {
  const created = (await post('/api/events', {
    event_url: EVENT,
    profile_urls: [conn('il0'), conn('uk0', { country: 'United Kingdom', cc: 'GB' })],
  })).json();

  // A draft is not queued work: it will never run until somebody arms it.
  expect((await app.inject({ method: 'GET', url: '/api/queue/grouped' })).json().events).toEqual([]);

  await post(`/api/events/${created.event.id}/arm`, {});
  const events = (await app.inject({ method: 'GET', url: '/api/queue/grouped' })).json().events;
  expect(events).toHaveLength(1);
  expect(events[0].id).toBe(created.event.id);
  expect(events[0].pending).toBe(2);
  expect(events[0].buckets.map((b: { label: string }) => b.label)).toEqual(['Israel', 'United Kingdom']);
  expect(events[0].locations_left).toBe(0);
});

test('a new campaign inherits the current caps from settings', async () => {
  await post('/api/settings', { event_invite_cap: 42, event_bucket_ceiling: 3 });
  const created = (await post('/api/events', { event_url: EVENT, profile_urls: [conn('keren')] })).json();
  expect(created.event.invite_cap).toBe(42);
  expect(created.event.bucket_ceiling).toBe(3);
});
