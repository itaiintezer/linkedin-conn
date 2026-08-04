# Posts Feed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track up to 200 LinkedIn profiles, sweep their recent posts daily via Apify, and present them as a feed whose per-post and bulk actions enqueue rows into the *existing* engagement pipeline.

**Architecture:** Two new tables (`tracked_profiles`, `posts`) behind two new repositories. A new Apify client for the `harvestapi~linkedin-profile-posts` actor using async run+poll (not `run-sync`, which dies at 300s), driving one actor run per sweep. A slot-gated worker (`posts-sweep.ts`) mirroring `runRosterSync`, wired into `Orchestrator` on a 30-minute tick. Seven API routes; the engage routes call the **existing** `createEngagement` closure in `server.ts` so URL/URN normalization, reaction validation and comment limits are shared rather than reimplemented. UI is a new `src/web/posts.js` classic script — `app.js` is already 2,971 lines.

**Tech Stack:** TypeScript (ESM, `node:sqlite`), Fastify, vanilla browser JS (no build step), vitest. Node >= 22.13.

**Spec:** [`docs/superpowers/specs/2026-08-04-posts-feed-design.md`](../specs/2026-08-04-posts-feed-design.md) (commit `3d11bd7`).

---

## Conventions for every task in this plan

**Commit trailer.** Every commit message in this plan must end with this trailer. Task steps show only the subject line; append this every time:

```
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

**Never touch `data/app.db`.** It is production data holding a live send queue. Every test opens `openDatabase(':memory:')`.

**Never let a test reach Apify.** The sweep worker and server only ever receive an injected client. A test that constructs `HttpApifyPostsClient` with a real token is a bug.

**Commands.** `npm test` runs the suite; `npx vitest run <file>` runs one file; `npx vitest run <file> -t "<name>"` runs one test. `npm run typecheck` is `tsc --noEmit`. `vitest.config.ts` pins `TZ=UTC` — the window-derivation and relative-age tests depend on it.

**Two deliberate tightenings over the spec**, both applied in Task 1 and called out here so they are not mistaken for drift:

1. `posts.posted_at` and `posts.first_seen_at` get the same `GLOB` `CHECK` constraints as `engagements.reacted_at`. The retention prune compares these columns with `<` as TEXT, and per the scar documented in `schema.sql` that is only a chronological comparison while every value is the fixed-width `toISOString()` shape.
2. The prune and the feed sort both use `COALESCE(posted_at, first_seen_at)`. A post whose `postedAt` Apify could not parse holds `NULL`, and `NULL < cutoff` is `NULL` — so without the coalesce those rows would never prune and would sort unpredictably.

---

## File Structure

**Create:**

| File | Responsibility |
|---|---|
| `src/core/apify-posts-extract.ts` | Pure: one raw actor item → an `ExtractedPost`, or `null`. All field reads isolated here so actor drift is one file. |
| `src/core/apify-posts-client.ts` | `ApifyPostsClient` interface + `HttpApifyPostsClient` (async run + poll + paged dataset read). |
| `src/db/posts-repos.ts` | `TrackedProfileRepo` + `PostRepo`. Together because they change together. |
| `src/worker/posts-sweep.ts` | One sweep pass: window derivation, batched run, upsert, per-profile error stamping, prune. |
| `src/web/posts.js` | The Posts screen: feed rendering, chips, selection, bulk, tracking manager. |
| `tests/core/apify-posts-extract.test.ts` | Payload-shape tolerance. |
| `tests/db/posts-repo.test.ts` | Dedupe, soft-delete, prune, reconcile survival. |
| `tests/worker/posts-sweep.test.ts` | Gates, slot stamping, window choice, error isolation. |
| `tests/api/posts.test.ts` | Routes, filters, cap, engage semantics. |
| `tests/web/posts-feed.test.ts` | jsdom: chips, selection bar, bulk endpoint. |

**Modify:** `src/db/schema.sql` (tables + settings + app_state), `src/db/database.ts` (guarded ALTERs), `src/db/repositories.ts` (`Repos` aggregator), `src/types.ts` (row + payload types), `src/worker/orchestrator.ts` (tick), `src/api/server.ts` (7 routes), `src/web/index.html` (nav, panel, settings), `src/web/app.js` (one line in `init()`, plus the Connections button), `tests/web/helpers/load-app.ts` (load `posts.js`), `API.md`, `README.md`, `RUNBOOK.md`.

---

# Phase 1 — Data layer

### Task 1: Schema, migrations and types

**Files:**
- Modify: `src/db/schema.sql`
- Modify: `src/db/database.ts` (inside `runMigrations`)
- Modify: `src/types.ts`
- Test: `tests/db/posts-repo.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/db/posts-repo.test.ts`:

```ts
/**
 * The Posts data layer. Covers the four decisions the spec defends: URN dedupe,
 * soft-delete, the retention prune, and engagement_id surviving a URN reconcile.
 */
import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';

let repos: Repos;
beforeEach(() => { repos = new Repos(openDatabase(':memory:')); });

test('the new tables and columns exist', () => {
  const tables = (repos.db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('tracked_profiles','posts')",
  ).all() as { name: string }[]).map((r) => r.name).sort();
  expect(tables).toEqual(['posts', 'tracked_profiles']);

  const settings = (repos.db.prepare('PRAGMA table_info(settings)').all() as { name: string }[])
    .map((c) => c.name);
  expect(settings).toContain('posts_sweep_per_day');
  expect(settings).toContain('posts_max_per_sweep');
  expect(settings).toContain('posts_sweep_batch_size');
  expect(settings).toContain('posts_retention_days');
  expect(settings).toContain('tracked_profile_cap');

  const app = (repos.db.prepare('PRAGMA table_info(app_state)').all() as { name: string }[])
    .map((c) => c.name);
  expect(app).toContain('posts_swept_at');
  expect(app).toContain('posts_halted');
});

test('settings defaults match the spec', () => {
  const s = repos.settings.get() as unknown as Record<string, number>;
  expect(s.posts_sweep_per_day).toBe(1);
  expect(s.posts_max_per_sweep).toBe(3);
  expect(s.posts_sweep_batch_size).toBe(200);
  expect(s.posts_retention_days).toBe(30);
  expect(s.tracked_profile_cap).toBe(200);
});

test('posted_at rejects a non-ISO shape, because the prune compares it as TEXT', () => {
  repos.db.prepare(
    "INSERT INTO tracked_profiles (profile_url, source) VALUES ('https://www.linkedin.com/in/a', 'urls')",
  ).run();
  const bad = () => repos.db.prepare(
    `INSERT INTO posts (post_urn, post_url, tracked_profile_id, posted_at, first_seen_at)
     VALUES ('urn:li:activity:1', 'https://x', 1, '2026-08-04 10:00:00', '2026-08-04T10:00:00.000Z')`,
  ).run();
  expect(bad).toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/posts-repo.test.ts`
Expected: FAIL — `expect(tables).toEqual(['posts','tracked_profiles'])` receives `[]`.

- [ ] **Step 3: Add the tables to `src/db/schema.sql`**

Append at the end of the file:

```sql
-- ============================================================================
-- Posts feed (2026-08-04). Track a set of profiles, sweep their recent posts
-- via Apify, and act on them through the EXISTING engagements pipeline.
--
-- CAREFUL: CREATE TABLE IF NOT EXISTS back-fills the whole table on every
-- openDatabase, but is a no-op once the table exists. A column added here
-- LATER is silently absent on existing databases and needs its own guarded
-- ALTER in runMigrations — the same trap documented for event_buckets.
-- ============================================================================

CREATE TABLE IF NOT EXISTS tracked_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_url TEXT NOT NULL UNIQUE,        -- normalizeProfileUrl(), same form as connections
  -- Nullable on purpose: the paste box accepts any profile URL, and someone worth watching
  -- need not be a 1st-degree connection. When set, the connection row owns name/headline.
  connection_id INTEGER REFERENCES connections(id),
  full_name TEXT,                          -- display fallback when connection_id IS NULL
  headline TEXT,                            -- filled from the first sweep's author payload
  source TEXT NOT NULL,                     -- search | urls
  -- Untracking sets this to 0; it never deletes. A delete strands posts.tracked_profile_id,
  -- and cascading it would destroy the record of posts already engaged with.
  active INTEGER NOT NULL DEFAULT 1,
  -- Chooses THIS profile's postedLimit window and bounds retries. Distinct from
  -- app_state.posts_swept_at, which gates the pass as a whole.
  last_swept_at TEXT,
  last_sweep_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tracked_active ON tracked_profiles(active);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- THE identity, same rule as engagements.post_urn. INSERT OR IGNORE on this is what
  -- makes re-sweeping idempotent with no cursor to maintain.
  post_urn TEXT NOT NULL UNIQUE,
  post_url TEXT NOT NULL,
  tracked_profile_id INTEGER NOT NULL REFERENCES tracked_profiles(id),
  author_name TEXT,
  author_headline TEXT,
  content TEXT,
  -- The CHECKs pin the exact shape toISOString() produces, NULL still allowed. Not
  -- decoration: the retention prune compares these with `<` as TEXT, which is only a
  -- chronological comparison while every value is that one fixed-width shape. See the
  -- send_log.at scar documented on engagements.reacted_at.
  posted_at TEXT CHECK (
    posted_at IS NULL
    OR posted_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
  is_repost INTEGER NOT NULL DEFAULT 0,
  reaction_count INTEGER,
  comment_count INTEGER,
  -- A DIRECT id, deliberately not a join on post_urn. An engagement's URN is provisional:
  -- the driver reads the canonical one off the live post and rewrites the row (see API.md).
  -- A URN join would silently lose this link exactly when reconciliation fires.
  engagement_id INTEGER REFERENCES engagements(id),
  first_seen_at TEXT NOT NULL CHECK (
    first_seen_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
  raw_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_posts_profile ON posts(tracked_profile_id);
CREATE INDEX IF NOT EXISTS idx_posts_engagement ON posts(engagement_id);
CREATE INDEX IF NOT EXISTS idx_posts_posted ON posts(posted_at);
```

- [ ] **Step 4: Add the settings columns to `src/db/schema.sql`**

In the `settings` table, immediately after the `engage_comment_daily_cap` line, add:

```sql
  ,
  -- Posts feed. postedLimit is the cost model, not a filter: INSERT OR IGNORE dedupes
  -- storage but never the bill, so a 'week' window on a daily sweep re-bills the same
  -- posts (~20x). The window is derived from per-profile staleness, not configured here.
  posts_sweep_per_day INTEGER NOT NULL DEFAULT 1,
  posts_max_per_sweep INTEGER NOT NULL DEFAULT 3,
  -- Safety valve only. One run covers every tracked profile in practice; this splits the
  -- run if the profile cap is ever raised well past 200.
  posts_sweep_batch_size INTEGER NOT NULL DEFAULT 200,
  -- Load-bearing, not hygiene: with no dismiss action, ageing out is the ONLY way a post
  -- leaves the New chip. Without it, New grows without bound and stops meaning anything.
  posts_retention_days INTEGER NOT NULL DEFAULT 30,
  tracked_profile_cap INTEGER NOT NULL DEFAULT 200
```

- [ ] **Step 5: Add the app_state columns to `src/db/schema.sql`**

In the `app_state` table, after `connections_seeded_at TEXT`, add:

```sql
  ,
  -- Gates the sweep PASS (per-day slot). Stamped only on a clean pass.
  posts_swept_at TEXT,
  -- An ERROR latch, not a spend cap (a spend ceiling was explicitly declined). It exists
  -- so a bad key does not produce 1,440 failed Apify calls a day and bury the alert.
  posts_halted INTEGER NOT NULL DEFAULT 0,
  posts_halt_reason TEXT,
  posts_halt_detail TEXT,
  posts_halted_at TEXT
```

- [ ] **Step 6: Add the guarded ALTERs to `runMigrations` in `src/db/database.ts`**

Find the end of `runMigrations` and add before its closing brace. Each column gets its own guard, because an interruption between ALTERs must not permanently skip whichever ones did not run yet:

```ts
  // --- Posts feed (2026-08-04) ---
  // New TABLES need nothing here: schema.sql's CREATE TABLE IF NOT EXISTS covers them.
  // Only new COLUMNS on pre-existing tables require an explicit ALTER.
  if (cols.length > 0 && !cols.includes('posts_sweep_per_day')) {
    db.exec('ALTER TABLE settings ADD COLUMN posts_sweep_per_day INTEGER NOT NULL DEFAULT 1');
  }
  if (cols.length > 0 && !cols.includes('posts_max_per_sweep')) {
    db.exec('ALTER TABLE settings ADD COLUMN posts_max_per_sweep INTEGER NOT NULL DEFAULT 3');
  }
  if (cols.length > 0 && !cols.includes('posts_sweep_batch_size')) {
    db.exec('ALTER TABLE settings ADD COLUMN posts_sweep_batch_size INTEGER NOT NULL DEFAULT 200');
  }
  if (cols.length > 0 && !cols.includes('posts_retention_days')) {
    db.exec('ALTER TABLE settings ADD COLUMN posts_retention_days INTEGER NOT NULL DEFAULT 30');
  }
  if (cols.length > 0 && !cols.includes('tracked_profile_cap')) {
    db.exec('ALTER TABLE settings ADD COLUMN tracked_profile_cap INTEGER NOT NULL DEFAULT 200');
  }
  if (appCols.length > 0 && !appCols.includes('posts_swept_at')) {
    db.exec('ALTER TABLE app_state ADD COLUMN posts_swept_at TEXT');
  }
  if (appCols.length > 0 && !appCols.includes('posts_halted')) {
    db.exec('ALTER TABLE app_state ADD COLUMN posts_halted INTEGER NOT NULL DEFAULT 0');
  }
  if (appCols.length > 0 && !appCols.includes('posts_halt_reason')) {
    db.exec('ALTER TABLE app_state ADD COLUMN posts_halt_reason TEXT');
  }
  if (appCols.length > 0 && !appCols.includes('posts_halt_detail')) {
    db.exec('ALTER TABLE app_state ADD COLUMN posts_halt_detail TEXT');
  }
  if (appCols.length > 0 && !appCols.includes('posts_halted_at')) {
    db.exec('ALTER TABLE app_state ADD COLUMN posts_halted_at TEXT');
  }
```

`cols` and `appCols` are already in scope from earlier in the function — do not redeclare them.

- [ ] **Step 7: Add the types to `src/types.ts`**

Append:

```ts
/** A profile whose posts are swept. `active = 0` means untracked (soft delete). */
export interface TrackedProfile {
  id: number;
  profile_url: string;
  connection_id: number | null;
  full_name: string | null;
  headline: string | null;
  source: 'search' | 'urls';
  active: number;
  last_swept_at: string | null;
  last_sweep_error: string | null;
  created_at: string;
}

/** One scraped post. Identity is post_urn, never post_url. */
export interface Post {
  id: number;
  post_urn: string;
  post_url: string;
  tracked_profile_id: number;
  author_name: string | null;
  author_headline: string | null;
  content: string | null;
  posted_at: string | null;
  is_repost: number;
  reaction_count: number | null;
  comment_count: number | null;
  engagement_id: number | null;
  first_seen_at: string;
  raw_json: string | null;
  created_at: string;
}

/** A feed row: a post plus the engagement columns the UI renders a badge from. */
export interface FeedPost extends Post {
  engagement_status: EngagementStatus | null;
  engagement_reaction: Reaction | null;
  engagement_reacted_at: string | null;
  author_display: string | null;
  headline_display: string | null;
}

export type PostFilter = 'new' | 'queued' | 'engaged';

/** Why the sweep latched off. Mirrors EnrichHaltReason. */
export type PostsHaltReason = 'no_api_key' | 'auth' | 'run_failed';

export type TrackRejectReason = 'invalid_url' | 'already_tracked' | 'cap_reached';

export interface TrackReject {
  profile_url: string;
  reason: TrackRejectReason;
  message: string;
}
```

Then extend the existing `Settings` interface with:

```ts
  posts_sweep_per_day: number;
  posts_max_per_sweep: number;
  posts_sweep_batch_size: number;
  posts_retention_days: number;
  tracked_profile_cap: number;
```

and the existing `AppState` interface with:

```ts
  posts_swept_at: string | null;
  posts_halted: number;
  posts_halt_reason: PostsHaltReason | null;
  posts_halt_detail: string | null;
  posts_halted_at: string | null;
```

- [ ] **Step 8: Run the tests**

Run: `npx vitest run tests/db/posts-repo.test.ts`
Expected: PASS (3 tests).

Run: `npm run typecheck`
Expected: no errors.

Run: `npm test`
Expected: the whole existing suite still passes — the ALTERs and new columns must not disturb it.

- [ ] **Step 9: Commit**

```bash
git add src/db/schema.sql src/db/database.ts src/types.ts tests/db/posts-repo.test.ts
git commit -m "feat(posts): tracked_profiles and posts tables, settings and halt columns"
```

---

### Task 2: TrackedProfileRepo

**Files:**
- Create: `src/db/posts-repos.ts`
- Modify: `src/db/repositories.ts` (the `Repos` aggregator)
- Test: `tests/db/posts-repo.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/db/posts-repo.test.ts`:

```ts
const URL_A = 'https://www.linkedin.com/in/ada-lovelace';
const URL_B = 'https://www.linkedin.com/in/grace-hopper';

test('add is idempotent and reactivates a previously untracked profile', () => {
  const first = repos.trackedProfiles.add(URL_A, null, 'urls');
  const again = repos.trackedProfiles.add(URL_A, null, 'urls');
  expect(again.id).toBe(first.id);

  repos.trackedProfiles.deactivate(first.id);
  expect(repos.trackedProfiles.findByUrl(URL_A)!.active).toBe(0);

  // Re-adding the same URL reactivates rather than duplicating, so re-tracking someone
  // you removed neither creates a second row nor re-bills their first sweep.
  const back = repos.trackedProfiles.add(URL_A, null, 'urls');
  expect(back.id).toBe(first.id);
  expect(back.active).toBe(1);
});

test('activeProfiles and countActive exclude soft-deleted rows', () => {
  const a = repos.trackedProfiles.add(URL_A, null, 'urls');
  repos.trackedProfiles.add(URL_B, null, 'search');
  expect(repos.trackedProfiles.countActive()).toBe(2);

  repos.trackedProfiles.deactivate(a.id);
  expect(repos.trackedProfiles.countActive()).toBe(1);
  expect(repos.trackedProfiles.activeProfiles().map((p) => p.profile_url)).toEqual([URL_B]);
});

test('markSwept clears a previous error; markSweepError leaves last_swept_at alone', () => {
  const a = repos.trackedProfiles.add(URL_A, null, 'urls');

  repos.trackedProfiles.markSweepError(a.id, 'run failed');
  expect(repos.trackedProfiles.findById(a.id)!.last_sweep_error).toBe('run failed');
  // A failed sweep must not advance last_swept_at, or the next pass would treat this
  // profile as fresh and use the narrow 24h window it never actually got.
  expect(repos.trackedProfiles.findById(a.id)!.last_swept_at).toBeNull();

  repos.trackedProfiles.markSwept(a.id, '2026-08-04T10:00:00.000Z');
  const row = repos.trackedProfiles.findById(a.id)!;
  expect(row.last_swept_at).toBe('2026-08-04T10:00:00.000Z');
  expect(row.last_sweep_error).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/posts-repo.test.ts -t "idempotent"`
Expected: FAIL — `repos.trackedProfiles` is undefined.

- [ ] **Step 3: Create `src/db/posts-repos.ts`**

```ts
/**
 * Repositories for the Posts feed.
 *
 * Both live in one file for the same reason event-repos.ts groups four: repositories.ts is
 * already long, and these two always change together.
 */
import type { DB } from './database.js';
import type { TrackedProfile } from '../types.js';

export class TrackedProfileRepo {
  constructor(private db: DB) {}

  /**
   * Insert, or return (and REACTIVATE) the row that already holds this URL.
   *
   * Reactivating rather than refusing is what makes untracking safe: `active = 0` is a soft
   * delete, so re-adding someone you removed must resurrect their row instead of colliding
   * with the UNIQUE constraint. Idempotent, mirroring ProfileRepo.add.
   */
  add(profileUrl: string, connectionId: number | null, source: 'search' | 'urls'): TrackedProfile {
    const existing = this.findByUrl(profileUrl);
    if (existing) {
      if (existing.active !== 1) {
        this.db.prepare('UPDATE tracked_profiles SET active = 1 WHERE id = ?').run(existing.id);
      }
      // A later add may know the connection the first one did not. Never unset it.
      if (connectionId !== null && existing.connection_id === null) {
        this.db.prepare('UPDATE tracked_profiles SET connection_id = ? WHERE id = ?')
          .run(connectionId, existing.id);
      }
      return this.findById(existing.id)!;
    }
    this.db.prepare(
      'INSERT INTO tracked_profiles (profile_url, connection_id, source) VALUES (?, ?, ?)',
    ).run(profileUrl, connectionId, source);
    return this.findByUrl(profileUrl)!;
  }

  findById(id: number): TrackedProfile | undefined {
    return this.db.prepare('SELECT * FROM tracked_profiles WHERE id = ?')
      .get(id) as unknown as TrackedProfile | undefined;
  }

  findByUrl(profileUrl: string): TrackedProfile | undefined {
    return this.db.prepare('SELECT * FROM tracked_profiles WHERE profile_url = ?')
      .get(profileUrl) as unknown as TrackedProfile | undefined;
  }

  /** Untrack. Soft, so posts keep a valid parent and history survives. */
  deactivate(id: number): void {
    this.db.prepare('UPDATE tracked_profiles SET active = 0 WHERE id = ?').run(id);
  }

  activeProfiles(): TrackedProfile[] {
    return this.db.prepare('SELECT * FROM tracked_profiles WHERE active = 1 ORDER BY id')
      .all() as unknown as TrackedProfile[];
  }

  countActive(): number {
    return (this.db.prepare('SELECT COUNT(*) c FROM tracked_profiles WHERE active = 1')
      .get() as unknown as { c: number }).c;
  }

  /** A clean sweep of this profile. Clears any previous error — it no longer applies. */
  markSwept(id: number, atIso: string): void {
    this.db.prepare(
      'UPDATE tracked_profiles SET last_swept_at = ?, last_sweep_error = NULL WHERE id = ?',
    ).run(atIso, id);
  }

  /**
   * A failed sweep of this profile. Deliberately does NOT touch last_swept_at: advancing it
   * would tell the next pass this profile is fresh and hand it the narrow 24h window it
   * never actually received, silently losing whatever it posted.
   */
  markSweepError(id: number, error: string): void {
    this.db.prepare('UPDATE tracked_profiles SET last_sweep_error = ? WHERE id = ?')
      .run(error, id);
  }

  /** Display rows for the tracking manager: the profile plus how many posts it has yielded. */
  withCounts(): (TrackedProfile & { post_count: number })[] {
    return this.db.prepare(`
      SELECT tp.*, COUNT(p.id) AS post_count
      FROM tracked_profiles tp
      LEFT JOIN posts p ON p.tracked_profile_id = tp.id
      WHERE tp.active = 1
      GROUP BY tp.id
      ORDER BY tp.id
    `).all() as unknown as (TrackedProfile & { post_count: number })[];
  }
}
```

Leave `PostRepo` for Task 3 — this file grows in one more step.

- [ ] **Step 4: Wire into the `Repos` aggregator in `src/db/repositories.ts`**

Add the import at the top:

```ts
import { TrackedProfileRepo } from './posts-repos.js';
```

Add the field to `class Repos` after `engagements`:

```ts
  /** Posts feed — the tracked set. */
  trackedProfiles: TrackedProfileRepo;
```

And in its constructor, after `this.engagements = new EngagementRepo(db);`:

```ts
    this.trackedProfiles = new TrackedProfileRepo(db);
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/db/posts-repo.test.ts`
Expected: PASS (6 tests).

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/db/posts-repos.ts src/db/repositories.ts tests/db/posts-repo.test.ts
git commit -m "feat(posts): TrackedProfileRepo with reactivating add and per-profile sweep stamps"
```

---

### Task 3: PostRepo

**Files:**
- Modify: `src/db/posts-repos.ts`
- Modify: `src/db/repositories.ts`
- Test: `tests/db/posts-repo.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/db/posts-repo.test.ts`:

```ts
const postInput = (urn: string, profileId: number, postedAt: string | null) => ({
  post_urn: urn,
  post_url: `https://www.linkedin.com/feed/update/${urn}/`,
  tracked_profile_id: profileId,
  author_name: 'Ada Lovelace',
  author_headline: 'Analytical Engine',
  content: 'A note on the engine.',
  posted_at: postedAt,
  is_repost: 0,
  reaction_count: 12,
  comment_count: 3,
  raw_json: '{}',
});

test('upsert dedupes on post_urn and reports how many were new', () => {
  const a = repos.trackedProfiles.add(URL_A, null, 'urls');
  const now = '2026-08-04T10:00:00.000Z';

  const first = repos.posts.upsertMany([
    postInput('urn:li:activity:1', a.id, '2026-08-03T09:00:00.000Z'),
    postInput('urn:li:activity:2', a.id, '2026-08-02T09:00:00.000Z'),
  ], now);
  expect(first).toBe(2);

  // Re-sweeping the same posts is a no-op. This is what removes the need for a cursor.
  const second = repos.posts.upsertMany([
    postInput('urn:li:activity:1', a.id, '2026-08-03T09:00:00.000Z'),
    postInput('urn:li:activity:3', a.id, '2026-08-01T09:00:00.000Z'),
  ], now);
  expect(second).toBe(1);
  expect(repos.posts.countAll()).toBe(3);
});

test('the feed hides posts of an untracked profile without deleting them', () => {
  const a = repos.trackedProfiles.add(URL_A, null, 'urls');
  repos.posts.upsertMany([postInput('urn:li:activity:9', a.id, '2026-08-03T09:00:00.000Z')],
    '2026-08-04T10:00:00.000Z');
  expect(repos.posts.feed('new', 20, null)).toHaveLength(1);

  repos.trackedProfiles.deactivate(a.id);
  expect(repos.posts.feed('new', 20, null)).toHaveLength(0);
  expect(repos.posts.countAll()).toBe(1);   // still on disk
});

test('the prune drops un-engaged old posts, keeps engaged ones, and uses first_seen_at when posted_at is NULL', () => {
  const a = repos.trackedProfiles.add(URL_A, null, 'urls');
  const now = new Date('2026-08-04T10:00:00.000Z');
  repos.posts.upsertMany([
    postInput('urn:li:activity:old', a.id, '2026-06-01T09:00:00.000Z'),      // old, un-engaged
    postInput('urn:li:activity:keep', a.id, '2026-06-01T09:00:00.000Z'),     // old, engaged
    postInput('urn:li:activity:fresh', a.id, '2026-08-03T09:00:00.000Z'),    // recent
    postInput('urn:li:activity:nodate', a.id, null),                          // no posted_at
  ], '2026-06-01T09:00:00.000Z');   // first_seen_at is old for all four

  const eng = repos.engagements.add(
    'https://www.linkedin.com/feed/update/urn:li:activity:keep/',
    'urn:li:activity:keep', 'like', null,
  );
  repos.posts.setEngagement(repos.posts.findByUrn('urn:li:activity:keep')!.id, eng.id);

  const pruned = repos.posts.prune(30, now);
  expect(pruned).toBe(2);   // 'old' and 'nodate' — the latter via first_seen_at
  const left = repos.db.prepare('SELECT post_urn FROM posts ORDER BY post_urn')
    .all() as { post_urn: string }[];
  expect(left.map((r) => r.post_urn)).toEqual(['urn:li:activity:fresh', 'urn:li:activity:keep']);
});

test('engagement_id survives the engagement URN being reconciled', () => {
  const a = repos.trackedProfiles.add(URL_A, null, 'urls');
  const urn = 'urn:li:activity:7489401095899770880';
  repos.posts.upsertMany([postInput(urn, a.id, '2026-08-03T09:00:00.000Z')],
    '2026-08-04T10:00:00.000Z');
  const post = repos.posts.findByUrn(urn)!;
  const eng = repos.engagements.add(`https://www.linkedin.com/feed/update/${urn}/`, urn, 'like', null);
  repos.posts.setEngagement(post.id, eng.id);

  // The driver rewrites the engagement's URN to the canonical one it read off the live post.
  // A join on post_urn would lose the link here; a direct id does not.
  expect(repos.engagements.reconcileUrn(eng.id, 'urn:li:activity:7489401096851906561'))
    .toBe('reconciled');
  expect(repos.posts.feed('queued', 20, null).map((p) => p.id)).toEqual([post.id]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/posts-repo.test.ts -t "upsert dedupes"`
Expected: FAIL — `repos.posts` is undefined.

- [ ] **Step 3: Append `PostRepo` to `src/db/posts-repos.ts`**

Add `FeedPost` and `PostFilter` to the existing type import at the top of the file:

```ts
import type { FeedPost, Post, PostFilter, TrackedProfile } from '../types.js';
```

Then append:

```ts
/** What upsertMany accepts. Everything the extractor produces, minus the row's own id. */
export interface PostInput {
  post_urn: string;
  post_url: string;
  tracked_profile_id: number;
  author_name: string | null;
  author_headline: string | null;
  content: string | null;
  posted_at: string | null;
  is_repost: number;
  reaction_count: number | null;
  comment_count: number | null;
  raw_json: string | null;
}

/**
 * The feed's three filters, defined ONCE so the API and the UI cannot drift.
 *
 * These are a deliberate PARTITION: every post falls in exactly one chip, never none and
 * never two. An earlier draft keyed `queued` and `new` off status alone, which left
 * `needs_attention` under no chip at all (invisible in the UI that owns posts, and unprunable
 * because engagement_id is not NULL) and put a reacted-but-failed post under both `new` and
 * `engaged` — where the feed offered to queue it and every attempt 409'd on the duplicate URN.
 *
 * `reacted_at` outranks `status` because a reaction on LinkedIn is a fact, while a status is
 * our bookkeeping about it. `failed`/`skipped` without a reaction return to `new` so they can
 * be retried from the feed. Everything else with an engagement is in flight — including
 * `needs_attention`, because a human still has to act on it.
 *
 * NOTE `queued` relies on `e.status` being NULL for a post with no engagement row, and on
 * `NULL NOT IN (...)` evaluating to NULL rather than true. That is what keeps an
 * engagement-less post out of `queued`, and it is why the LEFT JOIN cannot become an inner one.
 */
const FILTER_SQL: Record<PostFilter, string> = {
  new: "(p.engagement_id IS NULL OR (e.reacted_at IS NULL AND e.status IN ('failed','skipped')))",
  queued: "(e.reacted_at IS NULL AND e.status NOT IN ('failed','skipped'))",
  engaged: 'e.reacted_at IS NOT NULL',
};

/** Sort and prune key. COALESCE because an unparseable postedAt lands as NULL, and
 *  `NULL < cutoff` is NULL — so without this those rows would never prune. */
const SORT_KEY = 'COALESCE(p.posted_at, p.first_seen_at)';

export class PostRepo {
  constructor(private db: DB) {}

  /**
   * Store a sweep's results. Returns how many rows were genuinely new.
   *
   * INSERT OR IGNORE on the UNIQUE post_urn is the whole dedupe strategy — no cursor, no
   * have-I-seen-this bookkeeping, so a repeated or overlapping sweep is free. Note this
   * dedupes STORAGE and not the Apify bill; that is what the postedLimit window is for.
   */
  upsertMany(items: PostInput[], firstSeenAtIso: string): { added: number; rejected: number } {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO posts
        (post_urn, post_url, tracked_profile_id, author_name, author_headline, content,
         posted_at, is_repost, reaction_count, comment_count, raw_json, first_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let added = 0;
    for (const it of items) {
      // `changes` is 0 when OR IGNORE swallowed a duplicate and 1 on a real insert, which is
      // exactly the count we want. Number() because it can arrive as a bigint — same wrapping
      // as EventInviteeRepo and ConnectionRepo already use.
      added += Number(stmt.run(
        it.post_urn, it.post_url, it.tracked_profile_id, it.author_name, it.author_headline,
        it.content, it.posted_at, it.is_repost, it.reaction_count, it.comment_count,
        it.raw_json, firstSeenAtIso,
      ).changes);
    }
    return added;
  }

  findById(id: number): Post | undefined {
    return this.db.prepare('SELECT * FROM posts WHERE id = ?')
      .get(id) as unknown as Post | undefined;
  }

  findByUrn(urn: string): Post | undefined {
    return this.db.prepare('SELECT * FROM posts WHERE post_urn = ?')
      .get(urn) as unknown as Post | undefined;
  }

  countAll(): number {
    return (this.db.prepare('SELECT COUNT(*) c FROM posts').get() as unknown as { c: number }).c;
  }

  /** Link a post to the engagement queued for it. */
  setEngagement(id: number, engagementId: number): void {
    this.db.prepare('UPDATE posts SET engagement_id = ? WHERE id = ?').run(engagementId, id);
  }

  /**
   * One page of the feed, newest first.
   *
   * `cursor` is the keyset position — `"<sortKey>|<id>"` from the previous page's last row.
   * Keyset rather than OFFSET because the sweep inserts rows between requests, and OFFSET
   * would skip or repeat posts as the set shifts underneath the reader.
   */
  feed(filter: PostFilter, limit: number, cursor: string | null): FeedPost[] {
    const params: unknown[] = [];
    let keyset = '';
    if (cursor !== null) {
      const sep = cursor.lastIndexOf('|');
      const key = cursor.slice(0, sep);
      const id = Number(cursor.slice(sep + 1));
      keyset = `AND (${SORT_KEY} < ? OR (${SORT_KEY} = ? AND p.id < ?))`;
      params.push(key, key, id);
    }
    params.push(limit);
    return this.db.prepare(`
      SELECT p.*,
             e.status   AS engagement_status,
             e.reaction AS engagement_reaction,
             e.reacted_at AS engagement_reacted_at,
             COALESCE(c.full_name, p.author_name, tp.full_name) AS author_display,
             COALESCE(c.headline, p.author_headline, tp.headline) AS headline_display
      FROM posts p
      JOIN tracked_profiles tp ON tp.id = p.tracked_profile_id
      LEFT JOIN engagements e ON e.id = p.engagement_id
      LEFT JOIN connections c ON c.id = tp.connection_id
      WHERE tp.active = 1 AND ${FILTER_SQL[filter]} ${keyset}
      ORDER BY ${SORT_KEY} DESC, p.id DESC
      LIMIT ?
    `).all(...(params as never[])) as unknown as FeedPost[];
  }

  /** The chip counts, in one pass rather than three round-trips. */
  counts(): Record<PostFilter, number> {
    const row = this.db.prepare(`
      SELECT
        SUM(CASE WHEN ${FILTER_SQL.new}    THEN 1 ELSE 0 END) AS new_c,
        SUM(CASE WHEN ${FILTER_SQL.queued} THEN 1 ELSE 0 END) AS queued_c,
        SUM(CASE WHEN ${FILTER_SQL.engaged} THEN 1 ELSE 0 END) AS engaged_c
      FROM posts p
      JOIN tracked_profiles tp ON tp.id = p.tracked_profile_id
      LEFT JOIN engagements e ON e.id = p.engagement_id
      WHERE tp.active = 1
    `).get() as unknown as { new_c: number | null; queued_c: number | null; engaged_c: number | null };
    return { new: row.new_c ?? 0, queued: row.queued_c ?? 0, engaged: row.engaged_c ?? 0 };
  }

  /** Posts stored in the trailing window — drives the informational cost readout. */
  countSince(iso: string): number {
    return (this.db.prepare('SELECT COUNT(*) c FROM posts WHERE first_seen_at >= ?')
      .get(iso) as unknown as { c: number }).c;
  }

  /**
   * Delete un-engaged posts older than `days`. Returns how many went.
   *
   * Load-bearing, not hygiene: with no dismiss action, ageing out is the only way a post
   * leaves the New chip. Anything with an engagement is kept regardless of age — that is
   * the record of what was actually done.
   */
  prune(days: number, now: Date): number {
    const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
    return Number(this.db.prepare(
      `DELETE FROM posts WHERE engagement_id IS NULL
       AND COALESCE(posted_at, first_seen_at) < ?`,
    ).run(cutoff).changes);
  }
}
```

- [ ] **Step 4: Wire into `Repos`**

In `src/db/repositories.ts`, extend the import:

```ts
import { PostRepo, TrackedProfileRepo } from './posts-repos.js';
```

Add the field after `trackedProfiles`:

```ts
  /** Posts feed — the swept posts. */
  posts: PostRepo;
```

And in the constructor:

```ts
    this.posts = new PostRepo(db);
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/db/posts-repo.test.ts`
Expected: PASS (10 tests).

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/db/posts-repos.ts src/db/repositories.ts tests/db/posts-repo.test.ts
git commit -m "feat(posts): PostRepo with URN dedupe, keyset feed, chip counts and retention prune"
```

---

**Phase 1 checkpoint.** Run `npm test` and `npm run typecheck`. Both must be clean before Phase 2.

# Phase 2 — Apify posts client and extraction

### Task 4: `apify-posts-extract.ts` — payload to row

The one file that reads actor field names. Actor drift is contained here and in its test.

**Files:**
- Create: `src/core/apify-posts-extract.ts`
- Modify: `src/types.ts`
- Test: `tests/core/apify-posts-extract.test.ts`

- [ ] **Step 1: Add the raw payload type to `src/types.ts`**

```ts
/**
 * One item from harvestapi~linkedin-profile-posts. Every field optional: this is untrusted
 * upstream JSON, and the extractor's job is to survive any of it being absent or reshaped.
 */
export interface ApifyPost {
  id?: unknown;
  type?: unknown;
  linkedinUrl?: unknown;
  content?: unknown;
  postedAt?: unknown;
  author?: { name?: unknown; linkedinUrl?: unknown; position?: unknown; headline?: unknown } | null;
  engagement?: { likes?: unknown; reactions?: unknown; comments?: unknown } | null;
  /** Echoes the exact input URL, which is how a batched run's items split per profile. */
  query?: { targetUrl?: unknown } | null;
  /** Present on a reshare: the post being reshared. */
  repost?: unknown;
  resharedPost?: unknown;
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/core/apify-posts-extract.test.ts`:

```ts
/**
 * Payload-shape tolerance for the posts actor.
 *
 * Every test here is a shape observed in, or plausible from, the reference implementation at
 * C:\Projects\prospecting\apify_linkedin.py — whose _parse_post_date exists precisely because
 * postedAt arrives as a dict, a bare string, or a unix number depending on the payload.
 */
import { test, expect } from 'vitest';
import { extractPost, parsePostedAt, attribute } from '../../src/core/apify-posts-extract.js';
import type { ApifyPost } from '../../src/types.js';

const URN = 'urn:li:activity:7489401096851906561';
const base: ApifyPost = {
  id: URN,
  linkedinUrl: `https://www.linkedin.com/feed/update/${URN}/`,
  content: 'Alert triage is an ownership problem.',
  postedAt: { date: '2026-08-03 14:23:00', timestamp: 1785853380000, relative: '1d' },
  author: { name: 'Dana Reingold', linkedinUrl: 'https://www.linkedin.com/in/dana', position: 'VP Security' },
  engagement: { likes: 42, comments: 7 },
  query: { targetUrl: 'https://www.linkedin.com/in/dana' },
};

test('parsePostedAt accepts a dict, an ISO string, a unix-ms number, and rejects junk', () => {
  // The timestamp is preferred when present: numeric and unambiguous.
  expect(parsePostedAt({ date: '2026-08-03 14:23:00', timestamp: 1785853380000 }))
    .toBe('2026-08-03T14:23:00.000Z');
  expect(parsePostedAt('2026-08-03T14:23:00Z')).toBe('2026-08-03T14:23:00.000Z');
  expect(parsePostedAt('2026-08-03 14:23:00')).toBe('2026-08-03T14:23:00.000Z');
  expect(parsePostedAt('2026-08-03')).toBe('2026-08-03T00:00:00.000Z');
  expect(parsePostedAt(1785853380000)).toBe('2026-08-03T14:23:00.000Z');
  // Seconds rather than ms, scaled up the way the reference implementation does.
  expect(parsePostedAt(1785853380)).toBe('2026-08-03T14:23:00.000Z');
  expect(parsePostedAt('2 days ago')).toBeNull();
  expect(parsePostedAt(null)).toBeNull();
  expect(parsePostedAt({ relative: '1d' })).toBeNull();
});

test('every parsed date is the fixed-width shape the posted_at CHECK demands', () => {
  const iso = parsePostedAt('2026-08-03T14:23:00Z')!;
  expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('extractPost maps a full item', () => {
  const out = extractPost(base, 5)!;
  expect(out.post_urn).toBe(URN);
  expect(out.post_url).toBe(`https://www.linkedin.com/feed/update/${URN}/`);
  expect(out.tracked_profile_id).toBe(5);
  expect(out.author_name).toBe('Dana Reingold');
  expect(out.author_headline).toBe('VP Security');
  expect(out.content).toBe('Alert triage is an ownership problem.');
  expect(out.posted_at).toBe('2026-08-03T14:23:00.000Z');
  expect(out.is_repost).toBe(0);
  expect(out.reaction_count).toBe(42);
  expect(out.comment_count).toBe(7);
});

test('the URN comes from linkedinUrl, falling back to a bare or numeric id', () => {
  expect(extractPost({ ...base, id: undefined }, 1)!.post_urn).toBe(URN);
  // No URL at all: a bare URN in `id` still identifies the post.
  expect(extractPost({ ...base, linkedinUrl: undefined }, 1)!.post_urn).toBe(URN);
  // A digits-only id is promoted to an activity URN rather than discarded.
  expect(extractPost({ ...base, linkedinUrl: undefined, id: '7489401096851906561' }, 1)!.post_urn)
    .toBe(URN);
});

test('an item with no resolvable identity is dropped, not guessed at', () => {
  expect(extractPost({ ...base, id: undefined, linkedinUrl: undefined }, 1)).toBeNull();
  expect(extractPost({ ...base, id: 'not-a-urn', linkedinUrl: 'https://example.com/x' }, 1)).toBeNull();
});

test('an item with no text is dropped — there is nothing to judge or engage with', () => {
  expect(extractPost({ ...base, content: '   ' }, 1)).toBeNull();
  expect(extractPost({ ...base, content: undefined }, 1)).toBeNull();
});

test('missing author and engagement degrade to null rather than throwing', () => {
  const out = extractPost({ ...base, author: null, engagement: null }, 1)!;
  expect(out.author_name).toBeNull();
  expect(out.author_headline).toBeNull();
  expect(out.reaction_count).toBeNull();
  expect(out.comment_count).toBeNull();
});

test('is_repost is set from type or a nested reshared post, and defaults to 0 when unclear', () => {
  expect(extractPost({ ...base, type: 'repost' }, 1)!.is_repost).toBe(1);
  expect(extractPost({ ...base, resharedPost: { id: 'x' } }, 1)!.is_repost).toBe(1);
  // Under-label rather than mislabel: an unrecognized shape is not called a repost.
  expect(extractPost({ ...base, type: 'something-new' }, 1)!.is_repost).toBe(0);
});

test('reactions falls back to `reactions` when `likes` is absent', () => {
  expect(extractPost({ ...base, engagement: { reactions: 9 } }, 1)!.reaction_count).toBe(9);
});

test('attribute splits a batched run by query.targetUrl, then author.linkedinUrl', () => {
  const byUrl = new Map([
    ['https://www.linkedin.com/in/dana', 11],
    ['https://www.linkedin.com/in/marcus', 22],
  ]);
  const items: ApifyPost[] = [
    base,
    { ...base, id: 'urn:li:activity:2', linkedinUrl: undefined,
      query: null, author: { name: 'M', linkedinUrl: 'https://www.linkedin.com/in/marcus' } },
    // Matches neither: dropped rather than assigned to whichever profile came first.
    { ...base, id: 'urn:li:activity:3', query: { targetUrl: 'https://www.linkedin.com/in/nobody' },
      author: { name: 'X', linkedinUrl: 'https://www.linkedin.com/in/nobody' } },
  ];
  const { rows, unattributed } = attribute(items, byUrl);
  expect(rows.map((r) => r.tracked_profile_id)).toEqual([11, 22]);
  expect(unattributed).toBe(1);
});

test('attribute matches a targetUrl that differs only by trailing slash or case', () => {
  const byUrl = new Map([['https://www.linkedin.com/in/dana', 11]]);
  const { rows } = attribute(
    [{ ...base, query: { targetUrl: 'https://WWW.LinkedIn.com/in/Dana/' } }], byUrl,
  );
  expect(rows.map((r) => r.tracked_profile_id)).toEqual([11]);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/core/apify-posts-extract.test.ts`
Expected: FAIL — cannot resolve `../../src/core/apify-posts-extract.js`.

- [ ] **Step 4: Create `src/core/apify-posts-extract.ts`**

```ts
/**
 * Raw posts-actor item -> a `posts` row. Pure, and the ONLY place actor field names are
 * read — the same containment `apify-extract.ts` provides for the profile actor, so a
 * harvestapi rename is one file and one test rather than a hunt.
 */
import type { ApifyPost } from '../types.js';
import type { PostInput } from '../db/posts-repos.js';
import { normalizePostUrl, normalizeProfileUrl } from './url.js';

/** Trim to a non-empty string, or null. Everything downstream expects null, not ''. */
const str = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s === '' ? null : s;
};

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/**
 * Best-effort parse of an actor post date into the fixed-width ISO shape the `posted_at`
 * CHECK demands.
 *
 * Ported from `apify_linkedin.py::_parse_post_date`, which exists because `postedAt` arrives
 * as `{date, timestamp, relative}`, a bare ISO string, `YYYY-MM-DD HH:MM:SS`, a bare date,
 * or a unix number depending on the payload. Returns null rather than guessing — a NULL
 * posted_at is handled everywhere via COALESCE(posted_at, first_seen_at).
 */
export function parsePostedAt(value: unknown): string | null {
  if (value === null || value === undefined) return null;

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    // Apify returns ms. A value small enough to be seconds is scaled up, matching the
    // reference implementation — 10^12 ms is the year 2001, so the threshold is unambiguous.
    const ms = value > 1e12 ? value : value * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  if (typeof value === 'object') {
    const o = value as { timestamp?: unknown; date?: unknown; iso?: unknown; isoDate?: unknown };
    // Prefer the timestamp: numeric and unambiguous.
    const fromTs = parsePostedAt(o.timestamp);
    if (fromTs !== null) return fromTs;
    for (const k of ['date', 'iso', 'isoDate'] as const) {
      const s = str(o[k]);
      if (s !== null) return parsePostedAt(s);
    }
    return null;
  }

  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (s === '') return null;

  // ISO 8601, including a trailing Z or an offset.
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  // "YYYY-MM-DD HH:MM[:SS]" with no zone. Read as UTC — the suite pins TZ=UTC, and
  // guessing a local zone for an upstream timestamp would shift every date.
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ ](\d{2}:\d{2}(?::\d{2})?)$/);
  if (m) {
    const d = new Date(`${m[1]}T${m[2].length === 5 ? `${m[2]}:00` : m[2]}Z`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  // A bare date.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  // "2 days ago" and friends: relative text carries no absolute instant. Refused.
  return null;
}

/**
 * The post's identity, reusing the existing normalizer rather than re-deriving URN rules.
 *
 * `linkedinUrl` first, because normalizePostUrl already knows that a path outranks anything
 * else in a URL. `id` is the fallback, accepted as a bare URN or promoted from a digits-only
 * value. Anything else yields null and the item is dropped — a post we cannot name is one we
 * could later navigate to the wrong page for.
 */
function identify(raw: ApifyPost): { url: string; urn: string } | null {
  const fromUrl = normalizePostUrl(raw.linkedinUrl);
  if (fromUrl !== null) return fromUrl;
  const fromId = normalizePostUrl(raw.id);
  if (fromId !== null) return fromId;
  const id = str(raw.id);
  if (id !== null && /^\d+$/.test(id)) return normalizePostUrl(`urn:li:activity:${id}`);
  return null;
}

/**
 * Is this a reshare? The discriminator is the `type` field or a nested original-post object.
 *
 * Defaults to 0 when indeterminate, so an unrecognized payload shape UNDER-labels rather
 * than mislabels. Reposts are engageable (one container, all selectors resolve), but comment
 * attribution on them is already broken upstream — so the label matters to the operator.
 */
function isRepost(raw: ApifyPost): number {
  const type = (str(raw.type) ?? '').toLowerCase();
  if (type === 'repost' || type === 'reshare') return 1;
  if (raw.resharedPost != null || raw.repost != null) return 1;
  return 0;
}

/** One item -> one row, or null when it is unusable. */
export function extractPost(raw: ApifyPost, trackedProfileId: number): PostInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const content = str(raw.content);
  if (content === null) return null;       // nothing to judge, nothing to engage with
  const ref = identify(raw);
  if (ref === null) return null;

  const author = raw.author ?? null;
  const eng = raw.engagement ?? null;
  return {
    post_urn: ref.urn,
    post_url: ref.url,
    tracked_profile_id: trackedProfileId,
    author_name: author ? str(author.name) : null,
    author_headline: author ? str(author.position) ?? str(author.headline) : null,
    content,
    posted_at: parsePostedAt(raw.postedAt),
    is_repost: isRepost(raw),
    reaction_count: eng ? num(eng.likes) ?? num(eng.reactions) : null,
    comment_count: eng ? num(eng.comments) : null,
    raw_json: JSON.stringify(raw),
  };
}

/**
 * Split a batched run's flat dataset back into per-profile rows.
 *
 * `query.targetUrl` echoes the exact input URL and is the primary key; `author.linkedinUrl`
 * is the fallback. Both are normalized before lookup, so a trailing slash or different case
 * still matches. An item matching NEITHER is counted and dropped — never assigned to
 * whichever profile happens to be nearby, which would attribute a post to the wrong person.
 */
export function attribute(
  items: ApifyPost[],
  profileIdByUrl: Map<string, number>,
): { rows: PostInput[]; unattributed: number } {
  const rows: PostInput[] = [];
  let unattributed = 0;
  for (const raw of items) {
    const candidates = [
      raw?.query?.targetUrl,
      raw?.author?.linkedinUrl,
    ];
    let id: number | undefined;
    for (const c of candidates) {
      const key = typeof c === 'string' ? normalizeProfileUrl(c) : null;
      if (key !== null) { id = profileIdByUrl.get(key); if (id !== undefined) break; }
    }
    if (id === undefined) { unattributed++; continue; }
    const row = extractPost(raw, id);
    if (row === null) { unattributed++; continue; }
    rows.push(row);
  }
  return { rows, unattributed };
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/core/apify-posts-extract.test.ts`
Expected: PASS (10 tests).

If the trailing-slash test fails, check what `normalizeProfileUrl` actually returns for
`https://WWW.LinkedIn.com/in/Dana/` and make the map keys in Task 6 use that same normalizer —
do not add a second normalization rule here.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/core/apify-posts-extract.ts src/types.ts tests/core/apify-posts-extract.test.ts
git commit -m "feat(posts): pure extraction for the posts actor payload, with per-profile attribution"
```

---

### Task 5: `apify-posts-client.ts` — async run + poll

**Files:**
- Create: `src/core/apify-posts-client.ts`
- Test: `tests/core/apify-posts-client.test.ts`

Why not reuse the existing client's `run-sync-get-dataset-items`: it fails at 300s with HTTP
408, and the timeout kills only the HTTP request — the run keeps going, so a retry would
double-bill. The actor documents no maximum on `targetUrls`, so with async run + poll one run
covers every tracked profile.

- [ ] **Step 1: Write the failing test**

Create `tests/core/apify-posts-client.test.ts`:

```ts
/**
 * The posts client. Every test drives an injected fetch — nothing here reaches Apify.
 *
 * The token appears in the query string, and these tests pin the rule that it must never
 * reach an error message: those land in data/relay.log, which the operator downloads and
 * shares when troubleshooting.
 */
import { test, expect, vi } from 'vitest';
import { HttpApifyPostsClient } from '../../src/core/apify-posts-client.js';

const TOKEN = 'apify_api_SECRETVALUE';
const RUN_ID = 'run123';
const DATASET_ID = 'ds456';

/** Scripted fetch: a queue of [matcher, response] pairs, asserted in order. */
function scriptedFetch(steps: { status?: number; body: unknown }[]): {
  impl: typeof fetch; urls: string[]; bodies: unknown[];
} {
  const urls: string[] = [];
  const bodies: unknown[] = [];
  let i = 0;
  const impl = (async (url: string, init?: RequestInit) => {
    urls.push(url);
    if (init?.body) bodies.push(JSON.parse(String(init.body)));
    const step = steps[Math.min(i++, steps.length - 1)];
    return {
      ok: (step.status ?? 200) < 400,
      status: step.status ?? 200,
      json: async () => step.body,
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, urls, bodies };
}

const startedRun = { data: { id: RUN_ID, status: 'RUNNING', defaultDatasetId: DATASET_ID } };
const succeeded = { data: { id: RUN_ID, status: 'SUCCEEDED', defaultDatasetId: DATASET_ID } };

test('starts a run with the batched input, polls, then reads the dataset', async () => {
  const { impl, urls, bodies } = scriptedFetch([
    { body: startedRun },
    { body: succeeded },
    { body: [{ id: 'urn:li:activity:1' }, { id: 'urn:li:activity:2' }] },
    { body: [] },
  ]);
  const client = new HttpApifyPostsClient(TOKEN, { fetchImpl: impl, sleep: async () => {} });

  const items = await client.fetchPosts(
    ['https://www.linkedin.com/in/a', 'https://www.linkedin.com/in/b'],
    { maxPosts: 3, postedLimit: '24h' },
  );

  expect(items).toHaveLength(2);
  // One run for many profiles — the whole point of using the async API.
  expect(bodies[0]).toEqual({
    targetUrls: ['https://www.linkedin.com/in/a', 'https://www.linkedin.com/in/b'],
    maxPosts: 3,
    postedLimit: '24h',
    scrapeReactions: false,
    scrapeComments: false,
  });
  expect(urls[0]).toContain('/v2/acts/harvestapi~linkedin-profile-posts/runs');
  expect(urls[1]).toContain(`/v2/actor-runs/${RUN_ID}`);
  expect(urls[2]).toContain(`/v2/datasets/${DATASET_ID}/items`);
});

test('scrapeReactions and scrapeComments are always false — they bill as extra posts', async () => {
  const { impl, bodies } = scriptedFetch([
    { body: startedRun }, { body: succeeded }, { body: [] },
  ]);
  const client = new HttpApifyPostsClient(TOKEN, { fetchImpl: impl, sleep: async () => {} });
  await client.fetchPosts(['https://www.linkedin.com/in/a'], { maxPosts: 3, postedLimit: 'week' });
  const sent = bodies[0] as Record<string, unknown>;
  expect(sent.scrapeReactions).toBe(false);
  expect(sent.scrapeComments).toBe(false);
});

test('pages the dataset until a short page comes back', async () => {
  const page = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `urn:li:activity:${i}` }));
  const { impl, urls } = scriptedFetch([
    { body: startedRun },
    { body: succeeded },
    { body: page(1000) },   // full page => ask for more
    { body: page(4) },      // short page => stop
  ]);
  const client = new HttpApifyPostsClient(TOKEN, { fetchImpl: impl, sleep: async () => {} });
  const items = await client.fetchPosts(['https://www.linkedin.com/in/a'],
    { maxPosts: 3, postedLimit: '24h' });
  expect(items).toHaveLength(1004);
  expect(urls[2]).toContain('offset=0');
  expect(urls[3]).toContain('offset=1000');
});

test('a failed run throws without leaking the token', async () => {
  const { impl } = scriptedFetch([
    { body: startedRun },
    { body: { data: { id: RUN_ID, status: 'FAILED', defaultDatasetId: DATASET_ID } } },
  ]);
  const client = new HttpApifyPostsClient(TOKEN, { fetchImpl: impl, sleep: async () => {} });
  await expect(client.fetchPosts(['https://www.linkedin.com/in/a'],
    { maxPosts: 3, postedLimit: '24h' })).rejects.toThrow(/FAILED/);
  await expect(client.fetchPosts(['https://www.linkedin.com/in/a'],
    { maxPosts: 3, postedLimit: '24h' })).rejects.not.toThrow(new RegExp(TOKEN));
});

test('an HTTP error names the status but never the token', async () => {
  const { impl } = scriptedFetch([{ status: 401, body: {} }]);
  const client = new HttpApifyPostsClient(TOKEN, { fetchImpl: impl, sleep: async () => {} });
  const err = await client.fetchPosts(['https://www.linkedin.com/in/a'],
    { maxPosts: 3, postedLimit: '24h' }).catch((e: Error) => e);
  expect((err as Error).message).toMatch(/401/);
  expect((err as Error).message).not.toContain('SECRETVALUE');
});

test('polling gives up rather than hanging forever', async () => {
  const { impl } = scriptedFetch([{ body: startedRun }, { body: startedRun }]);
  const client = new HttpApifyPostsClient(TOKEN, {
    fetchImpl: impl, sleep: async () => {}, maxPolls: 3,
  });
  await expect(client.fetchPosts(['https://www.linkedin.com/in/a'],
    { maxPosts: 3, postedLimit: '24h' })).rejects.toThrow(/did not finish/i);
});

test('an empty tracked list never starts a run', async () => {
  const spy = vi.fn();
  const client = new HttpApifyPostsClient(TOKEN, {
    fetchImpl: spy as unknown as typeof fetch, sleep: async () => {},
  });
  expect(await client.fetchPosts([], { maxPosts: 3, postedLimit: '24h' })).toEqual([]);
  expect(spy).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/apify-posts-client.test.ts`
Expected: FAIL — cannot resolve `../../src/core/apify-posts-client.js`.

- [ ] **Step 3: Create `src/core/apify-posts-client.ts`**

```ts
/**
 * Apify client for harvestapi~linkedin-profile-posts — the second actor, alongside the
 * profile scraper in apify-client.ts.
 *
 * WHY A SEPARATE INTERFACE rather than a method on ApifyClient: every existing test fake
 * implements `{ fetchProfile }`, and adding a required `fetchPosts` would break all of them
 * for reasons unrelated to this feature. HttpApifyPostsClient can implement both if that ever
 * becomes useful; the sweep worker only ever sees ApifyPostsClient.
 *
 * WHY ASYNC RUN + POLL rather than the run-sync endpoint the profile client uses: run-sync
 * fails at 300s with HTTP 408, and that timeout kills only the HTTP request — the run keeps
 * going, so retrying would bill twice for the same work. The actor documents no maximum on
 * targetUrls, so polling lets ONE run cover every tracked profile.
 *
 * Like the profile client, this never touches the LinkedIn browser session, so it needs no
 * guardrail, no pacing and no browser mutex.
 */
import type { ApifyPost } from '../types.js';

const ACTOR_ID = 'harvestapi~linkedin-profile-posts';

/** $1.50–2.00 per 1,000 posts, pay-per-result. The conservative end, for the cost readout. */
export const COST_PER_POST_USD = 0.002;

/** Apify pages dataset items; 1000 is its usual maximum page size. */
const PAGE_SIZE = 1000;
const DEFAULT_POLL_MS = 5_000;
const DEFAULT_MAX_POLLS = 240;        // 240 x 5s = 20 minutes
const DEFAULT_TIMEOUT_MS = 60_000;    // per HTTP request, not per run

export type PostedLimit = '24h' | 'week' | 'month';

export interface FetchPostsOptions {
  /** Per profile, not per run. */
  maxPosts: number;
  /**
   * THE cost control. INSERT OR IGNORE dedupes storage but never the bill, so a wide window
   * on a frequent sweep re-bills posts already stored. Derived from per-profile staleness by
   * the sweep worker; never widened casually.
   */
  postedLimit: PostedLimit;
}

/** Injected everywhere so no test ever spends money. */
export interface ApifyPostsClient {
  fetchPosts(urls: string[], opts: FetchPostsOptions): Promise<ApifyPost[]>;
}

export interface HttpApifyPostsClientOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  maxPolls?: number;
  timeoutMs?: number;
}

const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT', 'TIMED_OUT']);

export class HttpApifyPostsClient implements ApifyPostsClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollMs: number;
  private readonly maxPolls: number;
  private readonly timeoutMs: number;

  constructor(private readonly token: string, opts: HttpApifyPostsClientOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
    this.maxPolls = opts.maxPolls ?? DEFAULT_MAX_POLLS;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async fetchPosts(urls: string[], opts: FetchPostsOptions): Promise<ApifyPost[]> {
    // Guarded here rather than at the call site: an empty targetUrls array is a billable run
    // that can only return nothing.
    if (urls.length === 0) return [];
    const { runId, datasetId } = await this.startRun(urls, opts);
    const finalDataset = await this.awaitRun(runId, datasetId);
    return this.readDataset(finalDataset);
  }

  private async startRun(
    urls: string[], opts: FetchPostsOptions,
  ): Promise<{ runId: string; datasetId: string }> {
    const body = {
      targetUrls: urls,
      maxPosts: opts.maxPosts,
      postedLimit: opts.postedLimit,
      // Both bill as ADDITIONAL posts. Never enable them.
      scrapeReactions: false,
      scrapeComments: false,
    };
    const payload = await this.request(`/v2/acts/${ACTOR_ID}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    }) as { data?: { id?: string; defaultDatasetId?: string } };
    const runId = payload?.data?.id;
    const datasetId = payload?.data?.defaultDatasetId;
    if (!runId || !datasetId) throw new Error('Apify did not return a run id and dataset id');
    return { runId, datasetId };
  }

  /** Poll until terminal. Returns the dataset id the finished run reports. */
  private async awaitRun(runId: string, fallbackDatasetId: string): Promise<string> {
    for (let i = 0; i < this.maxPolls; i++) {
      const payload = await this.request(`/v2/actor-runs/${runId}`, { method: 'GET' }) as
        { data?: { status?: string; defaultDatasetId?: string } };
      const status = payload?.data?.status ?? 'UNKNOWN';
      if (TERMINAL.has(status)) {
        if (status !== 'SUCCEEDED') throw new Error(`Apify run ${status}`);
        return payload?.data?.defaultDatasetId ?? fallbackDatasetId;
      }
      await this.sleep(this.pollMs);
    }
    // Deliberately does not abort the run: it may still be doing billable work, and a second
    // sweep would pay for it again. The next pass reaches these profiles via their unchanged
    // last_swept_at, and INSERT OR IGNORE makes any overlap free.
    throw new Error(`Apify run did not finish within ${this.maxPolls} polls`);
  }

  private async readDataset(datasetId: string): Promise<ApifyPost[]> {
    const out: ApifyPost[] = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const page = await this.request(
        `/v2/datasets/${datasetId}/items?clean=true&limit=${PAGE_SIZE}&offset=${offset}`,
        { method: 'GET' },
      );
      if (!Array.isArray(page)) throw new Error('Apify returned an unexpected dataset shape');
      out.push(...(page as ApifyPost[]));
      // A short page is the last page. Paged rather than fetched whole because a large run's
      // response would otherwise be silently truncated.
      if (page.length < PAGE_SIZE) return out;
    }
  }

  /**
   * One HTTP call. The token travels in the query string and MUST NEVER reach an error
   * message: those land in data/relay.log, which the operator downloads and shares when
   * troubleshooting. So every throw below names the path or status, never the URL.
   */
  private async request(path: string, init: RequestInit): Promise<unknown> {
    const sep = path.includes('?') ? '&' : '?';
    const url = `https://api.apify.com${path}${sep}token=${encodeURIComponent(this.token)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, { ...init, signal: controller.signal });
      if (!res.ok) throw new Error(`Apify request failed (HTTP ${res.status})`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/core/apify-posts-client.test.ts`
Expected: PASS (7 tests).

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/core/apify-posts-client.ts tests/core/apify-posts-client.test.ts
git commit -m "feat(posts): Apify posts client using async run+poll, one run for every profile"
```

---

**Phase 2 checkpoint.** `npm test` and `npm run typecheck` must both be clean.

---

# Phase 3 — The sweep worker

### Task 6: `posts-sweep.ts` — one sweep pass

**Files:**
- Create: `src/worker/posts-sweep.ts`
- Test: `tests/worker/posts-sweep.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/worker/posts-sweep.test.ts`:

```ts
/**
 * One sweep pass. A FakeApifyPostsClient throughout — nothing here can spend money.
 *
 * The window-derivation tests are the important ones: postedLimit is the cost model, not a
 * filter, and widening it silently multiplies the Apify bill.
 */
import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { runPostsSweep, windowFor } from '../../src/worker/posts-sweep.js';
import type { ApifyPostsClient, FetchPostsOptions } from '../../src/core/apify-posts-client.js';
import type { ApifyPost } from '../../src/types.js';

let repos: Repos;
const NOW = new Date('2026-08-04T10:00:00.000Z');

beforeEach(() => { repos = new Repos(openDatabase(':memory:')); });

const URL_A = 'https://www.linkedin.com/in/dana';
const URL_B = 'https://www.linkedin.com/in/marcus';

/** Records every call so the batching and window choices can be asserted precisely. */
function fakeClient(
  postsFor: (url: string) => ApifyPost[] = () => [],
  fail?: (urls: string[]) => Error | null,
): ApifyPostsClient & { calls: { urls: string[]; opts: FetchPostsOptions }[] } {
  const calls: { urls: string[]; opts: FetchPostsOptions }[] = [];
  return {
    calls,
    async fetchPosts(urls, opts) {
      calls.push({ urls: [...urls], opts });
      const err = fail?.(urls) ?? null;
      if (err) throw err;
      return urls.flatMap((u) => postsFor(u));
    },
  };
}

const postFor = (url: string, urn: string, postedAt: string): ApifyPost => ({
  id: urn,
  linkedinUrl: `https://www.linkedin.com/feed/update/${urn}/`,
  content: `A post from ${url}`,
  postedAt: { timestamp: new Date(postedAt).getTime() },
  author: { name: 'Someone', linkedinUrl: url, position: 'Engineer' },
  engagement: { likes: 3, comments: 1 },
  query: { targetUrl: url },
});

test('windowFor picks the cheap 24h window only for a freshly-swept profile', () => {
  // Never swept: the wider window is what gives a newly-tracked profile content at all,
  // which is what replaced the rejected backfill mechanism.
  expect(windowFor(null, NOW)).toBe('week');
  expect(windowFor('2026-08-04T09:00:00.000Z', NOW)).toBe('24h');
  expect(windowFor('2026-08-03T11:00:00.000Z', NOW)).toBe('24h');
  // Stale: a missed sweep self-heals rather than losing those posts forever.
  expect(windowFor('2026-08-02T09:00:00.000Z', NOW)).toBe('week');
});

test('a sweep issues one run per window and stores what comes back', async () => {
  const a = repos.trackedProfiles.add(URL_A, null, 'urls');
  const b = repos.trackedProfiles.add(URL_B, null, 'search');
  // A is fresh, B has never been swept — so two windows, two runs.
  repos.trackedProfiles.markSwept(a.id, '2026-08-04T09:00:00.000Z');

  const client = fakeClient((url) => [
    postFor(url, `urn:li:activity:${url.endsWith('dana') ? 1 : 2}`, '2026-08-04T08:00:00.000Z'),
  ]);
  const res = await runPostsSweep(repos, { client, now: NOW, maxPosts: 3, batchSize: 200 });

  expect(res.postsAdded).toBe(2);
  expect(res.clean).toBe(true);
  const windows = client.calls.map((c) => c.opts.postedLimit).sort();
  expect(windows).toEqual(['24h', 'week']);
  expect(client.calls.every((c) => c.opts.maxPosts === 3)).toBe(true);
});

test('every profile in one window goes in ONE run', async () => {
  repos.trackedProfiles.add(URL_A, null, 'urls');
  repos.trackedProfiles.add(URL_B, null, 'urls');
  const client = fakeClient();
  await runPostsSweep(repos, { client, now: NOW, maxPosts: 3, batchSize: 200 });
  expect(client.calls).toHaveLength(1);
  expect(client.calls[0].urls.sort()).toEqual([URL_A, URL_B].sort());
});

test('batchSize splits a window into several runs', async () => {
  for (let i = 0; i < 5; i++) {
    repos.trackedProfiles.add(`https://www.linkedin.com/in/p${i}`, null, 'urls');
  }
  const client = fakeClient();
  await runPostsSweep(repos, { client, now: NOW, maxPosts: 3, batchSize: 2 });
  expect(client.calls.map((c) => c.urls.length)).toEqual([2, 2, 1]);
});

test('a clean pass stamps posts_swept_at; a failed one does not', async () => {
  repos.trackedProfiles.add(URL_A, null, 'urls');

  const boom = fakeClient(() => [], () => new Error('actor exploded'));
  const bad = await runPostsSweep(repos, { client: boom, now: NOW, maxPosts: 3, batchSize: 200 });
  expect(bad.clean).toBe(false);
  // Not stamped, so the next tick retries instead of recording this pass as done.
  expect(repos.appState.get().posts_swept_at).toBeNull();

  const ok = await runPostsSweep(repos, {
    client: fakeClient(), now: NOW, maxPosts: 3, batchSize: 200,
  });
  expect(ok.clean).toBe(true);
  expect(repos.appState.get().posts_swept_at).toBe(NOW.toISOString());
});

test('a failed run stamps only its own profiles and leaves their last_swept_at alone', async () => {
  const a = repos.trackedProfiles.add(URL_A, null, 'urls');
  const b = repos.trackedProfiles.add(URL_B, null, 'urls');
  repos.trackedProfiles.markSwept(a.id, '2026-08-04T09:00:00.000Z');   // fresh  -> 24h run
  // b has never been swept -> week run. Only the week run fails.
  const client = fakeClient(
    (url) => [postFor(url, 'urn:li:activity:1', '2026-08-04T08:00:00.000Z')],
    (urls) => (urls.includes(URL_B) ? new Error('run failed') : null),
  );

  const res = await runPostsSweep(repos, { client, now: NOW, maxPosts: 3, batchSize: 200 });
  expect(res.clean).toBe(false);

  // A succeeded and advanced. B recorded the error but did NOT advance — advancing would
  // hand it the narrow 24h window next pass and lose whatever it posted.
  expect(repos.trackedProfiles.findById(a.id)!.last_swept_at).toBe(NOW.toISOString());
  expect(repos.trackedProfiles.findById(b.id)!.last_swept_at).toBeNull();
  expect(repos.trackedProfiles.findById(b.id)!.last_sweep_error).toContain('run failed');
});

test('an auth failure latches the halt; an ordinary failure does not', async () => {
  repos.trackedProfiles.add(URL_A, null, 'urls');

  await runPostsSweep(repos, {
    client: fakeClient(() => [], () => new Error('Apify request failed (HTTP 401)')),
    now: NOW, maxPosts: 3, batchSize: 200,
  });
  expect(repos.appState.get().posts_halted).toBe(1);
  expect(repos.appState.get().posts_halt_reason).toBe('auth');

  repos.appState.clearPostsHalt();
  await runPostsSweep(repos, {
    client: fakeClient(() => [], () => new Error('socket hang up')),
    now: NOW, maxPosts: 3, batchSize: 200,
  });
  // A transient network failure is retried by the next tick, not latched off.
  expect(repos.appState.get().posts_halted).toBe(0);
});

test('the sweep prunes un-engaged posts past the retention window', async () => {
  const a = repos.trackedProfiles.add(URL_A, null, 'urls');
  repos.posts.upsertMany([{
    post_urn: 'urn:li:activity:ancient',
    post_url: 'https://www.linkedin.com/feed/update/urn:li:activity:ancient/',
    tracked_profile_id: a.id, author_name: null, author_headline: null,
    content: 'old', posted_at: '2026-01-01T00:00:00.000Z', is_repost: 0,
    reaction_count: null, comment_count: null, raw_json: null,
  }], '2026-01-01T00:00:00.000Z');

  const res = await runPostsSweep(repos, {
    client: fakeClient(), now: NOW, maxPosts: 3, batchSize: 200, retentionDays: 30,
  });
  expect(res.pruned).toBe(1);
  expect(repos.posts.countAll()).toBe(0);
});

test('an untracked profile is never swept', async () => {
  const a = repos.trackedProfiles.add(URL_A, null, 'urls');
  repos.trackedProfiles.deactivate(a.id);
  const client = fakeClient();
  const res = await runPostsSweep(repos, { client, now: NOW, maxPosts: 3, batchSize: 200 });
  expect(client.calls).toHaveLength(0);
  expect(res.clean).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/worker/posts-sweep.test.ts`
Expected: FAIL — cannot resolve `../../src/worker/posts-sweep.js`.

- [ ] **Step 3: Add the halt helpers to `AppStateRepo` in `src/db/repositories.ts`**

Next to `haltEnrichment` / `clearEnrichHalt`, add:

```ts
  /** Latch the posts sweep off. An ERROR latch, not a spend cap. */
  haltPosts(reason: PostsHaltReason, detail: string, atIso: string): void {
    this.db.prepare(
      'UPDATE app_state SET posts_halted = 1, posts_halt_reason = ?, posts_halt_detail = ?, posts_halted_at = ? WHERE id = 1',
    ).run(reason, detail, atIso);
  }

  /** Clear the latch entirely — a half-cleared halt would render a stale reason. */
  clearPostsHalt(): void {
    this.db.prepare(
      'UPDATE app_state SET posts_halted = 0, posts_halt_reason = NULL, posts_halt_detail = NULL, posts_halted_at = NULL WHERE id = 1',
    ).run();
  }

  /** Stamped ONLY on a clean sweep, so a failed pass is retried by the next tick. */
  markPostsSwept(atIso: string): void {
    this.db.prepare('UPDATE app_state SET posts_swept_at = ? WHERE id = 1').run(atIso);
  }
```

Add `PostsHaltReason` to the existing type import at the top of `repositories.ts`.

- [ ] **Step 4: Create `src/worker/posts-sweep.ts`**

```ts
/**
 * One posts-sweep pass: derive each profile's window, run the actor, store what comes back,
 * then prune.
 *
 * Shape borrowed from runRosterSync (slot-gated by the caller, stamps only on a clean pass)
 * and runEnrichment (injected Apify client, halt latch). Like enrichment, this never touches
 * the LinkedIn browser session — so no guardrail, no pacing, no browser mutex.
 */
import type { Repos } from '../db/repositories.js';
import type { PostInput } from '../db/posts-repos.js';
import type { ApifyPostsClient, PostedLimit } from '../core/apify-posts-client.js';
import { attribute } from '../core/apify-posts-extract.js';
import { normalizeProfileUrl } from '../core/url.js';
import { log } from '../core/log.js';

const DAY_MS = 86_400_000;

/** One run at a time per process. A sweep can outlast the 30-minute tick interval. */
let running = false;
export function isPostsSweepRunning(): boolean { return running; }

export interface PostsSweepOptions {
  client: ApifyPostsClient;
  now?: Date;
  maxPosts: number;
  batchSize: number;
  retentionDays?: number;
}

export interface PostsSweepResult {
  runs: number;
  profilesSwept: number;
  postsAdded: number;
  /** Posts the schema refused — a malformed posted_at from Apify. Billed but unusable, so
   *  this must be visible rather than swallowed by INSERT OR IGNORE. */
  postsRejected: number;
  unattributed: number;
  pruned: number;
  /** True when every run succeeded. Only a clean pass stamps posts_swept_at. */
  clean: boolean;
}

/**
 * Which postedLimit this profile gets.
 *
 * THE cost decision, and the thing that replaced a separate backfill mechanism. A profile
 * swept within the last day only needs the last day — and because billing is per post
 * RETURNED, that is what makes the steady state cheap. A stale or never-swept profile gets a
 * week, which both self-heals downtime and gives a newly-tracked profile immediate content.
 */
export function windowFor(lastSweptAt: string | null, now: Date): PostedLimit {
  if (lastSweptAt === null) return 'week';
  const age = now.getTime() - new Date(lastSweptAt).getTime();
  if (!Number.isFinite(age) || age < 0) return 'week';   // an unparseable stamp is not "fresh"
  return age <= DAY_MS ? '24h' : 'week';
}

/** Split into chunks of at most `size`. */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += Math.max(1, size)) out.push(items.slice(i, i + Math.max(1, size)));
  return out;
}

/** An auth failure will not fix itself, so it latches. Anything else is retried next tick. */
function isAuthFailure(message: string): boolean {
  return /HTTP 40[13]/.test(message);
}

export async function runPostsSweep(repos: Repos, opts: PostsSweepOptions): Promise<PostsSweepResult> {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const result: PostsSweepResult = {
    runs: 0, profilesSwept: 0, postsAdded: 0, postsRejected: 0, unattributed: 0,
    pruned: 0, clean: true,
  };

  running = true;
  try {
    const profiles = repos.trackedProfiles.activeProfiles();

    // Group by window, so each window costs exactly one run per batch rather than one per
    // profile. Keys are normalized the same way attribute() normalizes what comes back.
    const groups = new Map<PostedLimit, { url: string; id: number }[]>();
    for (const p of profiles) {
      const key = normalizeProfileUrl(p.profile_url);
      if (key === null) {
        // Stored un-normalizable: nothing can be attributed back to it, so say so rather
        // than paying for a run whose results would be silently dropped.
        repos.trackedProfiles.markSweepError(p.id, 'profile_url could not be normalized');
        result.clean = false;
        continue;
      }
      const w = windowFor(p.last_swept_at, now);
      const list = groups.get(w) ?? [];
      list.push({ url: key, id: p.id });
      groups.set(w, list);
    }

    for (const [postedLimit, members] of groups) {
      for (const batch of chunk(members, opts.batchSize)) {
        const byUrl = new Map(batch.map((m) => [m.url, m.id]));
        result.runs++;
        try {
          const items = await opts.client.fetchPosts(batch.map((m) => m.url),
            { maxPosts: opts.maxPosts, postedLimit });
          const { rows, unattributed } = attribute(items, byUrl);
          result.unattributed += unattributed;
          if (unattributed > 0) {
            log.warn('posts', 'dropped unattributable items', { count: unattributed, postedLimit });
          }
          // upsertMany returns { added, rejected }: `rejected` is a post the CHECK constraints
          // refused (a malformed posted_at from Apify), which OR IGNORE would otherwise
          // discard indistinguishably from a duplicate — and we would re-bill for it every
          // sweep, forever, with nothing to show the operator.
          //
          // Do NOT wrap this call in a transaction of your own: upsertMany opens its own
          // unconditionally, and SQLite refuses a nested BEGIN ("cannot start a transaction
          // within a transaction"). Same constraint as ConnectionRepo.upsertMany.
          const stored = repos.posts.upsertMany(rows as PostInput[], nowIso);
          result.postsAdded += stored.added;
          result.postsRejected += stored.rejected;
          if (stored.rejected > 0) {
            log.warn('posts', 'posts rejected by the schema', { count: stored.rejected, postedLimit });
          }
          for (const m of batch) repos.trackedProfiles.markSwept(m.id, nowIso);
          result.profilesSwept += batch.length;
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          result.clean = false;
          // Only THIS batch's profiles are marked, so the next pass retries them without
          // re-billing everyone else.
          for (const m of batch) repos.trackedProfiles.markSweepError(m.id, error);
          log.error('posts', 'sweep batch failed', { count: batch.length, postedLimit, error });
          if (isAuthFailure(error)) {
            repos.appState.haltPosts('auth', `Apify rejected the API key: ${error}`, nowIso);
            return result;   // every remaining batch would fail the same way
          }
        }
      }
    }

    // Prune regardless of whether the runs succeeded: ageing out is the only way a post
    // leaves the New chip, and a failed Apify call is no reason to let the feed grow forever.
    const retention = opts.retentionDays ?? repos.settings.get().posts_retention_days;
    result.pruned = repos.posts.prune(retention, now);

    // Stamped only on a clean pass — the acceptance-checker lesson. A bailed-out pass leaves
    // the stamp untouched so the next tick retries within the same slot.
    if (result.clean) repos.appState.markPostsSwept(nowIso);

    log.info('posts', 'sweep finished', {
      runs: result.runs, profiles: result.profilesSwept, added: result.postsAdded,
      rejected: result.postsRejected, pruned: result.pruned, clean: result.clean,
    });
    return result;
  } finally {
    running = false;
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/worker/posts-sweep.test.ts`
Expected: PASS (9 tests).

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/worker/posts-sweep.ts src/db/repositories.ts tests/worker/posts-sweep.test.ts
git commit -m "feat(posts): sweep worker with staleness-derived windows and per-batch error isolation"
```

---

### Task 7: The orchestrator tick

**Files:**
- Modify: `src/worker/orchestrator.ts`
- Test: `tests/worker/posts-sweep-tick.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/worker/posts-sweep-tick.test.ts`:

```ts
/**
 * The sweep TICK — the gates, as opposed to the pass itself (posts-sweep.test.ts).
 *
 * The guardrail test is the one that matters most: Apify never touches the LinkedIn session,
 * so a tripped guardrail must NOT stop the sweep. Please do not "fix" that.
 */
import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { FakeDriver } from '../../src/browser/driver.js';
import { Orchestrator } from '../../src/worker/orchestrator.js';
import type { ApifyPostsClient } from '../../src/core/apify-posts-client.js';

let repos: Repos;
const NOW = new Date('2026-08-04T10:00:00.000Z');
const URL_A = 'https://www.linkedin.com/in/dana';

beforeEach(() => {
  repos = new Repos(openDatabase(':memory:'));
  repos.settings.update({ apify_api_key: 'apify_api_test' });
  repos.trackedProfiles.add(URL_A, null, 'urls');
});

/** Counts runs so "never spends" can be asserted precisely. */
function spyFactory(): { factory: (t: string) => ApifyPostsClient; runs: string[][] } {
  const runs: string[][] = [];
  return {
    runs,
    factory: () => ({ async fetchPosts(urls) { runs.push([...urls]); return []; } }),
  };
}

function orchestrator(factory: (t: string) => ApifyPostsClient): Orchestrator {
  return new Orchestrator(repos, new FakeDriver(), undefined, {}, undefined, factory);
}

test('a tick sweeps and stamps', async () => {
  const spy = spyFactory();
  await orchestrator(spy.factory).runPostsSweepTick(NOW);
  expect(spy.runs).toHaveLength(1);
  expect(repos.appState.get().posts_swept_at).toBe(NOW.toISOString());
});

test('the slot gate keeps one sweep per day', async () => {
  const spy = spyFactory();
  const orc = orchestrator(spy.factory);
  await orc.runPostsSweepTick(NOW);
  await orc.runPostsSweepTick(new Date('2026-08-04T14:00:00.000Z'));   // same day, same slot
  expect(spy.runs).toHaveLength(1);
  await orc.runPostsSweepTick(new Date('2026-08-05T10:00:00.000Z'));   // next day
  expect(spy.runs).toHaveLength(2);
});

test('paused blocks the sweep — it is the operator stop switch and that includes spending', async () => {
  repos.settings.update({ paused: 1 });
  const spy = spyFactory();
  await orchestrator(spy.factory).runPostsSweepTick(NOW);
  expect(spy.runs).toHaveLength(0);
});

test('a tripped guardrail does NOT block the sweep', async () => {
  // The guardrail means the LinkedIn session is in trouble. Apify never touches that
  // session, so gating on it here would stop harmless work for an unrelated reason.
  repos.appState.trip('checkpoint', 'verification requested', NOW.toISOString());
  const spy = spyFactory();
  await orchestrator(spy.factory).runPostsSweepTick(NOW);
  expect(spy.runs).toHaveLength(1);
});

test('a latched halt blocks the sweep instead of retrying it 1,440 times a day', async () => {
  repos.appState.haltPosts('auth', 'bad key', NOW.toISOString());
  const spy = spyFactory();
  await orchestrator(spy.factory).runPostsSweepTick(NOW);
  expect(spy.runs).toHaveLength(0);
});

test('no tracked profiles means no run and no client is ever built', async () => {
  const fresh = new Repos(openDatabase(':memory:'));
  fresh.settings.update({ apify_api_key: 'apify_api_test' });
  const built: string[] = [];
  const orc = new Orchestrator(fresh, new FakeDriver(), undefined, {}, undefined,
    (t: string) => { built.push(t); return { async fetchPosts() { return []; } }; });
  await orc.runPostsSweepTick(NOW);
  expect(built).toEqual([]);
});

test('work but no API key halts with a reason the operator can act on', async () => {
  repos.settings.update({ apify_api_key: '' });
  const spy = spyFactory();
  await orchestrator(spy.factory).runPostsSweepTick(NOW);
  expect(spy.runs).toHaveLength(0);
  const app = repos.appState.get();
  expect(app.posts_halted).toBe(1);
  expect(app.posts_halt_reason).toBe('no_api_key');
});

test('a throwing sweep never escapes the tick', async () => {
  const orc = orchestrator(() => ({
    async fetchPosts(): Promise<never> { throw new Error('unexpected'); },
  }));
  // A tick fires as `void this.runPostsSweepTick()`, so an uncaught rejection would crash
  // the whole process.
  await expect(orc.runPostsSweepTick(NOW)).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/worker/posts-sweep-tick.test.ts`
Expected: FAIL — `runPostsSweepTick` is not a function on `Orchestrator`.

- [ ] **Step 3: Add the imports to `src/worker/orchestrator.ts`**

```ts
import { type ApifyPostsClient, HttpApifyPostsClient } from '../core/apify-posts-client.js';
import { runPostsSweep, isPostsSweepRunning } from './posts-sweep.js';
```

- [ ] **Step 4: Add the constructor parameter**

Append a sixth parameter to the `Orchestrator` constructor, after `apifyClientFactory`:

```ts
    /** Injected so no test ever spends money. Built per run from the key currently in
     *  settings — same shape and reason as apifyClientFactory above. */
    private apifyPostsClientFactory: (token: string) => ApifyPostsClient =
      (t: string) => new HttpApifyPostsClient(t),
```

- [ ] **Step 5: Add the tick method**

Add after `runEnrichDrainTick`:

```ts
  /**
   * Sweep the tracked profiles' recent posts, at most once per slot.
   *
   * The gate reads the PERSISTED `posts_swept_at`, which runPostsSweep stamps only on a
   * clean pass — so a failed sweep leaves the stamp untouched and the next 30-minute tick
   * retries it inside the same slot. Same reasoning as the roster sync.
   *
   * `guardrail_tripped` is deliberately NOT a gate: the guardrail means the LinkedIn session
   * is in trouble, and Apify never touches that session. This mirrors runEnrichDrainTick.
   * Please do not "fix" this.
   */
  async runPostsSweepTick(now: Date = new Date()): Promise<void> {
    const s = this.repos.settings.get();
    // Pause is the operator's "stop doing things" switch, so it also stops unattended
    // spending. The manual Sweep now endpoint is the override.
    if (s.paused) return;
    // A latched halt is a problem already reported on the dashboard. Retrying it every 30
    // minutes would hammer Apify and bury the alert in noise.
    if (this.repos.appState.get().posts_halted === 1) return;
    // A sweep can outlast the tick interval, so overlap is prevented explicitly rather than
    // relying on the slot gate (which an unstamped failed pass does not close).
    if (isPostsSweepRunning()) return;

    const app = this.repos.appState.get();
    const slot = daySlot(now, s.posts_sweep_per_day);
    if (app.posts_swept_at
      && daySlot(new Date(app.posts_swept_at), s.posts_sweep_per_day) === slot) return;

    // The steady state must be cheap: one indexed COUNT and nothing else.
    if (this.repos.trackedProfiles.countActive() === 0) return;

    // There is work but no credential. Say so where the operator will see it — but only once
    // something is actually tracked, so a fresh install never nags about a key it needs.
    if (!s.apify_api_key) {
      this.repos.appState.haltPosts('no_api_key', 'No Apify API key is configured.',
        now.toISOString());
      log.error('posts', 'halted', { reason: 'no_api_key' });
      return;
    }

    try {
      await runPostsSweep(this.repos, {
        client: this.apifyPostsClientFactory(s.apify_api_key),
        now,
        maxPosts: s.posts_max_per_sweep,
        batchSize: s.posts_sweep_batch_size,
        retentionDays: s.posts_retention_days,
      });
    } catch (err) {
      this.handleTickError('posts', err);
    }
  }
```

Note this awaits rather than fire-and-forget (unlike `runEnrichDrainTick`): a sweep is minutes
rather than hours, and `isPostsSweepRunning()` above is what keeps it to one at a time.

- [ ] **Step 6: Register the timer in `start()`**

Add after the enrichment drain timer:

```ts
    // Posts sweep. 30 minutes for the same reason the roster sync uses it: the slot gate
    // decides how often a sweep actually happens, and a frequent tick is what lets a failed
    // pass retry inside the same slot instead of waiting a whole day.
    this.timers.push(setInterval(() => { void this.runPostsSweepTick(); }, 30 * 60 * 1000));
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run tests/worker/posts-sweep-tick.test.ts`
Expected: PASS (8 tests).

Run: `npm test`
Expected: the whole suite passes. Existing `Orchestrator` constructions rely on the new sixth
parameter's default, so none of them need changing — if any test fails to compile here, it
passed a positional argument past `apifyClientFactory` and needs the new parameter added.

- [ ] **Step 8: Commit**

```bash
git add src/worker/orchestrator.ts tests/worker/posts-sweep-tick.test.ts
git commit -m "feat(posts): slot-gated sweep tick, not gated on the guardrail"
```

---

**Phase 3 checkpoint.** `npm test` and `npm run typecheck` must both be clean. At this point the
sweep works end to end with no UI: set an Apify key, insert a tracked profile by hand into a
scratch database, and call `runPostsSweepTick`.

---

# Phase 4 — API

### Task 8: Tracked-profile routes

**Files:**
- Modify: `src/api/server.ts`
- Test: `tests/api/posts.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/api/posts.test.ts`:

```ts
/**
 * The Posts routes. A fake posts client is injected, so nothing here reaches Apify.
 */
import { test, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { FakeDriver } from '../../src/browser/driver.js';
import { buildServer } from '../../src/api/server.js';
import type { ApifyPostsClient } from '../../src/core/apify-posts-client.js';
import type { FastifyInstance } from 'fastify';

let repos: Repos; let app: FastifyInstance;

const fakePostsClient: ApifyPostsClient = { async fetchPosts() { return []; } };

beforeEach(() => {
  repos = new Repos(openDatabase(':memory:'));
  app = buildServer(repos, new FakeDriver(), undefined, undefined,
    { apifyPostsClientFactory: () => fakePostsClient });
});
afterEach(async () => { await app.close(); });

const post = (url: string, payload: unknown) =>
  app.inject({ method: 'POST', url, payload: payload as object });

test('POST /api/tracked-profiles accepts an array and reports per-URL rejects', async () => {
  const res = await post('/api/tracked-profiles', {
    profile_urls: [
      'https://www.linkedin.com/in/dana',
      'https://www.linkedin.com/in/dana',      // duplicate inside one request
      'not a url',
    ],
  });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  expect(body.added).toBe(1);
  expect(body.rejected).toEqual([
    expect.objectContaining({ reason: 'already_tracked' }),
    expect.objectContaining({ reason: 'invalid_url' }),
  ]);
  expect(repos.trackedProfiles.countActive()).toBe(1);
});

test('POST /api/tracked-profiles also accepts a pasted text blob', async () => {
  const res = await post('/api/tracked-profiles', {
    text: 'https://www.linkedin.com/in/dana\nsome noise\nhttps://www.linkedin.com/in/marcus',
  });
  expect(res.json().added).toBe(2);
});

test('a tracked profile is linked to its connection row when one exists', async () => {
  // Inserted directly: the subject here is the route's connection lookup, not ConnectionRepo's
  // upsert signature, and coupling this test to that signature buys nothing.
  repos.db.prepare(
    `INSERT INTO connections (profile_url, full_name, source, first_seen_at, last_seen_at)
     VALUES ('https://www.linkedin.com/in/dana', 'Dana Reingold', 'urls',
             '2026-08-04T10:00:00.000Z', '2026-08-04T10:00:00.000Z')`,
  ).run();
  const conn = repos.connections.findByUrl('https://www.linkedin.com/in/dana')!;
  await post('/api/tracked-profiles', { profile_urls: ['https://www.linkedin.com/in/dana'] });
  expect(repos.trackedProfiles.findByUrl('https://www.linkedin.com/in/dana')!.connection_id)
    .toBe(conn.id);
});

test('the cap fills partially rather than refusing the whole batch', async () => {
  repos.settings.update({ tracked_profile_cap: 2 });
  const res = await post('/api/tracked-profiles', {
    profile_urls: [
      'https://www.linkedin.com/in/a',
      'https://www.linkedin.com/in/b',
      'https://www.linkedin.com/in/c',
    ],
  });
  const body = res.json();
  expect(body.added).toBe(2);
  expect(body.rejected).toEqual([expect.objectContaining({ reason: 'cap_reached' })]);
  // The message must name the cap, not just the status — the operator has to know what to do.
  expect(body.rejected[0].message).toMatch(/2/);
});

test('GET /api/tracked-profiles returns active rows with post counts', async () => {
  await post('/api/tracked-profiles', { profile_urls: ['https://www.linkedin.com/in/dana'] });
  const res = await app.inject({ method: 'GET', url: '/api/tracked-profiles' });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.tracked).toHaveLength(1);
  expect(body.tracked[0].post_count).toBe(0);
  expect(body.cap).toBe(200);
});

test('DELETE untracks without deleting, and re-adding reactivates the same row', async () => {
  await post('/api/tracked-profiles', { profile_urls: ['https://www.linkedin.com/in/dana'] });
  const id = repos.trackedProfiles.findByUrl('https://www.linkedin.com/in/dana')!.id;

  const del = await app.inject({ method: 'DELETE', url: `/api/tracked-profiles/${id}` });
  expect(del.statusCode).toBe(200);
  expect(repos.trackedProfiles.findById(id)!.active).toBe(0);

  const again = await post('/api/tracked-profiles',
    { profile_urls: ['https://www.linkedin.com/in/dana'] });
  expect(again.json().added).toBe(1);
  expect(repos.trackedProfiles.findById(id)!.active).toBe(1);
});

test('DELETE on an unknown id is a 404, not a silent success', async () => {
  const res = await app.inject({ method: 'DELETE', url: '/api/tracked-profiles/999' });
  expect(res.statusCode).toBe(404);
});

test('an empty request is a 400', async () => {
  expect((await post('/api/tracked-profiles', { profile_urls: [] })).statusCode).toBe(400);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/api/posts.test.ts`
Expected: FAIL — 404 from Fastify, `added` is undefined.

- [ ] **Step 3: Extend `buildServer`'s options in `src/api/server.ts`**

Add to the `opts` object type:

```ts
    /** Injected so tests never reach Apify. Production builds a real client per sweep from
     *  the key currently in settings. */
    apifyPostsClientFactory?: (token: string) => ApifyPostsClient;
```

Add the imports:

```ts
import { type ApifyPostsClient, HttpApifyPostsClient, COST_PER_POST_USD } from '../core/apify-posts-client.js';
import { runPostsSweep } from '../worker/posts-sweep.js';
import { extractProfileUrls, normalizeProfileUrl } from '../core/url.js';
import type { PostFilter, TrackReject } from '../types.js';
```

`normalizeProfileUrl` may already be imported — check before adding it twice.

And near the top of the function body:

```ts
  const postsClientFactory = opts.apifyPostsClientFactory
    ?? ((t: string) => new HttpApifyPostsClient(t));
```

- [ ] **Step 4: Add the routes**

Add near the engagement routes:

```ts
  /**
   * The tracked set: who gets swept.
   *
   * Accepts `{ profile_urls: [...] }` (the Connections "Track posts" button) or
   * `{ text: "..." }` (the paste box), because a pasted blob is the other real-world input
   * shape and making the browser parse it would duplicate extractProfileUrls.
   *
   * Bulk-shaped with rejects reported BY URL AND REASON, like POST /api/events: finding out
   * later that a URL was junk is far too late.
   */
  app.post('/api/tracked-profiles', async (req, reply) => {
    const b = (req.body ?? {}) as { profile_urls?: unknown; text?: unknown };
    const raws: string[] = Array.isArray(b.profile_urls)
      ? b.profile_urls.map((u) => (typeof u === 'string' ? u.trim() : ''))
      : typeof b.text === 'string' ? extractProfileUrls(b.text) : [];
    if (raws.length === 0) return reply.code(400).send({ error: 'no profile urls supplied' });

    const s = repos.settings.get();
    const rejected: TrackReject[] = [];
    const added: number[] = [];
    // Recomputed per item rather than once: each successful add consumes a slot, so a batch
    // straddling the cap must stop exactly at it.
    for (const raw of raws) {
      const url = normalizeProfileUrl(raw);
      if (url === null) {
        rejected.push({ profile_url: raw, reason: 'invalid_url',
          message: `not a LinkedIn profile URL: ${raw === '' ? '(empty)' : raw}` });
        continue;
      }
      const existing = repos.trackedProfiles.findByUrl(url);
      if (existing && existing.active === 1) {
        rejected.push({ profile_url: url, reason: 'already_tracked',
          message: `already tracked (id ${existing.id})` });
        continue;
      }
      // A reactivation consumes a slot too, so it is counted here rather than exempted.
      if (repos.trackedProfiles.countActive() >= s.tracked_profile_cap) {
        rejected.push({ profile_url: url, reason: 'cap_reached',
          message: `tracking cap of ${s.tracked_profile_cap} reached — remove some profiles first` });
        continue;
      }
      const conn = repos.connections.findByUrl(url);
      const row = repos.trackedProfiles.add(url, conn?.id ?? null,
        Array.isArray(b.profile_urls) ? 'search' : 'urls');
      added.push(row.id);
    }

    if (added.length > 0) {
      defaultLog.info('api', 'profiles tracked', { added: added.length, rejected: rejected.length });
    }
    // Always 201, even when everything was rejected: the per-item verdicts are the payload,
    // not the status code. Same contract as POST /api/engagements.
    return reply.code(201).send({ added: added.length, ids: added, rejected });
  });

  app.get('/api/tracked-profiles', async () => ({
    tracked: repos.trackedProfiles.withCounts(),
    cap: repos.settings.get().tracked_profile_cap,
    swept_at: repos.appState.get().posts_swept_at,
  }));

  /** Untrack. Soft (active = 0) so posts keep a valid parent and history survives. */
  app.delete('/api/tracked-profiles/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const row = repos.trackedProfiles.findById(id);
    if (!row) return reply.code(404).send({ error: `no tracked profile ${id}` });
    repos.trackedProfiles.deactivate(id);
    defaultLog.info('api', 'profile untracked', { id, url: row.profile_url });
    return { ok: true, id };
  });
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/api/posts.test.ts`
Expected: PASS (8 tests).

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/api/server.ts tests/api/posts.test.ts
git commit -m "feat(posts): tracked-profile routes with partial cap fill and per-URL rejects"
```

---

### Task 9: The feed route

**Files:**
- Modify: `src/api/server.ts`
- Test: `tests/api/posts.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/api/posts.test.ts`:

```ts
/** Insert a tracked profile and n posts, newest first by index. */
async function seed(n: number): Promise<number> {
  await post('/api/tracked-profiles', { profile_urls: ['https://www.linkedin.com/in/dana'] });
  const tp = repos.trackedProfiles.findByUrl('https://www.linkedin.com/in/dana')!;
  repos.posts.upsertMany(
    Array.from({ length: n }, (_, i) => ({
      post_urn: `urn:li:activity:${i}`,
      post_url: `https://www.linkedin.com/feed/update/urn:li:activity:${i}/`,
      tracked_profile_id: tp.id,
      author_name: 'Dana Reingold', author_headline: 'VP Security',
      content: `Post number ${i}`,
      // Descending dates, so index 0 is the OLDEST and index n-1 the newest.
      posted_at: new Date(Date.UTC(2026, 6, 1 + i)).toISOString(),
      is_repost: 0, reaction_count: null, comment_count: null, raw_json: null,
    })),
    '2026-08-04T10:00:00.000Z',
  );
  return tp.id;
}

test('GET /api/posts returns newest first with counts', async () => {
  await seed(3);
  const res = await app.inject({ method: 'GET', url: '/api/posts' });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.posts.map((p: { post_urn: string }) => p.post_urn))
    .toEqual(['urn:li:activity:2', 'urn:li:activity:1', 'urn:li:activity:0']);
  expect(body.counts).toEqual({ new: 3, queued: 0, engaged: 0 });
  expect(body.filter).toBe('new');          // the default
  expect(body.tracked).toBe(1);
  expect(body.author_display).toBeUndefined();
  expect(body.posts[0].author_display).toBe('Dana Reingold');
});

test('the feed pages by keyset, not offset', async () => {
  await seed(5);
  const first = (await app.inject({ method: 'GET', url: '/api/posts?limit=2' })).json();
  expect(first.posts).toHaveLength(2);
  expect(first.next_cursor).toBeTruthy();

  const second = (await app.inject({
    method: 'GET', url: `/api/posts?limit=2&before=${encodeURIComponent(first.next_cursor)}`,
  })).json();
  expect(second.posts.map((p: { post_urn: string }) => p.post_urn))
    .toEqual(['urn:li:activity:2', 'urn:li:activity:1']);
});

test('next_cursor is null on the last page', async () => {
  await seed(2);
  const res = (await app.inject({ method: 'GET', url: '/api/posts?limit=10' })).json();
  expect(res.posts).toHaveLength(2);
  expect(res.next_cursor).toBeNull();
});

test('an unknown filter is a 400 rather than silently becoming new', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/posts?filter=nonsense' });
  expect(res.statusCode).toBe(400);
});

test('the cost readout reports posts stored in the trailing window', async () => {
  await seed(4);
  const res = (await app.inject({ method: 'GET', url: '/api/posts' })).json();
  expect(res.cost_30d.posts).toBe(4);
  expect(res.cost_30d.usd).toBeCloseTo(4 * 0.002, 6);
});

test('the halt latch travels with the feed so the screen needs one request', async () => {
  await seed(1);
  const clean = (await app.inject({ method: 'GET', url: '/api/posts' })).json();
  expect(clean.halt.halted).toBe(0);

  repos.appState.haltPosts('auth', 'Apify rejected the API key', '2026-08-04T10:00:00.000Z');
  const halted = (await app.inject({ method: 'GET', url: '/api/posts' })).json();
  expect(halted.halt.halted).toBe(1);
  expect(halted.halt.reason).toBe('auth');
  expect(halted.halt.detail).toBe('Apify rejected the API key');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/api/posts.test.ts -t "newest first"`
Expected: FAIL — 404.

- [ ] **Step 3: Add the route to `src/api/server.ts`**

```ts
  const POST_FILTERS = new Set<PostFilter>(['new', 'queued', 'engaged']);
  const FEED_LIMIT_DEFAULT = 25;
  const FEED_LIMIT_MAX = 100;

  /**
   * One page of the feed, plus everything the screen's header needs, in ONE round-trip —
   * chip counts, the tracked total, the last sweep and the cost readout. Three separate
   * endpoints for that would mean four requests to render one screen.
   *
   * `before` is the opaque `next_cursor` from the previous page. Keyset rather than offset
   * because the sweep inserts rows between requests, and offset would skip or repeat posts
   * as the set shifts underneath the reader.
   */
  app.get('/api/posts', async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const filter = (q.filter ?? 'new') as PostFilter;
    // Refused rather than defaulted: silently answering the `new` feed for a filter the
    // caller misspelled looks like an empty result, not a mistake.
    if (!POST_FILTERS.has(filter)) {
      return reply.code(400).send({ error: `unknown filter: ${String(q.filter)}` });
    }
    const asked = Number(q.limit);
    const limit = Number.isFinite(asked) && asked > 0
      ? Math.min(Math.floor(asked), FEED_LIMIT_MAX)
      : FEED_LIMIT_DEFAULT;
    const cursor = typeof q.before === 'string' && q.before !== '' ? q.before : null;

    // One extra row is fetched to learn whether another page exists, rather than issuing a
    // second COUNT for the same question.
    const rows = repos.posts.feed(filter, limit + 1, cursor);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor = rows.length > limit && last
      ? `${last.posted_at ?? last.first_seen_at}|${last.id}`
      : null;

    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const scraped = repos.posts.countSince(since);
    const app = repos.appState.get();
    return {
      posts: page,
      filter,
      counts: repos.posts.counts(),
      next_cursor: nextCursor,
      tracked: repos.trackedProfiles.countActive(),
      swept_at: app.posts_swept_at,
      // The halt latch rides along so the screen renders its banner without a second
      // request. Same treatment as the enrichment halt.
      halt: {
        halted: app.posts_halted,
        reason: app.posts_halt_reason,
        detail: app.posts_halt_detail,
        at: app.posts_halted_at,
      },
      // Informational only. No enforcement — a spend ceiling was explicitly declined; this
      // exists so the cost question is a number the operator can watch.
      cost_30d: { posts: scraped, usd: scraped * COST_PER_POST_USD },
    };
  });
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/api/posts.test.ts`
Expected: PASS (14 tests).

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/api/server.ts tests/api/posts.test.ts
git commit -m "feat(posts): feed route with keyset pagination, chip counts and cost readout"
```

---

### Task 10: Engage routes and sweep-now

The routes that put work into the engagement pipeline. They call the **existing**
`createEngagement` closure — do not reimplement URL parsing, reaction validation or the
comment length limit.

**Files:**
- Modify: `src/api/server.ts`
- Test: `tests/api/posts.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/api/posts.test.ts`:

```ts
test('engaging a post creates an engagement and links it', async () => {
  await seed(1);
  const id = repos.posts.findByUrn('urn:li:activity:0')!.id;
  const res = await post(`/api/posts/${id}/engage`,
    { reaction: 'insightful', comment: 'Useful framing.' });
  expect(res.statusCode).toBe(201);

  const body = res.json();
  expect(body.engagement.reaction).toBe('insightful');
  expect(body.engagement.comment_text).toBe('Useful framing.');
  expect(repos.posts.findById(id)!.engagement_id).toBe(body.engagement.id);
  // The post has left the New chip.
  expect(repos.posts.counts()).toEqual({ new: 0, queued: 1, engaged: 0 });
});

test('an omitted reaction defaults to like', async () => {
  await seed(1);
  const id = repos.posts.findByUrn('urn:li:activity:0')!.id;
  const res = await post(`/api/posts/${id}/engage`, {});
  expect(res.json().engagement.reaction).toBe('like');
});

test('validation is the engagement pipeline validation, not a second copy', async () => {
  await seed(1);
  const id = repos.posts.findByUrn('urn:li:activity:0')!.id;
  expect((await post(`/api/posts/${id}/engage`, { reaction: 'shrug' })).statusCode).toBe(400);
  expect((await post(`/api/posts/${id}/engage`, { comment: 'x'.repeat(1251) })).statusCode)
    .toBe(400);
  // Whitespace-only is NO comment, not an empty one — it must not claim a comment-cap slot.
  const ok = await post(`/api/posts/${id}/engage`, { comment: '   ' });
  expect(ok.json().engagement.comment_text).toBeNull();
});

test('engaging twice is a 409 naming the existing engagement', async () => {
  await seed(1);
  const id = repos.posts.findByUrn('urn:li:activity:0')!.id;
  await post(`/api/posts/${id}/engage`, { reaction: 'like' });
  const again = await post(`/api/posts/${id}/engage`, { reaction: 'love' });
  expect(again.statusCode).toBe(409);
  expect(again.json().error).toMatch(/already queued/);
});

test('a post whose engagement failed can be engaged again', async () => {
  await seed(1);
  const id = repos.posts.findByUrn('urn:li:activity:0')!.id;
  const first = (await post(`/api/posts/${id}/engage`, { reaction: 'like' })).json();
  repos.engagements.setStatus(first.engagement.id, 'failed', { last_error: 'nope' });
  // Back in the New chip, so it is retryable from the feed rather than invisible.
  expect(repos.posts.counts().new).toBe(1);
  expect((await post(`/api/posts/${id}/engage`, { reaction: 'like' })).statusCode).toBe(201);
});

test('an engagement already queued for the same post by URL is adopted, not duplicated', async () => {
  await seed(1);
  const urn = 'urn:li:activity:0';
  // The operator pasted the URL into /api/engagements earlier, before the feed existed.
  const pasted = repos.engagements.add(
    `https://www.linkedin.com/feed/update/${urn}/`, urn, 'celebrate', null);
  const id = repos.posts.findByUrn(urn)!.id;

  const res = await post(`/api/posts/${id}/engage`, { reaction: 'like' });
  expect(res.statusCode).toBe(200);
  expect(res.json().adopted).toBe(true);
  expect(repos.posts.findById(id)!.engagement_id).toBe(pasted.id);
  // The pre-existing reaction is left alone rather than being silently rewritten.
  expect(repos.engagements.findById(pasted.id)!.reaction).toBe('celebrate');
});

test('bulk engage applies one reaction to many posts', async () => {
  const tp = await seed(3);
  expect(tp).toBeGreaterThan(0);
  const ids = ['urn:li:activity:0', 'urn:li:activity:1', 'urn:li:activity:2']
    .map((u) => repos.posts.findByUrn(u)!.id);

  const res = await post('/api/posts/engage', { post_ids: ids, reaction: 'insightful' });
  expect(res.statusCode).toBe(201);
  expect(res.json().added).toBe(3);
  expect(repos.posts.counts()).toEqual({ new: 0, queued: 3, engaged: 0 });
});

test('bulk engage IGNORES a comment field — bulk commenting is unreachable', async () => {
  await seed(2);
  const ids = ['urn:li:activity:0', 'urn:li:activity:1'].map((u) => repos.posts.findByUrn(u)!.id);
  await post('/api/posts/engage',
    { post_ids: ids, reaction: 'like', comment: 'the same sentence on both' });
  for (const id of ids) {
    const eid = repos.posts.findById(id)!.engagement_id!;
    expect(repos.engagements.findById(eid)!.comment_text).toBeNull();
  }
});

test('bulk engage reports per-post rejects and still answers 201', async () => {
  await seed(1);
  const good = repos.posts.findByUrn('urn:li:activity:0')!.id;
  const res = await post('/api/posts/engage', { post_ids: [good, 9999], reaction: 'like' });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  expect(body.added).toBe(1);
  expect(body.rejected).toEqual([expect.objectContaining({ post_id: 9999, reason: 'not_found' })]);
});

test('bulk engage with an unknown reaction is a 400 before anything is queued', async () => {
  await seed(2);
  const ids = ['urn:li:activity:0', 'urn:li:activity:1'].map((u) => repos.posts.findByUrn(u)!.id);
  const res = await post('/api/posts/engage', { post_ids: ids, reaction: 'shrug' });
  expect(res.statusCode).toBe(400);
  // Validated up front: a bad reaction is one mistake for the whole batch, and half-applying
  // it would leave the operator to undo real queued rows.
  expect(repos.posts.counts().queued).toBe(0);
});

test('POST /api/posts/sweep-now runs a sweep regardless of the slot gate', async () => {
  await post('/api/tracked-profiles', { profile_urls: ['https://www.linkedin.com/in/dana'] });
  repos.settings.update({ apify_api_key: 'apify_api_test' });
  const first = await post('/api/posts/sweep-now', {});
  expect(first.statusCode).toBe(200);
  // A second call in the same slot still runs — that is what makes it the override.
  expect((await post('/api/posts/sweep-now', {})).statusCode).toBe(200);
});

test('sweep-now without an API key is a 400 the operator can act on', async () => {
  await post('/api/tracked-profiles', { profile_urls: ['https://www.linkedin.com/in/dana'] });
  const res = await post('/api/posts/sweep-now', {});
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toMatch(/Apify/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/api/posts.test.ts -t "creates an engagement"`
Expected: FAIL — 404.

- [ ] **Step 3: Add the routes to `src/api/server.ts`**

These must be registered **after** the `createEngagement` closure is defined (it is declared
around line 780, before `POST /api/engagements`) so they are in scope.

```ts
  /** Statuses that leave a post retryable — kept beside the repo's own filter definition. */
  const RETRYABLE = new Set(['failed', 'skipped']);

  /**
   * Queue one post's engagement from the feed.
   *
   * Delegates every judgement to createEngagement: URL and URN normalization, the six valid
   * reactions, the 1250-character comment limit, and whitespace-only comments collapsing to
   * null. A second copy of those rules here is how they drift apart.
   */
  app.post('/api/posts/:id/engage', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const row = repos.posts.findById(id);
    if (!row) return reply.code(404).send({ error: `no post ${id}` });

    if (row.engagement_id !== null) {
      const held = repos.engagements.findById(row.engagement_id);
      if (held && !RETRYABLE.has(held.status)) {
        return reply.code(409).send({
          error: `already queued as engagement ${held.id} (${held.status})`,
        });
      }
    }

    const b = (req.body ?? {}) as Record<string, unknown>;
    // `expanded` is null: a post_url from the sweep is already canonical, and isShortlink
    // is false for it, so the shortlink branch is never taken.
    const outcome = createEngagement({ reaction: b.reaction, comment: b.comment },
      row.post_url, null);

    if ('reason' in outcome) {
      // A duplicate means an engagement for this URN already exists — queued by hand through
      // /api/engagements before the feed existed. Adopt it rather than reporting a conflict
      // the operator cannot resolve: the work is already scheduled, it just was not linked.
      if (outcome.reason === 'duplicate') {
        const held = repos.engagements.findByUrn(row.post_urn);
        if (held) {
          repos.posts.setEngagement(id, held.id);
          return reply.code(200).send({ post_id: id, engagement: held, adopted: true });
        }
      }
      return reply.code(REJECT_STATUS[outcome.reason]).send({ error: outcome.message });
    }

    repos.posts.setEngagement(id, outcome.id);
    // Same reasoning as /api/engagements: give the new task a real slot now rather than
    // leaving it until the hourly tick. planAndAssignToday declines on its own while paused,
    // halted, off-hours or on a non-sending day.
    planAndAssignToday(repos, new Date());
    defaultLog.info('api', 'post engaged from feed', { post_id: id, engagement: outcome.id });
    return reply.code(201).send({
      post_id: id,
      engagement: repos.engagements.findById(outcome.id) ?? outcome,
    });
  });

  /**
   * Bulk: one reaction across several selected posts.
   *
   * There is NO comment parameter, deliberately. Identical comment text on several posts is a
   * recognizable spam pattern published under the operator's own name, and
   * engage_comment_daily_cap defaults to 10/day — so one click would spend the whole day's
   * allowance looking automated. Comments are per-post only.
   */
  app.post('/api/posts/engage', async (req, reply) => {
    const b = (req.body ?? {}) as { post_ids?: unknown; reaction?: unknown };
    const ids = Array.isArray(b.post_ids)
      ? b.post_ids.map((v) => Number(v)).filter((n) => Number.isInteger(n))
      : [];
    if (ids.length === 0) return reply.code(400).send({ error: 'no post ids supplied' });

    // Validated ONCE up front: a bad reaction is one mistake for the whole batch, and
    // half-applying it would leave the operator undoing real queued rows.
    const parsed = parseReaction(b.reaction);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const reaction = parsed.reaction ?? DEFAULT_REACTION;

    const created: number[] = [];
    const rejected: { post_id: number; reason: string; message: string }[] = [];
    for (const id of ids) {
      const row = repos.posts.findById(id);
      if (!row) {
        rejected.push({ post_id: id, reason: 'not_found', message: `no post ${id}` });
        continue;
      }
      if (row.engagement_id !== null) {
        const held = repos.engagements.findById(row.engagement_id);
        if (held && !RETRYABLE.has(held.status)) {
          rejected.push({ post_id: id, reason: 'duplicate',
            message: `already queued as engagement ${held.id} (${held.status})` });
          continue;
        }
      }
      // No comment is passed, so no bulk path can ever publish one.
      const outcome = createEngagement({ reaction }, row.post_url, null);
      if ('reason' in outcome) {
        if (outcome.reason === 'duplicate') {
          const held = repos.engagements.findByUrn(row.post_urn);
          if (held) { repos.posts.setEngagement(id, held.id); created.push(id); continue; }
        }
        rejected.push({ post_id: id, reason: outcome.reason, message: outcome.message });
        continue;
      }
      repos.posts.setEngagement(id, outcome.id);
      created.push(id);
    }

    if (created.length > 0) {
      planAndAssignToday(repos, new Date());
      defaultLog.info('api', 'posts bulk-engaged',
        { added: created.length, rejected: rejected.length, reaction });
    }
    // Always 201: the per-item verdicts are the payload. Same contract as /api/engagements.
    return reply.code(201).send({ added: created.length, post_ids: created, rejected });
  });

  /**
   * Sweep now — the override for the once-per-slot gate and for `paused`.
   *
   * Mirrors the per-belt "Run now": long on purpose, since it returns only after the actor
   * run finishes. Do not retry it.
   */
  app.post('/api/posts/sweep-now', async (req, reply) => {
    const s = repos.settings.get();
    if (repos.trackedProfiles.countActive() === 0) {
      return reply.code(400).send({ error: 'no profiles are being tracked' });
    }
    if (!s.apify_api_key) {
      return reply.code(400).send({ error: 'No Apify API key is configured — add one in Settings.' });
    }
    // A manual sweep is the operator saying "try again", so clear a previous latch first.
    repos.appState.clearPostsHalt();
    const result = await runPostsSweep(repos, {
      client: postsClientFactory(s.apify_api_key),
      now: new Date(),
      maxPosts: s.posts_max_per_sweep,
      batchSize: s.posts_sweep_batch_size,
      retentionDays: s.posts_retention_days,
    });
    return result;
  });
```

Confirm `parseReaction` and `DEFAULT_REACTION` are imported in `server.ts` — they are already
used by `createEngagement`, so they should be. `REJECT_STATUS` and `planAndAssignToday` are
likewise already in scope.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/api/posts.test.ts`
Expected: PASS (26 tests).

Run: `npm test`
Expected: the whole suite passes.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/api/server.ts tests/api/posts.test.ts
git commit -m "feat(posts): engage routes reusing createEngagement, bulk reaction-only, sweep-now"
```

---

**Phase 4 checkpoint.** The feature is now fully usable over HTTP with no UI. Verify by hand
against a scratch database — never `data/app.db`:

```bash
curl -s localhost:4400/api/tracked-profiles -H 'content-type: application/json' -d '{"profile_urls":["https://www.linkedin.com/in/some-profile"]}'
```

---

# Phase 5 — UI and docs

### Task 11: Markup, styles and settings fields

**Files:**
- Modify: `src/web/index.html`
- Modify: `src/web/styles.css`

No test in this task — it is static markup that Task 12's jsdom test exercises. Reuse the
existing `.panel`, `.panel-head`, `.card-surface`, `.btn`, `.pill` and `.data-table` classes;
only genuinely new structure gets new classes.

- [ ] **Step 1: Add the nav tab**

In `src/web/index.html`, in `<nav class="tabs" id="tabs">`, add after the Connections button
(Posts is downstream of Connections):

```html
      <button class="tab" data-tab="posts">Posts</button>
```

- [ ] **Step 2: Add the panel**

After the `</section>` that closes `#tab-connections`, add:

```html
    <section class="panel" id="tab-posts" hidden>
      <div class="panel-head">
        <div class="panel-title">
          <h2>Posts</h2>
          <p class="panel-sub">Recent posts from the profiles you track</p>
        </div>
        <div class="panel-actions">
          <button class="btn btn-ghost" type="button" id="postsManageToggle"
                  aria-expanded="false" aria-controls="postsManage">Manage tracking</button>
          <button class="btn" type="button" id="postsSweepNow"
                  title="Scrape now, ignoring the once-a-day schedule">Sweep now</button>
        </div>
      </div>

      <!-- Sweep state and the informational cost readout. No enforcement lives here: a spend
           ceiling was declined, so this exists purely so the cost is a number, not a guess. -->
      <div class="posts-status" id="postsStatus"></div>

      <!-- The halt latch, same treatment as the enrichment halt banner. -->
      <div class="posts-halt" id="postsHalt" hidden></div>

      <!-- Collapsed by default: the feed is the screen, tracking is the occasional chore. -->
      <div class="card-surface posts-manage" id="postsManage" hidden>
        <div class="add-field">
          <label for="postsTrackText">Add profiles to track
            <span class="hint">one URL per line; anything else on the line is ignored</span>
          </label>
          <textarea id="postsTrackText" rows="4"
                    placeholder="https://www.linkedin.com/in/some-person"></textarea>
        </div>
        <div class="posts-manage-actions">
          <span class="muted" id="postsTrackCount"></span>
          <button class="btn btn-green" type="button" id="postsTrackAdd">Track posts</button>
        </div>
        <div class="table-wrap">
          <table class="data-table" id="postsTrackedTable">
            <thead>
              <tr><th>Profile</th><th>Posts</th><th>Last swept</th><th></th></tr>
            </thead>
            <tbody id="postsTrackedRows"></tbody>
          </table>
        </div>
      </div>

      <div class="posts-chips" id="postsChips" role="tablist" aria-label="Filter posts">
        <button class="posts-chip is-active" type="button" data-filter="new" role="tab"
                aria-selected="true">New <span class="posts-chip-n" data-count="new">0</span></button>
        <button class="posts-chip" type="button" data-filter="queued" role="tab"
                aria-selected="false">Queued <span class="posts-chip-n" data-count="queued">0</span></button>
        <button class="posts-chip" type="button" data-filter="engaged" role="tab"
                aria-selected="false">Engaged <span class="posts-chip-n" data-count="engaged">0</span></button>
      </div>

      <!-- Appears only once something is selected. An always-present queue affordance beside
           a feed is how people queue engagements they didn't mean to — the same reasoning
           already written into the Connections selection bar. -->
      <div class="selection-bar" id="postsSelectionBar" hidden>
        <span class="selection-count" id="postsSelectionCount">0 selected</span>
        <div class="selection-actions">
          <button class="btn btn-ghost" type="button" id="postsSelectionClear">Clear</button>
          <label class="visually-hidden" for="postsBulkReaction">Reaction</label>
          <select id="postsBulkReaction">
            <option value="like">👍 Like</option>
            <option value="celebrate">👏 Celebrate</option>
            <option value="support">🤝 Support</option>
            <option value="love">❤️ Love</option>
            <option value="insightful">💡 Insightful</option>
            <option value="funny">😄 Funny</option>
          </select>
          <button class="btn btn-green" type="button" id="postsBulkQueue">Queue reaction</button>
        </div>
      </div>

      <div class="posts-feed" id="postsFeed"></div>
      <div class="empty" id="postsEmpty">No posts yet. Track some profiles, then sweep.</div>
      <div class="search-more">
        <button class="btn" type="button" id="postsMore" hidden>Load more</button>
      </div>
    </section>
```

- [ ] **Step 3: Add the settings fields**

In the Settings panel, after the `setEngageCommentCap` field, add a new group:

```html
        <h3 class="settings-group-title">Posts feed</h3>
        <div class="field">
          <label for="setPostsSweepPerDay">Sweeps / day
            <span class="hint">one is plenty; more multiplies the Apify bill</span>
          </label>
          <input id="setPostsSweepPerDay" type="number" min="0" />
        </div>
        <div class="field">
          <label for="setPostsMaxPerSweep">Posts / profile / sweep
            <span class="hint">the per-sweep ceiling per person</span>
          </label>
          <input id="setPostsMaxPerSweep" type="number" min="1" />
        </div>
        <div class="field">
          <label for="setPostsRetentionDays">Keep posts for
            <span class="hint">days; engaged posts are kept forever</span>
          </label>
          <input id="setPostsRetentionDays" type="number" min="1" />
        </div>
        <div class="field">
          <label for="setTrackedProfileCap">Tracked profile cap</label>
          <input id="setTrackedProfileCap" type="number" min="1" />
        </div>
```

Then wire them into the existing settings load/save in `app.js` exactly as the neighbouring
`setEngage*` fields are — find `setEngageCommentCap` in `src/web/app.js` and add the four new
ids alongside it in the same two places (the populate function and the save payload).

`posts_sweep_batch_size` is deliberately **not** exposed: it is a safety valve for a raised
profile cap, not an operator dial.

- [ ] **Step 4: Load `posts.js`**

At the bottom of `src/web/index.html`, after the `app.js` tag:

```html
  <script src="/posts.js"></script>
```

Order matters: `posts.js` calls helpers defined in `app.js`, and classic scripts share one
global scope in load order.

- [ ] **Step 5: Add the styles**

Append to `src/web/styles.css`:

```css
/* --- Posts feed -------------------------------------------------------------
   Cards rather than a table: this screen exists to judge whether a post is worth
   engaging with, and that judgment needs the post's actual words. */
.posts-status { display: flex; gap: 14px; align-items: center; flex-wrap: wrap;
  font-size: 12px; color: var(--muted); margin-bottom: 10px; }
.posts-status .posts-cost { margin-left: auto; }

.posts-halt { border: 1px solid var(--red); background: var(--red-bg); color: var(--red);
  border-radius: 10px; padding: 10px 14px; margin-bottom: 12px; font-size: 13px; }

.posts-manage { padding: 14px; margin-bottom: 14px; }
.posts-manage-actions { display: flex; align-items: center; gap: 12px; margin: 10px 0 14px; }
.posts-manage-actions .muted { margin-right: auto; }

.posts-chips { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
.posts-chip { border: 1px solid var(--line); background: transparent; color: var(--text);
  border-radius: 999px; padding: 5px 14px; font: inherit; font-size: 13px; cursor: pointer; }
.posts-chip:hover { border-color: var(--muted); }
.posts-chip.is-active { background: var(--green); border-color: var(--green);
  color: #fff; font-weight: 600; }
.posts-chip-n { opacity: .75; margin-left: 4px; font-variant-numeric: tabular-nums; }

.posts-feed { display: flex; flex-direction: column; gap: 10px; }

.post-card { display: flex; gap: 12px; border: 1px solid var(--line); border-radius: 10px;
  padding: 12px 14px; background: var(--card); }
.post-card.is-selected { border-color: var(--green); background: var(--green-bg); }
.post-select { margin-top: 4px; flex: none; }
.post-main { flex: 1; min-width: 0; }
.post-who { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.post-name { font-weight: 600; }
.post-meta { font-size: 12px; color: var(--muted); margin-top: 1px; }
.post-body { margin: 8px 0 10px; white-space: pre-wrap; overflow-wrap: anywhere; }
/* Clamped to two lines with an explicit expand: a feed of full posts is unscannable, and
   truncating with no way back hides the thing being judged. */
.post-body.is-clamped { display: -webkit-box; -webkit-line-clamp: 2;
  -webkit-box-orient: vertical; overflow: hidden; }
.post-expand { background: none; border: 0; padding: 0; font: inherit; font-size: 12px;
  color: var(--blue); cursor: pointer; }
.post-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.post-comment { width: 100%; margin-top: 8px; font: inherit; font-size: 13px; }
.post-repost { font-size: 11px; text-transform: uppercase; letter-spacing: .4px;
  color: var(--amber); border: 1px solid var(--amber); border-radius: 4px; padding: 1px 5px; }
.post-error { font-size: 12px; color: var(--red); margin-top: 6px; }
```

If any custom property above (`--card`, `--line`, `--green-bg`) is not already declared in
`styles.css`, use the nearest one that is rather than inventing a new token — check the
`:root` block at the top of the file first.

- [ ] **Step 6: Verify nothing broke**

Run: `npm test`
Expected: the existing suite passes. `tests/web/*` load the real `index.html`, so a malformed
tag shows up here.

- [ ] **Step 7: Commit**

```bash
git add src/web/index.html src/web/styles.css src/web/app.js
git commit -m "feat(posts): Posts panel markup, feed-card styles and settings fields"
```

---

### Task 12: `posts.js` — feed rendering and chips

**Files:**
- Create: `src/web/posts.js`
- Modify: `src/web/app.js` (one line in `init()`)
- Modify: `tests/web/helpers/load-app.ts`
- Test: `tests/web/posts-feed.test.ts`

- [ ] **Step 1: Extend the jsdom harness**

In `tests/web/helpers/load-app.ts`, find where `app.js` is read and executed, and load
`posts.js` immediately after it in the same scope (classic scripts share one global scope, and
`posts.js` depends on helpers from `app.js`). Then add these to the `AppInternals` interface:

```ts
  initPosts: () => void;
  renderPostsFeed: (payload: Record<string, unknown>, append?: boolean) => void;
  refreshPosts: (append?: boolean) => Promise<void>;
  refreshTracked: () => Promise<void>;
  postsState: { filter: string; selected: Set<number>; cursor: string | null };
```

**Name-collision check before you write a line of `posts.js`.** `app.js` and `posts.js` are
classic scripts sharing ONE global lexical scope, so a top-level `const`/`let`/`function`
declared in both throws `Identifier 'x' has already been declared` — which kills the entire
file, silently, with no feature and no obvious cause. `app.js` already declares
`REACTION_LABELS`, `reactionLabel`, `api`, `el`, `$`, `toast` and `selected`. The code below
reuses those rather than redeclaring them. Grep `app.js` for any new top-level name you add.

- [ ] **Step 2: Write the failing test**

Create `tests/web/posts-feed.test.ts`:

```ts
// @vitest-environment jsdom
/**
 * The Posts screen, against the REAL index.html and the REAL posts.js — so element ids and
 * structure are the ones the browser sees, not hand-rolled stubs. Same reasoning as the other
 * tests/web suites.
 */
import { test, expect, beforeEach, vi } from 'vitest';
import { loadApp, type AppInternals } from './helpers/load-app.js';

let internals: AppInternals;

const feedPayload = (over: Record<string, unknown> = {}) => ({
  posts: [
    {
      id: 1, post_urn: 'urn:li:activity:1',
      post_url: 'https://www.linkedin.com/feed/update/urn:li:activity:1/',
      author_display: 'Dana Reingold', headline_display: 'VP Security',
      content: 'Alert triage is an ownership problem.',
      posted_at: '2026-08-03T09:00:00.000Z', is_repost: 0,
      engagement_status: null, engagement_reaction: null, engagement_reacted_at: null,
    },
    {
      id: 2, post_urn: 'urn:li:activity:2',
      post_url: 'https://www.linkedin.com/feed/update/urn:li:activity:2/',
      author_display: 'Marcus Oyelaran', headline_display: 'CISO',
      content: 'We ran a tabletop.', posted_at: '2026-08-02T09:00:00.000Z', is_repost: 1,
      engagement_status: 'scheduled', engagement_reaction: 'insightful',
      engagement_reacted_at: null,
    },
  ],
  filter: 'new',
  counts: { new: 23, queued: 4, engaged: 61 },
  next_cursor: null,
  tracked: 187,
  swept_at: '2026-08-04T09:20:00.000Z',
  cost_30d: { posts: 640, usd: 1.28 },
  ...over,
});

beforeEach(async () => { internals = await loadApp(); });

test('renders one card per post, newest first, with author and body', () => {
  internals.renderPostsFeed(feedPayload());
  const cards = document.querySelectorAll('#postsFeed .post-card');
  expect(cards).toHaveLength(2);
  expect(cards[0].querySelector('.post-name')!.textContent).toBe('Dana Reingold');
  expect(cards[0].querySelector('.post-body')!.textContent)
    .toBe('Alert triage is an ownership problem.');
});

test('post text is inserted as text, never as HTML', () => {
  // Post content is attacker-influenced: it is whatever a tracked person typed on LinkedIn.
  internals.renderPostsFeed(feedPayload({
    posts: [{ ...feedPayload().posts[0], content: '<img src=x onerror="window.__xss=1">' }],
  }));
  expect(document.querySelector('#postsFeed img')).toBeNull();
  expect(document.querySelector('.post-body')!.textContent)
    .toBe('<img src=x onerror="window.__xss=1">');
});

test('chip counts render and the active chip reflects the filter', () => {
  internals.renderPostsFeed(feedPayload());
  expect(document.querySelector('[data-count="new"]')!.textContent).toBe('23');
  expect(document.querySelector('[data-count="engaged"]')!.textContent).toBe('61');
  const active = document.querySelector('.posts-chip.is-active') as HTMLElement;
  expect(active.dataset.filter).toBe('new');
});

test('a queued post shows its engagement status and offers no Queue button', () => {
  internals.renderPostsFeed(feedPayload());
  const second = document.querySelectorAll('#postsFeed .post-card')[1];
  expect(second.querySelector('.pill')!.textContent!.toLowerCase()).toContain('scheduled');
  expect(second.querySelector('[data-act="queue"]')).toBeNull();
  // A new post does offer one.
  const first = document.querySelectorAll('#postsFeed .post-card')[0];
  expect(first.querySelector('[data-act="queue"]')).not.toBeNull();
});

test('a repost is labelled', () => {
  internals.renderPostsFeed(feedPayload());
  const second = document.querySelectorAll('#postsFeed .post-card')[1];
  expect(second.querySelector('.post-repost')).not.toBeNull();
});

test('the status strip shows tracked count, last sweep and the cost readout', () => {
  internals.renderPostsFeed(feedPayload());
  const strip = document.getElementById('postsStatus')!.textContent!;
  expect(strip).toContain('187');
  expect(strip).toMatch(/1\.28/);
});

test('the empty state shows only when there are no posts', () => {
  internals.renderPostsFeed(feedPayload({ posts: [], counts: { new: 0, queued: 0, engaged: 0 } }));
  expect(document.getElementById('postsEmpty')!.hidden).toBe(false);
  internals.renderPostsFeed(feedPayload());
  expect(document.getElementById('postsEmpty')!.hidden).toBe(true);
});

test('Load more shows only when the server reported another page', () => {
  internals.renderPostsFeed(feedPayload({ next_cursor: null }));
  expect((document.getElementById('postsMore') as HTMLButtonElement).hidden).toBe(true);
  internals.renderPostsFeed(feedPayload({ next_cursor: '2026-08-02T09:00:00.000Z|2' }));
  expect((document.getElementById('postsMore') as HTMLButtonElement).hidden).toBe(false);
});

test('a halted sweep shows the banner with its reason', () => {
  internals.renderPostsFeed(feedPayload({
    halt: { halted: 1, reason: 'auth', detail: 'Apify rejected the API key' },
  }));
  const banner = document.getElementById('postsHalt')!;
  expect(banner.hidden).toBe(false);
  expect(banner.textContent).toContain('Apify rejected the API key');
});

test('clicking a chip refetches with that filter', async () => {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => feedPayload({ filter: 'engaged' }) } as Response;
  }));
  internals.initPosts();
  (document.querySelector('[data-filter="engaged"]') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(calls.some((u) => u.includes('filter=engaged'))).toBe(true));
  // A filter change starts a fresh page rather than carrying the old cursor forward.
  expect(calls.every((u) => !u.includes('before='))).toBe(true);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/web/posts-feed.test.ts`
Expected: FAIL — `internals.renderPostsFeed is not a function`.

- [ ] **Step 4: Create `src/web/posts.js`**

```js
/* The Posts screen.
 *
 * Its own file rather than more of app.js, which is already ~3,000 lines. Loaded as a third
 * classic script AFTER app.js, so the helpers below (api, el, $) are the ones app.js already
 * defines — classic scripts share one global scope in load order. No build step, no module
 * system, no refactor of app.js.
 */

/** Feed page size. Matches the server's default; the server caps at 100 regardless. */
const POSTS_PAGE = 25;

/* CAREFUL: app.js and posts.js share ONE global lexical scope, so a top-level `const` or
 * `function` name declared in both throws "Identifier has already been declared" and kills
 * this whole file silently. app.js already declares REACTION_LABELS and reactionLabel() — so
 * the reaction vocabulary is REUSED here rather than redeclared. Before adding any new
 * top-level name to this file, grep app.js for it. */
const POST_REACTION_EMOJI = {
  like: '👍', celebrate: '👏', support: '🤝', love: '❤️', insightful: '💡', funny: '😄',
};

/** "👍 Like". Built from app.js's REACTION_LABELS so the six names live in exactly one place. */
function postReactionLabel(r) {
  return `${POST_REACTION_EMOJI[r] || ''} ${reactionLabel(r)}`.trim();
}

/* Selection lives here rather than being read back off the DOM: a re-render replaces every
 * card, and reading checkboxes would silently drop selections on refresh. */
const postsState = { filter: 'new', selected: new Set(), cursor: null, loading: false };

/** "6h" / "3d" / a date once it stops being useful as a relative age. */
function postAge(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 60) return `${Math.max(0, mins)}m ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
  const days = Math.floor(mins / 1440);
  return days <= 30 ? `${days}d ago` : new Date(iso).toISOString().slice(0, 10);
}

/**
 * Which chip a post belongs to, mirroring the server's FILTER_SQL partition exactly.
 *
 * Order matters and matches the SQL: a reaction outranks the status, because a reaction on
 * LinkedIn is a fact while a status is bookkeeping. Then `failed`/`skipped` return to `new`
 * so they can be retried; everything else with an engagement is in flight, `needs_attention`
 * included. Every post lands in exactly one chip — if you change this, change FILTER_SQL in
 * `src/db/posts-repos.ts` in the same commit or the badge and the filter will disagree.
 */
function postPhase(p) {
  if (p.engagement_reacted_at) return 'engaged';
  if (p.engagement_status && !['failed', 'skipped'].includes(p.engagement_status)) return 'queued';
  return 'new';
}

/** One feed card. */
function postCard(p) {
  const phase = postPhase(p);
  const card = el('div', { class: `post-card${postsState.selected.has(p.id) ? ' is-selected' : ''}` });
  card.dataset.postId = String(p.id);

  const box = el('input', {
    type: 'checkbox', class: 'post-select',
    'aria-label': `Select post by ${p.author_display || 'unknown author'}`,
  });
  box.checked = postsState.selected.has(p.id);
  box.dataset.act = 'select';
  card.appendChild(box);

  const main = el('div', { class: 'post-main' });

  const who = el('div', { class: 'post-who' });
  who.appendChild(el('span', { class: 'post-name' }, p.author_display || 'Unknown'));
  if (p.is_repost) who.appendChild(el('span', { class: 'post-repost' }, 'repost'));
  if (phase !== 'new') {
    who.appendChild(el('span', { class: `pill ${p.engagement_status || ''}` },
      p.engagement_status || phase));
  }
  main.appendChild(who);

  const bits = [p.headline_display, postAge(p.posted_at)].filter(Boolean);
  main.appendChild(el('div', { class: 'post-meta' }, bits.join(' · ')));

  /* textContent, never innerHTML: post content is whatever a tracked person typed on
   * LinkedIn, so it is untrusted input arriving from a third party. */
  const body = el('div', { class: 'post-body is-clamped' });
  body.textContent = p.content || '';
  main.appendChild(body);

  const expand = el('button', { class: 'post-expand', type: 'button' }, 'Show more');
  expand.dataset.act = 'expand';
  main.appendChild(expand);

  const acts = el('div', { class: 'post-actions' });
  if (phase === 'new') {
    const sel = el('select', { 'aria-label': 'Reaction' });
    sel.dataset.act = 'reaction';
    for (const value of Object.keys(REACTION_LABELS)) {
      sel.appendChild(el('option', { value }, postReactionLabel(value)));
    }
    acts.appendChild(sel);

    const commentBtn = el('button', { class: 'btn btn-ghost', type: 'button' }, '💬 Comment');
    commentBtn.dataset.act = 'comment-toggle';
    acts.appendChild(commentBtn);

    const queue = el('button', { class: 'btn btn-green', type: 'button' }, 'Queue');
    queue.dataset.act = 'queue';
    acts.appendChild(queue);
  } else if (p.engagement_reaction) {
    acts.appendChild(el('span', { class: 'post-meta' },
      `${postReactionLabel(p.engagement_reaction)} queued`));
  }
  const open = el('a', { class: 'btn btn-ghost', href: p.post_url, target: '_blank',
    rel: 'noopener noreferrer' }, 'Open ↗');
  acts.appendChild(open);
  main.appendChild(acts);

  const comment = el('textarea', {
    class: 'post-comment', rows: '2',
    placeholder: 'Comment (optional) — goes out under your name',
  });
  comment.dataset.act = 'comment';
  comment.hidden = true;
  main.appendChild(comment);

  card.appendChild(main);
  return card;
}

/** Render a whole payload from GET /api/posts. `append` keeps the existing cards. */
function renderPostsFeed(payload, append = false) {
  const p = payload || {};
  const feed = $('#postsFeed');
  if (!feed) return;
  if (!append) feed.replaceChildren();

  const posts = Array.isArray(p.posts) ? p.posts : [];
  for (const post of posts) feed.appendChild(postCard(post));

  const counts = p.counts || {};
  for (const key of ['new', 'queued', 'engaged']) {
    const n = document.querySelector(`[data-count="${key}"]`);
    if (n) n.textContent = String(counts[key] ?? 0);
  }
  if (typeof p.filter === 'string') postsState.filter = p.filter;
  for (const chip of document.querySelectorAll('.posts-chip')) {
    const on = chip.dataset.filter === postsState.filter;
    chip.classList.toggle('is-active', on);
    chip.setAttribute('aria-selected', on ? 'true' : 'false');
  }

  const strip = $('#postsStatus');
  if (strip) {
    strip.replaceChildren();
    strip.appendChild(el('span', {}, `${p.tracked ?? 0} tracked`));
    strip.appendChild(el('span', {},
      p.swept_at ? `Last swept ${postAge(p.swept_at)}` : 'Never swept'));
    const cost = p.cost_30d || {};
    strip.appendChild(el('span', { class: 'posts-cost' },
      `${cost.posts ?? 0} posts scraped in 30d (≈$${Number(cost.usd ?? 0).toFixed(2)})`));
  }

  const halt = p.halt || {};
  const banner = $('#postsHalt');
  if (banner) {
    banner.hidden = !halt.halted;
    banner.textContent = halt.halted
      ? `Post sweeping is halted (${halt.reason || 'unknown'}): ${halt.detail || ''} — fix it, then press Sweep now.`
      : '';
  }

  postsState.cursor = p.next_cursor || null;
  const more = $('#postsMore');
  if (more) more.hidden = postsState.cursor === null;
  const empty = $('#postsEmpty');
  if (empty) empty.hidden = feed.children.length > 0;
  renderPostsSelection();
}

/** Fetch a page. `append` false resets to the top of the current filter. */
async function refreshPosts(append = false) {
  if (postsState.loading) return;
  postsState.loading = true;
  try {
    const q = new URLSearchParams({ filter: postsState.filter, limit: String(POSTS_PAGE) });
    if (append && postsState.cursor) q.set('before', postsState.cursor);
    const payload = await api(`/api/posts?${q.toString()}`);
    renderPostsFeed(payload, append);
  } finally {
    postsState.loading = false;
  }
}
```

`renderPostsSelection` is defined in Task 13. Add a temporary no-op so this task's tests pass
on their own, and replace it there:

```js
/* Replaced in Task 13 with the real selection bar renderer. */
function renderPostsSelection() {}
```

- [ ] **Step 5: Add `initPosts` (rendering half)**

Append to `src/web/posts.js`:

```js
function initPosts() {
  for (const chip of document.querySelectorAll('.posts-chip')) {
    chip.addEventListener('click', () => {
      if (postsState.filter === chip.dataset.filter) return;
      postsState.filter = chip.dataset.filter;
      // A filter change is a fresh page: carrying the old cursor forward would page into the
      // middle of a different result set.
      postsState.cursor = null;
      postsState.selected.clear();
      void refreshPosts(false);
    });
  }
  $('#postsMore')?.addEventListener('click', () => { void refreshPosts(true); });
  $('#postsManageToggle')?.addEventListener('click', () => {
    const panel = $('#postsManage');
    const btn = $('#postsManageToggle');
    if (!panel || !btn) return;
    panel.hidden = !panel.hidden;
    btn.setAttribute('aria-expanded', panel.hidden ? 'false' : 'true');
    if (!panel.hidden) void refreshTracked();
  });
  void refreshPosts(false);
}
```

`refreshTracked` arrives in Task 13; add `async function refreshTracked() {}` as a temporary
no-op so this task stands alone.

- [ ] **Step 6: Call it from `app.js`**

In `src/web/app.js`, in `init()` (around line 2948), add alongside the other init calls:

```js
  initPosts();
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run tests/web/posts-feed.test.ts`
Expected: PASS (10 tests).

If `el()` rejects a `class` key or `$()` is named differently, use whatever `app.js` actually
defines — do not add a second helper.

Run: `npm test`
Expected: full suite passes.

- [ ] **Step 8: Commit**

```bash
git add src/web/posts.js src/web/app.js tests/web/helpers/load-app.ts tests/web/posts-feed.test.ts
git commit -m "feat(posts): feed rendering, chips and paging in a dedicated posts.js"
```

---

### Task 13: `posts.js` — selection, bulk and per-post engage

**Files:**
- Modify: `src/web/posts.js` (replacing the two no-ops from Task 12)
- Test: `tests/web/posts-feed.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/web/posts-feed.test.ts`:

```ts
/** Capture every fetch, and answer feed requests with a payload. */
function stubFetch(payload = feedPayload()) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({
      url, method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return { ok: true, status: 200, json: async () => payload } as Response;
  }));
  return calls;
}

test('the bulk bar stays hidden until something is selected', () => {
  internals.renderPostsFeed(feedPayload());
  expect(document.getElementById('postsSelectionBar')!.hidden).toBe(true);

  (document.querySelector('.post-card [data-act="select"]') as HTMLInputElement).click();
  expect(document.getElementById('postsSelectionBar')!.hidden).toBe(false);
  expect(document.getElementById('postsSelectionCount')!.textContent).toContain('1');
});

test('selection survives a re-render', () => {
  internals.renderPostsFeed(feedPayload());
  (document.querySelector('.post-card [data-act="select"]') as HTMLInputElement).click();
  // A refresh replaces every card; reading checkboxes off the DOM would lose this.
  internals.renderPostsFeed(feedPayload());
  expect(internals.postsState.selected.has(1)).toBe(true);
  expect((document.querySelector('.post-card [data-act="select"]') as HTMLInputElement).checked)
    .toBe(true);
});

test('Clear empties the selection and hides the bar', () => {
  internals.renderPostsFeed(feedPayload());
  (document.querySelector('.post-card [data-act="select"]') as HTMLInputElement).click();
  (document.getElementById('postsSelectionClear') as HTMLButtonElement).click();
  expect(internals.postsState.selected.size).toBe(0);
  expect(document.getElementById('postsSelectionBar')!.hidden).toBe(true);
});

test('bulk queue posts the selected ids and the chosen reaction, and no comment', async () => {
  const calls = stubFetch();
  internals.initPosts();
  internals.renderPostsFeed(feedPayload());
  (document.querySelector('.post-card [data-act="select"]') as HTMLInputElement).click();
  (document.getElementById('postsBulkReaction') as HTMLSelectElement).value = 'insightful';
  (document.getElementById('postsBulkQueue') as HTMLButtonElement).click();

  await vi.waitFor(() => {
    const bulk = calls.find((c) => c.url.includes('/api/posts/engage'));
    expect(bulk).toBeTruthy();
    expect(bulk!.method).toBe('POST');
    expect(bulk!.body).toEqual({ post_ids: [1], reaction: 'insightful' });
    // The bulk payload must never carry a comment: identical text on several posts is a spam
    // pattern under the operator's own name.
    expect(Object.keys(bulk!.body as object)).not.toContain('comment');
  });
});

test('bulk queue does nothing when nothing is selected', async () => {
  const calls = stubFetch();
  internals.initPosts();
  internals.renderPostsFeed(feedPayload());
  (document.getElementById('postsBulkQueue') as HTMLButtonElement).click();
  await new Promise((r) => setTimeout(r, 5));
  expect(calls.filter((c) => c.url.includes('/api/posts/engage'))).toHaveLength(0);
});

test('per-post Queue sends the card reaction and the comment when one was typed', async () => {
  const calls = stubFetch();
  internals.initPosts();
  internals.renderPostsFeed(feedPayload());
  const card = document.querySelector('.post-card') as HTMLElement;
  (card.querySelector('[data-act="reaction"]') as HTMLSelectElement).value = 'celebrate';
  (card.querySelector('[data-act="comment-toggle"]') as HTMLButtonElement).click();
  const box = card.querySelector('[data-act="comment"]') as HTMLTextAreaElement;
  expect(box.hidden).toBe(false);
  box.value = 'Congrats!';
  (card.querySelector('[data-act="queue"]') as HTMLButtonElement).click();

  await vi.waitFor(() => {
    const one = calls.find((c) => c.url === '/api/posts/1/engage');
    expect(one).toBeTruthy();
    expect(one!.body).toEqual({ reaction: 'celebrate', comment: 'Congrats!' });
  });
});

test('a per-post Queue with no comment omits the field entirely', async () => {
  const calls = stubFetch();
  internals.initPosts();
  internals.renderPostsFeed(feedPayload());
  const card = document.querySelector('.post-card') as HTMLElement;
  (card.querySelector('[data-act="queue"]') as HTMLButtonElement).click();
  await vi.waitFor(() => {
    const one = calls.find((c) => c.url === '/api/posts/1/engage');
    expect(one!.body).toEqual({ reaction: 'like' });
  });
});

test('Show more unclamps the body', () => {
  internals.renderPostsFeed(feedPayload());
  const card = document.querySelector('.post-card') as HTMLElement;
  const body = card.querySelector('.post-body')!;
  expect(body.classList.contains('is-clamped')).toBe(true);
  (card.querySelector('[data-act="expand"]') as HTMLButtonElement).click();
  expect(body.classList.contains('is-clamped')).toBe(false);
});

test('the tracking table lists profiles with a Remove button', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, status: 200,
    json: async () => ({
      tracked: [{ id: 3, profile_url: 'https://www.linkedin.com/in/dana',
        full_name: 'Dana Reingold', post_count: 12, last_swept_at: '2026-08-04T09:00:00.000Z',
        last_sweep_error: null }],
      cap: 200, swept_at: '2026-08-04T09:00:00.000Z',
    }),
  } as Response)));
  await internals.refreshTracked();
  const rows = document.querySelectorAll('#postsTrackedRows tr');
  expect(rows).toHaveLength(1);
  expect(rows[0].textContent).toContain('Dana Reingold');
  expect(rows[0].querySelector('[data-act="untrack"]')).not.toBeNull();
});

test('a per-profile sweep error is surfaced in the tracking table', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, status: 200,
    json: async () => ({
      tracked: [{ id: 3, profile_url: 'https://www.linkedin.com/in/dana', full_name: null,
        post_count: 0, last_swept_at: null, last_sweep_error: 'Apify run FAILED' }],
      cap: 200, swept_at: null,
    }),
  } as Response)));
  await internals.refreshTracked();
  expect(document.querySelector('#postsTrackedRows .post-error')!.textContent)
    .toContain('Apify run FAILED');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/web/posts-feed.test.ts -t "bulk bar stays hidden"`
Expected: FAIL — the bar stays hidden because `renderPostsSelection` is still the no-op.

- [ ] **Step 3: Replace the `renderPostsSelection` no-op in `src/web/posts.js`**

```js
/** Show the bulk bar only while something is selected, and keep its count honest. */
function renderPostsSelection() {
  const bar = $('#postsSelectionBar');
  const count = $('#postsSelectionCount');
  const n = postsState.selected.size;
  if (count) count.textContent = `${n} selected`;
  if (bar) bar.hidden = n === 0;
  for (const card of document.querySelectorAll('.post-card')) {
    const on = postsState.selected.has(Number(card.dataset.postId));
    card.classList.toggle('is-selected', on);
    const box = card.querySelector('[data-act="select"]');
    if (box) box.checked = on;
  }
}
```

- [ ] **Step 4: Replace the `refreshTracked` no-op**

```js
/** The tracking manager's table. */
async function refreshTracked() {
  const body = $('#postsTrackedRows');
  if (!body) return;
  const payload = await api('/api/tracked-profiles');
  const rows = Array.isArray(payload && payload.tracked) ? payload.tracked : [];
  body.replaceChildren();
  for (const t of rows) {
    const tr = el('tr', {});
    tr.dataset.trackedId = String(t.id);

    const who = el('td', {});
    who.appendChild(el('div', {}, t.full_name || t.profile_url));
    if (t.full_name) who.appendChild(el('div', { class: 'post-meta' }, t.profile_url));
    if (t.last_sweep_error) {
      who.appendChild(el('div', { class: 'post-error' }, t.last_sweep_error));
    }
    tr.appendChild(who);

    tr.appendChild(el('td', {}, String(t.post_count ?? 0)));
    tr.appendChild(el('td', {}, t.last_swept_at ? postAge(t.last_swept_at) : 'never'));

    const actions = el('td', {});
    const remove = el('button', { class: 'btn btn-ghost', type: 'button' }, 'Remove');
    remove.dataset.act = 'untrack';
    actions.appendChild(remove);
    tr.appendChild(actions);

    body.appendChild(tr);
  }
  const cap = $('#postsTrackCount');
  if (cap) cap.textContent = `${rows.length} of ${payload.cap ?? 0} tracked`;
}
```

- [ ] **Step 5: Add the event wiring to `initPosts`**

Add inside `initPosts`, before the closing brace:

```js
  /* One delegated listener on the feed rather than per-card handlers: a re-render replaces
     every card, and re-binding handlers each time is how listeners leak. */
  $('#postsFeed')?.addEventListener('click', (ev) => {
    const target = ev.target;
    const act = target && target.dataset ? target.dataset.act : null;
    if (!act) return;
    const card = target.closest('.post-card');
    if (!card) return;
    const id = Number(card.dataset.postId);

    if (act === 'select') {
      if (target.checked) postsState.selected.add(id); else postsState.selected.delete(id);
      renderPostsSelection();
      return;
    }
    if (act === 'expand') {
      const body = card.querySelector('.post-body');
      const clamped = body.classList.toggle('is-clamped');
      target.textContent = clamped ? 'Show more' : 'Show less';
      return;
    }
    if (act === 'comment-toggle') {
      const box = card.querySelector('[data-act="comment"]');
      box.hidden = !box.hidden;
      if (!box.hidden) box.focus();
      return;
    }
    if (act === 'queue') void queuePost(card, id, target);
  });

  $('#postsSelectionClear')?.addEventListener('click', () => {
    postsState.selected.clear();
    renderPostsSelection();
  });

  $('#postsBulkQueue')?.addEventListener('click', () => { void bulkQueue(); });

  $('#postsTrackAdd')?.addEventListener('click', () => { void addTracked(); });

  $('#postsTrackedRows')?.addEventListener('click', (ev) => {
    if (ev.target?.dataset?.act !== 'untrack') return;
    const id = Number(ev.target.closest('tr').dataset.trackedId);
    void untrack(id);
  });

  $('#postsSweepNow')?.addEventListener('click', () => { void sweepNow(); });
```

- [ ] **Step 6: Add the action functions**

Append to `src/web/posts.js`:

```js
/** Queue one post. `comment` is omitted entirely when empty, never sent as ''. */
async function queuePost(card, id, button) {
  const reaction = card.querySelector('[data-act="reaction"]')?.value || 'like';
  const box = card.querySelector('[data-act="comment"]');
  const comment = box && !box.hidden ? box.value.trim() : '';
  const payload = comment === '' ? { reaction } : { reaction, comment };
  if (button) button.disabled = true;
  try {
    await api(`/api/posts/${id}/engage`, { method: 'POST', body: payload });
    await refreshPosts(false);
  } finally {
    if (button) button.disabled = false;
  }
}

/**
 * Bulk: one reaction across the selection. No comment parameter exists here by design —
 * see POST /api/posts/engage.
 */
async function bulkQueue() {
  const ids = [...postsState.selected];
  if (ids.length === 0) return;
  const reaction = $('#postsBulkReaction')?.value || 'like';
  const btn = $('#postsBulkQueue');
  if (btn) btn.disabled = true;
  try {
    const res = await api('/api/posts/engage', { method: 'POST', body: { post_ids: ids, reaction } });
    postsState.selected.clear();
    if (res && Array.isArray(res.rejected) && res.rejected.length > 0) {
      // Named rather than counted: "3 of 5 queued" leaves the operator guessing which two.
      toast(`Queued ${res.added}. ${res.rejected.length} skipped: ${res.rejected[0].message}`);
    } else if (res) {
      toast(`Queued ${res.added} ${res.added === 1 ? 'reaction' : 'reactions'}.`);
    }
    await refreshPosts(false);
  } finally {
    if (btn) btn.disabled = false;
  }
}

/** Add whatever is in the paste box to the tracked set. */
async function addTracked() {
  const area = $('#postsTrackText');
  const text = area ? area.value.trim() : '';
  if (text === '') return;
  const res = await api('/api/tracked-profiles', { method: 'POST', body: { text } });
  if (area) area.value = '';
  const rejects = Array.isArray(res?.rejected) ? res.rejected : [];
  toast(rejects.length === 0
    ? `Now tracking ${res.added} ${res.added === 1 ? 'profile' : 'profiles'}.`
    : `Tracking ${res.added}. ${rejects.length} skipped: ${rejects[0].message}`);
  await refreshTracked();
  await refreshPosts(false);
}

async function untrack(id) {
  await api(`/api/tracked-profiles/${id}`, { method: 'DELETE' });
  await refreshTracked();
  await refreshPosts(false);
}

/**
 * Manual sweep. Long on purpose — it returns only after the actor run finishes, so the button
 * is disabled for the duration rather than inviting a second click that would bill again.
 */
async function sweepNow() {
  const btn = $('#postsSweepNow');
  if (btn) { btn.disabled = true; btn.textContent = 'Sweeping…'; }
  try {
    const res = await api('/api/posts/sweep-now', { method: 'POST', body: {} });
    toast(res && typeof res.postsAdded === 'number'
      ? `Swept ${res.profilesSwept} profiles, ${res.postsAdded} new posts.`
      : 'Sweep finished.');
    await refreshPosts(false);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Sweep now'; }
  }
}
```

`api()` and `toast()` are `app.js` helpers. Check their real signatures before running — this
plan assumes `api(url, { method, body })` with `body` as an object that `api` serializes, and
`toast(message)`. If `api` expects a pre-stringified body or `toast` is named differently, match
the existing calls in `app.js` rather than adding a wrapper.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run tests/web/posts-feed.test.ts`
Expected: PASS (21 tests).

Run: `npm test`
Expected: full suite passes.

- [ ] **Step 8: Commit**

```bash
git add src/web/posts.js tests/web/posts-feed.test.ts
git commit -m "feat(posts): selection, bulk reaction, per-post engage and the tracking manager"
```

---

### Task 14: The Connections "Track posts" button

**Files:**
- Modify: `src/web/index.html`
- Modify: `src/web/app.js`
- Test: `tests/web/posts-feed.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/web/posts-feed.test.ts`:

```ts
test('Track posts sends the selected connection URLs to the tracking endpoint', async () => {
  const calls = stubFetch({ added: 2, ids: [1, 2], rejected: [] });
  internals.initSearch();

  // `selected` is app.js's module-level Set of profile URLs (app.js:1875) — the SAME store
  // "Invite to event" and "Add to message campaign" already read. Seeded directly rather than
  // through a second selection mechanism.
  const urls = ['https://www.linkedin.com/in/dana', 'https://www.linkedin.com/in/marcus'];
  internals.searchSelection().clear();
  for (const u of urls) internals.searchSelection().add(u);

  (document.getElementById('selectionTrack') as HTMLButtonElement).click();
  await vi.waitFor(() => {
    const call = calls.find((c) => c.url === '/api/tracked-profiles');
    expect(call).toBeTruthy();
    expect(call!.method).toBe('POST');
    expect(call!.body).toEqual({ profile_urls: urls });
  });
});
```

Add the accessor to `AppInternals` in `tests/web/helpers/load-app.ts`:

```ts
  /** app.js's module-level `selected` Set of profile URLs (app.js:1875). */
  searchSelection: () => Set<string>;
```

and expose it from `app.js` the same way the harness already reaches its other internals — a
one-line `function searchSelection() { return selected; }`. Do **not** introduce a second
selection store; `selected` is the one the other two buttons use.

- [ ] **Step 2: Add the button**

In `src/web/index.html`, inside the Connections `.selection-actions` div, add before
`selectionAdd`:

```html
          <button class="btn btn-ghost" id="selectionTrack" type="button">Track posts</button>
```

- [ ] **Step 3: Wire it in `app.js`**

Next to the existing `#selectionAdd` / `#selectionEvent` handlers in `initSearch`:

```js
  $('#selectionTrack')?.addEventListener('click', async (ev) => {
    // `selected` is the module-level Set the other two buttons already read (app.js:1875,
    // spread the same way at app.js:2106). No second selection store.
    const urls = [...selected];
    if (urls.length === 0) return;
    const btn = ev.currentTarget;
    btn.disabled = true;
    try {
      // Tracking is not a send: it queues nothing in front of anyone, it only decides whose
      // posts get scraped. So no confirmation dialog, unlike "Add to message campaign".
      const res = await api('/api/tracked-profiles', { method: 'POST', body: { profile_urls: urls } });
      const rejects = Array.isArray(res?.rejected) ? res.rejected : [];
      toast(rejects.length === 0
        ? `Now tracking posts for ${res.added} ${res.added === 1 ? 'person' : 'people'}.`
        : `Tracking ${res.added}. ${rejects.length} skipped: ${rejects[0].message}`);
    } finally {
      btn.disabled = false;
    }
  });
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/web/posts-feed.test.ts`
Expected: PASS (22 tests).

Run: `npm test`
Expected: full suite passes, including `tests/web/search-to-campaign.test.ts` — a third button
in that bar must not disturb the existing two.

- [ ] **Step 5: Commit**

```bash
git add src/web/index.html src/web/app.js tests/web/posts-feed.test.ts
git commit -m "feat(posts): Track posts button on the Connections selection bar"
```

---

### Task 15: Documentation

**Files:**
- Modify: `API.md`, `README.md`, `RUNBOOK.md`

No test. The Docs tab renders these files, so a broken table shows up there.

- [ ] **Step 1: Document the routes in `API.md`**

Add a `## Posts` section after `## Post engagements`, covering:

- The model: `tracked_profiles` (soft-deleted, cap 200) and `posts` (URN-keyed, `INSERT OR IGNORE`).
- All seven endpoints with a `curl` example each, mirroring the existing sections' style.
- The three reject reasons for `POST /api/tracked-profiles` in a table (`invalid_url`,
  `already_tracked`, `cap_reached`), and the partial-cap-fill rule.
- The `filter` definitions, stated as the **partition** they are — every post is in exactly
  one chip, never none and never two:
  - `engaged` — the engagement has a `reacted_at`. This outranks status, because a reaction on
    LinkedIn is a fact and a status is only our bookkeeping about it.
  - `new` — no engagement at all, **or** an engagement that ended `failed`/`skipped` without
    reacting, so it can be retried from the feed.
  - `queued` — an engagement that has not reacted and is not `failed`/`skipped`. That includes
    `needs_attention`, because a human still has to act on it.

  Say explicitly that a post whose reaction landed but whose *comment* failed shows as
  `engaged`, not `new` — the reaction is already on LinkedIn, so the feed must not offer to
  queue it again (the enqueue would 409 on the duplicate URN). Fixing the comment is
  `POST /api/engagements/:id/retry`, which is reachable from the Attention list.
- That `POST /api/posts/engage` has **no** `comment` field, and why.
- That `sweep-now` is long and must not be retried, like `run-now`.
- That the sweep is gated by `paused` but **not** by the guardrail.

- [ ] **Step 2: Document the operator view in `RUNBOOK.md`**

Add a plain-language section. It must say, without jargon:

- What tracking is, and that adding someone costs a small amount per scraped post.
- That a newly-tracked person's feed starts nearly empty and fills as they post — there is no
  history import.
- That queueing from the feed does **not** send immediately: it joins the same paced queue as
  everything else, spaced out and capped.
- That comments go out under their own name and are capped far lower than reactions
  (10/day by default), which is why bulk only does reactions.
- That posts older than 30 days disappear unless engaged with.
- What the red "post sweeping is halted" banner means and what to do about it.

- [ ] **Step 3: Document the settings in `README.md`**

Add the four operator-facing settings (`posts_sweep_per_day`, `posts_max_per_sweep`,
`posts_retention_days`, `tracked_profile_cap`) to the settings table, and note that
`posts_sweep_batch_size` exists but is a safety valve rather than a dial.

State the cost model in one line: **billing is per post returned, so the sweep window is
derived from staleness (24h when fresh, a week when stale or new) — widening it re-bills posts
already stored.**

- [ ] **Step 4: Verify the Docs tab still renders**

Run: `npm test`
Expected: passes, including any docs test.

Start the app and open the Docs tab; confirm the new sections render and no table is broken.

- [ ] **Step 5: Commit**

```bash
git add API.md README.md RUNBOOK.md
git commit -m "docs: Posts feed endpoints, operator guide and settings"
```

---

## Final verification

- [ ] `npm test` — full suite green
- [ ] `npm run typecheck` — clean
- [ ] `npm start`, then in the dashboard:
  - [ ] Connections → search → select two people → **Track posts** → toast confirms
  - [ ] Posts tab → **Manage tracking** shows both, paste a third URL, Remove one
  - [ ] **Sweep now** → posts appear (needs a real Apify key; this is the one step that spends
        money, and it is the only way to confirm the actor contract end to end)
  - [ ] Queue a reaction on one post → its badge becomes `queued`, and the row appears on the
        Dashboard's engagement conveyor
  - [ ] Select three posts → bulk **Queue reaction** → all three move to `queued`
  - [ ] Chips **New** / **Queued** / **Engaged** filter correctly and their counts add up
- [ ] Confirm the first real sweep's cost against the Apify console, and compare it with the
      30-day readout on the Posts screen. This is spec Risk #1 — that `postedLimit` bills only
      for posts actually returned is inference from the pricing model, not a documented
      guarantee. If the bill is closer to `profiles × maxPosts × sweeps`, turn
      `posts_sweep_per_day` and `posts_max_per_sweep` down; both are settings, no code changes.
