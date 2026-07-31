# Connection Directory — Phase 2 (Apify Enrichment) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrich every roster connection with its LinkedIn profile via Apify — name, headline, parsed location, current role, full experience/education/skills — and index it for the phase-3 search.

**Architecture:** A TypeScript Apify client (ported from `C:\Projects\prospecting\apify_linkedin.py`) sits behind an injectable interface. A concurrent, resumable worker drains connections whose `enrich_status` is `pending`, one URL per actor run at configurable concurrency, writing extracted scalars + a cherry-picked `raw_json` + an FTS5 document. Unlike every other worker here it has **no pacing, no guardrail and no browser mutex** — Apify runs on third-party infrastructure and never touches the LinkedIn session. Spec: `docs/superpowers/specs/2026-07-31-connection-directory-design.md` (see "Apify payload findings").

**Tech Stack:** Node 22+ (`node:sqlite`, FTS5 verified available), TypeScript ESM, Fastify, vitest, vanilla-JS frontend.

**Execution notes:**
- Run all commands from the repo root. Tests: `npx vitest run <file>`; all: `npm test`. Typecheck: `npm run typecheck`.
- `data/app.db` is **PRODUCTION** and now holds **7,147 real connections**. Never point a test at it.
- **No test may call Apify.** The client is injectable and faked everywhere. The one real call lives in `scripts/verify-enrichment.ts`, run by hand.
- Real raw fixture: `tests/fixtures/apify-profile-raw.json` (captured live 2026-07-31).
- 6,333 further real (cherry-picked) payloads exist at `C:\Projects\prospecting\icp_cache_contacts\linkedin_*.json` for eyeballing shape variety. Do not copy them into this repo.
- UI task (Task 8) uses the `frontend-design` skill and must match the existing Settings idiom.
- Commit after every task.

---

## File Structure

| File | Change |
|---|---|
| `src/types.ts` | `ApifyProfile` (raw subset), `EnrichedProfile` (extracted), `EnrichOutcome` |
| `src/db/schema.sql` | `location_country_code` column; `connections_fts` FTS5 table; `apify_api_key` + `enrich_ttl_days` + `enrich_concurrency` settings |
| `src/db/database.ts` | ALTERs for the new columns; FTS table needs none (CREATE IF NOT EXISTS) |
| `src/db/repositories.ts` | `claimForEnrichment`, `applyEnrichment`, `markEnrichFailure`, `resetFailed`, `dueForRefresh`, FTS upsert; key accessor kept out of `SETTINGS_COLUMNS` reads |
| `src/core/apify-client.ts` (new) | `ApifyClient` interface + `HttpApifyClient` (fetch, retries, backoff) |
| `src/core/apify-extract.ts` (new) | `isEmptyProfile`, `extractProfile`, `flattenForFts` — pure, fully tested |
| `src/worker/enrichment.ts` (new) | Concurrent resumable drain loop, pause/resume, progress snapshot |
| `src/api/server.ts` | `POST /api/enrichment/start|pause`, `GET /api/enrichment/status`, `POST /api/connections/:slug/refresh`, `POST /api/enrichment/retry-failed`; write-only key handling |
| `src/web/index.html` | Enrichment progress + controls in the Connections panel; Apify key field |
| `src/web/app.js` | Progress polling, start/pause, key save |
| `src/web/styles.css` | Progress bar + state chips |
| `scripts/verify-enrichment.ts` (new) | One real profile against live Apify |
| `API.md`, `README.md` | Enrichment endpoints, cost, settings |

---

### Task 1: Schema, types, and the FTS table

**Files:**
- Modify: `src/types.ts`, `src/db/schema.sql`, `src/db/database.ts`
- Test: `tests/db/database.test.ts` (append)

- [ ] **Step 1: Write the failing test**

```ts
test('migrates a pre-enrichment database: adds enrichment columns and the FTS table', () => {
  const db = openDatabase(':memory:');
  const cols = (db.prepare('PRAGMA table_info(connections)').all() as { name: string }[]).map((c) => c.name);
  expect(cols).toContain('location_country_code');
  const scols = (db.prepare('PRAGMA table_info(settings)').all() as { name: string }[]).map((c) => c.name);
  expect(scols).toEqual(expect.arrayContaining(['apify_api_key', 'enrich_ttl_days', 'enrich_concurrency']));
  // FTS5 must be usable — node:sqlite ships it, verified 2026-07-31.
  db.exec("INSERT INTO connections_fts (rowid, doc) VALUES (1, 'seattle security engineer')");
  const hit = db.prepare("SELECT rowid FROM connections_fts WHERE connections_fts MATCH 'securit*'").get();
  expect(hit).toBeTruthy();
});
```

Run: `npx vitest run tests/db/database.test.ts` → FAIL (`no such column: location_country_code`).

- [ ] **Step 2: Add schema**

In `src/db/schema.sql`, add to `connections` after `location_country`:

```sql
  location_country_code TEXT,         -- ISO-3166 alpha-2, straight from Apify's parsed location
```

Add to `settings` after `roster_sync_per_day`:

```sql
  -- Apify credential. Write-only over HTTP: GET /api/settings never returns it.
  apify_api_key TEXT,
  -- Re-enrich a connection this many days after its last successful scrape.
  enrich_ttl_days INTEGER NOT NULL DEFAULT 180,
  -- Concurrent Apify runs. No LinkedIn risk — bounded only by your Apify plan.
  enrich_concurrency INTEGER NOT NULL DEFAULT 8,
```

Append the FTS table:

```sql
-- Search index over the enriched corpus. Contentless-external would couple us to
-- connections' rowids on every write path; a plain FTS5 table keyed by connection id is
-- simpler and small (one text doc per person). Rebuilt per enrichment, never partially.
CREATE VIRTUAL TABLE IF NOT EXISTS connections_fts USING fts5(doc);
```

- [ ] **Step 3: Add migrations**

In `runMigrations`, after the roster block:

```ts
  // --- Enrichment (phase 2) ---
  const connCols = (db.prepare('PRAGMA table_info(connections)').all() as { name: string }[]).map((c) => c.name);
  if (connCols.length > 0 && !connCols.includes('location_country_code')) {
    db.exec('ALTER TABLE connections ADD COLUMN location_country_code TEXT');
  }
  if (cols.length > 0 && !cols.includes('apify_api_key')) {
    db.exec('ALTER TABLE settings ADD COLUMN apify_api_key TEXT');
  }
  if (cols.length > 0 && !cols.includes('enrich_ttl_days')) {
    db.exec('ALTER TABLE settings ADD COLUMN enrich_ttl_days INTEGER NOT NULL DEFAULT 180');
  }
  if (cols.length > 0 && !cols.includes('enrich_concurrency')) {
    db.exec('ALTER TABLE settings ADD COLUMN enrich_concurrency INTEGER NOT NULL DEFAULT 8');
  }
```

- [ ] **Step 4: Add types** to `src/types.ts`:

```ts
/** The subset of Apify's ~50-field payload we actually read. Shapes verified live
 *  2026-07-31 — see the spec's "Apify payload findings". */
export interface ApifyProfile {
  id?: string | null;
  publicIdentifier?: string | null;
  linkedinUrl?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  name?: string | null;
  headline?: string | null;
  about?: string | null;
  /** Apify pre-parses this; never comma-split linkedinText yourself. */
  location?: {
    linkedinText?: string | null;
    countryCode?: string | null;
    parsed?: {
      text?: string | null; city?: string | null; state?: string | null;
      country?: string | null; countryFull?: string | null; countryCode?: string | null;
    } | null;
  } | string | null;
  currentPosition?: ApifyPosition[] | null;
  experience?: ApifyPosition[] | null;
  education?: Record<string, unknown>[] | null;
  skills?: ({ name?: string | null } | string)[] | null;
  topSkills?: ({ name?: string | null } | string)[] | null;
  certifications?: Record<string, unknown>[] | null;
  languages?: ({ name?: string | null } | string)[] | null;
  originalQuery?: { query?: string | null } | null;
}

/** Apify uses `position`, not `title`. */
export interface ApifyPosition {
  position?: string | null;
  title?: string | null;
  companyName?: string | null;
  location?: unknown;
  employmentType?: string | null;
  duration?: string | null;
  startDate?: unknown;
  endDate?: unknown;
  description?: string | null;
}

/** What extraction produces: indexed scalars, a compact payload, and the FTS document. */
export interface EnrichedProfile {
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
  location_country_code: string | null;
  current_title: string | null;
  current_company: string | null;
  /** Cherry-picked payload stored as raw_json. */
  compact: Record<string, unknown>;
  /** Flattened searchable text for connections_fts. */
  doc: string;
}

export type EnrichOutcome =
  | { kind: 'enriched'; profile: EnrichedProfile }
  | { kind: 'empty' }                       // silent-empty shell: 200 OK, no signal
  | { kind: 'failed'; error: string };
```

- [ ] **Step 5: Run** `npx vitest run tests/db/database.test.ts && npm run typecheck` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/db/schema.sql src/db/database.ts tests/db/database.test.ts
git commit -m "feat(enrich): enrichment schema, FTS table, and Apify payload types"
```

---

### Task 2: Payload extraction (pure, no network)

**Files:**
- Create: `src/core/apify-extract.ts`
- Test: `tests/core/apify-extract.test.ts`
- Fixture: `tests/fixtures/apify-profile-raw.json` (already present)

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isEmptyProfile, extractProfile } from '../../src/core/apify-extract.js';
import type { ApifyProfile } from '../../src/types.js';

const RAW = JSON.parse(
  readFileSync(join(process.cwd(), 'tests/fixtures/apify-profile-raw.json'), 'utf8'),
) as ApifyProfile;

test('extracts identity and current role from a real payload', () => {
  const p = extractProfile(RAW);
  expect(p.linkedin_id).toBe('ACoAABCb3-UBTG79PeQUR4P-txeGhSMVy1_AU5k');
  expect(p.public_identifier).toBe('keren-tevet-3453a079');
  expect(p.full_name).toBe('Keren Tevet');
  expect(p.current_title).toBe('Senior Software Engineer');   // from `position`, not `title`
  expect(p.current_company).toBe('Aiven');
});

test('uses Apify\'s parsed location rather than splitting the display string', () => {
  const p = extractProfile(RAW);
  expect(p.location_raw).toBe('Israel');
  expect(p.location_country).toBe('Israel');
  expect(p.location_country_code).toBe('IL');
  expect(p.location_city).toBeNull();      // a country-only location yields no city
});

test('resolves a metro-area location into city/state/country', () => {
  const p = extractProfile({
    location: {
      linkedinText: 'Greater Leeds Area', countryCode: 'GB',
      parsed: { text: 'Leeds, United Kingdom', city: 'Leeds', state: 'England', country: 'UK', countryFull: 'United Kingdom', countryCode: 'GB' },
    },
  });
  expect(p.location_raw).toBe('Greater Leeds Area');
  expect(p.location_city).toBe('Leeds');
  expect(p.location_region).toBe('England');
  expect(p.location_country).toBe('United Kingdom'); // countryFull beats the "UK" abbreviation
  expect(p.location_country_code).toBe('GB');
});

test('tolerates location arriving as a bare string (older payload shape)', () => {
  const p = extractProfile({ location: 'Seattle, Washington, United States' } as ApifyProfile);
  expect(p.location_raw).toBe('Seattle, Washington, United States');
  expect(p.location_city).toBeNull();      // no parsed object => we do NOT guess
  expect(p.location_country_code).toBeNull();
});

test('the FTS document carries every field search must reach', () => {
  const { doc } = extractProfile(RAW);
  const lower = doc.toLowerCase();
  for (const term of ['keren', 'senior software engineer', 'aiven', 'israel', 'python']) {
    expect(lower).toContain(term);
  }
});

test('skills are flattened from objects to names', () => {
  const p = extractProfile(RAW);
  expect(p.compact.skills).toEqual(expect.arrayContaining(['C++']));
});

test('isEmptyProfile only fires when EVERY identifying signal is missing', () => {
  expect(isEmptyProfile({})).toBe(true);
  expect(isEmptyProfile({ firstName: '', headline: '', about: '', experience: [], education: [], skills: [] })).toBe(true);
  expect(isEmptyProfile({ headline: 'Security Engineer' })).toBe(false); // sparse but real
  expect(isEmptyProfile(RAW)).toBe(false);
});
```

Run → FAIL (module not found).

- [ ] **Step 2: Implement `src/core/apify-extract.ts`**

Port `is_empty_profile` and `extract_classifier_input` from the reference script, with the
location change. Key rules:

```ts
import type { ApifyProfile, ApifyPosition, EnrichedProfile } from '../types.js';

const str = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s === '' ? null : s;
};

const nameOf = (x: unknown): string | null =>
  typeof x === 'string' ? str(x)
    : (x && typeof x === 'object') ? str((x as { name?: unknown }).name) : null;

const names = (items: unknown, limit: number): string[] =>
  Array.isArray(items) ? items.map(nameOf).filter((v): v is string => !!v).slice(0, limit) : [];

/**
 * Apify's "silent empty": HTTP 200 with a valid-shaped payload where every field is null.
 * Declared empty ONLY when all identifying signals are missing, so a sparse-but-real
 * profile (headline only) is not falsely flagged. Ported from apify_linkedin.py.
 */
export function isEmptyProfile(raw: ApifyProfile | null | undefined): boolean {
  if (!raw || typeof raw !== 'object') return true;
  const name = `${raw.firstName ?? ''}${raw.lastName ?? ''}${raw.name ?? ''}`.trim();
  return !name && !str(raw.headline) && !str(raw.about)
    && !(raw.experience?.length) && !(raw.education?.length) && !(raw.skills?.length);
}

const roleTitle = (p: ApifyPosition | undefined): string | null =>
  p ? str(p.position) ?? str(p.title) : null;
```

`extractProfile` must:
- Build `full_name` from `name`, else `firstName + lastName`.
- Take `current_title`/`current_company` from `currentPosition[0]`, falling back to
  `experience[0]` — using `position` before `title`.
- **Location:** if `location` is an object with `parsed`, take `city`/`state`, prefer
  `countryFull` over `country`, and `parsed.countryCode ?? location.countryCode`;
  `location_raw` is `linkedinText ?? parsed.text`. If `location` is a bare string, set only
  `location_raw` — **never comma-split** (measured: 3.2% of display strings put a country in
  the second segment, which positional splitting mislabels as a region).
- Trim `experience` to 12 entries and `education`, mapping `position` → `title`.
- `compact` holds: name, headline, location, about, currentPosition, experience, education,
  skills (≤40), topSkills (≤10), certifications, languages.
- `doc` joins, newline-separated: full name, headline, about, location_raw, city, region,
  country, every experience title + company + description, education school + degree +
  field, skills, certification names.

- [ ] **Step 3: Run** `npx vitest run tests/core/apify-extract.test.ts` → PASS (7 tests).

- [ ] **Step 4: Commit**

```bash
git add src/core/apify-extract.ts tests/core/apify-extract.test.ts tests/fixtures/apify-profile-raw.json
git commit -m "feat(enrich): Apify payload extraction with parsed-location handling"
```

---

### Task 3: Apify client

**Files:**
- Create: `src/core/apify-client.ts`
- Test: `tests/core/apify-client.test.ts`

- [ ] **Step 1: Write the failing test** — cover: success, retry-then-succeed on 5xx, giving
up after `MAX_RETRIES`, non-array payload, empty dataset, and that the token never appears in
a thrown message.

```ts
test('retries a 5xx then succeeds', async () => {
  let calls = 0;
  const fetchStub = async () => {
    calls++;
    return calls < 2
      ? { ok: false, status: 502, json: async () => ({}) }
      : { ok: true, status: 201, json: async () => [{ publicIdentifier: 'ada' }] };
  };
  const client = new HttpApifyClient('tok', { fetchImpl: fetchStub as never, backoffMs: 0 });
  const out = await client.fetchProfile('https://www.linkedin.com/in/ada');
  expect(calls).toBe(2);
  expect(out.publicIdentifier).toBe('ada');
});

test('never leaks the token in an error message', async () => {
  const fetchStub = async () => ({ ok: false, status: 401, json: async () => ({ error: 'bad token' }) });
  const client = new HttpApifyClient('SUPER-SECRET', { fetchImpl: fetchStub as never, backoffMs: 0, maxRetries: 0 });
  await expect(client.fetchProfile('https://www.linkedin.com/in/ada')).rejects.toThrow(/401/);
  await expect(client.fetchProfile('https://www.linkedin.com/in/ada')).rejects.not.toThrow(/SUPER-SECRET/);
});
```

- [ ] **Step 2: Implement**

```ts
export interface ApifyClient {
  /** Resolves the first dataset item, or throws. Never returns undefined. */
  fetchProfile(profileUrl: string): Promise<ApifyProfile>;
}

const ACTOR_ID = 'LpVuK3Zozwuipa5bp';           // harvestapi/linkedin-profile-scraper
const SCRAPER_MODE = 'Profile details no email ($4 per 1k)';
```

`HttpApifyClient` POSTs to
`https://api.apify.com/v2/acts/${ACTOR_ID}/run-sync-get-dataset-items?token=…` with
`{ profileScraperMode, queries: [profileUrl] }`, 300 s timeout, `maxRetries` 2 with
`backoffMs` 5000. One URL per run — see the spec's finding 3. **The token goes in the query
string, so it must never be interpolated into an error message**; throw
`Apify run failed (HTTP ${status})` only.

- [ ] **Step 3: Run** → PASS. **Step 4: Commit.**

---

### Task 4: Repository methods for the enrichment lifecycle

**Files:** `src/db/repositories.ts`; Test: `tests/db/connections-repo.test.ts` (append)

- [ ] **Step 1: Write the failing tests** covering:
  - `claimForEnrichment(n)` returns pending rows and flips them to `enriching`, so two
    concurrent workers never claim the same row.
  - `applyEnrichment` writes scalars + `raw_json` + `enriched_at`, sets `enriched`, resets
    `enrich_error`, and upserts the FTS doc (re-enriching replaces, never duplicates).
  - `markEnrichFailure` increments `enrich_attempts`, and parks at `failed` on the 3rd
    attempt but leaves `pending` before that.
  - An `empty` outcome parks immediately as `empty` (a shell will not become real on retry).
  - `dueForRefresh(ttlDays, now)` returns only `enriched` rows older than the TTL.
  - `resetFailed()` returns `failed`/`empty` rows to `pending` with attempts zeroed.
  - Merge-by-`linkedin_id`: enriching a row whose `linkedin_id` already exists on a
    *different* row merges into the older row and records the loser's URL in
    `connection_aliases`.

- [ ] **Step 2: Implement.** All multi-statement paths run inside a transaction (phase 1
lesson: `node:sqlite` is synchronous and un-batched commits fsync per row).

- [ ] **Step 3: Run → PASS. Step 4: Commit.**

---

### Task 5: The enrichment worker

**Files:** Create `src/worker/enrichment.ts`; Test: `tests/worker/enrichment.test.ts`

- [ ] **Step 1: Write the failing tests** with a `FakeApifyClient`:
  - Drains all pending rows and reports `{ enriched, empty, failed }`.
  - Runs `concurrency` requests in flight at once — assert observed max concurrency.
  - A single profile throwing does not abort the run; others still complete.
  - `pause()` stops claiming new work; in-flight requests finish; `enriching` rows are
    returned to `pending` so a resume re-claims them (**no row may be stranded in
    `enriching`**).
  - Resumable: a second `run()` picks up exactly what is left.
  - Refuses to start with no API key configured, reporting that reason.
  - `progress()` reports `{ running, total, enriched, pending, failed, empty, startedAt }`.

- [ ] **Step 2: Implement** a claim → fetch → apply loop with a fixed worker pool:

```ts
export interface EnrichmentDeps { client: ApifyClient; concurrency: number; }
export async function runEnrichment(repos: Repos, deps: EnrichmentDeps, opts?: { signal?: AbortSignal }): Promise<EnrichmentResult>
```

No guardrail, no browser mutex, no pacing — this never touches LinkedIn. A module-level
singleton tracks the in-flight run so the API can report progress and pause it. On process
exit or pause, requeue anything still `enriching`.

- [ ] **Step 3: Run → PASS. Step 4: Commit.**

---

### Task 6: Auto-enqueue and TTL refresh

**Files:** `src/worker/orchestrator.ts`, `src/api/server.ts`; Test: `tests/worker/orchestrator.test.ts`

- [ ] **Step 1: Failing test** — a daily tick moves `enriched` rows past `enrich_ttl_days`
back to `pending`; rows inside the TTL are untouched; `failed`/`empty` rows are **never**
auto-re-armed (they cost money and will not spontaneously become scrapeable).
- [ ] **Step 2:** Add `runEnrichRefreshTick` on a 6-hour interval, gated on a key being set.
- [ ] **Step 3:** Newly imported/scraped rows already default to `pending`, so no extra
enqueue is needed — assert that in a test rather than adding code.
- [ ] **Step 4: Run → PASS. Step 5: Commit.**

---

### Task 7: API endpoints

**Files:** `src/api/server.ts`; Test: `tests/api/enrichment.test.ts`

- [ ] **Step 1: Failing tests:**
  - `POST /api/enrichment/start` → `{ started: true, queued: N, estimated_cost_usd }`; `409`
    if already running; `400` with an actionable message if no API key is set.
  - `GET /api/enrichment/status` → progress snapshot; safe to poll while idle.
  - `POST /api/enrichment/pause` → stops claiming; reports how many were requeued.
  - `POST /api/enrichment/retry-failed` → re-arms parked rows, returns the count.
  - `POST /api/connections/:slug/refresh` → enriches one person now; `404` for an unknown slug.
  - **`GET /api/settings` must NOT return `apify_api_key`** — it returns `apify_key_set:
    true|false`. Assert the raw body does not contain the secret.
  - `POST /api/settings` accepts `apify_api_key` and persists it.
- [ ] **Step 2: Implement.** Add `apify_api_key` to the settings write allowlist but strip it
from every read path. `estimated_cost_usd` is `queued * 0.004`.
- [ ] **Step 3: Run → PASS. Step 4: Commit.**

---

### Task 8: Enrichment UI

**Files:** `src/web/index.html`, `app.js`, `styles.css`; Test: `tests/web/enrichment-panel.test.ts`

> Use the `frontend-design` skill. Match the existing Settings idiom exactly — display-serif
> tabular figures, mono uppercase micro-labels, hairline dividers. This extends the
> Connections panel built in phase 1; it is not a new visual language.

- [ ] **Step 1: Failing tests** — renders progress; Start shows the cost estimate and
disables while running; Pause appears only while running; a missing key surfaces the
actionable error rather than a bare 400; progress polling stops when the run ends.
- [ ] **Step 2:** Add a masked Apify key field, a **Start enrichment** button showing
`N connections · ~$X`, a progress bar with enriched/pending/failed counts, **Pause**, and
**Retry failed** when any are parked.
- [ ] **Step 3: Run → PASS. Step 4: Commit.**

---

### Task 9: Docs and live verification

**Files:** Create `scripts/verify-enrichment.ts`; modify `API.md`, `README.md`

- [ ] **Step 1:** `scripts/verify-enrichment.ts` — enrich ONE profile against live Apify
using the configured key, print the extracted fields and the FTS doc, and **write nothing to
the database**. Default target `https://www.linkedin.com/in/keren-tevet-3453a079` (the
project's designated test profile).
- [ ] **Step 2:** Document the endpoints in `API.md` and the feature, cost and settings in
`README.md` — including that enrichment never touches the LinkedIn session and is therefore
unpaced.
- [ ] **Step 3:** Run `npx tsx scripts/verify-enrichment.ts` (~$0.004) and confirm the
extracted fields match the live profile.
- [ ] **Step 4: Commit.**

---

## Done criteria

- [ ] `npm test` and `npm run typecheck` clean; **no test calls Apify**.
- [ ] Extraction is verified against the real captured fixture, including both location shapes.
- [ ] Pause leaves **zero** rows stranded in `enriching`.
- [ ] `GET /api/settings` provably never returns the API key.
- [ ] `scripts/verify-enrichment.ts` enriches one live profile correctly.
- [ ] A real backfill of the 7,147-row roster is started and reaches >95% `enriched`
      (expect ~77 min at concurrency 8, ~$29; some rows will legitimately park as
      `empty`/`failed` — restricted or deleted profiles).
