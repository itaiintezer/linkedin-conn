/**
 * The halt surfaces over HTTP so the dashboard can alert on it, and clears when the operator
 * says they have fixed the problem. A fake client throughout — no test spends money.
 */
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
  app = buildServer(repos, new FakeDriver(), undefined, undefined, { apifyClientFactory: () => fakeClient });
});
afterEach(async () => {
  pauseEnrichment();
  for (let i = 0; i < 50 && isEnrichmentRunning(); i++) await new Promise((r) => setTimeout(r, 5));
  await app.close();
});

const HALT_AT = '2026-07-31T12:00:00.000Z';
const seed = (n: number): void => {
  for (let i = 0; i < n; i++) {
    repos.connections.upsert({ profile_url: `https://www.linkedin.com/in/p${i}` }, 'scrape', HALT_AT);
  }
};

test('enrichment status reports no halt when everything is fine', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/enrichment/status' });
  expect(res.json().halt).toBeNull();
});

test('enrichment status reports the halt reason, detail and time', async () => {
  repos.appState.haltEnrichment('auth', 'Apify run failed (HTTP 401)', HALT_AT);

  const halt = (await app.inject({ method: 'GET', url: '/api/enrichment/status' })).json().halt;

  expect(halt).toMatchObject({ reason: 'auth', detail: 'Apify run failed (HTTP 401)', at: HALT_AT });
});

test('the dashboard status carries the halt too, so the banner needs no second poll', async () => {
  repos.appState.haltEnrichment('no_api_key', 'No Apify API key is configured.', HALT_AT);

  const body = (await app.inject({ method: 'GET', url: '/api/status' })).json();

  expect(body.enrich_halt).toMatchObject({ reason: 'no_api_key', at: HALT_AT });
});

test('/api/status reports null when un-halted, not a half-filled object', async () => {
  expect((await app.inject({ method: 'GET', url: '/api/status' })).json().enrich_halt).toBeNull();
});

test('resume clears the latch and starts a run', async () => {
  repos.settings.update({ apify_api_key: 'k' });
  seed(3);
  repos.appState.haltEnrichment('auth', 'bad key', HALT_AT);

  const res = await app.inject({ method: 'POST', url: '/api/enrichment/resume' });

  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ resumed: true });
  expect(repos.appState.get().enrich_halted).toBe(0);
});

test('resume without a key reports the problem instead of pretending to resume', async () => {
  seed(1);
  repos.appState.haltEnrichment('no_api_key', 'No Apify API key is configured.', HALT_AT);

  const res = await app.inject({ method: 'POST', url: '/api/enrichment/resume' });

  expect(res.statusCode).toBe(400);
  expect(res.json().error).toMatch(/Apify API key/i);
});

test('manual Start clears a halt — clicking it IS the operator saying they fixed it', async () => {
  repos.settings.update({ apify_api_key: 'k' });
  seed(2);
  repos.appState.haltEnrichment('repeated_errors', '5 profiles failed in a row', HALT_AT);

  const res = await app.inject({ method: 'POST', url: '/api/enrichment/start' });

  expect(res.statusCode).toBe(200);
  expect(repos.appState.get().enrich_halted).toBe(0);
});

test('a halt does not block the per-person Refresh button', async () => {
  // One deliberate profile is the operator testing whether the problem is fixed.
  repos.settings.update({ apify_api_key: 'k' });
  seed(1);
  repos.appState.haltEnrichment('auth', 'bad key', HALT_AT);

  const res = await app.inject({ method: 'POST', url: '/api/connections/p0/refresh' });

  expect(res.statusCode).toBe(200);
  expect(res.json().status).toBe('enriched');
});
