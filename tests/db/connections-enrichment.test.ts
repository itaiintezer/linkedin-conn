/**
 * Enrichment lifecycle at the repository layer: claiming, applying, failing, parking,
 * refreshing, and merging a slug change. Every path here costs real money when it runs for
 * real, so the rules about what may be retried are load-bearing, not housekeeping.
 */
import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import type { EnrichedProfile } from '../../src/types.js';

let repos: Repos;
beforeEach(() => { repos = new Repos(openDatabase(':memory:')); });

const URL_A = 'https://www.linkedin.com/in/ada';
const NOW = '2026-07-31T12:00:00.000Z';

function seedPending(...urls: string[]): void {
  for (const u of urls) repos.connections.upsert({ profile_url: u }, 'csv', '2026-07-01T00:00:00.000Z');
}

function fakeEnriched(over: Partial<EnrichedProfile> = {}): EnrichedProfile {
  return {
    linkedin_id: 'ACoAA-ada', public_identifier: 'ada', full_name: 'Ada Lovelace',
    first_name: 'Ada', last_name: 'Lovelace', headline: 'Mathematician',
    location_raw: 'Leeds, United Kingdom', location_city: 'Leeds', location_region: 'England',
    location_country: 'United Kingdom', location_country_code: 'GB',
    current_title: 'Mathematician', current_company: 'Analytical Engines',
    compact: { name: 'Ada Lovelace', skills: ['Mathematics'] },
    doc: 'Ada Lovelace\nMathematician\nLeeds\nAnalytical Engines\nMathematics',
    ...over,
  };
}

test('claimForEnrichment flips rows to enriching so two workers never claim the same row', () => {
  seedPending('https://www.linkedin.com/in/a', 'https://www.linkedin.com/in/b', 'https://www.linkedin.com/in/c');

  const first = repos.connections.claimForEnrichment(2);
  expect(first).toHaveLength(2);
  expect(first.every((r) => r.enrich_status === 'enriching')).toBe(true);

  const second = repos.connections.claimForEnrichment(5);
  expect(second).toHaveLength(1); // only the untouched row remains claimable
  expect(first.map((r) => r.id)).not.toContain(second[0].id);

  expect(repos.connections.claimForEnrichment(5)).toHaveLength(0);
});

test('applyEnrichment writes scalars, raw_json, the FTS doc, and clears prior error state', () => {
  seedPending(URL_A);
  const [row] = repos.connections.claimForEnrichment(1);
  repos.db.prepare("UPDATE connections SET enrich_error='earlier boom', enrich_attempts=1 WHERE id=?").run(row.id);

  repos.connections.applyEnrichment(row.id, fakeEnriched(), NOW);

  const c = repos.connections.findByUrl(URL_A)!;
  expect(c.enrich_status).toBe('enriched');
  expect(c.enriched_at).toBe(NOW);
  expect(c.enrich_error).toBeNull();
  expect(c.location_city).toBe('Leeds');
  expect(c.location_country_code).toBe('GB');
  expect(c.linkedin_id).toBe('ACoAA-ada');
  expect(JSON.parse(c.raw_json!).skills).toEqual(['Mathematics']);

  const hit = repos.db.prepare("SELECT rowid FROM connections_fts WHERE connections_fts MATCH 'mathematics'")
    .get() as { rowid: number };
  expect(hit.rowid).toBe(c.id);
});

test('re-enriching replaces the FTS document rather than duplicating it', () => {
  seedPending(URL_A);
  const [row] = repos.connections.claimForEnrichment(1);
  repos.connections.applyEnrichment(row.id, fakeEnriched(), NOW);
  repos.connections.applyEnrichment(
    row.id, fakeEnriched({ doc: 'Ada Lovelace\nCountess', headline: 'Countess' }), '2026-08-01T00:00:00.000Z',
  );

  const n = repos.db.prepare('SELECT COUNT(*) c FROM connections_fts WHERE rowid = ?').get(row.id) as { c: number };
  expect(n.c).toBe(1);
  // The superseded terms must be gone, or search would keep returning a stale job title.
  const stale = repos.db.prepare("SELECT COUNT(*) c FROM connections_fts WHERE connections_fts MATCH 'mathematics'")
    .get() as { c: number };
  expect(stale.c).toBe(0);
});

test('markEnrichFailure retries up to the limit then parks the row as failed', () => {
  seedPending(URL_A);
  const [row] = repos.connections.claimForEnrichment(1);

  repos.connections.markEnrichFailure(row.id, 'boom', 3);
  expect(repos.connections.findByUrl(URL_A)!.enrich_status).toBe('pending');
  expect(repos.connections.findByUrl(URL_A)!.enrich_attempts).toBe(1);

  repos.connections.claimForEnrichment(1);
  repos.connections.markEnrichFailure(row.id, 'boom', 3);
  expect(repos.connections.findByUrl(URL_A)!.enrich_status).toBe('pending');

  repos.connections.claimForEnrichment(1);
  repos.connections.markEnrichFailure(row.id, 'boom', 3);
  const c = repos.connections.findByUrl(URL_A)!;
  expect(c.enrich_status).toBe('failed');
  expect(c.enrich_attempts).toBe(3);
  expect(c.enrich_error).toBe('boom');

  // Parked rows are no longer claimable — never auto-retried, because each retry bills.
  expect(repos.connections.claimForEnrichment(5)).toHaveLength(0);
});

test('an empty shell parks immediately — a retry cannot make it real', () => {
  seedPending(URL_A);
  const [row] = repos.connections.claimForEnrichment(1);
  repos.connections.markEnrichEmpty(row.id);

  const c = repos.connections.findByUrl(URL_A)!;
  expect(c.enrich_status).toBe('empty');
  expect(c.enrich_attempts).toBe(1);
  expect(repos.connections.claimForEnrichment(5)).toHaveLength(0);
});

test('requeueEnriching returns stranded rows to pending (pause / crash recovery)', () => {
  seedPending('https://www.linkedin.com/in/a', 'https://www.linkedin.com/in/b');
  repos.connections.claimForEnrichment(2);

  expect(repos.connections.requeueEnriching()).toBe(2);
  expect(repos.connections.countsByEnrichStatus().pending).toBe(2);
  expect(repos.connections.countsByEnrichStatus().enriching).toBe(0);
});

test('dueForRefresh returns only enriched rows past the TTL, never parked ones', () => {
  seedPending(
    'https://www.linkedin.com/in/old', 'https://www.linkedin.com/in/fresh', 'https://www.linkedin.com/in/failed',
  );
  const rows = repos.connections.claimForEnrichment(3);
  const byUrl = new Map(rows.map((r) => [r.profile_url, r.id]));
  // Distinct linkedin_ids: these are three different people. Reusing one id would (correctly)
  // trigger the slug-change merge and collapse them into a single row.
  repos.connections.applyEnrichment(
    byUrl.get('https://www.linkedin.com/in/old')!, fakeEnriched({ linkedin_id: 'ACoAA-old' }), '2026-01-01T00:00:00.000Z',
  );
  repos.connections.applyEnrichment(
    byUrl.get('https://www.linkedin.com/in/fresh')!, fakeEnriched({ linkedin_id: 'ACoAA-fresh' }), '2026-07-20T00:00:00.000Z',
  );
  repos.connections.markEnrichFailure(byUrl.get('https://www.linkedin.com/in/failed')!, 'boom', 1);

  const due = repos.connections.dueForRefresh(180, new Date('2026-07-31T00:00:00.000Z'));

  // 'old' is 211 days stale; 'fresh' is 11 days; 'failed' is parked and must never be
  // auto-re-armed — it bills again and will not spontaneously become scrapeable.
  expect(due.map((r) => r.profile_url)).toEqual(['https://www.linkedin.com/in/old']);
});

test('resetFailed re-arms parked rows with attempts zeroed', () => {
  seedPending('https://www.linkedin.com/in/f', 'https://www.linkedin.com/in/e');
  const rows = repos.connections.claimForEnrichment(2);
  repos.connections.markEnrichFailure(rows[0].id, 'boom', 1);
  repos.connections.markEnrichEmpty(rows[1].id);

  expect(repos.connections.resetFailed()).toBe(2);
  const counts = repos.connections.countsByEnrichStatus();
  expect(counts.pending).toBe(2);
  expect(counts.failed + counts.empty).toBe(0);
  expect(repos.connections.findByUrl('https://www.linkedin.com/in/f')!.enrich_attempts).toBe(0);
});

test('a slug change merges into the older row and records the old URL as an alias', () => {
  // Same human, two URLs: the roster met them under one slug, then again under a new one.
  // Without the linkedin_id merge these accumulate silently as duplicates for years.
  seedPending('https://www.linkedin.com/in/old-slug');
  const [oldRow] = repos.connections.claimForEnrichment(1);
  repos.connections.applyEnrichment(oldRow.id, fakeEnriched(), '2026-07-01T00:00:00.000Z');

  seedPending('https://www.linkedin.com/in/new-slug');
  const [newRow] = repos.connections.claimForEnrichment(1);
  repos.connections.applyEnrichment(newRow.id, fakeEnriched(), NOW); // same linkedin_id

  expect(repos.connections.count()).toBe(1);
  expect(repos.connections.findByUrl('https://www.linkedin.com/in/old-slug')).toBeTruthy();
  expect(repos.connections.findByUrl('https://www.linkedin.com/in/new-slug')).toBeUndefined();

  const alias = repos.db.prepare('SELECT connection_id FROM connection_aliases WHERE profile_url = ?')
    .get('https://www.linkedin.com/in/new-slug') as { connection_id: number } | undefined;
  expect(alias?.connection_id).toBe(oldRow.id);

  // The merged row keeps ONE fts document, under the surviving id.
  const n = repos.db.prepare('SELECT COUNT(*) c FROM connections_fts').get() as { c: number };
  expect(n.c).toBe(1);
});

test('a null linkedin_id never merges rows together', () => {
  // Two genuinely different people, neither of whom Apify gave an id for. Merging on a
  // shared NULL would silently destroy one of them.
  seedPending('https://www.linkedin.com/in/p1', 'https://www.linkedin.com/in/p2');
  const rows = repos.connections.claimForEnrichment(2);
  repos.connections.applyEnrichment(rows[0].id, fakeEnriched({ linkedin_id: null, full_name: 'One' }), NOW);
  repos.connections.applyEnrichment(rows[1].id, fakeEnriched({ linkedin_id: null, full_name: 'Two' }), NOW);

  expect(repos.connections.count()).toBe(2);
});
