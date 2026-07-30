import { test, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { FakeDriver } from '../../src/browser/driver.js';
import { buildServer } from '../../src/api/server.js';
import type { FastifyInstance } from 'fastify';

let repos: Repos; let driver: FakeDriver; let app: FastifyInstance;

beforeEach(() => {
  repos = new Repos(openDatabase(':memory:'));
  driver = new FakeDriver();
  repos.appState.setLogin({ loggedIn: true, cookieExpiry: null }, '2026-07-31T00:00:00.000Z');
  app = buildServer(repos, driver);
});
afterEach(async () => { await app.close(); });

const CSV = [
  'Notes:', '', 'First Name,Last Name,URL,Company,Position,Connected On',
  'Ada,Lovelace,https://www.linkedin.com/in/ada,Analytical Engines,Mathematician,04 Mar 2024',
  'Grace,Hopper,https://www.linkedin.com/in/grace,US Navy,Rear Admiral,12 Dec 1985',
].join('\n');

test('imports a Connections.csv and reports what happened', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/connections/import', payload: { text: CSV } });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ format: 'csv', parsed: 2, inserted: 2, updated: 0, skipped: 0 });
  expect(repos.connections.findByUrl('https://www.linkedin.com/in/ada')!.current_title).toBe('Mathematician');
  expect(repos.connections.findByUrl('https://www.linkedin.com/in/ada')!.connected_on).toBe('2024-03-04');
});

test('re-importing the same CSV updates rather than duplicates', async () => {
  await app.inject({ method: 'POST', url: '/api/connections/import', payload: { text: CSV } });
  const res = await app.inject({ method: 'POST', url: '/api/connections/import', payload: { text: CSV } });
  expect(res.json()).toMatchObject({ inserted: 0, updated: 2 });
  expect(repos.connections.count()).toBe(2);
});

test('imports a bare URL list', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/connections/import',
    payload: { text: 'https://www.linkedin.com/in/ada\nhttps://www.linkedin.com/in/grace' },
  });
  expect(res.json()).toMatchObject({ format: 'urls', parsed: 2, inserted: 2 });
  expect(repos.connections.findByUrl('https://www.linkedin.com/in/ada')!.source).toBe('urls');
});

test('rejects an empty import with a legible error', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/connections/import', payload: { text: '   ' } });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toMatch(/no linkedin profile urls/i);
});

test('rejects a CSV whose rows have no usable URL', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/connections/import',
    payload: { text: 'First Name,Last Name,URL\nAda,Lovelace,not-a-url' },
  });
  expect(res.statusCode).toBe(400);
});

/**
 * Regression: Fastify's 1 MiB default bodyLimit rejected a real Connections.csv with a
 * bare 413. An 8k-connection export is ~1.15 MiB and LinkedIn allows up to 30k, so the
 * default made the feature's primary input path unusable at real scale.
 */
test('accepts an export larger than Fastify\'s 1 MiB default body limit', async () => {
  const rows = ['First Name,Last Name,URL,Email Address,Company,Position,Connected On'];
  for (let i = 0; i < 9000; i++) {
    rows.push(`First${i},Last${i},https://www.linkedin.com/in/some-person-slug-${i},,Company Name Incorporated ${i},Senior Director of Something,04 Mar 2024`);
  }
  const text = rows.join('\n');
  expect(Buffer.byteLength(text)).toBeGreaterThan(1024 * 1024);

  const res = await app.inject({ method: 'POST', url: '/api/connections/import', payload: { text } });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ inserted: 9000, skipped: 0 });
});

test('stats report totals, the enrichment breakdown and the last sync', async () => {
  await app.inject({ method: 'POST', url: '/api/connections/import', payload: { text: CSV } });
  const res = await app.inject({ method: 'GET', url: '/api/connections/stats' });
  expect(res.json()).toEqual({
    total: 2,
    by_enrich_status: { pending: 2, enriching: 0, enriched: 0, empty: 0, failed: 0 },
    last_synced_at: null,
  });
});

test('lists connections newest-first with pagination', async () => {
  await app.inject({ method: 'POST', url: '/api/connections/import', payload: { text: CSV } });
  const res = await app.inject({ method: 'GET', url: '/api/connections?limit=1&offset=0' });
  const body = res.json();
  expect(body.total).toBe(2);
  expect(body.results).toHaveLength(1);
  expect(body.results[0].profile_url).toBe('https://www.linkedin.com/in/grace');
});

test('list clamps an absurd limit rather than dumping the roster', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/connections?limit=99999' });
  expect(res.json().limit).toBe(200);
});

test('sync-now forces a pass even while paused and reports the result', async () => {
  repos.settings.update({ paused: 1 });
  driver.connectionCards = [{ url: 'https://www.linkedin.com/in/ada', name: 'Ada Lovelace' }];
  const res = await app.inject({ method: 'POST', url: '/api/roster/sync-now' });
  expect(res.json()).toMatchObject({ ran: true, seen: 1, discovered: 1 });
});

test('sync-now reports why a pass did not run instead of failing silently', async () => {
  driver.connectionCards = [];
  const res = await app.inject({ method: 'POST', url: '/api/roster/sync-now' });
  expect(res.json()).toMatchObject({ ran: false, reason: 'empty_read' });
});

test('roster_sync_per_day is settable through /api/settings', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/settings', payload: { roster_sync_per_day: 4 } });
  expect(res.statusCode).toBe(200);
  expect(repos.settings.get().roster_sync_per_day).toBe(4);
});

/* ---------- search + detail (phase 3) ---------- */

function enrich(slug: string, over: Record<string, unknown> = {}): void {
  const url = `https://www.linkedin.com/in/${slug}`;
  repos.connections.upsert({ profile_url: url }, 'csv', '2026-07-01T00:00:00.000Z');
  const [row] = repos.connections.claimForEnrichment(1);
  repos.connections.applyEnrichment(row.id, {
    linkedin_id: `ACoAA-${slug}`, public_identifier: slug, full_name: `Person ${slug}`,
    first_name: 'Person', last_name: slug, headline: 'Chief Information Security Officer',
    location_raw: 'Seattle, Washington, United States', location_city: 'Seattle',
    location_region: 'Washington', location_country: 'United States', location_country_code: 'US',
    current_title: 'Chief Information Security Officer', current_company: 'Acme',
    compact: { name: `Person ${slug}`, skills: ['CISSP'] },
    doc: `Person ${slug}
Chief Information Security Officer
Seattle
Acme
CISSP`,
    ...over,
  } as never, '2026-07-30T00:00:00.000Z');
}

test('search returns compact rows, match evidence and coverage', async () => {
  enrich('a');
  repos.connections.upsert({ profile_url: 'https://www.linkedin.com/in/notyet' }, 'csv', '2026-07-01T00:00:00.000Z');

  const res = await app.inject({
    method: 'POST', url: '/api/connections/search',
    payload: { title_any: ['Chief Information Security'], location_any: ['Seattle'] },
  });

  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.total).toBe(1);
  expect(body.results[0].full_name).toBe('Person a');
  expect(body.results[0].matched.location_any).toEqual(['Seattle']);
  expect(body.coverage).toEqual({ total: 2, enriched: 1, pending: 1, unresolvable: 0 });
});

test('search accepts a bare string where an array is expected', async () => {
  enrich('a');
  const res = await app.inject({
    method: 'POST', url: '/api/connections/search', payload: { location_any: 'Seattle' },
  });
  expect(res.json().total).toBe(1);
});

test('an empty search body is valid and returns the enriched corpus', async () => {
  enrich('a'); enrich('b');
  expect((await app.inject({ method: 'POST', url: '/api/connections/search', payload: {} })).json().total).toBe(2);
});

test('GET /api/connections/:slug returns the full stored payload', async () => {
  enrich('a');
  const res = await app.inject({ method: 'GET', url: '/api/connections/a' });
  expect(res.statusCode).toBe(200);
  expect(res.json().full_name).toBe('Person a');
  expect(res.json().profile.skills).toEqual(['CISSP']);
  // raw_json is unwrapped into `profile`, never echoed as a JSON string.
  expect(res.json().raw_json).toBeUndefined();
});

test('the detail route does not shadow /api/connections/stats', async () => {
  enrich('a');
  const res = await app.inject({ method: 'GET', url: '/api/connections/stats' });
  expect(res.json().total).toBe(1);
  expect(res.json().by_enrich_status).toBeDefined();
});

test('detail 404s for an unknown slug', async () => {
  expect((await app.inject({ method: 'GET', url: '/api/connections/nobody' })).statusCode).toBe(404);
});

test('an old slug still resolves through its alias after a merge', async () => {
  // The SAME person under two public slugs — that is what a slug change looks like, and it
  // is the linkedin_id (not the URL) that identifies them.
  enrich('old-slug', { linkedin_id: 'ACoAA-same-human' });
  enrich('new-slug', { linkedin_id: 'ACoAA-same-human' });

  const res = await app.inject({ method: 'GET', url: '/api/connections/new-slug' });
  expect(res.statusCode).toBe(200);
  expect(res.json().profile_url).toBe('https://www.linkedin.com/in/old-slug');
});
