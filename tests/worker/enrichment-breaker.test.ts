/**
 * The circuit breaker. Automatic enrichment runs unattended, so a broken account must stop
 * the run and raise an alert — never quietly grind the whole roster into `failed` rows,
 * which are manual-re-arm-only by design.
 *
 * As everywhere in this suite: a FakeApifyClient, so no test spends money.
 */
import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { runEnrichment } from '../../src/worker/enrichment.js';
import type { ApifyClient } from '../../src/core/apify-client.js';
import type { ApifyProfile } from '../../src/types.js';

let repos: Repos;
beforeEach(() => { repos = new Repos(openDatabase(':memory:')); });

function seed(n: number): void {
  for (let i = 0; i < n; i++) {
    repos.connections.upsert({ profile_url: `https://www.linkedin.com/in/p${i}` }, 'csv', '2026-07-01T00:00:00.000Z');
  }
}

const profileFor = (url: string): ApifyProfile => {
  const slug = url.split('/in/')[1];
  return {
    id: `ACoAA-${slug}`, publicIdentifier: slug, linkedinUrl: url,
    firstName: 'Person', lastName: slug, headline: 'Security Engineer',
    location: { linkedinText: 'Seattle, Washington, United States', countryCode: 'US',
      parsed: { city: 'Seattle', state: 'Washington', countryFull: 'United States', countryCode: 'US' } },
    currentPosition: [{ position: 'Security Engineer', companyName: 'Acme' }],
  };
};

/** Throws a scripted message for the first `failCount` calls, then succeeds. */
class ScriptedClient implements ApifyClient {
  calls = 0;
  constructor(private message: string, private failCount = Infinity) {}
  async fetchProfile(url: string): Promise<ApifyProfile> {
    this.calls++;
    if (this.calls <= this.failCount) throw new Error(this.message);
    return profileFor(url);
  }
}

test('a rejected API key halts the run and leaves every row pending with no attempts spent', async () => {
  // The whole point: 401 means the KEY is wrong, not that these people are unscrapeable.
  // Charging attempts here would park the roster as `failed` after three auto-drain cycles.
  seed(20);
  const client = new ScriptedClient('Apify run failed (HTTP 401)');

  const r = await runEnrichment(repos, { client, concurrency: 4 });

  expect(r.haltReason).toBe('auth');
  expect(r.failed).toBe(0);
  expect(repos.connections.countsByEnrichStatus()).toMatchObject({ pending: 20, failed: 0, enriching: 0 });
  const row = repos.connections.findByUrl('https://www.linkedin.com/in/p0')!;
  expect(row.enrich_attempts).toBe(0);
});

test('the halt is latched in app_state for the dashboard to render', async () => {
  seed(3);
  await runEnrichment(repos, { client: new ScriptedClient('Apify run failed (HTTP 402)'), concurrency: 1 });

  const a = repos.appState.get();
  expect(a.enrich_halted).toBe(1);
  expect(a.enrich_halt_reason).toBe('billing');
  expect(a.enrich_halt_detail).toContain('402');
  expect(a.enrich_halted_at).not.toBeNull();
});

test('an account-level failure stops the run early instead of walking the queue', async () => {
  // 500 rows must not become 500 doomed requests.
  seed(50);
  const client = new ScriptedClient('Apify run failed (HTTP 503)');

  await runEnrichment(repos, { client, concurrency: 2 });

  // Bounded by the in-flight pool, not the queue: each worker discovers the outage once.
  expect(client.calls).toBeLessThanOrEqual(4);
  expect(repos.appState.get().enrich_halt_reason).toBe('upstream');
});

test('five consecutive profile-level failures halt the run', async () => {
  seed(30);
  const client = new ScriptedClient('apify exploded');

  const r = await runEnrichment(repos, { client, concurrency: 1 });

  expect(r.haltReason).toBe('repeated_errors');
  expect(repos.appState.get().enrich_halt_reason).toBe('repeated_errors');
  // Profile-level errors DO cost attempts — the row genuinely was tried.
  expect(repos.connections.findByUrl('https://www.linkedin.com/in/p0')!.enrich_attempts).toBe(1);
});

test('a success resets the streak, so scattered bad profiles never halt a big run', async () => {
  // The original promise of this worker: one restricted profile must not abort 7,000 rows.
  seed(12);
  let n = 0;
  const client: ApifyClient = {
    async fetchProfile(url: string): Promise<ApifyProfile> {
      n++;
      if (n % 2 === 1) throw new Error('apify exploded'); // every other one fails
      return profileFor(url);
    },
  };

  const r = await runEnrichment(repos, { client, concurrency: 1 });

  expect(r.haltReason).toBeUndefined();
  expect(repos.appState.get().enrich_halted).toBe(0);
  expect(r.enriched).toBeGreaterThan(0);
});

test('a run that enriches anything clears a previous halt', async () => {
  repos.appState.haltEnrichment('auth', 'stale halt from yesterday', '2026-07-30T00:00:00.000Z');
  seed(2);

  await runEnrichment(repos, { client: new ScriptedClient('unused', 0), concurrency: 1 });

  expect(repos.appState.get().enrich_halted).toBe(0);
});

test('an empty run does not clear a halt it never disproved', async () => {
  // Nothing pending means nothing was tried, so the recorded problem still stands.
  repos.appState.haltEnrichment('auth', 'bad key', '2026-07-30T00:00:00.000Z');

  await runEnrichment(repos, { client: new ScriptedClient('unused', 0), concurrency: 1 });

  expect(repos.appState.get().enrich_halted).toBe(1);
});
