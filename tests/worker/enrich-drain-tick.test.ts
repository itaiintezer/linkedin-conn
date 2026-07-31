/**
 * The drain tick — the piece whose absence was the bug. Rows have always enqueued
 * themselves (`enrich_status` defaults to 'pending'), but nothing ever consumed them, so a
 * connection discovered by roster sync stayed un-enriched forever.
 *
 * The tick deliberately asks "is there work?" and never "where did the work come from?" —
 * import, roster discovery, TTL sweep and crash recovery all converge on 'pending', so one
 * consumer serves every producer, present and future.
 */
import { test, expect, beforeEach, vi } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { FakeDriver } from '../../src/browser/driver.js';
import { Orchestrator } from '../../src/worker/orchestrator.js';
import { isEnrichmentRunning } from '../../src/worker/enrichment.js';
import type { ApifyClient } from '../../src/core/apify-client.js';
import type { ApifyProfile } from '../../src/types.js';

let repos: Repos; let driver: FakeDriver;
const NOW = new Date('2026-07-31T10:00:00.000Z');

beforeEach(() => { repos = new Repos(openDatabase(':memory:')); driver = new FakeDriver(); });

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

/** Counts how many clients were built, so "never spends" can be asserted precisely. */
function fakeFactory(): { factory: (t: string) => ApifyClient; built: string[]; calls: string[] } {
  const built: string[] = [];
  const calls: string[] = [];
  return {
    built,
    calls,
    factory: (token: string) => {
      built.push(token);
      return { async fetchProfile(url: string) { calls.push(url); return profileFor(url); } };
    },
  };
}

function seedPending(n: number): void {
  for (let i = 0; i < n; i++) {
    repos.connections.upsert({ profile_url: `https://www.linkedin.com/in/p${i}` }, 'scrape', NOW.toISOString());
  }
}

/** The tick fires the run and does not await it; give the microtask queue a moment. */
const settle = async (): Promise<void> => { for (let i = 0; i < 20 && isEnrichmentRunning(); i++) await new Promise((r) => setTimeout(r, 5)); };

test('enriches a connection roster sync just discovered — no click required', async () => {
  repos.settings.update({ apify_api_key: 'k' });
  seedPending(3);
  const f = fakeFactory();

  await new Orchestrator(repos, driver, undefined, {}, f.factory).runEnrichDrainTick(NOW);
  await settle();

  expect(repos.connections.countsByEnrichStatus()).toMatchObject({ enriched: 3, pending: 0 });
});

test('does nothing at all when the queue is empty — the steady state must be free', async () => {
  repos.settings.update({ apify_api_key: 'k' });
  const f = fakeFactory();

  await new Orchestrator(repos, driver, undefined, {}, f.factory).runEnrichDrainTick(NOW);

  expect(f.built).toEqual([]); // no client constructed, so not a single network call
});

test('respects Pause — a paused Relay does not spend money on its own', async () => {
  repos.settings.update({ apify_api_key: 'k', paused: 1 });
  seedPending(2);
  const f = fakeFactory();

  await new Orchestrator(repos, driver, undefined, {}, f.factory).runEnrichDrainTick(NOW);
  await settle();

  expect(f.built).toEqual([]);
  expect(repos.connections.countsByEnrichStatus().pending).toBe(2);
});

test('ignores a tripped guardrail — that is LinkedIn session health, Apify is unaffected', async () => {
  repos.settings.update({ apify_api_key: 'k' });
  repos.appState.trip('checkpoint', 'captcha', NOW.toISOString());
  seedPending(2);
  const f = fakeFactory();

  await new Orchestrator(repos, driver, undefined, {}, f.factory).runEnrichDrainTick(NOW);
  await settle();

  expect(repos.connections.countsByEnrichStatus().enriched).toBe(2);
});

test('halts with no_api_key when there is work but no key, so the dashboard can say so', async () => {
  seedPending(2);
  const f = fakeFactory();

  await new Orchestrator(repos, driver, undefined, {}, f.factory).runEnrichDrainTick(NOW);

  const a = repos.appState.get();
  expect(a.enrich_halted).toBe(1);
  expect(a.enrich_halt_reason).toBe('no_api_key');
  expect(f.built).toEqual([]);
});

test('stays quiet about a missing key when there is nothing to enrich anyway', async () => {
  // A fresh install with an empty roster must not nag about a credential it does not need.
  await new Orchestrator(repos, driver, undefined, {}, fakeFactory().factory).runEnrichDrainTick(NOW);

  expect(repos.appState.get().enrich_halted).toBe(0);
});

test('a latched halt stops the tick retrying every 60 seconds', async () => {
  repos.settings.update({ apify_api_key: 'k' });
  seedPending(2);
  repos.appState.haltEnrichment('auth', 'Apify run failed (HTTP 401)', NOW.toISOString());
  const f = fakeFactory();

  await new Orchestrator(repos, driver, undefined, {}, f.factory).runEnrichDrainTick(NOW);

  expect(f.built).toEqual([]);
});

test('does not start a second run on top of a live one', async () => {
  repos.settings.update({ apify_api_key: 'k' });
  seedPending(40);
  const built: string[] = [];
  const slowFactory = (token: string): ApifyClient => {
    built.push(token);
    return { async fetchProfile(url: string) { await new Promise((r) => setTimeout(r, 20)); return profileFor(url); } };
  };
  const orch = new Orchestrator(repos, driver, undefined, {}, slowFactory);

  await orch.runEnrichDrainTick(NOW);   // starts a run
  await orch.runEnrichDrainTick(NOW);   // a tick 60s later, mid-run
  await settle();

  expect(built).toHaveLength(1);
});

test('picks up the token currently in settings, so re-keying takes effect next tick', async () => {
  repos.settings.update({ apify_api_key: 'first' });
  seedPending(1);
  const f = fakeFactory();
  const orch = new Orchestrator(repos, driver, undefined, {}, f.factory);

  await orch.runEnrichDrainTick(NOW);
  await settle();
  repos.settings.update({ apify_api_key: 'second' });
  seedPending(2);
  await orch.runEnrichDrainTick(NOW);
  await settle();

  expect(f.built).toEqual(['first', 'second']);
});

test('start() sweeps TTL-stale rows immediately, not six hours later', () => {
  // A Relay restarted more often than the 6h interval would otherwise never sweep at all.
  repos.settings.update({ apify_api_key: 'k', enrich_ttl_days: 30 });
  seedPending(1);
  const row = repos.connections.findByUrl('https://www.linkedin.com/in/p0')!;
  repos.connections.applyEnrichment(row.id, {
    linkedin_id: 'x', public_identifier: 'p0', full_name: 'P', first_name: 'P', last_name: null,
    headline: null, location_raw: null, location_city: null, location_region: null,
    location_country: null, location_country_code: null, current_title: null,
    current_company: null, compact: {}, doc: 'P',
  }, '2026-01-01T00:00:00.000Z'); // long past a 30-day TTL

  const orch = new Orchestrator(repos, driver, undefined, {}, fakeFactory().factory);
  vi.useFakeTimers();
  try {
    orch.start();
    expect(repos.connections.countsByEnrichStatus().pending).toBe(1);
  } finally {
    orch.stop();
    vi.useRealTimers();
  }
});
