import { test, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { FakeDriver } from '../../src/browser/driver.js';
import { buildServer } from '../../src/api/server.js';
import type { ApifyClient } from '../../src/core/apify-client.js';
import type { ApifyProfile } from '../../src/types.js';
import type { FastifyInstance } from 'fastify';
import { pauseEnrichment, isEnrichmentRunning } from '../../src/worker/enrichment.js';

let repos: Repos; let app: FastifyInstance;

const fakeClient: ApifyClient = {
  async fetchProfile(url: string): Promise<ApifyProfile> {
    // A small delay keeps a run genuinely in flight across an await boundary. Without it an
    // instant fake drains hundreds of rows before the next request lands, and the
    // already-running / pause paths would never be exercised. Real runs take ~5s per profile.
    await new Promise((r) => setTimeout(r, 2));
    const slug = url.split('/in/')[1];
    return {
      id: `ACoAA-${slug}`, publicIdentifier: slug, linkedinUrl: url,
      firstName: 'Person', lastName: slug, headline: 'Security Engineer',
      location: { linkedinText: 'Seattle, Washington, United States', countryCode: 'US',
        parsed: { city: 'Seattle', state: 'Washington', countryFull: 'United States', countryCode: 'US' } },
      currentPosition: [{ position: 'Security Engineer', companyName: 'Acme' }],
    };
  },
};

beforeEach(() => {
  repos = new Repos(openDatabase(':memory:'));
  // A fake client is injected so no test can reach Apify or spend money.
  app = buildServer(repos, new FakeDriver(), undefined, undefined, { apifyClientFactory: () => fakeClient });
});
afterEach(async () => {
  // The in-flight run is module-level state (one run per process, by design), so a test
  // that leaves one running would make the next test see a phantom 409. Stop and settle.
  pauseEnrichment();
  for (let i = 0; i < 50 && isEnrichmentRunning(); i++) await new Promise((r) => setTimeout(r, 5));
  await app.close();
});

function seed(n: number): void {
  for (let i = 0; i < n; i++) {
    repos.connections.upsert({ profile_url: `https://www.linkedin.com/in/p${i}` }, 'csv', '2026-07-01T00:00:00.000Z');
  }
}
const withKey = (): void => { repos.settings.update({ apify_api_key: 'test-key' }); };

test('GET /api/settings never returns the Apify key', async () => {
  repos.settings.update({ apify_api_key: 'SUPER-SECRET-TOKEN' });

  const res = await app.inject({ method: 'GET', url: '/api/settings' });

  // Assert on the RAW body: a nested or renamed field would still be a leak.
  expect(res.body).not.toContain('SUPER-SECRET-TOKEN');
  expect(res.json().apify_api_key).toBeUndefined();
  expect(res.json().apify_key_set).toBe(true);
});

test('apify_key_set is false when no key is configured', async () => {
  expect((await app.inject({ method: 'GET', url: '/api/settings' })).json().apify_key_set).toBe(false);
});

test('POST /api/settings persists the Apify key', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/settings', payload: { apify_api_key: 'k123' } });
  expect(res.statusCode).toBe(200);
  expect(repos.settings.get().apify_api_key).toBe('k123');
});

test('start refuses without an API key, and says so actionably', async () => {
  seed(3);
  const res = await app.inject({ method: 'POST', url: '/api/enrichment/start' });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toMatch(/apify/i);
});

test('start reports the queue size and estimated cost', async () => {
  withKey(); seed(250);
  const res = await app.inject({ method: 'POST', url: '/api/enrichment/start' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ started: true, queued: 250 });
  expect(res.json().estimated_cost_usd).toBeCloseTo(1.0, 2); // 250 * $0.004
});

test('start enriches the queue and the results are searchable', async () => {
  withKey(); seed(4);
  await app.inject({ method: 'POST', url: '/api/enrichment/start' });
  await new Promise((r) => setTimeout(r, 60)); // the run is kicked off in the background

  expect(repos.connections.countsByEnrichStatus().enriched).toBe(4);
  const n = repos.db.prepare("SELECT COUNT(*) c FROM connections_fts WHERE connections_fts MATCH 'seattle'").get() as { c: number };
  expect(n.c).toBe(4);
});

test('GET /api/enrichment/status is safe to poll while idle', async () => {
  seed(2);
  const res = await app.inject({ method: 'GET', url: '/api/enrichment/status' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ running: false, total: 2, pending: 2, enriched: 0 });
});

test('a second start while running is rejected rather than doubling the spend', async () => {
  withKey(); seed(300);
  const first = await app.inject({ method: 'POST', url: '/api/enrichment/start' });
  expect(first.statusCode).toBe(200);
  const second = await app.inject({ method: 'POST', url: '/api/enrichment/start' });
  expect(second.statusCode).toBe(409);
  await app.inject({ method: 'POST', url: '/api/enrichment/pause' });
});

test('pause stops the run and strands nothing', async () => {
  withKey(); seed(300);
  await app.inject({ method: 'POST', url: '/api/enrichment/start' });
  const res = await app.inject({ method: 'POST', url: '/api/enrichment/pause' });

  expect(res.json()).toMatchObject({ paused: true });
  await new Promise((r) => setTimeout(r, 60));
  expect(repos.connections.countsByEnrichStatus().enriching).toBe(0);
});

test('pause on an idle engine reports that nothing was running', async () => {
  expect((await app.inject({ method: 'POST', url: '/api/enrichment/pause' })).json()).toMatchObject({ paused: false });
});

test('retry-failed re-arms parked rows', async () => {
  seed(2);
  const rows = repos.connections.claimForEnrichment(2);
  repos.connections.markEnrichFailure(rows[0].id, 'boom', 1);
  repos.connections.markEnrichEmpty(rows[1].id);

  const res = await app.inject({ method: 'POST', url: '/api/enrichment/retry-failed' });

  expect(res.json()).toMatchObject({ requeued: 2 });
  expect(repos.connections.countsByEnrichStatus().pending).toBe(2);
});

test('refresh enriches a single connection on demand', async () => {
  withKey(); seed(1);
  const res = await app.inject({ method: 'POST', url: '/api/connections/p0/refresh' });

  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ status: 'enriched' });
  expect(repos.connections.findByUrl('https://www.linkedin.com/in/p0')!.current_title).toBe('Security Engineer');
});

test('refresh 404s on an unknown slug', async () => {
  withKey();
  expect((await app.inject({ method: 'POST', url: '/api/connections/nobody/refresh' })).statusCode).toBe(404);
});
