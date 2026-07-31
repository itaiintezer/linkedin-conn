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

test('upsertMany returns the insert/update split', () => {
  const first = repos.connections.upsertMany(
    [{ profile_url: URL_A }, { profile_url: 'https://www.linkedin.com/in/bob' }],
    'csv', '2026-07-31T00:00:00.000Z',
  );
  expect(first).toEqual({ inserted: 2, updated: 0 });

  const second = repos.connections.upsertMany(
    [{ profile_url: URL_A, current_title: 'CTO' }, { profile_url: 'https://www.linkedin.com/in/carol' }],
    'csv', '2026-08-01T00:00:00.000Z',
  );
  expect(second).toEqual({ inserted: 1, updated: 1 });
  expect(repos.connections.count()).toBe(3);
  expect(repos.connections.findByUrl(URL_A)!.current_title).toBe('CTO');
});

test('upsertMany is atomic: a bad row late in the file rolls the whole import back', () => {
  repos.connections.upsert({ profile_url: URL_A }, 'csv', '2026-07-01T00:00:00.000Z');

  const rows = [
    { profile_url: 'https://www.linkedin.com/in/good1' },
    { profile_url: 'https://www.linkedin.com/in/good2' },
    { profile_url: null as unknown as string }, // violates NOT NULL — throws mid-loop
  ];
  expect(() => repos.connections.upsertMany(rows, 'csv', '2026-07-31T00:00:00.000Z')).toThrow();

  // Neither good row survives, and the pre-existing row is untouched: a half-written
  // roster is worse than a rejected import.
  expect(repos.connections.findByUrl('https://www.linkedin.com/in/good1')).toBeUndefined();
  expect(repos.connections.findByUrl('https://www.linkedin.com/in/good2')).toBeUndefined();
  expect(repos.connections.count()).toBe(1);
});

test('list is newest-first and paginates', () => {
  for (let i = 0; i < 5; i++) {
    repos.connections.upsert({ profile_url: `https://www.linkedin.com/in/p${i}` }, 'csv', '2026-07-31T00:00:00.000Z');
  }
  const page = repos.connections.list(2, 1);
  expect(page).toHaveLength(2);
  expect(page[0].profile_url).toBe('https://www.linkedin.com/in/p3');
});

test('upsert sanitises the first name from CSV or scrape input', () => {
  repos.connections.upsert(
    { profile_url: URL_A, first_name: 'Dr. Chidhanandham', full_name: 'Dr. Chidhanandham Arunachalam' },
    'csv', '2026-07-31T00:00:00.000Z',
  );
  expect(repos.connections.findByUrl(URL_A)!.first_name).toBe('Chidhanandham');
  expect(repos.connections.findByUrl(URL_A)!.full_name).toBe('Dr. Chidhanandham Arunachalam');
});

test('a roster-sync card name is sanitised too', () => {
  repos.connections.upsert({ profile_url: URL_A, full_name: '\u200FErik Decker' }, 'scrape', '2026-07-31T00:00:00.000Z');
  expect(repos.connections.findByUrl(URL_A)!.first_name).toBe('Erik');
});

test('backfillFirstNames repairs existing rows and is idempotent', () => {
  const rows = [
    ['https://www.linkedin.com/in/a', 'Dr. Chidhanandham', 'Dr. Chidhanandham Arunachalam'],
    ['https://www.linkedin.com/in/b', '🪐 Leonardo', '🪐 Leonardo Pizarro'],
    ['https://www.linkedin.com/in/c', 'Ada', 'Ada Lovelace'],          // already clean
    ['https://www.linkedin.com/in/d', 'M.', 'M. G.'],                  // unusable
  ];
  for (const [url, fn, fl] of rows) {
    repos.db.prepare(
      "INSERT INTO connections (profile_url, first_name, full_name, source, first_seen_at, last_seen_at) VALUES (?,?,?,'csv','x','x')",
    ).run(url, fn, fl);
  }

  expect(repos.connections.backfillFirstNames()).toBe(3);   // c was already correct

  const get = (u: string) => repos.connections.findByUrl(u)!.first_name;
  expect(get('https://www.linkedin.com/in/a')).toBe('Chidhanandham');
  expect(get('https://www.linkedin.com/in/b')).toBe('Leonardo');
  expect(get('https://www.linkedin.com/in/c')).toBe('Ada');
  expect(get('https://www.linkedin.com/in/d')).toBeNull();  // nothing usable -> "there" at send

  // Idempotent: a second pass changes nothing.
  expect(repos.connections.backfillFirstNames()).toBe(0);
});

test('the backfill never touches full_name', () => {
  repos.db.prepare(
    "INSERT INTO connections (profile_url, first_name, full_name, source, first_seen_at, last_seen_at) VALUES (?,?,?,'csv','x','x')",
  ).run('https://www.linkedin.com/in/z', '🪐 Leonardo', '🪐 Leonardo Pizarro');
  repos.connections.backfillFirstNames();
  expect(repos.connections.findByUrl('https://www.linkedin.com/in/z')!.full_name).toBe('🪐 Leonardo Pizarro');
});

test('a backfill with nothing to repair writes nothing and takes no backup', () => {
  // The fresh-install path. Rows written after sanitisation existed are already correct, so
  // a new user must not have their whole database copied aside on the second start to guard
  // a migration they never needed.
  repos.connections.upsert(
    { profile_url: URL_A, first_name: 'Dr. Chidhanandham', full_name: 'Dr. Chidhanandham Arunachalam' },
    'csv', '2026-07-31T00:00:00.000Z',
  );
  let snapshots = 0;
  expect(repos.connections.backfillFirstNames(() => { snapshots++; })).toBe(0);
  expect(snapshots).toBe(0);
});

test('a backfill with work to do snapshots exactly once, before writing', () => {
  repos.db.prepare(
    "INSERT INTO connections (profile_url, first_name, full_name, source, first_seen_at, last_seen_at) VALUES (?,?,?,'csv','x','x')",
  ).run('https://www.linkedin.com/in/y', 'Dr. Chidhanandham', 'Dr. Chidhanandham Arunachalam');
  repos.db.prepare(
    "INSERT INTO connections (profile_url, first_name, full_name, source, first_seen_at, last_seen_at) VALUES (?,?,?,'csv','x','x')",
  ).run('https://www.linkedin.com/in/w', '🪐 Leonardo', '🪐 Leonardo Pizarro');

  const seenAtSnapshot: (string | null)[] = [];
  const changed = repos.connections.backfillFirstNames(() => {
    // Called BEFORE any UPDATE: the rows must still hold their original values here, or the
    // "backup" would be a copy of the already-rewritten database.
    seenAtSnapshot.push(repos.connections.findByUrl('https://www.linkedin.com/in/y')!.first_name);
  });

  expect(changed).toBe(2);
  expect(seenAtSnapshot).toEqual(['Dr. Chidhanandham']);   // exactly once, pre-write
  expect(repos.connections.findByUrl('https://www.linkedin.com/in/y')!.first_name).toBe('Chidhanandham');
});
