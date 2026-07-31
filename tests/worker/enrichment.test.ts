/**
 * Enrichment worker. Every test here uses a FakeApifyClient — no test may ever spend money.
 *
 * The invariants that matter: the pool must not exceed its concurrency (that is the
 * operator's Apify plan limit), one bad profile must not abort a 7,000-row run, and a pause
 * must never strand a row in `enriching` where nothing will ever claim it again.
 */
import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { runEnrichment, enrichmentProgress } from '../../src/worker/enrichment.js';
import type { ApifyClient } from '../../src/core/apify-client.js';
import type { ApifyProfile } from '../../src/types.js';

let repos: Repos;
beforeEach(() => { repos = new Repos(openDatabase(':memory:')); });

function seed(n: number): void {
  for (let i = 0; i < n; i++) {
    repos.connections.upsert({ profile_url: `https://www.linkedin.com/in/p${i}` }, 'csv', '2026-07-01T00:00:00.000Z');
  }
}

/** Records concurrency and lets individual URLs be scripted to fail or come back empty. */
class FakeApifyClient implements ApifyClient {
  inFlight = 0;
  maxInFlight = 0;
  calls: string[] = [];
  failFor = new Set<string>();
  emptyFor = new Set<string>();
  delayMs = 0;

  async fetchProfile(url: string): Promise<ApifyProfile> {
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    this.calls.push(url);
    try {
      if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
      if (this.failFor.has(url)) throw new Error('apify exploded');
      if (this.emptyFor.has(url)) return {}; // silent-empty shell
      const slug = url.split('/in/')[1];
      return {
        id: `ACoAA-${slug}`, publicIdentifier: slug, linkedinUrl: url,
        firstName: 'Person', lastName: slug, headline: 'Security Engineer',
        location: { linkedinText: 'Seattle, Washington, United States', countryCode: 'US',
          parsed: { city: 'Seattle', state: 'Washington', countryFull: 'United States', countryCode: 'US' } },
        currentPosition: [{ position: 'Security Engineer', companyName: 'Acme' }],
      };
    } finally {
      this.inFlight--;
    }
  }
}

test('drains every pending row and reports the outcome split', async () => {
  seed(5);
  const client = new FakeApifyClient();

  const r = await runEnrichment(repos, { client, concurrency: 3 });

  expect(r).toMatchObject({ enriched: 5, empty: 0, failed: 0 });
  expect(repos.connections.countsByEnrichStatus()).toMatchObject({ enriched: 5, pending: 0, enriching: 0 });
});

test('extracted data lands on the row and in the search index', async () => {
  seed(1);
  await runEnrichment(repos, { client: new FakeApifyClient(), concurrency: 1 });

  const c = repos.connections.findByUrl('https://www.linkedin.com/in/p0')!;
  expect(c.current_title).toBe('Security Engineer');
  expect(c.location_city).toBe('Seattle');
  expect(c.location_country_code).toBe('US');

  const hit = repos.db.prepare("SELECT rowid FROM connections_fts WHERE connections_fts MATCH 'seattle'").get() as { rowid: number };
  expect(hit.rowid).toBe(c.id);
});

test('never exceeds the configured concurrency', async () => {
  seed(20);
  const client = new FakeApifyClient();
  client.delayMs = 5; // hold requests open so overlap is observable

  await runEnrichment(repos, { client, concurrency: 4 });

  expect(client.maxInFlight).toBeLessThanOrEqual(4);
  expect(client.maxInFlight).toBeGreaterThan(1); // ...but it IS running in parallel
});

test('one failing profile does not abort the run', async () => {
  seed(5);
  const client = new FakeApifyClient();
  client.failFor.add('https://www.linkedin.com/in/p2');

  const r = await runEnrichment(repos, { client, concurrency: 2, maxAttempts: 1 });

  expect(r.enriched).toBe(4);
  expect(r.failed).toBe(1);
  expect(repos.connections.findByUrl('https://www.linkedin.com/in/p2')!.enrich_status).toBe('failed');
});

test('a silent-empty shell is parked as empty, not counted as enriched', async () => {
  seed(3);
  const client = new FakeApifyClient();
  client.emptyFor.add('https://www.linkedin.com/in/p1');

  const r = await runEnrichment(repos, { client, concurrency: 2 });

  expect(r).toMatchObject({ enriched: 2, empty: 1 });
  expect(repos.connections.findByUrl('https://www.linkedin.com/in/p1')!.enrich_status).toBe('empty');
});

test('retries a transient failure within the same run and can still succeed', async () => {
  seed(1);
  const url = 'https://www.linkedin.com/in/p0';
  const client = new FakeApifyClient();
  // Fail only the FIRST call, then behave normally — a transient Apify blip.
  const original = client.fetchProfile.bind(client);
  let n = 0;
  client.fetchProfile = async (u: string) => { if (++n === 1) throw new Error('blip'); return original(u); };

  const r = await runEnrichment(repos, { client, concurrency: 1, maxAttempts: 3 });

  expect(r.enriched).toBe(1);
  expect(repos.connections.findByUrl(url)!.enrich_status).toBe('enriched');
});

test('pause stops claiming and strands nothing in enriching', async () => {
  seed(40);
  const client = new FakeApifyClient();
  client.delayMs = 5;
  const controller = new AbortController();

  const run = runEnrichment(repos, { client, concurrency: 4 }, { signal: controller.signal });
  await new Promise((r) => setTimeout(r, 25));
  controller.abort();
  const r = await run;

  expect(r.stopped).toBe(true);
  // The whole point: a paused run leaves NO row in `enriching`, or those rows would be
  // permanently unclaimable and silently missing from search forever.
  expect(repos.connections.countsByEnrichStatus().enriching).toBe(0);
  expect(client.calls.length).toBeLessThan(40); // it really did stop early
});

test('a paused run is resumable and finishes the remainder', async () => {
  seed(20);
  const client = new FakeApifyClient();
  client.delayMs = 5;
  const controller = new AbortController();
  const run = runEnrichment(repos, { client, concurrency: 4 }, { signal: controller.signal });
  await new Promise((r) => setTimeout(r, 20));
  controller.abort();
  await run;

  const done = repos.connections.countsByEnrichStatus().enriched;
  expect(done).toBeGreaterThan(0);
  expect(done).toBeLessThan(20);

  const second = await runEnrichment(repos, { client: new FakeApifyClient(), concurrency: 4 });

  expect(second.enriched).toBe(20 - done);
  expect(repos.connections.countsByEnrichStatus()).toMatchObject({ enriched: 20, pending: 0, enriching: 0 });
});

test('an empty queue is a no-op, not an error', async () => {
  const r = await runEnrichment(repos, { client: new FakeApifyClient(), concurrency: 4 });
  expect(r).toMatchObject({ enriched: 0, empty: 0, failed: 0 });
});

test('progress reports the live breakdown', async () => {
  seed(4);
  const client = new FakeApifyClient();
  client.emptyFor.add('https://www.linkedin.com/in/p0');
  await runEnrichment(repos, { client, concurrency: 2 });

  const p = enrichmentProgress(repos);
  expect(p).toMatchObject({ running: false, total: 4, enriched: 3, empty: 1, pending: 0 });
});
