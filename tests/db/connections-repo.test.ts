import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';

let repos: Repos;
beforeEach(() => { repos = new Repos(openDatabase(':memory:')); });

const URL_A = 'https://www.linkedin.com/in/ada';

test('upsert inserts a new connection with seen timestamps and pending enrichment', () => {
  const r = repos.connections.upsert(
    { profile_url: URL_A, full_name: 'Ada Lovelace', current_company: 'Analytical Engines' },
    'csv', '2026-07-31T10:00:00.000Z',
  );
  expect(r).toBe('inserted');
  const c = repos.connections.findByUrl(URL_A)!;
  expect(c.full_name).toBe('Ada Lovelace');
  expect(c.source).toBe('csv');
  expect(c.first_seen_at).toBe('2026-07-31T10:00:00.000Z');
  expect(c.last_seen_at).toBe('2026-07-31T10:00:00.000Z');
  expect(c.enrich_status).toBe('pending');
});

test('upsert on an existing un-enriched row fills fields and advances last_seen_at only', () => {
  repos.connections.upsert({ profile_url: URL_A, full_name: 'Ada Lovelace' }, 'scrape', '2026-07-01T00:00:00.000Z');
  const r = repos.connections.upsert(
    { profile_url: URL_A, current_title: 'Mathematician', connected_on: '2024-03-04' },
    'csv', '2026-07-31T10:00:00.000Z',
  );
  expect(r).toBe('updated');
  const c = repos.connections.findByUrl(URL_A)!;
  expect(c.current_title).toBe('Mathematician');
  expect(c.connected_on).toBe('2024-03-04');
  expect(c.full_name).toBe('Ada Lovelace');            // not clobbered by an absent field
  expect(c.source).toBe('scrape');                      // first source wins
  expect(c.first_seen_at).toBe('2026-07-01T00:00:00.000Z');
  expect(c.last_seen_at).toBe('2026-07-31T10:00:00.000Z');
});

test('upsert never overwrites Apify data on an enriched row, but still advances last_seen_at', () => {
  repos.connections.upsert({ profile_url: URL_A, full_name: 'Ada Lovelace' }, 'csv', '2026-07-01T00:00:00.000Z');
  repos.db.prepare(
    "UPDATE connections SET enrich_status='enriched', current_title='Countess of Lovelace', enriched_at='2026-07-15T00:00:00.000Z' WHERE profile_url = ?",
  ).run(URL_A);

  repos.connections.upsert(
    { profile_url: URL_A, current_title: 'STALE CSV TITLE', connected_on: '2024-03-04' },
    'csv', '2026-07-31T10:00:00.000Z',
  );

  const c = repos.connections.findByUrl(URL_A)!;
  expect(c.current_title).toBe('Countess of Lovelace'); // Apify wins
  expect(c.connected_on).toBe('2024-03-04');            // but connected_on still fills a NULL
  expect(c.last_seen_at).toBe('2026-07-31T10:00:00.000Z');
});

test('an enriched row with a NULL field still accepts a value from an import', () => {
  repos.connections.upsert({ profile_url: URL_A }, 'csv', '2026-07-01T00:00:00.000Z');
  repos.db.prepare("UPDATE connections SET enrich_status='enriched' WHERE profile_url = ?").run(URL_A);

  repos.connections.upsert({ profile_url: URL_A, current_company: 'Analytical Engines' }, 'csv', '2026-07-31T00:00:00.000Z');

  expect(repos.connections.findByUrl(URL_A)!.current_company).toBe('Analytical Engines');
});

test('connected_on is never overwritten once set', () => {
  repos.connections.upsert({ profile_url: URL_A, connected_on: '2020-01-01' }, 'csv', '2026-07-01T00:00:00.000Z');
  repos.connections.upsert({ profile_url: URL_A, connected_on: '2024-03-04' }, 'csv', '2026-07-31T00:00:00.000Z');
  expect(repos.connections.findByUrl(URL_A)!.connected_on).toBe('2020-01-01');
});

test('counts report the total and a breakdown by enrichment status', () => {
  repos.connections.upsert({ profile_url: URL_A }, 'csv', '2026-07-31T00:00:00.000Z');
  repos.connections.upsert({ profile_url: 'https://www.linkedin.com/in/bob' }, 'csv', '2026-07-31T00:00:00.000Z');
  repos.db.prepare("UPDATE connections SET enrich_status='enriched' WHERE profile_url = ?").run(URL_A);

  expect(repos.connections.count()).toBe(2);
  expect(repos.connections.countsByEnrichStatus()).toEqual({
    pending: 1, enriching: 0, enriched: 1, empty: 0, failed: 0,
  });
});

test('list is newest-first and paginates', () => {
  for (let i = 0; i < 5; i++) {
    repos.connections.upsert({ profile_url: `https://www.linkedin.com/in/p${i}` }, 'csv', '2026-07-31T00:00:00.000Z');
  }
  const page = repos.connections.list(2, 1);
  expect(page).toHaveLength(2);
  expect(page[0].profile_url).toBe('https://www.linkedin.com/in/p3');
});
