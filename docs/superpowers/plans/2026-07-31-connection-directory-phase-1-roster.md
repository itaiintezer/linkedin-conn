# Connection Directory — Phase 1 (Roster Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a first-class `connections` roster — a new table, a seed from existing campaign data, `Connections.csv` / URL-list import, and a dedicated `roster-sync` worker that discovers newly-added connections — without touching the live invite pipeline.

**Architecture:** A new `connections` table keyed by normalized `profile_url`, independent of cohorts and campaign status. Import parses either a LinkedIn CSV export or a bare URL list into `ConnectionInput` rows and upserts them. A `roster-sync` worker mirrors `acceptance-checker.ts` exactly (slot-gated, empty-read fail-safe, guardrail-aware) but reads connection *cards* (URL + name) and has no `no_pending` early return. **The acceptance checker is deliberately left untouched** — it keeps its own scrape this phase; the cutover to a DB read happens in phase 3 after the roster proves itself. Spec: `docs/superpowers/specs/2026-07-31-connection-directory-design.md`.

**Tech Stack:** Node 22+ (`node:sqlite`), TypeScript ESM, Fastify, playwright-core via cloakbrowser, vitest, vanilla-JS frontend (`src/web/`).

**Execution notes:**
- Run all commands from the repo root. Tests: `npx vitest run <file>`; all: `npm test`. Typecheck: `npm run typecheck`.
- `data/app.db` is **PRODUCTION** (427 real profiles). Never seed test data into it. Unit tests use `openDatabase(':memory:')`.
- Nothing in this phase spends Apify credit — there is no Apify code in phase 1.
- Nothing in this phase modifies `src/worker/acceptance-checker.ts`. If a task seems to require it, stop and ask.
- User preference (memory): the UI task (Task 10) should be executed by an Opus subagent using the `frontend-design` skill; mechanical tasks can use Sonnet. Verify e2e before merge.
- Commit after every task (steps include the commands).

---

## File Structure

| File | Change |
|---|---|
| `src/types.ts` | `Connection`, `ConnectionInput`, `ConnectionCard`, `ConnectionSource`, `EnrichStatus`; `readConnectionCards` on `BrowserDriver`; two new `AppState` fields; `roster_sync_per_day` on `Settings` |
| `src/db/schema.sql` | `connections` + `connection_aliases` tables; `settings.roster_sync_per_day`; `app_state.roster_synced_at` + `connections_seeded_at` |
| `src/db/database.ts` | Pre-connections backup snapshot; ALTERs for the three new columns |
| `src/db/repositories.ts` | New `ConnectionRepo`; `setRosterSynced` / `setConnectionsSeeded` on `AppStateRepo`; whitelist `roster_sync_per_day` |
| `src/db/seed-connections.ts` (new) | One-time seed from `accepted`/`replied`/messaged profiles |
| `src/core/csv.ts` (new) | RFC4180-subset CSV reader |
| `src/core/connections-csv.ts` (new) | LinkedIn `Connections.csv` → `ConnectionInput[]`; `parseConnectedOn` |
| `src/core/roster-input.ts` (new) | Format sniffing: CSV vs bare URL list |
| `src/browser/driver.ts` | `FakeDriver.readConnectionCards` |
| `src/browser/linkedin-driver.ts` | Real `readConnectionCards` (URL + name, deduped per card) |
| `src/worker/roster-sync.ts` (new) | Slot-gated roster scrape → upsert |
| `src/worker/orchestrator.ts` | `runRosterSyncTick` + 30-min timer |
| `src/api/server.ts` | `POST /api/connections/import`, `GET /api/connections`, `GET /api/connections/stats`, `POST /api/roster/sync-now`; settings key |
| `src/web/index.html` | Connections panel in Settings; optional import block in the wizard |
| `src/web/app.js` | Import + stats + sync-now wiring |
| `src/web/styles.css` | Styles for the new panel |
| `API.md`, `README.md` | Document the roster, endpoints, and the new setting |
| `scripts/verify-roster-sync.ts` (new) | Live single-pass verification |

Tests mirror source paths under `tests/`.

---

### Task 1: Types, schema, and migrations

**Files:**
- Modify: `src/types.ts`
- Modify: `src/db/schema.sql`
- Modify: `src/db/database.ts`
- Test: `tests/db/database.test.ts` (append)

- [ ] **Step 1: Write the failing migration test**

Append to `tests/db/database.test.ts`:

```ts
test('migrates a pre-connections database: adds roster columns, creates connections tables', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), weekly_cap INTEGER NOT NULL DEFAULT 100);
    INSERT INTO settings (id) VALUES (1);
    CREATE TABLE app_state (id INTEGER PRIMARY KEY CHECK (id = 1), failure_streak INTEGER NOT NULL DEFAULT 0);
    INSERT INTO app_state (id) VALUES (1);
  `);

  runMigrations(db);

  const settingsCols = (db.prepare('PRAGMA table_info(settings)').all() as { name: string }[]).map((c) => c.name);
  expect(settingsCols).toContain('roster_sync_per_day');
  const appCols = (db.prepare('PRAGMA table_info(app_state)').all() as { name: string }[]).map((c) => c.name);
  expect(appCols).toContain('roster_synced_at');
  expect(appCols).toContain('connections_seeded_at');

  // Idempotent: a second pass must not throw.
  expect(() => runMigrations(db)).not.toThrow();
});

test('a fresh database has the connections tables with a unique profile_url', () => {
  const db = openDatabase(':memory:');
  db.exec("INSERT INTO connections (profile_url, source, first_seen_at, last_seen_at) VALUES ('https://www.linkedin.com/in/a','csv','2026-07-31T00:00:00Z','2026-07-31T00:00:00Z')");
  expect(() =>
    db.exec("INSERT INTO connections (profile_url, source, first_seen_at, last_seen_at) VALUES ('https://www.linkedin.com/in/a','csv','2026-07-31T00:00:00Z','2026-07-31T00:00:00Z')"),
  ).toThrow();
  expect((db.prepare('SELECT enrich_status s FROM connections').get() as { s: string }).s).toBe('pending');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/db/database.test.ts`
Expected: FAIL — `expect(settingsCols).toContain('roster_sync_per_day')` and `no such table: connections`.

- [ ] **Step 3: Add the types**

Append to `src/types.ts`:

```ts
export type ConnectionSource = 'csv' | 'urls' | 'scrape' | 'migration';

/** Lifecycle of a connection's Apify enrichment (phase 2 drives this; phase 1 only writes 'pending'). */
export type EnrichStatus = 'pending' | 'enriching' | 'enriched' | 'empty' | 'failed';

/** One person you are connected to. Independent of cohorts and campaign status. */
export interface Connection {
  id: number;
  profile_url: string;              // normalized
  linkedin_id: string | null;
  public_identifier: string | null;
  full_name: string | null;
  first_name: string | null;
  last_name: string | null;
  headline: string | null;
  location_raw: string | null;
  location_city: string | null;
  location_region: string | null;
  location_country: string | null;
  current_title: string | null;
  current_company: string | null;
  /** ISO date. ONLY from the CSV export or a known accepted_at — never inferred. */
  connected_on: string | null;
  source: ConnectionSource;
  first_seen_at: string;
  last_seen_at: string;
  enrich_status: EnrichStatus;
  enrich_attempts: number;
  enrich_error: string | null;
  enriched_at: string | null;
  raw_json: string | null;
  created_at: string;
}

/** An incoming roster row from any non-Apify source (CSV, URL list, connection card). */
export interface ConnectionInput {
  profile_url: string;              // normalized
  full_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  current_title?: string | null;
  current_company?: string | null;
  connected_on?: string | null;
}

/** One card read off the LinkedIn connections page. */
export interface ConnectionCard {
  url: string;                      // normalized
  name: string | null;
}
```

In the same file, add `readConnectionCards` to `BrowserDriver` immediately below `readRecentConnections`:

```ts
  /** One scroll-loaded read of the connections page, returning URL + display name per card.
   *  Roster sync uses this; `readRecentConnections` above stays until the phase-3 cutover. */
  readConnectionCards(): Promise<ConnectionCard[]>;
```

Add to `Settings`, after `reply_checks_per_day`:

```ts
  roster_sync_per_day: number;
```

Add to `AppState`, after `replies_checked_at`:

```ts
  roster_synced_at: string | null;      // ISO, last successful roster read
  connections_seeded_at: string | null; // ISO, one-time seed from existing profiles
```

- [ ] **Step 4: Add the schema**

Append to `src/db/schema.sql`:

```sql
-- The connection roster. One row per person you are connected to, independent of any
-- cohort or campaign. Append-only: nothing in this app removes a connection (see the
-- 2026-07-31 design doc — removals are deliberately not tracked).
CREATE TABLE IF NOT EXISTS connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_url TEXT NOT NULL UNIQUE,   -- normalizeProfileUrl()
  linkedin_id TEXT,                   -- stable id from Apify; merge key for slug changes
  public_identifier TEXT,
  full_name TEXT,
  first_name TEXT,
  last_name TEXT,
  headline TEXT,
  location_raw TEXT,
  location_city TEXT,
  location_region TEXT,
  location_country TEXT,
  current_title TEXT,
  current_company TEXT,
  -- ISO date. ONLY from the CSV export or a known accepted_at. Never inferred from
  -- first_seen_at: "when we first saw them" is not "when you connected".
  connected_on TEXT,
  source TEXT NOT NULL,               -- csv | urls | scrape | migration
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  enrich_status TEXT NOT NULL DEFAULT 'pending',
  enrich_attempts INTEGER NOT NULL DEFAULT 0,
  enrich_error TEXT,
  enriched_at TEXT,
  raw_json TEXT,                      -- cherry-picked Apify payload (phase 2)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_connections_enrich ON connections(enrich_status);
CREATE INDEX IF NOT EXISTS idx_connections_linkedin_id ON connections(linkedin_id);

-- Old profile URLs kept after a slug-change merge, so a stale link still resolves.
CREATE TABLE IF NOT EXISTS connection_aliases (
  profile_url TEXT PRIMARY KEY,
  connection_id INTEGER NOT NULL REFERENCES connections(id)
);
```

In the same file add `roster_sync_per_day` to the `settings` table, after `reply_checks_per_day`:

```sql
  -- Roster syncs per day, same slot mechanism as acceptance/reply checks.
  roster_sync_per_day INTEGER NOT NULL DEFAULT 2,
```

And two columns to `app_state`, after `replies_checked_at`:

```sql
  roster_synced_at TEXT,
  connections_seeded_at TEXT,
```

- [ ] **Step 5: Add the migrations and the backup snapshot**

In `src/db/database.ts`, insert this block inside `openDatabase` **before** `const schema = readFileSync(...)` (it must run before `CREATE TABLE IF NOT EXISTS connections` makes the detection impossible):

```ts
  // Safety net before the connection-roster migration touches a production database.
  // Detection: the connections table is absent exactly on pre-roster databases. Runs at
  // most once — skipped as soon as the backup file exists. :memory: has no file to copy.
  if (path !== ':memory:') {
    const has = (name: string) =>
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;
    const backupPath = `${path}.pre-connections-backup`;
    if (has('profiles') && !has('connections') && !existsSync(backupPath)) {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); // fold the WAL in — a bare copy misses it
      copyFileSync(path, backupPath);
    }
  }
```

Then append to `runMigrations`, after the `reply_checks_per_day` block:

```ts
  // --- Connection roster (2026-07-31) ---
  // The connections/connection_aliases tables need no migration: schema.sql's
  // CREATE TABLE IF NOT EXISTS back-fills them on every openDatabase. Only new columns
  // on pre-existing tables need an ALTER. One guard each, so an interruption between
  // ALTERs cannot permanently skip whichever ones did not run yet.
  if (cols.length > 0 && !cols.includes('roster_sync_per_day')) {
    db.exec('ALTER TABLE settings ADD COLUMN roster_sync_per_day INTEGER NOT NULL DEFAULT 2');
  }
  if (appCols.length > 0 && !appCols.includes('roster_synced_at')) {
    db.exec('ALTER TABLE app_state ADD COLUMN roster_synced_at TEXT');
  }
  if (appCols.length > 0 && !appCols.includes('connections_seeded_at')) {
    db.exec('ALTER TABLE app_state ADD COLUMN connections_seeded_at TEXT');
  }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/db/database.test.ts && npm run typecheck`
Expected: PASS. Typecheck will report `readConnectionCards` missing on `FakeDriver` and `LinkedInDriver` — that is Task 6. To keep the tree green until then, add a temporary stub to **both** drivers now:

In `src/browser/driver.ts`, inside `FakeDriver`: `async readConnectionCards(): Promise<ConnectionCard[]> { return []; }` (import `ConnectionCard` from `../types.js`).
In `src/browser/linkedin-driver.ts`, inside `LinkedInDriver`: `async readConnectionCards(): Promise<ConnectionCard[]> { return []; }`.

Re-run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/db/schema.sql src/db/database.ts src/browser/driver.ts src/browser/linkedin-driver.ts tests/db/database.test.ts
git commit -m "feat(roster): connections schema, types, and migrations"
```

---

### Task 2: ConnectionRepo

**Files:**
- Modify: `src/db/repositories.ts`
- Test: `tests/db/connections-repo.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/db/connections-repo.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/db/connections-repo.test.ts`
Expected: FAIL — `repos.connections is undefined`.

- [ ] **Step 3: Implement `ConnectionRepo`**

In `src/db/repositories.ts`, extend the type import to include the new types:

```ts
import type { Cohort, Profile, Settings, ProfileStatus, EventType, AppState, GuardrailReason, CampaignKind, Connection, ConnectionInput, ConnectionSource, EnrichStatus } from '../types.js';
```

Add `'roster_sync_per_day'` to the `SETTINGS_COLUMNS` set.

Add this class above `export class Repos`:

```ts
/** Fields an import/scrape may fill. Enrichment columns are NOT in here — only the
 *  phase-2 enrichment worker writes those. */
const CONNECTION_INPUT_COLUMNS = [
  'full_name', 'first_name', 'last_name', 'current_title', 'current_company',
] as const;

const ENRICH_STATUSES: EnrichStatus[] = ['pending', 'enriching', 'enriched', 'empty', 'failed'];

export class ConnectionRepo {
  constructor(private db: DB) {}

  findByUrl(profileUrl: string): Connection | undefined {
    return this.db.prepare('SELECT * FROM connections WHERE profile_url = ?')
      .get(profileUrl) as unknown as Connection | undefined;
  }

  /**
   * Insert or merge one roster row. Merge rules (see the 2026-07-31 design doc):
   *  - `first_seen_at` and `source` record the FIRST sighting and never change.
   *  - `last_seen_at` always advances.
   *  - `connected_on` fills a NULL and is then immutable — the CSV is its only real
   *    source and a later sighting has nothing better to offer.
   *  - Everything else fills a NULL, and additionally overwrites on a row that has not
   *    been enriched yet. Once `enrich_status = 'enriched'`, Apify's values win: a stale
   *    CSV must never clobber fresh scraped data.
   */
  upsert(input: ConnectionInput, source: ConnectionSource, nowIso: string): 'inserted' | 'updated' {
    const existing = this.findByUrl(input.profile_url);
    if (!existing) {
      this.db.prepare(`
        INSERT INTO connections
          (profile_url, full_name, first_name, last_name, current_title, current_company,
           connected_on, source, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.profile_url,
        input.full_name ?? null, input.first_name ?? null, input.last_name ?? null,
        input.current_title ?? null, input.current_company ?? null,
        input.connected_on ?? null,
        source, nowIso, nowIso,
      );
      return 'inserted';
    }

    const sets: string[] = ['last_seen_at = ?'];
    const vals: unknown[] = [nowIso];
    const enriched = existing.enrich_status === 'enriched';
    for (const col of CONNECTION_INPUT_COLUMNS) {
      const incoming = input[col];
      if (incoming === undefined || incoming === null || incoming === '') continue;
      if (existing[col] !== null && enriched) continue; // Apify's value stands
      sets.push(`${col} = ?`); vals.push(incoming);
    }
    if (input.connected_on && existing.connected_on === null) {
      sets.push('connected_on = ?'); vals.push(input.connected_on);
    }
    vals.push(input.profile_url);
    this.db.prepare(`UPDATE connections SET ${sets.join(', ')} WHERE profile_url = ?`).run(...(vals as any[]));
    return 'updated';
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) c FROM connections').get() as unknown as { c: number }).c;
  }

  countsByEnrichStatus(): Record<EnrichStatus, number> {
    const out = Object.fromEntries(ENRICH_STATUSES.map((s) => [s, 0])) as Record<EnrichStatus, number>;
    const rows = this.db.prepare('SELECT enrich_status s, COUNT(*) c FROM connections GROUP BY enrich_status')
      .all() as unknown as { s: EnrichStatus; c: number }[];
    for (const r of rows) if (r.s in out) out[r.s] = r.c;
    return out;
  }

  list(limit: number, offset: number): Connection[] {
    return this.db.prepare('SELECT * FROM connections ORDER BY id DESC LIMIT ? OFFSET ?')
      .all(limit, offset) as unknown as Connection[];
  }
}
```

Register it on `Repos`:

```ts
export class Repos {
  cohorts: CohortRepo;
  profiles: ProfileRepo;
  events: EventRepo;
  settings: SettingsRepo;
  appState: AppStateRepo;
  connections: ConnectionRepo;
  constructor(public db: DB) {
    this.cohorts = new CohortRepo(db);
    this.profiles = new ProfileRepo(db);
    this.events = new EventRepo(db);
    this.settings = new SettingsRepo(db);
    this.appState = new AppStateRepo(db);
    this.connections = new ConnectionRepo(db);
  }
}
```

Add two methods to `AppStateRepo`, below `setRepliesChecked`:

```ts
  setRosterSynced(iso: string): void {
    this.db.prepare('UPDATE app_state SET roster_synced_at = ? WHERE id = 1').run(iso);
  }

  setConnectionsSeeded(iso: string): void {
    this.db.prepare('UPDATE app_state SET connections_seeded_at = ? WHERE id = 1').run(iso);
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/db/connections-repo.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/db/repositories.ts tests/db/connections-repo.test.ts
git commit -m "feat(roster): ConnectionRepo with provenance-aware upsert"
```

---

### Task 3: CSV reader

**Files:**
- Create: `src/core/csv.ts`
- Test: `tests/core/csv.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/core/csv.test.ts`:

```ts
import { test, expect } from 'vitest';
import { parseCsv } from '../../src/core/csv.js';

test('parses plain rows', () => {
  expect(parseCsv('a,b\n1,2')).toEqual([['a', 'b'], ['1', '2']]);
});

test('handles quoted fields containing commas', () => {
  expect(parseCsv('name,company\nAda,"Analytical Engines, Ltd"')).toEqual([
    ['name', 'company'], ['Ada', 'Analytical Engines, Ltd'],
  ]);
});

test('handles escaped double quotes inside a quoted field', () => {
  expect(parseCsv('a\n"she said ""hi"""')).toEqual([['a'], ['she said "hi"']]);
});

test('handles newlines inside a quoted field', () => {
  expect(parseCsv('a,b\n"line1\nline2",x')).toEqual([['a', 'b'], ['line1\nline2', 'x']]);
});

test('tolerates CRLF and a trailing newline', () => {
  expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([['a', 'b'], ['1', '2']]);
});

test('keeps empty fields and drops fully blank lines', () => {
  expect(parseCsv('a,b\n1,\n\n2,3')).toEqual([['a', 'b'], ['1', ''], ['2', '3']]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/core/csv.test.ts`
Expected: FAIL — `Cannot find module '../../src/core/csv.js'`.

- [ ] **Step 3: Implement the reader**

Create `src/core/csv.ts`:

```ts
/**
 * Minimal RFC4180-subset CSV reader — enough for LinkedIn's Connections.csv export,
 * whose Company and Position fields routinely contain commas and quotes.
 * Handles: quoted fields, "" escapes, embedded newlines, CRLF. Drops fully blank lines
 * (LinkedIn's export has one between its preamble and the header).
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  const endField = (): void => { row.push(field); field = ''; };
  const endRow = (): void => {
    endField();
    if (row.some((c) => c !== '')) rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { endField(); continue; }
    if (ch === '\r') continue;             // CRLF: the \n does the work
    if (ch === '\n') { endRow(); continue; }
    field += ch;
  }
  if (field !== '' || row.length > 0) endRow();
  return rows;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/core/csv.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/csv.ts tests/core/csv.test.ts
git commit -m "feat(roster): RFC4180-subset CSV reader"
```

---

### Task 4: LinkedIn Connections.csv parser

**Files:**
- Create: `src/core/connections-csv.ts`
- Test: `tests/core/connections-csv.test.ts` (create)

Background — a real LinkedIn export looks like this (three preamble lines, then the header):

```
Notes:
"When exporting your connection data, you may notice that some of the email addresses are missing..."

First Name,Last Name,URL,Email Address,Company,Position,Connected On
Ada,Lovelace,https://www.linkedin.com/in/ada,,Analytical Engines,Mathematician,04 Mar 2024
```

- [ ] **Step 1: Write the failing test**

Create `tests/core/connections-csv.test.ts`:

```ts
import { test, expect } from 'vitest';
import { parseConnectedOn, parseConnectionsCsv, looksLikeConnectionsCsv } from '../../src/core/connections-csv.js';

const REAL_EXPORT = [
  'Notes:',
  '"When exporting your connection data, you may notice that some of the email addresses are missing."',
  '',
  'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
  'Ada,Lovelace,https://www.linkedin.com/in/ada,,Analytical Engines,Mathematician,04 Mar 2024',
  'Grace,Hopper,https://www.linkedin.com/in/grace-hopper/,grace@navy.mil,"US Navy, Reserve",Rear Admiral,12 Dec 1985',
].join('\n');

test('skips the preamble and maps columns by header name', () => {
  const { rows, skipped } = parseConnectionsCsv(REAL_EXPORT);
  expect(skipped).toBe(0);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toEqual({
    profile_url: 'https://www.linkedin.com/in/ada',
    first_name: 'Ada', last_name: 'Lovelace', full_name: 'Ada Lovelace',
    current_company: 'Analytical Engines', current_title: 'Mathematician',
    connected_on: '2024-03-04',
  });
});

test('normalizes URLs (trailing slash, case, tracking params)', () => {
  const { rows } = parseConnectionsCsv(REAL_EXPORT);
  expect(rows[1].profile_url).toBe('https://www.linkedin.com/in/grace-hopper');
  expect(rows[1].current_company).toBe('US Navy, Reserve'); // quoted comma survived
});

test('counts rows with an unusable URL as skipped rather than throwing', () => {
  const csv = 'First Name,Last Name,URL,Company,Position,Connected On\nX,Y,,Acme,CEO,01 Jan 2024';
  const { rows, skipped } = parseConnectionsCsv(csv);
  expect(rows).toHaveLength(0);
  expect(skipped).toBe(1);
});

test('tolerates a column order it has never seen, and missing optional columns', () => {
  const csv = 'URL,Position,First Name\nhttps://www.linkedin.com/in/z,CTO,Zed';
  const { rows } = parseConnectionsCsv(csv);
  expect(rows[0]).toEqual({
    profile_url: 'https://www.linkedin.com/in/z',
    first_name: 'Zed', last_name: null, full_name: 'Zed',
    current_company: null, current_title: 'CTO', connected_on: null,
  });
});

test('throws a legible error when there is no recognizable header', () => {
  expect(() => parseConnectionsCsv('just,some,columns\n1,2,3')).toThrow(/header/i);
});

test('parseConnectedOn handles LinkedIn\'s "DD Mon YYYY" and returns null on junk', () => {
  expect(parseConnectedOn('04 Mar 2024')).toBe('2024-03-04');
  expect(parseConnectedOn('4 Mar 2024')).toBe('2024-03-04');
  expect(parseConnectedOn('12 Dec 1985')).toBe('1985-12-12');
  expect(parseConnectedOn('2024-03-04')).toBe('2024-03-04');
  expect(parseConnectedOn('')).toBeNull();
  expect(parseConnectedOn('sometime last spring')).toBeNull();
});

test('looksLikeConnectionsCsv distinguishes an export from a bare URL list', () => {
  expect(looksLikeConnectionsCsv(REAL_EXPORT)).toBe(true);
  expect(looksLikeConnectionsCsv('https://www.linkedin.com/in/a\nhttps://www.linkedin.com/in/b')).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/core/connections-csv.test.ts`
Expected: FAIL — `Cannot find module '../../src/core/connections-csv.js'`.

- [ ] **Step 3: Implement the parser**

Create `src/core/connections-csv.ts`:

```ts
import { parseCsv } from './csv.js';
import { normalizeProfileUrl } from './url.js';
import type { ConnectionInput } from '../types.js';

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/**
 * LinkedIn writes "Connected On" as "04 Mar 2024". Some exports use an ISO date.
 * Anything else returns null — a wrong connection date is worse than none, and this
 * column is the ONLY source of connected_on we will ever have.
 */
export function parseConnectedOn(raw: string | undefined | null): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return s;
  const m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})$/);
  if (!m) return null;
  const month = MONTHS[m[2].toLowerCase()];
  if (!month) return null;
  return `${m[3]}-${month}-${m[1].padStart(2, '0')}`;
}

/** Index of the header row (the first row carrying a "URL" column), or -1. */
function findHeaderRow(rows: string[][]): number {
  return rows.findIndex((r) => {
    const cells = r.map((c) => c.trim().toLowerCase());
    return cells.includes('url') && (cells.includes('first name') || cells.includes('last name'));
  });
}

/** True if the text is a LinkedIn Connections export rather than a bare URL list. */
export function looksLikeConnectionsCsv(text: string): boolean {
  return findHeaderRow(parseCsv(text)) !== -1;
}

export interface ConnectionsCsvResult {
  rows: ConnectionInput[];
  /** Data rows dropped because they had no usable LinkedIn profile URL. */
  skipped: number;
}

/**
 * Parse a LinkedIn Connections.csv export. Columns are mapped by header NAME, not
 * position — LinkedIn has reordered and added columns before, and an export missing
 * "Email Address" is common. The three-line preamble ("Notes:", a quoted paragraph, a
 * blank line) is skipped by scanning for the header row.
 */
export function parseConnectionsCsv(text: string): ConnectionsCsvResult {
  const table = parseCsv(text);
  const headerIdx = findHeaderRow(table);
  if (headerIdx === -1) {
    throw new Error('No Connections.csv header row found (expected a "URL" column alongside "First Name"/"Last Name")');
  }
  const header = table[headerIdx].map((c) => c.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const iUrl = col('url');
  const iFirst = col('first name');
  const iLast = col('last name');
  const iCompany = col('company');
  const iPosition = col('position');
  const iConnected = col('connected on');
  const cell = (row: string[], i: number): string | null => {
    if (i === -1) return null;
    const v = (row[i] ?? '').trim();
    return v === '' ? null : v;
  };

  const rows: ConnectionInput[] = [];
  let skipped = 0;
  for (const row of table.slice(headerIdx + 1)) {
    const url = normalizeProfileUrl(row[iUrl] ?? '');
    if (!url) { skipped++; continue; }
    const first = cell(row, iFirst);
    const last = cell(row, iLast);
    const full = [first, last].filter(Boolean).join(' ') || null;
    rows.push({
      profile_url: url,
      first_name: first,
      last_name: last,
      full_name: full,
      current_company: cell(row, iCompany),
      current_title: cell(row, iPosition),
      connected_on: parseConnectedOn(cell(row, iConnected)),
    });
  }
  return { rows, skipped };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/core/connections-csv.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/connections-csv.ts tests/core/connections-csv.test.ts
git commit -m "feat(roster): LinkedIn Connections.csv parser"
```

---

### Task 5: Roster input sniffing (CSV vs bare URL list)

**Files:**
- Create: `src/core/roster-input.ts`
- Test: `tests/core/roster-input.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/core/roster-input.test.ts`:

```ts
import { test, expect } from 'vitest';
import { parseRosterInput } from '../../src/core/roster-input.js';

test('recognizes a Connections.csv export', () => {
  const csv = [
    'Notes:', '', 'First Name,Last Name,URL,Company,Position,Connected On',
    'Ada,Lovelace,https://www.linkedin.com/in/ada,Analytical Engines,Mathematician,04 Mar 2024',
  ].join('\n');
  const out = parseRosterInput(csv);
  expect(out.format).toBe('csv');
  expect(out.rows).toHaveLength(1);
  expect(out.rows[0].full_name).toBe('Ada Lovelace');
});

test('falls back to extracting bare URLs, deduped and normalized', () => {
  const out = parseRosterInput([
    'https://www.linkedin.com/in/ada',
    'https://linkedin.com/in/ADA/',            // same person, different form
    'https://www.linkedin.com/in/grace-hopper?utm_source=x',
    'not a url at all',
  ].join('\n'));
  expect(out.format).toBe('urls');
  expect(out.rows.map((r) => r.profile_url)).toEqual([
    'https://www.linkedin.com/in/ada',
    'https://www.linkedin.com/in/grace-hopper',
  ]);
  expect(out.rows[0].full_name).toBeUndefined();
});

test('empty input yields no rows rather than throwing', () => {
  expect(parseRosterInput('   ')).toEqual({ format: 'urls', rows: [], skipped: 0 });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/core/roster-input.test.ts`
Expected: FAIL — `Cannot find module '../../src/core/roster-input.js'`.

- [ ] **Step 3: Implement the sniffer**

Create `src/core/roster-input.ts`:

```ts
import { extractProfileUrls } from './url.js';
import { looksLikeConnectionsCsv, parseConnectionsCsv } from './connections-csv.js';
import type { ConnectionInput } from '../types.js';

export interface RosterInput {
  format: 'csv' | 'urls';
  rows: ConnectionInput[];
  skipped: number;
}

/**
 * Accept either a LinkedIn Connections.csv export or a bare list of profile URLs
 * (newline/comma separated, or pasted prose containing them) and produce roster rows.
 * The CSV path additionally yields name, company, position and connected_on; the URL
 * path yields only the URL, and everything else waits for enrichment.
 */
export function parseRosterInput(text: string): RosterInput {
  if (looksLikeConnectionsCsv(text)) {
    const { rows, skipped } = parseConnectionsCsv(text);
    return { format: 'csv', rows, skipped };
  }
  return {
    format: 'urls',
    rows: extractProfileUrls(text).map((profile_url) => ({ profile_url })),
    skipped: 0,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/core/roster-input.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/roster-input.ts tests/core/roster-input.test.ts
git commit -m "feat(roster): sniff CSV export vs bare URL list"
```

---

### Task 6: One-time seed from existing campaign data

**Files:**
- Create: `src/db/seed-connections.ts`
- Modify: `src/db/database.ts`
- Test: `tests/db/seed-connections.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/db/seed-connections.test.ts`:

```ts
import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { seedConnectionsFromProfiles } from '../../src/db/seed-connections.js';

let repos: Repos;
const NOW = '2026-07-31T12:00:00.000Z';
beforeEach(() => { repos = new Repos(openDatabase(':memory:')); });

test('seeds accepted, replied, and successfully-messaged profiles — and nothing else', () => {
  const inv = repos.cohorts.create('inv', 'hi', true, 'invite');
  const msg = repos.cohorts.create('msg', 'hello', false, 'message');

  const accepted = repos.profiles.add(inv.id, 'https://www.linkedin.com/in/accepted', null, 'invite');
  repos.profiles.setStatus(accepted.id, 'accepted', { accepted_at: '2026-05-04T09:00:00.000Z' });

  const messaged = repos.profiles.add(msg.id, 'https://www.linkedin.com/in/messaged', null, 'message');
  repos.profiles.setStatus(messaged.id, 'sent', { sent_at: '2026-06-01T00:00:00.000Z' });

  const pending = repos.profiles.add(inv.id, 'https://www.linkedin.com/in/pending', null, 'invite');
  repos.profiles.setStatus(pending.id, 'sent', { sent_at: '2026-06-01T00:00:00.000Z' });

  repos.profiles.add(inv.id, 'https://www.linkedin.com/in/queued', null, 'invite');

  const n = seedConnectionsFromProfiles(repos, NOW);

  expect(n).toBe(2);
  const urls = repos.connections.list(50, 0).map((c) => c.profile_url).sort();
  expect(urls).toEqual([
    'https://www.linkedin.com/in/accepted',
    'https://www.linkedin.com/in/messaged',
  ]);
});

test('uses accepted_at as connected_on, and leaves it null when unknown', () => {
  const inv = repos.cohorts.create('inv', 'hi', true, 'invite');
  const msg = repos.cohorts.create('msg', 'hello', false, 'message');

  const a = repos.profiles.add(inv.id, 'https://www.linkedin.com/in/a', null, 'invite');
  repos.profiles.setStatus(a.id, 'accepted', { accepted_at: '2026-05-04T09:00:00.000Z', full_name: 'Ada L' });
  const b = repos.profiles.add(msg.id, 'https://www.linkedin.com/in/b', null, 'message');
  repos.profiles.setStatus(b.id, 'sent', { sent_at: '2026-06-01T00:00:00.000Z' });

  seedConnectionsFromProfiles(repos, NOW);

  expect(repos.connections.findByUrl('https://www.linkedin.com/in/a')!.connected_on).toBe('2026-05-04');
  expect(repos.connections.findByUrl('https://www.linkedin.com/in/a')!.full_name).toBe('Ada L');
  expect(repos.connections.findByUrl('https://www.linkedin.com/in/b')!.connected_on).toBeNull();
  expect(repos.connections.findByUrl('https://www.linkedin.com/in/b')!.source).toBe('migration');
});

test('collapses a person who appears in both an invite and a message cohort into one row', () => {
  const inv = repos.cohorts.create('inv', 'hi', true, 'invite');
  const msg = repos.cohorts.create('msg', 'hello', false, 'message');
  const url = 'https://www.linkedin.com/in/dup';

  const a = repos.profiles.add(inv.id, url, null, 'invite');
  repos.profiles.setStatus(a.id, 'accepted', { accepted_at: '2026-05-04T09:00:00.000Z' });
  const b = repos.profiles.add(msg.id, url, null, 'message');
  repos.profiles.setStatus(b.id, 'replied', { replied_at: '2026-06-10T00:00:00.000Z', full_name: 'Dup Person' });

  expect(seedConnectionsFromProfiles(repos, NOW)).toBe(1);
  const c = repos.connections.findByUrl(url)!;
  expect(c.connected_on).toBe('2026-05-04');
  expect(c.full_name).toBe('Dup Person');
});

test('is a one-shot: a second call seeds nothing and the stamp is recorded', () => {
  const inv = repos.cohorts.create('inv', 'hi', true, 'invite');
  const a = repos.profiles.add(inv.id, 'https://www.linkedin.com/in/a', null, 'invite');
  repos.profiles.setStatus(a.id, 'accepted', { accepted_at: '2026-05-04T09:00:00.000Z' });

  expect(seedConnectionsFromProfiles(repos, NOW)).toBe(1);
  expect(repos.appState.get().connections_seeded_at).toBe(NOW);
  expect(seedConnectionsFromProfiles(repos, '2026-08-01T00:00:00.000Z')).toBe(0);
  expect(repos.appState.get().connections_seeded_at).toBe(NOW);
});

test('never overwrites a connection that already exists from an import', () => {
  const inv = repos.cohorts.create('inv', 'hi', true, 'invite');
  const url = 'https://www.linkedin.com/in/a';
  repos.connections.upsert({ profile_url: url, full_name: 'From CSV', connected_on: '2020-01-01' }, 'csv', NOW);
  const a = repos.profiles.add(inv.id, url, null, 'invite');
  repos.profiles.setStatus(a.id, 'accepted', { accepted_at: '2026-05-04T09:00:00.000Z', full_name: 'From Profiles' });

  seedConnectionsFromProfiles(repos, NOW);

  const c = repos.connections.findByUrl(url)!;
  expect(c.full_name).toBe('From CSV');
  expect(c.connected_on).toBe('2020-01-01');
  expect(c.source).toBe('csv');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/db/seed-connections.test.ts`
Expected: FAIL — `Cannot find module '../../src/db/seed-connections.js'`.

- [ ] **Step 3: Implement the seed**

Create `src/db/seed-connections.ts`:

```ts
import type { Repos } from './repositories.js';

/**
 * One-time back-fill of the roster from campaign data that already proves a connection:
 *
 *  - `accepted` / `replied` profiles — acceptance or a reply confirmed it directly.
 *  - message-kind profiles that reached `sent` — the sender's live 1st-degree gate
 *    (`isAlreadyConnected`) had to pass before a DM could go out, so a sent message is
 *    proof of connection.
 *
 * Everything else is excluded: a `sent` INVITE is a pending request, not a connection.
 *
 * Runs at most once, gated on `app_state.connections_seeded_at`. Uses INSERT OR IGNORE so
 * a roster already populated by an import always wins — this is a back-fill, not a
 * source of truth. Returns the number of rows inserted.
 */
export function seedConnectionsFromProfiles(repos: Repos, nowIso: string): number {
  if (repos.appState.get().connections_seeded_at) return 0;

  // MIN/MAX ignore NULLs, which is exactly what we want when one person has both an
  // invite row (carrying accepted_at) and a message row (carrying the better full_name).
  const info = repos.db.prepare(`
    INSERT OR IGNORE INTO connections
      (profile_url, full_name, first_name, connected_on, source, first_seen_at, last_seen_at)
    SELECT
      profile_url,
      MAX(full_name),
      MAX(first_name),
      date(MIN(accepted_at)),
      'migration', ?, ?
    FROM profiles
    WHERE status IN ('accepted', 'replied')
       OR (kind = 'message' AND status IN ('sent', 'replied'))
    GROUP BY profile_url
  `).run(nowIso, nowIso);

  repos.appState.setConnectionsSeeded(nowIso);
  return Number(info.changes);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/db/seed-connections.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Wire the seed into startup**

In `src/index.ts`, after `const repos = new Repos(openDatabase(DB_PATH));`:

```ts
// One-time roster back-fill from campaign data that already proves a connection.
// No-op after the first run (gated on app_state.connections_seeded_at).
const seeded = seedConnectionsFromProfiles(repos, new Date().toISOString());
if (seeded > 0) log.info('roster', 'seeded connections from existing profiles', { seeded });
```

Add the import at the top: `import { seedConnectionsFromProfiles } from './db/seed-connections.js';`

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/db/seed-connections.ts src/index.ts tests/db/seed-connections.test.ts
git commit -m "feat(roster): one-time seed from accepted and messaged profiles"
```

---

### Task 7: Driver reads connection cards (URL + name)

**Files:**
- Modify: `src/browser/driver.ts`
- Modify: `src/browser/linkedin-driver.ts`
- Test: `tests/browser/driver.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/browser/driver.test.ts`:

```ts
import { test, expect } from 'vitest';
import { FakeDriver } from '../../src/browser/driver.js';

test('FakeDriver returns the scripted connection cards', async () => {
  const d = new FakeDriver();
  d.connectionCards = [
    { url: 'https://www.linkedin.com/in/ada', name: 'Ada Lovelace' },
    { url: 'https://www.linkedin.com/in/grace', name: null },
  ];
  await expect(d.readConnectionCards()).resolves.toEqual(d.connectionCards);
});

test('FakeDriver can script a card-read failure', async () => {
  const d = new FakeDriver();
  d.connectionCardsError = 'checkpoint detected during roster sync';
  await expect(d.readConnectionCards()).rejects.toThrow('checkpoint detected during roster sync');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/browser/driver.test.ts`
Expected: FAIL — the stub from Task 1 returns `[]`, so the first assertion fails.

- [ ] **Step 3: Implement on FakeDriver**

In `src/browser/driver.ts`, add to the imported types: `ConnectionCard`. Add these fields alongside `connections`:

```ts
  /** Cards returned by readConnectionCards (roster sync). */
  connectionCards: ConnectionCard[] = [];
  /** When set, readConnectionCards throws (read-failure paths). */
  connectionCardsError: string | null = null;
```

Replace the Task-1 stub with:

```ts
  async readConnectionCards(): Promise<ConnectionCard[]> {
    this.open = true;
    if (this.connectionCardsError) throw new Error(this.connectionCardsError);
    return this.connectionCards;
  }
```

- [ ] **Step 4: Implement on the real driver**

In `src/browser/linkedin-driver.ts`, replace the Task-1 stub with the real read (place it directly below `readRecentConnections`). Ensure `ConnectionCard` is imported from `../types.js`.

```ts
  /**
   * Roster sync's read of the connections page: same navigation and scroll as
   * readRecentConnections, but returns the display name alongside each URL so a
   * scrape-discovered connection has a name before enrichment ever runs.
   *
   * The name comes from the anchor's own text, NOT a class selector — the connections
   * page renders hashed class names that churn. Each card contributes several anchors
   * (avatar, name), so results are deduped by URL, preferring whichever anchor carried text.
   */
  async readConnectionCards(): Promise<ConnectionCard[]> {
    const page = await this.session.page();
    await page.goto(URLS.connections, { waitUntil: 'domcontentloaded' });
    await sleep(rand(2000, 4000));
    if ((await this.scanCheckpoint(page)).hit) {
      await captureEvidence(page, 'checkpoint', { during: 'roster sync' });
      throw new Error('checkpoint detected during roster sync');
    }
    await this.scrollConnections(page, 6);
    const raw = await page.locator(SEL.connectionCardLink).evaluateAll(
      (els) => els.map((e) => ({
        href: (e as HTMLAnchorElement).href,
        text: (e as HTMLElement).innerText ?? '',
      })),
    );
    const byUrl = new Map<string, ConnectionCard>();
    for (const { href, text } of raw) {
      const url = normalizeProfileUrl(href);
      if (!url) continue;
      const name = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? null;
      const existing = byUrl.get(url);
      if (!existing || (!existing.name && name)) byUrl.set(url, { url, name });
    }
    return [...byUrl.values()];
  }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/browser/driver.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/browser/driver.ts src/browser/linkedin-driver.ts tests/browser/driver.test.ts
git commit -m "feat(roster): read connection cards with display names"
```

---

### Task 8: roster-sync worker

**Files:**
- Create: `src/worker/roster-sync.ts`
- Test: `tests/worker/roster-sync.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/worker/roster-sync.test.ts`:

```ts
import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { FakeDriver } from '../../src/browser/driver.js';
import { runRosterSync } from '../../src/worker/roster-sync.js';

let repos: Repos; let driver: FakeDriver;
const NOW = new Date('2026-07-31T12:00:00.000Z');

beforeEach(() => {
  repos = new Repos(openDatabase(':memory:'));
  driver = new FakeDriver();
  repos.appState.setLogin({ loggedIn: true, cookieExpiry: null }, '2026-07-31T00:00:00.000Z');
});

test('upserts every card read and stamps roster_synced_at', async () => {
  driver.connectionCards = [
    { url: 'https://www.linkedin.com/in/ada', name: 'Ada Lovelace' },
    { url: 'https://www.linkedin.com/in/grace', name: 'Grace Hopper' },
  ];

  const r = await runRosterSync(repos, driver, NOW);

  expect(r).toMatchObject({ ran: true, seen: 2, discovered: 2 });
  expect(repos.connections.count()).toBe(2);
  expect(repos.connections.findByUrl('https://www.linkedin.com/in/ada')!.full_name).toBe('Ada Lovelace');
  expect(repos.connections.findByUrl('https://www.linkedin.com/in/ada')!.source).toBe('scrape');
  expect(repos.appState.get().roster_synced_at).toBe(NOW.toISOString());
});

test('a second pass over the same people discovers nothing new but advances last_seen_at', async () => {
  driver.connectionCards = [{ url: 'https://www.linkedin.com/in/ada', name: 'Ada Lovelace' }];
  await runRosterSync(repos, driver, NOW);

  const later = new Date('2026-08-01T12:00:00.000Z');
  const r = await runRosterSync(repos, driver, later);

  expect(r).toMatchObject({ ran: true, seen: 1, discovered: 0 });
  expect(repos.connections.count()).toBe(1);
  expect(repos.connections.findByUrl('https://www.linkedin.com/in/ada')!.last_seen_at).toBe(later.toISOString());
});

test('never invents connected_on for a scrape-discovered connection', async () => {
  driver.connectionCards = [{ url: 'https://www.linkedin.com/in/ada', name: 'Ada Lovelace' }];
  await runRosterSync(repos, driver, NOW);
  expect(repos.connections.findByUrl('https://www.linkedin.com/in/ada')!.connected_on).toBeNull();
});

test('an empty read changes nothing and does not stamp roster_synced_at', async () => {
  driver.connectionCards = [];
  const r = await runRosterSync(repos, driver, NOW);
  expect(r).toMatchObject({ ran: false, reason: 'empty_read', discovered: 0 });
  expect(repos.connections.count()).toBe(0);
  expect(repos.appState.get().roster_synced_at).toBeNull();
});

test('a read error records a failure and does not stamp roster_synced_at', async () => {
  driver.connectionCardsError = 'checkpoint detected during roster sync';
  const r = await runRosterSync(repos, driver, NOW);
  expect(r).toMatchObject({ ran: false, reason: 'read_error' });
  expect(repos.appState.get().roster_synced_at).toBeNull();
  expect(repos.appState.get().guardrail_tripped).toBe(1); // checkpoint text trips immediately
});

test('runs even with nothing pending acceptance — the roster is not hostage to the invite funnel', async () => {
  expect(repos.profiles.byStatus('sent')).toHaveLength(0);
  driver.connectionCards = [{ url: 'https://www.linkedin.com/in/ada', name: 'Ada Lovelace' }];
  await expect(runRosterSync(repos, driver, NOW)).resolves.toMatchObject({ ran: true });
});

test('paused blocks a scheduled pass but force overrides it', async () => {
  repos.settings.update({ paused: 1 });
  driver.connectionCards = [{ url: 'https://www.linkedin.com/in/ada', name: 'Ada' }];

  expect(await runRosterSync(repos, driver, NOW)).toMatchObject({ ran: false, reason: 'paused' });
  expect(await runRosterSync(repos, driver, NOW, { force: true })).toMatchObject({ ran: true });
});

test('a tripped guardrail blocks even a forced pass', async () => {
  repos.appState.trip('checkpoint', 'captcha', NOW.toISOString());
  driver.connectionCards = [{ url: 'https://www.linkedin.com/in/ada', name: 'Ada' }];
  expect(await runRosterSync(repos, driver, NOW, { force: true })).toMatchObject({ ran: false, reason: 'guardrail' });
});

test('a lost session trips login_lost and writes nothing', async () => {
  driver.loggedIn = false;
  driver.connectionCards = [{ url: 'https://www.linkedin.com/in/ada', name: 'Ada' }];
  const r = await runRosterSync(repos, driver, NOW);
  expect(r).toMatchObject({ ran: false, reason: 'login_lost' });
  expect(repos.connections.count()).toBe(0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/worker/roster-sync.test.ts`
Expected: FAIL — `Cannot find module '../../src/worker/roster-sync.js'`.

- [ ] **Step 3: Implement the worker**

Create `src/worker/roster-sync.ts`:

```ts
import type { Repos } from '../db/repositories.js';
import type { BrowserDriver } from '../types.js';
import { isTripped, tripLoginLost, recordReadError, recordSuccess } from './guardrail.js';
import { log } from '../core/log.js';

/**
 * Outcome of one roster pass. `ran` is true only when we actually read the connections
 * page and upserted; every early return sets `ran: false` with a `reason` so callers
 * (e.g. the manual "Sync now" endpoint) can report what happened.
 */
export interface RosterSyncResult {
  ran: boolean;
  reason?: 'paused' | 'guardrail' | 'logged_out' | 'login_lost' | 'read_error' | 'empty_read';
  /** Cards read off the page. */
  seen: number;
  /** Cards that were not already in the roster. */
  discovered: number;
  syncedAt?: string;
}

/**
 * Read the connections page and upsert everyone found into the roster.
 *
 * Deliberately mirrors acceptance-checker.ts's safety structure — same gates, same
 * empty-read fail-safe, same "stamp only on a clean pass so a failure retries next tick"
 * contract — with two differences:
 *
 *  1. There is NO "nothing pending" early return. The roster must stay fresh whether or
 *     not any invite is awaiting acceptance; that coupling is precisely what this worker
 *     exists to break.
 *  2. It only ever ADDS. Absence from the page never removes anyone (see the 2026-07-31
 *     design doc: removals are not tracked), so a partial read can under-discover but can
 *     never destroy data.
 *
 * Phase 1 note: the acceptance checker still performs its own independent read of the
 * same page. That duplication is intentional and temporary — it keeps a live pipeline off
 * unproven code — and is removed by the phase-3 cutover.
 */
export async function runRosterSync(
  repos: Repos,
  driver: BrowserDriver,
  now: Date,
  opts: { force?: boolean } = {},
): Promise<RosterSyncResult> {
  // `force` (manual sync) bypasses ONLY the paused gate — this pass is read-only against
  // LinkedIn. Every other safety gate below is unconditional.
  if (!opts.force && repos.settings.get().paused) return { ran: false, reason: 'paused', seen: 0, discovered: 0 };
  if (isTripped(repos)) return { ran: false, reason: 'guardrail', seen: 0, discovered: 0 };
  if (repos.appState.get().login_logged_in !== 1) return { ran: false, reason: 'logged_out', seen: 0, discovered: 0 };

  const snap = await driver.readLoginState();
  repos.appState.setLogin(snap, now.toISOString());
  if (!snap.loggedIn) {
    tripLoginLost(repos, now);
    return { ran: false, reason: 'login_lost', seen: 0, discovered: 0 };
  }

  let cards;
  try {
    cards = await driver.readConnectionCards();
  } catch (e) {
    // Checkpoint text trips immediately; other read failures count toward the streak.
    recordReadError(repos, (e as Error).message ?? 'roster read failed', now);
    return { ran: false, reason: 'read_error', seen: 0, discovered: 0 };
  }

  // Fail-safe: a suspiciously empty read (page didn't render, UI changed, rate-limited)
  // must never be treated as a successful pass. Skip it so the next tick retries.
  if (cards.length === 0) {
    log.warn('roster', 'connections read returned nothing — skipping (no state change)');
    return { ran: false, reason: 'empty_read', seen: 0, discovered: 0 };
  }

  const iso = now.toISOString();
  let discovered = 0;
  for (const card of cards) {
    const outcome = repos.connections.upsert(
      { profile_url: card.url, full_name: card.name },
      'scrape',
      iso,
    );
    if (outcome === 'inserted') discovered++;
  }

  repos.appState.setRosterSynced(iso);
  recordSuccess(repos); // a clean read clears any accumulated streak
  log.info('roster', 'synced', { seen: cards.length, discovered });
  return { ran: true, seen: cards.length, discovered, syncedAt: iso };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/worker/roster-sync.test.ts && npm run typecheck`
Expected: PASS (9 tests), no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/worker/roster-sync.ts tests/worker/roster-sync.test.ts
git commit -m "feat(roster): slot-gated roster-sync worker"
```

---

### Task 9: Orchestrator tick

**Files:**
- Modify: `src/worker/orchestrator.ts`
- Test: `tests/worker/orchestrator.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/worker/orchestrator.test.ts` (match the existing imports in that file; add `runRosterSync`'s subject via the orchestrator only):

```ts
test('roster tick runs once per slot and retries after a failed pass', async () => {
  const repos = new Repos(openDatabase(':memory:'));
  const driver = new FakeDriver();
  repos.appState.setLogin({ loggedIn: true, cookieExpiry: null }, '2026-07-31T00:00:00.000Z');
  repos.settings.update({ roster_sync_per_day: 2 });
  const orch = new Orchestrator(repos, driver);

  // First pass fails (empty read) -> nothing stamped, so the slot is NOT burned.
  driver.connectionCards = [];
  await orch.runRosterSyncTick(new Date('2026-07-31T09:00:00.000Z'));
  expect(repos.appState.get().roster_synced_at).toBeNull();

  // Retry in the same slot succeeds.
  driver.connectionCards = [{ url: 'https://www.linkedin.com/in/ada', name: 'Ada' }];
  await orch.runRosterSyncTick(new Date('2026-07-31T09:30:00.000Z'));
  expect(repos.appState.get().roster_synced_at).toBe('2026-07-31T09:30:00.000Z');

  // Same slot again -> no-op.
  driver.connectionCards = [{ url: 'https://www.linkedin.com/in/grace', name: 'Grace' }];
  await orch.runRosterSyncTick(new Date('2026-07-31T10:00:00.000Z'));
  expect(repos.connections.count()).toBe(1);

  // Next slot (2/day => slot boundary at local noon) -> runs again.
  await orch.runRosterSyncTick(new Date('2026-07-31T15:00:00.000Z'));
  expect(repos.connections.count()).toBe(2);
});

test('roster tick is a no-op while paused or halted', async () => {
  const repos = new Repos(openDatabase(':memory:'));
  const driver = new FakeDriver();
  repos.appState.setLogin({ loggedIn: true, cookieExpiry: null }, '2026-07-31T00:00:00.000Z');
  driver.connectionCards = [{ url: 'https://www.linkedin.com/in/ada', name: 'Ada' }];
  const orch = new Orchestrator(repos, driver);

  repos.settings.update({ paused: 1 });
  await orch.runRosterSyncTick(new Date('2026-07-31T09:00:00.000Z'));
  expect(repos.connections.count()).toBe(0);

  repos.settings.update({ paused: 0 });
  repos.appState.trip('checkpoint', 'captcha', '2026-07-31T08:00:00.000Z');
  await orch.runRosterSyncTick(new Date('2026-07-31T09:00:00.000Z'));
  expect(repos.connections.count()).toBe(0);
});
```

> Note: the slot test uses local-time hours because `acceptanceSlot` slices the **local**
> day. `09:00`/`10:00` and `15:00` are chosen to straddle local noon for a 2-per-day
> setting. If the runner's timezone makes those land in the same slot, adjust the hours —
> do not change `acceptanceSlot`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/worker/orchestrator.test.ts`
Expected: FAIL — `orch.runRosterSyncTick is not a function`.

- [ ] **Step 3: Implement the tick**

In `src/worker/orchestrator.ts`, add the import:

```ts
import { runRosterSync } from './roster-sync.js';
```

Add this method after `runReplyTick`:

```ts
  /**
   * Roster pass, at most once per slot (slot math shared with acceptance/reply checks via
   * acceptanceSlot — a generic day-slicer). The gate reads the PERSISTED
   * `roster_synced_at`, which runRosterSync stamps only on a clean, non-empty read, so a
   * bailed-out pass leaves the stamp untouched and the next 30-minute tick retries.
   * Queues behind in-flight browser work rather than being dropped.
   */
  async runRosterSyncTick(now: Date = new Date()): Promise<void> {
    const s = this.repos.settings.get();
    const app = this.repos.appState.get();
    if (s.paused || app.guardrail_tripped === 1) return;
    const slot = acceptanceSlot(now, s.roster_sync_per_day);
    if (app.roster_synced_at
      && acceptanceSlot(new Date(app.roster_synced_at), s.roster_sync_per_day) === slot) return;
    try {
      await this.browserLock.run(() => runRosterSync(this.repos, this.driver, now));
    } catch (err) {
      this.handleTickError('roster', err);
    }
  }
```

And register the timer in `start()`, next to the acceptance and reply timers:

```ts
    // Same cadence and the same slot-gate reasoning as the acceptance/reply passes.
    this.timers.push(setInterval(() => { void this.runRosterSyncTick(); }, 30 * 60 * 1000));
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/worker/orchestrator.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/worker/orchestrator.ts tests/worker/orchestrator.test.ts
git commit -m "feat(roster): slot-gated roster sync tick"
```

---

### Task 10: API endpoints

**Files:**
- Modify: `src/api/server.ts`
- Test: `tests/api/connections.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/api/connections.test.ts`:

```ts
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
});

test('rejects an empty import with a legible error', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/connections/import', payload: { text: '   ' } });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toMatch(/no linkedin profile urls/i);
});

test('rejects a malformed CSV with a legible error', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/connections/import',
    payload: { text: 'First Name,Last Name,URL\nAda,Lovelace,not-a-url' },
  });
  expect(res.statusCode).toBe(400);
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

test('sync-now forces a pass even while paused and reports the result', async () => {
  repos.settings.update({ paused: 1 });
  driver.connectionCards = [{ url: 'https://www.linkedin.com/in/ada', name: 'Ada Lovelace' }];
  const res = await app.inject({ method: 'POST', url: '/api/roster/sync-now' });
  expect(res.json()).toMatchObject({ ran: true, seen: 1, discovered: 1 });
});

test('roster_sync_per_day is settable through /api/settings', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/settings', payload: { roster_sync_per_day: 4 } });
  expect(res.statusCode).toBe(200);
  expect(repos.settings.get().roster_sync_per_day).toBe(4);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/api/connections.test.ts`
Expected: FAIL — 404 on every new route.

- [ ] **Step 3: Implement the endpoints**

In `src/api/server.ts`, add the imports:

```ts
import { parseRosterInput } from '../core/roster-input.js';
import { runRosterSync } from '../worker/roster-sync.js';
```

Add `'roster_sync_per_day'` to `ALLOWED_SETTINGS_KEYS`.

Add these routes (put them next to the other `/api` routes, after the cohort routes):

```ts
  /**
   * Ingest a roster. Accepts either a LinkedIn Connections.csv export (preamble and all)
   * or a bare list of profile URLs — the body is the same either way and the format is
   * sniffed. Idempotent: re-importing the same file updates rather than duplicates.
   */
  app.post('/api/connections/import', async (req, reply) => {
    const { text } = (req.body ?? {}) as { text?: string };
    if (typeof text !== 'string' || text.trim() === '') {
      return reply.code(400).send({ error: 'No LinkedIn profile URLs found in the input' });
    }
    // parseRosterInput throws on a CSV whose header we cannot recognize; the global error
    // handler turns that into a 400 with the message.
    const { format, rows, skipped } = parseRosterInput(text);
    if (rows.length === 0) {
      return reply.code(400).send({ error: 'No LinkedIn profile URLs found in the input' });
    }
    const nowIso = new Date().toISOString();
    let inserted = 0; let updated = 0;
    for (const row of rows) {
      if (repos.connections.upsert(row, format === 'csv' ? 'csv' : 'urls', nowIso) === 'inserted') inserted++;
      else updated++;
    }
    defaultLog.info('roster', 'import', { format, parsed: rows.length, inserted, updated, skipped });
    return { format, parsed: rows.length, inserted, updated, skipped };
  });

  app.get('/api/connections/stats', async () => ({
    total: repos.connections.count(),
    by_enrich_status: repos.connections.countsByEnrichStatus(),
    last_synced_at: repos.appState.get().roster_synced_at,
  }));

  /** Browse the roster (newest first). This is NOT the search API — that lands in phase 3. */
  app.get('/api/connections', async (req) => {
    const q = req.query as { limit?: string; offset?: string };
    const limit = Math.min(200, Math.max(1, Number(q.limit ?? 50) || 50));
    const offset = Math.max(0, Number(q.offset ?? 0) || 0);
    return { total: repos.connections.count(), limit, offset, results: repos.connections.list(limit, offset) };
  });

  app.post('/api/roster/sync-now', async () => {
    defaultLog.info('api', 'roster sync now');
    return browserLock.run(() => runRosterSync(repos, driver, new Date(), { force: true }));
  });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/api/connections.test.ts && npm run typecheck`
Expected: PASS (9 tests).

- [ ] **Step 5: Run the whole suite — nothing existing may regress**

Run: `npm test`
Expected: all PASS, including `tests/worker/acceptance-checker.test.ts` untouched and green.

- [ ] **Step 6: Commit**

```bash
git add src/api/server.ts tests/api/connections.test.ts
git commit -m "feat(roster): import, stats, list and sync-now endpoints"
```

---

### Task 11: Settings panel and wizard import

**Files:**
- Modify: `src/web/index.html`
- Modify: `src/web/app.js`
- Modify: `src/web/styles.css`
- Test: `tests/web/connections-panel.test.ts` (create)

> **Execute this task with an Opus subagent using the `frontend-design` skill** (user
> preference, recorded in memory). Match the existing panel/card/toast idiom in
> `index.html` and `styles.css` — this is one more Settings section, not a new visual
> language. The full Connections **tab** is phase 3; this task adds only the Settings
> panel plus an optional block in the existing wizard step.

- [ ] **Step 1: Write the failing test**

Create `tests/web/connections-panel.test.ts`, following the harness in
`tests/web/helpers/load-app.ts` used by `tests/web/dashboard.test.ts`:

```ts
import { test, expect, beforeEach, vi } from 'vitest';
import { loadApp } from './helpers/load-app.js';

let ctx: Awaited<ReturnType<typeof loadApp>>;
beforeEach(async () => { ctx = await loadApp(); });

test('renders roster stats from /api/connections/stats', async () => {
  ctx.mockApi('/api/connections/stats', {
    total: 8214,
    by_enrich_status: { pending: 2036, enriching: 0, enriched: 6140, empty: 0, failed: 38 },
    last_synced_at: '2026-07-31T09:00:00.000Z',
  });
  await ctx.refreshConnections();
  expect(ctx.document.getElementById('connTotal')!.textContent).toContain('8,214');
  expect(ctx.document.getElementById('connEnriched')!.textContent).toContain('6,140');
});

test('posting the import form sends the pasted text and reports the outcome', async () => {
  const post = ctx.mockApi('/api/connections/import', { format: 'csv', parsed: 2, inserted: 2, updated: 0, skipped: 0 });
  (ctx.document.getElementById('connImportText') as HTMLTextAreaElement).value = 'First Name,URL\nAda,https://www.linkedin.com/in/ada';
  ctx.document.getElementById('connImportForm')!.dispatchEvent(new ctx.window.Event('submit'));
  await ctx.flush();
  expect(post).toHaveBeenCalled();
  expect(ctx.document.getElementById('connImportResult')!.textContent).toMatch(/2 added/i);
});

test('an import error is surfaced, not swallowed', async () => {
  ctx.mockApiError('/api/connections/import', 400, 'No LinkedIn profile URLs found in the input');
  (ctx.document.getElementById('connImportText') as HTMLTextAreaElement).value = 'nonsense';
  ctx.document.getElementById('connImportForm')!.dispatchEvent(new ctx.window.Event('submit'));
  await ctx.flush();
  expect(ctx.document.getElementById('connImportResult')!.textContent).toMatch(/no linkedin profile urls/i);
});
```

> If `loadApp` does not already expose `mockApi` / `mockApiError` / `flush` /
> `refreshConnections`, extend the helper rather than inlining fetch stubs here — keep the
> web tests using one harness.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/web/connections-panel.test.ts`
Expected: FAIL — `connTotal` element is null.

- [ ] **Step 3: Add the Settings panel markup**

In `src/web/index.html`, inside `<section class="panel" id="tab-settings">`, immediately
before the `Run log` `panel-head sub` block:

```html
      <div class="panel-head sub">
        <div class="panel-title">
          <h3>Connections</h3>
          <p class="panel-sub">Your connection list — imported once, then kept current automatically</p>
        </div>
        <div class="panel-actions">
          <button class="btn" id="connSyncNow" type="button" title="Read the connections page now">Sync now</button>
        </div>
      </div>

      <div class="card-surface conn-panel">
        <div class="conn-stats">
          <div class="conn-stat"><span class="conn-stat-n" id="connTotal">—</span><span class="conn-stat-l">total</span></div>
          <div class="conn-stat"><span class="conn-stat-n" id="connEnriched">—</span><span class="conn-stat-l">enriched</span></div>
          <div class="conn-stat"><span class="conn-stat-n" id="connPending">—</span><span class="conn-stat-l">awaiting enrichment</span></div>
          <div class="conn-stat"><span class="conn-stat-n" id="connSynced">—</span><span class="conn-stat-l">last synced</span></div>
        </div>

        <form id="connImportForm" class="conn-import">
          <label for="connImportText">Import connections</label>
          <p class="hint">
            Paste your LinkedIn <code>Connections.csv</code> export (Settings &amp; Privacy →
            Get a copy of your data → Connections), or just a list of profile URLs.
            Re-importing the same file updates existing entries rather than duplicating them.
          </p>
          <input type="file" id="connImportFile" accept=".csv,.txt" />
          <textarea id="connImportText" rows="6" placeholder="First Name,Last Name,URL,…&#10;— or —&#10;https://www.linkedin.com/in/someone"></textarea>
          <button class="btn btn-green" type="submit">Import</button>
        </form>
        <div class="toast" id="connImportResult" hidden></div>
      </div>
```

Add the cadence field to `#settingsForm`, in the `Both engines` group next to the workday hours:

```html
        <div class="field"><label for="setRosterSync">Connection syncs / day <span class="hint">1–24</span></label><input id="setRosterSync" type="number" min="1" max="24" /></div>
```

- [ ] **Step 4: Add the optional wizard import block**

In `src/web/index.html`, inside the existing `<div class="wizard-step">`, after the
`wizard-actions` block:

```html
        <details class="wizard-optional" id="wizImport">
          <summary>Import your connections now <span class="hint">optional</span></summary>
          <p class="hint">
            Paste your LinkedIn <code>Connections.csv</code> export or a list of profile URLs.
            You can always do this later under Settings → Connections.
          </p>
          <textarea id="wizImportText" rows="4" placeholder="Paste Connections.csv contents or profile URLs"></textarea>
          <button class="btn" id="wizImportBtn" type="button">Import</button>
          <div class="toast slim" id="wizImportResult" hidden></div>
        </details>
```

> Keep the wizard a **single step**. Turning it into a stepper is a much larger change to
> `app.js` than this feature justifies, and "Finish setup" must remain reachable without
> importing anything.

- [ ] **Step 5: Wire it up in app.js**

In `src/web/app.js`, add (following the file's existing fetch/render/toast helpers — reuse
them rather than introducing new ones):

```js
const fmtInt = (n) => Number(n ?? 0).toLocaleString();

async function refreshConnections() {
  const s = await getJSON('/api/connections/stats');
  byId('connTotal').textContent = fmtInt(s.total);
  byId('connEnriched').textContent = fmtInt(s.by_enrich_status.enriched);
  byId('connPending').textContent = fmtInt(s.by_enrich_status.pending);
  byId('connSynced').textContent = s.last_synced_at ? relTime(s.last_synced_at) : 'never';
}

async function importConnections(text, resultEl) {
  try {
    const r = await postJSON('/api/connections/import', { text });
    const bits = [`${fmtInt(r.inserted)} added`, `${fmtInt(r.updated)} updated`];
    if (r.skipped) bits.push(`${fmtInt(r.skipped)} skipped (no usable URL)`);
    showToast(resultEl, bits.join(' · '), 'ok');
    await refreshConnections();
  } catch (e) {
    showToast(resultEl, e.message, 'err');
  }
}

// Reading the file into the textarea keeps ONE submit path — the endpoint only ever
// receives text, so a pasted export and an uploaded file behave identically.
byId('connImportFile')?.addEventListener('change', async (ev) => {
  const file = ev.target.files?.[0];
  if (file) byId('connImportText').value = await file.text();
});

byId('connImportForm')?.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  await importConnections(byId('connImportText').value, byId('connImportResult'));
});

byId('wizImportBtn')?.addEventListener('click', async () => {
  await importConnections(byId('wizImportText').value, byId('wizImportResult'));
});

byId('connSyncNow')?.addEventListener('click', async () => {
  const r = await postJSON('/api/roster/sync-now', {});
  showToast(
    byId('connImportResult'),
    r.ran ? `Synced — ${fmtInt(r.seen)} read, ${fmtInt(r.discovered)} new` : `Did not run (${r.reason})`,
    r.ran ? 'ok' : 'warn',
  );
  await refreshConnections();
});
```

Add `roster_sync_per_day` to the settings form's load and save paths alongside
`reply_checks_per_day` (element id `setRosterSync`), and call `refreshConnections()`
wherever the Settings tab is shown.

- [ ] **Step 6: Add styles**

In `src/web/styles.css`, add rules for `.conn-panel`, `.conn-stats`, `.conn-stat`,
`.conn-stat-n`, `.conn-stat-l`, `.conn-import`, and `.wizard-optional`, reusing the
existing spacing scale, card surface, and colour custom properties. The stat row should
sit on one line on desktop and wrap on narrow widths.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run tests/web/connections-panel.test.ts && npm test`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add src/web/index.html src/web/app.js src/web/styles.css tests/web/connections-panel.test.ts tests/web/helpers/load-app.ts
git commit -m "feat(roster): Settings connections panel and optional wizard import"
```

---

### Task 12: Documentation

**Files:**
- Modify: `API.md`
- Modify: `README.md`

- [ ] **Step 1: Document the endpoints in API.md**

Add a `## Connections` section matching the file's existing per-endpoint format (method,
path, body, response, errors) for:

- `POST /api/connections/import` — body `{ text }`; accepts a `Connections.csv` export or a
  bare URL list; response `{ format, parsed, inserted, updated, skipped }`; `400` when no
  usable URLs are found or the CSV header is unrecognizable. Idempotent.
- `GET /api/connections?limit=&offset=` — browse the roster newest-first; response
  `{ total, limit, offset, results }`. Note explicitly that **search lands in phase 3**.
- `GET /api/connections/stats` — `{ total, by_enrich_status, last_synced_at }`.
- `POST /api/roster/sync-now` — forces one connections-page read; response is the
  `RosterSyncResult` (`{ ran, reason?, seen, discovered, syncedAt? }`).

- [ ] **Step 2: Document the feature in README.md**

Add a `## Connections` section after `## Invites and messages` covering: what the roster is,
that it's append-only and does not track removals, how to import (Settings → Connections, or
the setup wizard), that `roster_sync_per_day` (default 2) governs discovery of newly-added
connections, and that enrichment and search arrive in later phases. Add `roster_sync_per_day`
to the settings documentation.

- [ ] **Step 3: Verify the docs render in-app**

Run: `npm start`, open <http://localhost:4400>, go to **Docs**, confirm API.md and README.md
render with the new sections (they are served by `listDocs`/`readDoc`). Stop with `Ctrl+C`.

- [ ] **Step 4: Commit**

```bash
git add API.md README.md
git commit -m "docs(roster): document the connection roster and its endpoints"
```

---

### Task 13: End-to-end test and live verification

**Files:**
- Create: `scripts/verify-roster-sync.ts`
- Test: `tests/e2e/roster.test.ts` (create)

- [ ] **Step 1: Write the end-to-end test**

Create `tests/e2e/roster.test.ts`:

```ts
import { test, expect } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { FakeDriver } from '../../src/browser/driver.js';
import { buildServer } from '../../src/api/server.js';
import { seedConnectionsFromProfiles } from '../../src/db/seed-connections.js';
import { Orchestrator } from '../../src/worker/orchestrator.js';

test('seed -> import -> sync builds one coherent roster, and acceptance is unaffected', async () => {
  const repos = new Repos(openDatabase(':memory:'));
  const driver = new FakeDriver();
  repos.appState.setLogin({ loggedIn: true, cookieExpiry: null }, '2026-07-31T00:00:00.000Z');
  const app = buildServer(repos, driver);

  // 1. Existing campaign data seeds the roster.
  const inv = repos.cohorts.create('inv', 'hi', true, 'invite');
  const accepted = repos.profiles.add(inv.id, 'https://www.linkedin.com/in/ada', null, 'invite');
  repos.profiles.setStatus(accepted.id, 'accepted', { accepted_at: '2026-05-04T09:00:00.000Z' });
  const pendingInvite = repos.profiles.add(inv.id, 'https://www.linkedin.com/in/pending', null, 'invite');
  repos.profiles.setStatus(pendingInvite.id, 'sent', { sent_at: '2026-07-01T00:00:00.000Z' });

  expect(seedConnectionsFromProfiles(repos, '2026-07-31T00:00:00.000Z')).toBe(1);

  // 2. A CSV import adds two more and enriches Ada's row with CSV detail.
  await app.inject({
    method: 'POST', url: '/api/connections/import',
    payload: {
      text: [
        'First Name,Last Name,URL,Company,Position,Connected On',
        'Ada,Lovelace,https://www.linkedin.com/in/ada,Analytical Engines,Mathematician,04 Mar 2024',
        'Grace,Hopper,https://www.linkedin.com/in/grace,US Navy,Rear Admiral,12 Dec 1985',
      ].join('\n'),
    },
  });
  expect(repos.connections.count()).toBe(2);
  const ada = repos.connections.findByUrl('https://www.linkedin.com/in/ada')!;
  expect(ada.current_title).toBe('Mathematician');
  expect(ada.connected_on).toBe('2026-05-04');   // seed value wins — connected_on is immutable
  expect(ada.source).toBe('migration');

  // 3. Roster sync discovers a brand-new connection.
  driver.connectionCards = [
    { url: 'https://www.linkedin.com/in/ada', name: 'Ada Lovelace' },
    { url: 'https://www.linkedin.com/in/newperson', name: 'New Person' },
  ];
  await new Orchestrator(repos, driver).runRosterSyncTick(new Date('2026-07-31T09:00:00.000Z'));
  expect(repos.connections.count()).toBe(3);
  expect(repos.connections.findByUrl('https://www.linkedin.com/in/newperson')!.source).toBe('scrape');

  // 4. The invite pipeline is untouched: the pending invite is still pending, not accepted.
  expect(repos.profiles.byStatus('sent').map((p) => p.id)).toEqual([pendingInvite.id]);

  const stats = (await app.inject({ method: 'GET', url: '/api/connections/stats' })).json();
  expect(stats).toMatchObject({ total: 3, by_enrich_status: { pending: 3, enriched: 0 } });

  await app.close();
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/e2e/roster.test.ts`
Expected: PASS.

- [ ] **Step 3: Write the live verification script**

Create `scripts/verify-roster-sync.ts`, following the shape of the existing
`scripts/verify-*.ts` files:

```ts
/**
 * Live, read-only verification of the roster read. Opens the real browser against the
 * persisted LinkedIn session, reads one page of connections, and prints what it found.
 * WRITES NOTHING to the database.
 *
 *   npx tsx scripts/verify-roster-sync.ts
 */
import { LinkedInDriver } from '../src/browser/linkedin-driver.js';

const driver = new LinkedInDriver();
try {
  const snap = await driver.readLoginState();
  if (!snap.loggedIn) { console.error('Not logged in — run the app and click Connect LinkedIn first.'); process.exit(1); }

  const cards = await driver.readConnectionCards();
  console.log(`read ${cards.length} connection cards`);
  console.log(`  with a name: ${cards.filter((c) => c.name).length}`);
  for (const c of cards.slice(0, 10)) console.log(`  ${c.name ?? '(no name)'} — ${c.url}`);
  if (cards.length === 0) console.error('EMPTY READ — selectors or scrolling may be broken.');
} finally {
  await driver.close();
}
```

- [ ] **Step 4: Run the live verification**

Ensure the app is **not** running (the browser profile is single-instance — a running app
holds `.linkedin-profile` and this script will fail to launch).

Run: `npx tsx scripts/verify-roster-sync.ts`
Expected: a non-zero card count, most with names, and URLs in the normalized
`https://www.linkedin.com/in/<slug>` form. If it reads 0 cards, the selector or the wheel
scrolling has drifted — fix `readConnectionCards` before merging, and do **not** relax the
empty-read fail-safe.

- [ ] **Step 5: Full suite, typecheck, and a real startup**

Run: `npm test && npm run typecheck`
Expected: all PASS.

Then run `npm start` once and confirm in the log that the seed ran against the production
database (`roster seeded connections from existing profiles`), that
`data/app.db.pre-connections-backup` was created, and that Settings → Connections shows a
non-zero total. Stop with `Ctrl+C` (never kill the window — it orphans the browser).

- [ ] **Step 6: Commit**

```bash
git add scripts/verify-roster-sync.ts tests/e2e/roster.test.ts
git commit -m "test(roster): end-to-end roster test and live verification script"
```

---

## Done criteria for phase 1

- [ ] `npm test` and `npm run typecheck` both clean.
- [ ] `tests/worker/acceptance-checker.test.ts` is **unmodified** and passing — the invite
      pipeline was not touched.
- [ ] `data/app.db.pre-connections-backup` exists after the first real start.
- [ ] Settings → Connections shows a total seeded from existing campaign data.
- [ ] A real `Connections.csv` import reports a sensible added/updated/skipped split, and
      re-importing it reports 0 added.
- [ ] `scripts/verify-roster-sync.ts` reads a non-zero number of named cards from the live
      connections page.
