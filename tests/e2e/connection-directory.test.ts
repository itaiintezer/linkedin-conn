/**
 * The whole capability, end to end, with a faked Apify client:
 *   import a Connections.csv -> enrich it -> search it -> drill into one person.
 *
 * This is the test that would catch a break in the seam between the four pieces, which unit
 * tests by construction cannot.
 */
import { test, expect } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { FakeDriver } from '../../src/browser/driver.js';
import { buildServer } from '../../src/api/server.js';
import { isEnrichmentRunning } from '../../src/worker/enrichment.js';
import type { ApifyClient } from '../../src/core/apify-client.js';
import type { ApifyProfile } from '../../src/types.js';

/** Three real-shaped payloads: a Seattle CISO, a Seattle physical-security manager, and a
 *  London engineer who used to run security at Microsoft. */
const PROFILES: Record<string, ApifyProfile> = {
  ada: {
    id: 'ACoAA-ada', publicIdentifier: 'ada', firstName: 'Ada', lastName: 'Sec',
    headline: 'CISO | Cloud security',
    location: { linkedinText: 'Greater Seattle Area', countryCode: 'US',
      parsed: { city: 'Seattle', state: 'Washington', country: 'US', countryFull: 'United States', countryCode: 'US' } },
    currentPosition: [{ position: 'Chief Information Security Officer', companyName: 'Amazon' }],
    experience: [{ position: 'Chief Information Security Officer', companyName: 'Amazon' }],
    skills: [{ name: 'Incident Response' }, { name: 'CISSP' }],
  },
  cara: {
    id: 'ACoAA-cara', publicIdentifier: 'cara', firstName: 'Cara', lastName: 'Guard',
    headline: 'Physical Security Manager',
    location: { linkedinText: 'Seattle, Washington, United States', countryCode: 'US',
      parsed: { city: 'Seattle', state: 'Washington', country: 'US', countryFull: 'United States', countryCode: 'US' } },
    currentPosition: [{ position: 'Physical Security Manager', companyName: 'Boeing' }],
    experience: [{ position: 'Physical Security Manager', companyName: 'Boeing' }],
  },
  fay: {
    id: 'ACoAA-fay', publicIdentifier: 'fay', firstName: 'Fay', lastName: 'Past',
    headline: 'VP Engineering',
    location: { linkedinText: 'London Area, United Kingdom', countryCode: 'GB',
      parsed: { city: 'London', state: 'England', country: 'UK', countryFull: 'United Kingdom', countryCode: 'GB' } },
    currentPosition: [{ position: 'VP Engineering', companyName: 'Stripe' }],
    experience: [
      { position: 'VP Engineering', companyName: 'Stripe' },
      { position: 'Head of Security', companyName: 'Microsoft' },
    ],
  },
};

const fakeClient: ApifyClient = {
  async fetchProfile(url: string): Promise<ApifyProfile> {
    await new Promise((r) => setTimeout(r, 1));
    const slug = url.split('/in/')[1];
    const p = PROFILES[slug];
    if (!p) return {};            // unknown slug => silent-empty shell
    return p;
  },
};

const CSV = [
  'Notes:', '', 'First Name,Last Name,URL,Company,Position,Connected On',
  'Ada,Sec,https://www.linkedin.com/in/ada,Amazon,CISO,04 Mar 2024',
  'Cara,Guard,https://www.linkedin.com/in/cara,Boeing,Security Manager,11 Jun 2022',
  'Fay,Past,https://www.linkedin.com/in/fay,Stripe,VP Engineering,02 Feb 2021',
  'Ghost,Gone,https://www.linkedin.com/in/ghost,,,15 Jan 2020',
].join('\n');

test('import -> enrich -> search -> detail', async () => {
  const repos = new Repos(openDatabase(':memory:'));
  const app = buildServer(repos, new FakeDriver(), undefined, undefined, { apifyClientFactory: () => fakeClient });
  repos.settings.update({ apify_api_key: 'test-key', enrich_concurrency: 2 });

  // 1. Import the export.
  const imported = await app.inject({ method: 'POST', url: '/api/connections/import', payload: { text: CSV } });
  expect(imported.json()).toMatchObject({ format: 'csv', inserted: 4, skipped: 0 });
  // The CSV alone gives title/company/connected_on, but no location — that needs enrichment.
  expect(repos.connections.findByUrl('https://www.linkedin.com/in/ada')!.connected_on).toBe('2024-03-04');
  expect(repos.connections.findByUrl('https://www.linkedin.com/in/ada')!.location_city).toBeNull();

  // 2. Search before enrichment finds nothing, and says why.
  const early = await app.inject({ method: 'POST', url: '/api/connections/search', payload: { location_any: ['Seattle'] } });
  expect(early.json().total).toBe(0);
  expect(early.json().coverage).toMatchObject({ enriched: 0, pending: 4 });

  // 3. Enrich.
  const started = await app.inject({ method: 'POST', url: '/api/enrichment/start' });
  expect(started.json()).toMatchObject({ started: true, queued: 4 });
  // Wait for the worker to actually finish rather than sleeping a fixed span: under CPU
  // contention a fixed wait is a flaky test, and this one did flake once in a full run.
  for (let i = 0; i < 500 && isEnrichmentRunning(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(isEnrichmentRunning()).toBe(false);

  const counts = repos.connections.countsByEnrichStatus();
  expect(counts.enriched).toBe(3);
  expect(counts.empty).toBe(1);   // the deleted profile came back as a shell

  // Enrichment overwrote the provisional CSV title and filled the parsed location.
  const ada = repos.connections.findByUrl('https://www.linkedin.com/in/ada')!;
  expect(ada.current_title).toBe('Chief Information Security Officer');
  expect(ada.location_city).toBe('Seattle');
  expect(ada.location_country_code).toBe('US');
  expect(ada.connected_on).toBe('2024-03-04'); // CSV value survives — it is immutable

  // 4. The flagship query.
  const found = await app.inject({
    method: 'POST', url: '/api/connections/search',
    payload: {
      title_any: ['CISO', 'Chief Information Security', 'SOC', 'appsec'],
      location_any: ['Seattle'],
      exclude_any: ['physical security'],
    },
  });
  const body = found.json();
  expect(body.results.map((r: { full_name: string }) => r.full_name)).toEqual(['Ada Sec']);
  expect(body.results[0].matched).toMatchObject({ location_any: ['Seattle'] });
  expect(body.coverage).toEqual({ total: 4, enriched: 3, pending: 0, unresolvable: 1 });

  // 5. Past roles are opt-in.
  const now = await app.inject({ method: 'POST', url: '/api/connections/search', payload: { company_any: ['Microsoft'] } });
  expect(now.json().total).toBe(0);
  const ever = await app.inject({
    method: 'POST', url: '/api/connections/search',
    payload: { company_any: ['Microsoft'], include_past_roles: true },
  });
  expect(ever.json().results.map((r: { full_name: string }) => r.full_name)).toEqual(['Fay Past']);

  // 6. Drill into one person.
  const detail = await app.inject({ method: 'GET', url: '/api/connections/ada' });
  expect(detail.json().full_name).toBe('Ada Sec');
  expect(detail.json().profile.skills).toEqual(['Incident Response', 'CISSP']);

  await app.close();
});
