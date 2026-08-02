# Post Engagements Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fourth pipeline to Relay — react to a LinkedIn post, optionally with a comment — enqueued over the HTTP API, paced and executed by the existing sender so it can never collide with connection requests, messages, reply checks, roster syncs or event-invite runs.

**Architecture:** A new `engagements` table (one row per post, keyed on the post URN) holds the work. It is deliberately NOT a `CampaignKind` — `profiles` is person-shaped. Scheduling reuses the existing planner via a new `planQueue` seam extracted from `planKind`; execution reuses the existing sender tick as a third pass after invites and messages. Pause, guardrail, working hours, browser mutex and event reservations are all inherited unchanged.

**Tech Stack:** TypeScript (ESM, `type: module`), Node 22 `node:sqlite` (`DatabaseSync`), Fastify 5, Playwright-core via cloakbrowser, Vitest 4. No ORM — hand-written SQL in repo classes.

**Spec:** `docs/superpowers/specs/2026-08-02-engagements-pipeline-design.md`

**Conventions this codebase enforces — read before starting:**
- Every boundary validates and never coerces an unknown value to a default. See `src/core/campaign-kind.ts` and its header comment for the canonical statement of why.
- New tables go in `src/db/schema.sql` under `CREATE TABLE IF NOT EXISTS` and need no migration. **New columns on existing tables need a guarded `ALTER` in `runMigrations`, one guard each.**
- Tests are Vitest, `:memory:` databases, no mocking framework — a hand-written `FakeDriver` in `src/browser/driver.ts`.
- Run the whole suite with `npm test`; typecheck with `npm run typecheck`.

---

## File Structure

**Created:**
| file | responsibility |
|---|---|
| `src/core/engagement-action.ts` | `REACTIONS`, `Reaction`, `isReaction`, `parseReaction`, `DEFAULT_REACTION` |
| `src/db/engagement-repo.ts` | `EngagementRepo` — all SQL for the `engagements` table |
| `src/browser/post-selectors.ts` | Selectors for the reaction bar, reaction flyout, comment box, posted comment |
| `tests/core/engagement-action.test.ts` | reaction parsing |
| `tests/db/engagements.test.ts` | repo behaviour |
| `tests/worker/plan-queue-regression.test.ts` | snapshot lock on invite/message planning across the refactor |
| `tests/worker/engagement-planning.test.ts` | engagement planning, comment budget, reservations |
| `tests/worker/sender-engagements.test.ts` | every driver result → status mapping; crash recovery |
| `tests/api/engagements.test.ts` | API validation matrix |
| `scripts/probe-post-engage.ts` | live DOM capture (not in the automated suite) |
| `scripts/verify-post-engage.ts` | one live engagement against the operator's own post |

**Modified:**
| file | change |
|---|---|
| `src/core/url.ts` | add `normalizePostUrl` |
| `src/core/caps.ts` | add `engagementCaps` |
| `src/core/message.ts` | add `MAX_COMMENT` |
| `src/db/schema.sql` | add `engagements` table + 4 settings columns |
| `src/db/database.ts` | 4 guarded settings `ALTER`s |
| `src/db/repositories.ts` | wire `EngagementRepo` into `Repos`; add settings columns to `SETTINGS_COLUMNS` |
| `src/types.ts` | `Engagement`, `EngagementStatus`, `EngagementSkipReason`, `EngagementResult`, `EngagementOutcome`, 2 `BrowserDriver` methods, `Settings` columns |
| `src/worker/scheduler-service.ts` | extract `planQueue`; add `planEngagements`, `engagementsCommittedToday`, `recoverOrphanedEngagements`; extend `requeueOverdue` / `resortSchedule` |
| `src/worker/sender.ts` | add the engagement pass |
| `src/worker/orchestrator.ts` | call `recoverOrphanedEngagements` at startup |
| `src/browser/driver.ts` | `FakeDriver.reactToPost` / `.commentOnPost` |
| `src/browser/linkedin-driver.ts` | real `reactToPost` / `commentOnPost` |
| `src/api/server.ts` | 5 engagement routes; settings keys; `/api/status` block; `/api/attention` discriminator |
| `src/web/app.js`, `src/web/index.html`, `src/web/styles.css` | read-only engagement card; attention list handles both sources |

---

## Task 1: Prior-art survey and live DOM probe

**No code ships in this task.** It produces findings that Task 12 depends on. The five non-`like` reactions sit behind a hover-driven flyout, which is the most fragile element in the feature — no selector may be written from memory.

**Files:**
- Create: `scripts/probe-post-engage.ts`
- Modify: `docs/superpowers/specs/2026-08-02-engagements-pipeline-design.md` (add a "Discovery findings" section)

- [ ] **Step 1: Survey prior art**

Search GitHub for actively-maintained LinkedIn browser-automation projects and read how they drive the reaction control. Look specifically for:
- hover versus click-and-hold to open the reaction flyout
- what they wait on after the hover (flyout visibility? a specific `aria` state?)
- how they re-locate the specific reaction button once the flyout is open
- how they verify the reaction took effect
- how they locate the comment box and confirm a comment posted

Write 5–10 bullet points of findings. Their selectors are mostly Selenium-era and rot fast — **copy the algorithm, never the selector**.

- [ ] **Step 2: Write the probe script**

Model it on the existing `scripts/probe-event.ts`. Read that file first for the session-attach boilerplate this repo uses. The probe must navigate to a post URL passed as `process.argv[2]` and dump:

```ts
// Required output, one section each:
// 1. outerHTML of the social action bar (the row holding Like / Comment / Repost / Send)
// 2. All attributes of the Like button, including every aria-* attribute
// 3. outerHTML of the reaction flyout AFTER hovering the Like button
// 4. For each of the six reactions: its accessible name and any stable data-* attribute
// 5. The comment box element and its attributes
// 6. outerHTML of the post container, listing every data-* attribute
//    (this is what decides whether the URN reconciliation in the spec is possible)
// 7. Whether the post exposes a canonical URN, and under which attribute name
```

- [ ] **Step 3: Run the probe against a real post**

```bash
npx tsx scripts/probe-post-engage.ts "https://www.linkedin.com/feed/update/urn:li:activity:<id>/"
```

The Relay server must NOT be running — `.linkedin-profile` is single-instance and a second Chromium cannot attach. Stop it gracefully first.

Run it against three posts: one from a 1st-degree connection, one from a company page, and one with commenting restricted.

- [ ] **Step 4: Record findings in the spec**

Add a `## Discovery findings (live-verified 2026-08-02)` section to the spec, mirroring the format of the `2026-07-28-message-campaigns-design.md` section of the same name. It must answer:
1. Exact selector for the Like button, using semantic/`aria` attributes only — never hashed class names.
2. How the flyout opens, and the exact selector for each of the six reactions.
3. How a placed reaction is detectable (which attribute flips).
4. Exact selector for the comment box and the submit control.
5. How a posted comment is confirmed present.
6. How a comments-disabled post differs structurally from a normal one.
7. **Whether the post container exposes a canonical URN.** If it does, note the attribute — Task 12 uses it to close the `activity` vs `ugcPost` gap. If it does not, state that plainly so the gap stays documented rather than silently assumed away.

- [ ] **Step 5: Commit**

```bash
git add scripts/probe-post-engage.ts docs/superpowers/specs/2026-08-02-engagements-pipeline-design.md
git commit -m "chore(engagements): probe the post reaction and comment DOM"
```

---

## Task 2: Post URL and URN normalization

**Files:**
- Modify: `src/core/url.ts`
- Test: `tests/core/url.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/core/url.test.ts`:

```ts
import { normalizePostUrl } from '../../src/core/url.js';

test('feed/update form: URN is taken straight from the path', () => {
  expect(normalizePostUrl('https://www.linkedin.com/feed/update/urn:li:activity:7123456789012345678/'))
    .toEqual({
      url: 'https://www.linkedin.com/feed/update/urn:li:activity:7123456789012345678/',
      urn: 'urn:li:activity:7123456789012345678',
    });
});

test('posts/<slug>-activity-<id> form: the id is rebuilt into an activity URN', () => {
  expect(normalizePostUrl('https://www.linkedin.com/posts/jane-doe_hiring-news-activity-7123456789012345678-AbCd'))
    .toEqual({
      url: 'https://www.linkedin.com/feed/update/urn:li:activity:7123456789012345678/',
      urn: 'urn:li:activity:7123456789012345678',
    });
});

test('updateId query parameter is URL-decoded', () => {
  expect(normalizePostUrl('https://www.linkedin.com/feed/?updateId=urn%3Ali%3Aactivity%3A7123456789012345678'))
    .toEqual({
      url: 'https://www.linkedin.com/feed/update/urn:li:activity:7123456789012345678/',
      urn: 'urn:li:activity:7123456789012345678',
    });
});

test('a bare URN is accepted as-is', () => {
  expect(normalizePostUrl('urn:li:activity:7123456789012345678')?.urn)
    .toBe('urn:li:activity:7123456789012345678');
});

test('the URN type is preserved, not assumed to be activity', () => {
  expect(normalizePostUrl('https://www.linkedin.com/feed/update/urn:li:ugcPost:7123456789012345678/')?.urn)
    .toBe('urn:li:ugcPost:7123456789012345678');
  expect(normalizePostUrl('https://www.linkedin.com/feed/update/urn:li:share:7123456789012345678/')?.urn)
    .toBe('urn:li:share:7123456789012345678');
});

test('ugcPost casing is canonicalized regardless of how it was written', () => {
  expect(normalizePostUrl('https://www.linkedin.com/feed/update/urn:li:ugcpost:712345678901234567/')?.urn)
    .toBe('urn:li:ugcPost:712345678901234567');
});

test('shortlinks are rejected — resolving one needs a network round-trip', () => {
  expect(normalizePostUrl('https://lnkd.in/abc123')).toBeNull();
});

test('a profile URL is not a post URL', () => {
  expect(normalizePostUrl('https://www.linkedin.com/in/jane-doe')).toBeNull();
});

test('garbage and empty input are rejected', () => {
  expect(normalizePostUrl('')).toBeNull();
  expect(normalizePostUrl('not a url')).toBeNull();
  expect(normalizePostUrl('https://example.com/feed/update/urn:li:activity:1/')).toBeNull();
});

test('a malformed percent-escape does not throw', () => {
  expect(() => normalizePostUrl('https://www.linkedin.com/feed/?updateId=%E0%A4%A')).not.toThrow();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run tests/core/url.test.ts
```

Expected: FAIL — `normalizePostUrl is not a function`.

- [ ] **Step 3: Implement**

Append to `src/core/url.ts`:

```ts
/** A post identified by both what we show and what we key on. */
export interface NormalizedPost {
  /** Canonical https://www.linkedin.com/feed/update/<urn>/ — display and navigation. */
  url: string;
  /** THE identity. See normalizePostUrl for why the URL cannot be. */
  urn: string;
}

const POST_URN_RE = /urn:li:(activity|ugcPost|share):(\d+)/i;

/** Decode percent-escapes, tolerating a malformed escape rather than throwing. */
function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

function buildPost(type: string, id: string): NormalizedPost {
  // LinkedIn writes ugcPost with a capital P; the other two are lowercase. Canonicalizing
  // here is what makes two spellings of the same URN dedupe against each other.
  const lower = type.toLowerCase();
  const canonical = lower === 'ugcpost' ? 'ugcPost' : lower;
  const urn = `urn:li:${canonical}:${id}`;
  return { url: `https://www.linkedin.com/feed/update/${urn}/`, urn };
}

/**
 * Resolve any LinkedIn post reference to its canonical URL and its URN.
 *
 * The URN — not the URL — is the identity. The same post is reachable as
 * /feed/update/urn:li:activity:…, /posts/<slug>-activity-…-<hash> and ?updateId=…, so
 * deduping on the URL would dedupe nothing.
 *
 * Pure string parsing: no network, no browser. That is why a shortened lnkd.in link is
 * REJECTED rather than followed — resolving one needs an HTTP redirect, and the enqueue
 * path must not make network calls. The caller is told to expand the link first.
 */
export function normalizePostUrl(raw: string): NormalizedPost | null {
  const s = (raw ?? '').trim();
  if (s === '') return null;
  if (/^https?:\/\/(www\.)?lnkd\.in\//i.test(s)) return null;

  const decoded = safeDecode(s);

  // A URN written out anywhere in the string: the /feed/update/ path, the ?updateId=
  // parameter once decoded, or a bare URN pasted on its own.
  const direct = decoded.match(POST_URN_RE);
  if (direct) return buildPost(direct[1], direct[2]);

  // The share-link form. The numeric id trails the slug after "-activity-".
  const posts = decoded.match(/linkedin\.com\/posts\/[^/?#]*-activity-(\d+)/i);
  if (posts) return buildPost('activity', posts[1]);

  return null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run tests/core/url.test.ts
```

Expected: PASS, all tests including the pre-existing profile-URL ones.

- [ ] **Step 5: Commit**

```bash
git add src/core/url.ts tests/core/url.test.ts
git commit -m "feat(engagements): resolve any LinkedIn post reference to its URN"
```

---

## Task 3: Reaction type and parser

**Files:**
- Create: `src/core/engagement-action.ts`
- Test: `tests/core/engagement-action.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/core/engagement-action.test.ts`:

```ts
import { test, expect } from 'vitest';
import {
  REACTIONS, DEFAULT_REACTION, isReaction, parseReaction,
} from '../../src/core/engagement-action.js';

test('the six LinkedIn reactions, and nothing else', () => {
  expect([...REACTIONS]).toEqual(['like', 'celebrate', 'support', 'love', 'insightful', 'funny']);
});

test('isReaction is a case-sensitive membership test — the DB stores lowercase', () => {
  expect(isReaction('insightful')).toBe(true);
  expect(isReaction('Insightful')).toBe(false);
  expect(isReaction('dislike')).toBe(false);
  expect(isReaction(7)).toBe(false);
  expect(isReaction(null)).toBe(false);
});

test('a valid reaction parses to itself', () => {
  expect(parseReaction('celebrate')).toEqual({ ok: true, reaction: 'celebrate' });
});

test('absent reports undefined and leaves the default to the call site', () => {
  expect(parseReaction(undefined)).toEqual({ ok: true, reaction: undefined });
  expect(DEFAULT_REACTION).toBe('like');
});

test('null is invalid, not absent — the caller chose to send it', () => {
  const r = parseReaction(null);
  expect(r.ok).toBe(false);
});

test('an unknown reaction is rejected by name', () => {
  const r = parseReaction('thumbsup');
  expect(r).toEqual({ ok: false, error: 'unknown reaction: thumbsup' });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/core/engagement-action.test.ts
```

Expected: FAIL — cannot resolve `../../src/core/engagement-action.js`.

- [ ] **Step 3: Implement**

Create `src/core/engagement-action.ts`:

```ts
/**
 * The reactions the engine can place on a post, and the one validator every boundary uses.
 *
 * `REACTIONS` is the single source of truth: `Reaction` is DERIVED from it, so the runtime
 * list and the compile-time type can never drift. Deliberately modelled on
 * `core/campaign-kind.ts` — same shape, same reason.
 *
 * ONE DIVERGENCE from parseKind, and it is intentional. There, absent is not a default,
 * because mis-defaulting a campaign kind sends an unsendable connection request. Here the
 * worst case is a `like` where the caller wanted an `insightful` — cosmetic and
 * retractable — so absent resolves to DEFAULT_REACTION at the call site.
 */
export const REACTIONS = ['like', 'celebrate', 'support', 'love', 'insightful', 'funny'] as const;

export type Reaction = typeof REACTIONS[number];

/** What an omitted reaction becomes. Applied by the caller, never inside parseReaction. */
export const DEFAULT_REACTION: Reaction = 'like';

/** Runtime membership test. Deliberately case-sensitive: the DB stores lowercase. */
export function isReaction(v: unknown): v is Reaction {
  return typeof v === 'string' && (REACTIONS as readonly string[]).includes(v);
}

export type ParsedReaction =
  | { ok: true; reaction: Reaction | undefined }
  | { ok: false; error: string };

/**
 * Parse a caller-supplied `reaction`.
 *
 *   absent (undefined) -> { ok: true, reaction: undefined }   (call site applies DEFAULT_REACTION)
 *   a valid reaction   -> { ok: true, reaction }
 *   anything else      -> { ok: false, error }
 *
 * `null` is invalid, not absent: the caller chose to send it.
 */
export function parseReaction(raw: unknown): ParsedReaction {
  if (raw === undefined) return { ok: true, reaction: undefined };
  if (isReaction(raw)) return { ok: true, reaction: raw };
  return { ok: false, error: `unknown reaction: ${String(raw)}` };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run tests/core/engagement-action.test.ts
```

Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/engagement-action.ts tests/core/engagement-action.test.ts
git commit -m "feat(engagements): add the reaction vocabulary and its boundary validator"
```

---

## Task 4: Schema, settings columns and migrations

**Files:**
- Modify: `src/db/schema.sql`, `src/db/database.ts`, `src/db/repositories.ts:16-28`, `src/types.ts`
- Test: `tests/db/database.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/db/database.test.ts`:

```ts
test('a fresh database has the engagements table with the expected shape', () => {
  const db = openDatabase(':memory:');
  const cols = (db.prepare('PRAGMA table_info(engagements)').all() as { name: string }[])
    .map((c) => c.name);
  expect(cols).toEqual(expect.arrayContaining([
    'id', 'post_url', 'post_urn', 'reaction', 'comment_text', 'status', 'attempts',
    'last_error', 'skip_reason', 'scheduled_for', 'reacted_at', 'commented_at',
    'priority', 'created_at',
  ]));
});

test('one engagement per post is a hard constraint', () => {
  const db = openDatabase(':memory:');
  const ins = "INSERT INTO engagements (post_url, post_urn, reaction) VALUES ('u', 'urn:li:activity:1', 'like')";
  db.exec(ins);
  expect(() => db.exec(ins)).toThrow();
});

test('the engage_* settings columns exist with their documented defaults', () => {
  const db = openDatabase(':memory:');
  const s = db.prepare('SELECT * FROM settings WHERE id = 1').get() as unknown as Record<string, number>;
  expect(s.engage_weekly_cap).toBe(500);
  expect(s.engage_batch_size).toBe(15);
  expect(s.engage_batches_per_day).toBe(6);
  expect(s.engage_comment_daily_cap).toBe(10);
});

test('a settings table predating the engage_* columns is migrated', () => {
  const db = openDatabase(':memory:');
  db.exec('ALTER TABLE settings DROP COLUMN engage_weekly_cap');
  db.exec('ALTER TABLE settings DROP COLUMN engage_comment_daily_cap');
  runMigrations(db);
  const s = db.prepare('SELECT * FROM settings WHERE id = 1').get() as unknown as Record<string, number>;
  expect(s.engage_weekly_cap).toBe(500);
  expect(s.engage_comment_daily_cap).toBe(10);
});

test('runMigrations is idempotent', () => {
  const db = openDatabase(':memory:');
  expect(() => { runMigrations(db); runMigrations(db); }).not.toThrow();
});
```

Ensure `runMigrations` is in the file's import from `../../src/db/database.js` — add it if it is not already there.

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/db/database.test.ts
```

Expected: FAIL — `PRAGMA table_info(engagements)` returns `[]`, so the `arrayContaining` assertion fails.

- [ ] **Step 3a: Add the table to `src/db/schema.sql`**

Append at the end of the file:

```sql
-- ============================================================================
-- Post engagements (2026-08-02). The fourth pipeline: react to a LinkedIn post,
-- optionally with a comment.
--
-- Deliberately NOT a CampaignKind. `profiles` is person-shaped — first_name,
-- accepted_at, thread_url, UNIQUE(profile_url, kind) — and a post is not a
-- person. Separate table; shared pause / guardrail / working-hours /
-- browser-mutex rails, and drained by the SAME sender tick as invites and
-- messages (unlike event invites, which need a reserved window of their own).
--
-- CAREFUL: CREATE TABLE IF NOT EXISTS back-fills the whole table on every
-- openDatabase, but it is a no-op once the table exists. A column added here
-- LATER is silently absent on existing databases and needs its own guarded
-- ALTER in runMigrations — the same trap documented for event_buckets.
-- ============================================================================
CREATE TABLE IF NOT EXISTS engagements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Canonical https://www.linkedin.com/feed/update/<urn>/ — display and navigation only.
  post_url TEXT NOT NULL,
  -- THE identity. The same post is reachable as /feed/update/, /posts/<slug>-activity-…
  -- and ?updateId=…, so deduping on post_url would dedupe nothing.
  post_urn TEXT NOT NULL UNIQUE,
  -- Always present. LinkedIn permits exactly one reaction per member per post, which is
  -- the same rule the UNIQUE above enforces.
  reaction TEXT NOT NULL,
  -- Optional. When set it is ALWAYS delivered alongside the reaction — there is no
  -- comment-only engagement.
  comment_text TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  -- not_found | unavailable | comments_disabled | dismissed
  skip_reason TEXT,
  scheduled_for TEXT,
  -- Partial progress, deliberately NOT one sent_at: the task does two things in sequence
  -- and a retry after a failed comment must not re-drive the reaction.
  reacted_at TEXT,
  commented_at TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_engagements_status ON engagements(status);
CREATE INDEX IF NOT EXISTS idx_engagements_reacted ON engagements(reacted_at);
```

- [ ] **Step 3b: Add the settings columns to `src/db/schema.sql`**

Inside the `CREATE TABLE IF NOT EXISTS settings (...)` block, immediately after the `event_shard_threshold` line, add a comma to that line and then:

```sql
  -- Post engagements. Own caps, with deliberately bigger batches than an invite: a
  -- reaction is a far cheaper action than a connection request. 15 x 6 = 90/day.
  engage_weekly_cap INTEGER NOT NULL DEFAULT 500,
  engage_batch_size INTEGER NOT NULL DEFAULT 15,
  engage_batches_per_day INTEGER NOT NULL DEFAULT 6,
  -- Comments are capped separately and far lower: 90 published comments a day under the
  -- operator's own name is a materially different risk from 90 likes.
  engage_comment_daily_cap INTEGER NOT NULL DEFAULT 10
```

- [ ] **Step 3c: Add the guarded migrations to `src/db/database.ts`**

In `runMigrations`, immediately before the `// profiles: kind/full_name/thread_url…` rebuild block at the end, add:

```ts
  // --- Post engagements (2026-08-02) ---
  // The engagements table is back-filled by schema.sql's CREATE TABLE IF NOT EXISTS.
  // Settings columns are not: one guard each, so an interruption between ALTERs cannot
  // permanently skip whichever did not run yet.
  if (cols.length > 0 && !cols.includes('engage_weekly_cap')) {
    db.exec('ALTER TABLE settings ADD COLUMN engage_weekly_cap INTEGER NOT NULL DEFAULT 500');
  }
  if (cols.length > 0 && !cols.includes('engage_batch_size')) {
    db.exec('ALTER TABLE settings ADD COLUMN engage_batch_size INTEGER NOT NULL DEFAULT 15');
  }
  if (cols.length > 0 && !cols.includes('engage_batches_per_day')) {
    db.exec('ALTER TABLE settings ADD COLUMN engage_batches_per_day INTEGER NOT NULL DEFAULT 6');
  }
  if (cols.length > 0 && !cols.includes('engage_comment_daily_cap')) {
    db.exec('ALTER TABLE settings ADD COLUMN engage_comment_daily_cap INTEGER NOT NULL DEFAULT 10');
  }
```

Note `cols` is the `settings` column snapshot already declared at the top of `runMigrations` — reuse it, do not re-read.

- [ ] **Step 3d: Add the types to `src/types.ts`**

Add the four fields to the `Settings` interface, after `event_shard_threshold`:

```ts
  engage_weekly_cap: number;
  engage_batch_size: number;
  engage_batches_per_day: number;
  engage_comment_daily_cap: number;
```

Then add the engagement types. Put them after the event-invite block:

```ts
// --- Post engagements -----------------------------------------------------------------

import type { Reaction } from './core/engagement-action.js';
export type { Reaction };

/** Its own union, NOT an alias of ProfileStatus: an engagement can never be accepted,
 *  replied or expired, and a shared type would invite code that pretends otherwise. */
export type EngagementStatus =
  | 'queued' | 'scheduled' | 'sending' | 'sent' | 'skipped' | 'failed' | 'needs_attention';

/** Why a skipped engagement was skipped (terminal — the engine never retries these). */
export type EngagementSkipReason =
  | 'not_found' | 'unavailable' | 'comments_disabled' | 'dismissed';

export interface Engagement {
  id: number;
  post_url: string;
  post_urn: string;
  reaction: Reaction;
  /** null for a reaction-only task. When set, always delivered WITH the reaction. */
  comment_text: string | null;
  status: EngagementStatus;
  attempts: number;
  last_error: string | null;
  skip_reason: EngagementSkipReason | null;
  scheduled_for: string | null;
  reacted_at: string | null;
  commented_at: string | null;
  priority: number;
  created_at: string;
}
```

Place the `import type { Reaction }` line at the TOP of `types.ts` alongside the existing `CampaignKind` import, not mid-file — ESM hoists it either way, but the file's convention is imports at the top.

- [ ] **Step 3e: Allow the new settings columns through `SettingsRepo.update`**

In `src/db/repositories.ts`, add to the `SETTINGS_COLUMNS` set (after the `event_*` entries):

```ts
  'engage_weekly_cap', 'engage_batch_size', 'engage_batches_per_day',
  'engage_comment_daily_cap',
```

- [ ] **Step 4: Run the tests and the typecheck**

```bash
npx vitest run tests/db/database.test.ts
```

Expected: PASS (5 new tests plus the pre-existing ones).

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.sql src/db/database.ts src/db/repositories.ts src/types.ts tests/db/database.test.ts
git commit -m "feat(engagements): add the engagements table and its pacing settings"
```

---

## Task 5: EngagementRepo

**Files:**
- Create: `src/db/engagement-repo.ts`
- Modify: `src/db/repositories.ts` (wire into `Repos`)
- Test: `tests/db/engagements.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/db/engagements.test.ts`:

```ts
import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';

let repos: Repos;
beforeEach(() => { repos = new Repos(openDatabase(':memory:')); });

const URN = 'urn:li:activity:7123456789012345678';
const URL = `https://www.linkedin.com/feed/update/${URN}/`;

test('add stores a reaction-only task in the queued state', () => {
  const e = repos.engagements.add(URL, URN, 'insightful', null);
  expect(e.post_urn).toBe(URN);
  expect(e.reaction).toBe('insightful');
  expect(e.comment_text).toBeNull();
  expect(e.status).toBe('queued');
  expect(e.attempts).toBe(0);
  expect(e.reacted_at).toBeNull();
  expect(e.commented_at).toBeNull();
});

test('add is idempotent per post — one engagement per post', () => {
  const first = repos.engagements.add(URL, URN, 'like', null);
  const second = repos.engagements.add(URL, URN, 'celebrate', 'different text');
  expect(second.id).toBe(first.id);
  expect(second.reaction).toBe('like'); // the original wins; the API 409s before reaching here
  expect(repos.engagements.all()).toHaveLength(1);
});

test('findByUrn locates the row the API needs for its duplicate check', () => {
  const e = repos.engagements.add(URL, URN, 'like', null);
  expect(repos.engagements.findByUrn(URN)?.id).toBe(e.id);
  expect(repos.engagements.findByUrn('urn:li:activity:9')).toBeUndefined();
});

test('setStatus rejects a column that is not on the allow-list', () => {
  const e = repos.engagements.add(URL, URN, 'like', null);
  expect(() => repos.engagements.setStatus(e.id, 'sent', { post_urn: 'x' } as never))
    .toThrow(/Illegal engagement column/);
});

test('setScheduled moves a row to scheduled with its slot', () => {
  const e = repos.engagements.add(URL, URN, 'like', null);
  repos.engagements.setScheduled(e.id, '2026-08-02T10:00:00.000Z');
  const row = repos.engagements.findById(e.id)!;
  expect(row.status).toBe('scheduled');
  expect(row.scheduled_for).toBe('2026-08-02T10:00:00.000Z');
});

test('queuedByPriority orders by priority then id', () => {
  const a = repos.engagements.add('u1', 'urn:li:activity:1', 'like', null);
  const b = repos.engagements.add('u2', 'urn:li:activity:2', 'like', null);
  repos.engagements.setStatus(b.id, 'queued', {});
  repos.db.prepare('UPDATE engagements SET priority = -1 WHERE id = ?').run(b.id);
  expect(repos.engagements.queuedByPriority().map((e) => e.id)).toEqual([b.id, a.id]);
});

test('countReactedSince counts the weekly cap unit, not rows', () => {
  const a = repos.engagements.add('u1', 'urn:li:activity:1', 'like', null);
  const b = repos.engagements.add('u2', 'urn:li:activity:2', 'like', null);
  repos.engagements.setStatus(a.id, 'sent', { reacted_at: '2026-08-02T09:00:00.000Z' });
  repos.engagements.setStatus(b.id, 'sent', { reacted_at: '2026-07-01T09:00:00.000Z' });
  expect(repos.engagements.countReactedSince('2026-08-01T00:00:00.000Z')).toBe(1);
});

test('countCommentedSince counts only rows that actually commented', () => {
  const a = repos.engagements.add('u1', 'urn:li:activity:1', 'like', 'hello');
  const b = repos.engagements.add('u2', 'urn:li:activity:2', 'like', 'hello');
  repos.engagements.setStatus(a.id, 'sent', {
    reacted_at: '2026-08-02T09:00:00.000Z', commented_at: '2026-08-02T09:00:05.000Z',
  });
  repos.engagements.setStatus(b.id, 'sent', { reacted_at: '2026-08-02T09:00:00.000Z' });
  expect(repos.engagements.countCommentedSince('2026-08-02T00:00:00.000Z')).toBe(1);
});

test('reconcileUrn rewrites a row to the URN the driver actually observed', () => {
  const e = repos.engagements.add(URL, 'urn:li:share:7489401095899770880', 'like', null);
  expect(repos.engagements.reconcileUrn(e.id, 'urn:li:activity:7489401096851906561'))
    .toBe('reconciled');
  expect(repos.engagements.findById(e.id)!.post_urn).toBe('urn:li:activity:7489401096851906561');
});

test('reconcileUrn reports a duplicate rather than colliding with an existing row', () => {
  const canonical = repos.engagements.add('u1', 'urn:li:activity:7489401096851906561', 'like', null);
  const dupe = repos.engagements.add('u2', 'urn:li:share:7489401095899770880', 'like', null);
  expect(repos.engagements.reconcileUrn(dupe.id, canonical.post_urn)).toBe('duplicate');
  // The row is NOT rewritten — the caller retires it instead of engaging twice.
  expect(repos.engagements.findById(dupe.id)!.post_urn).toBe('urn:li:share:7489401095899770880');
});

test('reconcileUrn is a no-op when the URN already matches', () => {
  const e = repos.engagements.add(URL, URN, 'like', null);
  expect(repos.engagements.reconcileUrn(e.id, URN)).toBe('unchanged');
});

test('countsByStatus reports every status the dashboard renders', () => {
  const a = repos.engagements.add('u1', 'urn:li:activity:1', 'like', null);
  repos.engagements.add('u2', 'urn:li:activity:2', 'like', null);
  repos.engagements.setStatus(a.id, 'failed', { last_error: 'boom' });
  expect(repos.engagements.countsByStatus()).toMatchObject({ queued: 1, failed: 1 });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/db/engagements.test.ts
```

Expected: FAIL — `repos.engagements is undefined`.

- [ ] **Step 3a: Create `src/db/engagement-repo.ts`**

```ts
import type { DB } from './database.js';
import type { Engagement, EngagementStatus, Reaction } from '../types.js';

/**
 * Columns `setStatus` may write. Mirrors PROFILE_COLUMNS in repositories.ts and exists for
 * the same reason: setStatus takes a caller-supplied object, so without an allow-list a
 * typo'd or hostile key becomes SQL.
 *
 * Note what is ABSENT: post_url, post_urn and reaction are immutable once the row exists.
 * The URN is the identity, and rewriting a row's reaction after the fact would silently
 * change what a queued task does.
 */
const ENGAGEMENT_COLUMNS = new Set([
  'attempts', 'last_error', 'skip_reason', 'scheduled_for', 'reacted_at', 'commented_at',
]);

export class EngagementRepo {
  constructor(private db: DB) {}

  /**
   * Insert, or return the row that already exists for this post.
   *
   * Idempotent rather than throwing, mirroring ProfileRepo.add. The API checks for a
   * duplicate first and returns a 409 naming the existing row — this is the backstop for
   * any path that does not, and a silent no-op is better than a 500 from a raw SQLite
   * constraint violation.
   */
  add(postUrl: string, postUrn: string, reaction: Reaction, commentText: string | null): Engagement {
    const existing = this.findByUrn(postUrn);
    if (existing) return existing;
    this.db.prepare(
      'INSERT INTO engagements (post_url, post_urn, reaction, comment_text) VALUES (?, ?, ?, ?)',
    ).run(postUrl, postUrn, reaction, commentText);
    return this.findByUrn(postUrn)!;
  }

  findById(id: number): Engagement | undefined {
    return this.db.prepare('SELECT * FROM engagements WHERE id = ?')
      .get(id) as unknown as Engagement | undefined;
  }

  findByUrn(urn: string): Engagement | undefined {
    return this.db.prepare('SELECT * FROM engagements WHERE post_urn = ?')
      .get(urn) as unknown as Engagement | undefined;
  }

  all(): Engagement[] {
    return this.db.prepare('SELECT * FROM engagements ORDER BY id').all() as unknown as Engagement[];
  }

  byStatus(status: EngagementStatus): Engagement[] {
    return this.db.prepare('SELECT * FROM engagements WHERE status = ? ORDER BY id')
      .all(status) as unknown as Engagement[];
  }

  queuedByPriority(): Engagement[] {
    return this.db.prepare("SELECT * FROM engagements WHERE status='queued' ORDER BY priority, id")
      .all() as unknown as Engagement[];
  }

  setStatus(id: number, status: EngagementStatus, fields: Partial<Engagement> = {}): void {
    const sets: string[] = ['status = ?'];
    const vals: unknown[] = [status];
    for (const [k, v] of Object.entries(fields)) {
      if (!ENGAGEMENT_COLUMNS.has(k)) throw new Error(`Illegal engagement column: ${k}`);
      sets.push(`${k} = ?`); vals.push(v);
    }
    vals.push(id);
    this.db.prepare(`UPDATE engagements SET ${sets.join(', ')} WHERE id = ?`).run(...(vals as any[]));
  }

  setScheduled(id: number, iso: string): void {
    this.db.prepare("UPDATE engagements SET status='scheduled', scheduled_for=? WHERE id=?")
      .run(iso, id);
  }

  /** The weekly-cap unit. The reaction always happens, so it is what a spent slot means. */
  countReactedSince(iso: string): number {
    return (this.db.prepare('SELECT COUNT(*) c FROM engagements WHERE reacted_at >= ?')
      .get(iso) as unknown as { c: number }).c;
  }

  /** Drives engage_comment_daily_cap. */
  countCommentedSince(iso: string): number {
    return (this.db.prepare('SELECT COUNT(*) c FROM engagements WHERE commented_at >= ?')
      .get(iso) as unknown as { c: number }).c;
  }

  /**
   * Rewrite a row's URN to the canonical one the driver read off the live post.
   *
   * The URN parsed from a URL is only a best-effort identity: LinkedIn's share-link slug
   * carries a DIFFERENT number from the post's own `data-urn` (observed 2026-08-02 —
   * slug 7489401095899770880 vs data-urn urn:li:activity:7489401096851906561 for one post).
   * So two URL forms of one post enqueue as two rows, and this is how that self-heals on
   * first execution.
   *
   * Returns 'reconciled' when the row was updated, 'duplicate' when the canonical URN is
   * already held by ANOTHER row — in which case this row is the redundant one and the
   * caller must retire it rather than engaging twice with the same post.
   */
  reconcileUrn(id: number, canonicalUrn: string): 'unchanged' | 'reconciled' | 'duplicate' {
    const row = this.findById(id);
    if (!row || row.post_urn === canonicalUrn) return 'unchanged';
    const holder = this.findByUrn(canonicalUrn);
    if (holder && holder.id !== id) return 'duplicate';
    this.db.prepare('UPDATE engagements SET post_urn = ? WHERE id = ?').run(canonicalUrn, id);
    return 'reconciled';
  }

  countsByStatus(): Record<string, number> {
    const rows = this.db.prepare('SELECT status, COUNT(*) c FROM engagements GROUP BY status')
      .all() as unknown as { status: string; c: number }[];
    const out: Record<string, number> = {};
    for (const r of rows) out[r.status] = r.c;
    return out;
  }
}
```

- [ ] **Step 3b: Wire it into `Repos`**

In `src/db/repositories.ts`, add the import beside the event-repos import:

```ts
import { EngagementRepo } from './engagement-repo.js';
```

Add the field to the `Repos` class, after `eventRuns`:

```ts
  /** Post engagements — the fourth pipeline. */
  engagements: EngagementRepo;
```

And in the constructor, after `this.eventRuns = ...`:

```ts
    this.engagements = new EngagementRepo(db);
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run tests/db/engagements.test.ts && npm run typecheck
```

Expected: PASS (9 tests), no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/db/engagement-repo.ts src/db/repositories.ts tests/db/engagements.test.ts
git commit -m "feat(engagements): add the engagement repository"
```

---

## Task 6: engagementCaps

**Files:**
- Modify: `src/core/caps.ts`
- Test: `tests/core/caps.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/core/caps.test.ts`:

```ts
import { engagementCaps } from '../../src/core/caps.js';

test('engagementCaps reads the engage_* columns, not the invite ones', () => {
  const s = {
    weekly_cap: 100, batch_size: 5, batches_per_day: 4,
    engage_weekly_cap: 500, engage_batch_size: 15, engage_batches_per_day: 6,
  } as never;
  expect(engagementCaps(s)).toEqual({ weeklyCap: 500, batchSize: 15, batchesPerDay: 6 });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/core/caps.test.ts
```

Expected: FAIL — `engagementCaps is not a function`.

- [ ] **Step 3: Implement**

Append to `src/core/caps.ts`:

```ts
/**
 * The pacing numbers for the engagement pipeline.
 *
 * A sibling of capsFor rather than a branch inside it: capsFor is typed on CampaignKind,
 * and engagements are deliberately not a CampaignKind. Returning the same KindCaps shape is
 * what lets both feed the one shared planner.
 */
export function engagementCaps(s: Settings): KindCaps {
  return {
    weeklyCap: s.engage_weekly_cap,
    batchSize: s.engage_batch_size,
    batchesPerDay: s.engage_batches_per_day,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run tests/core/caps.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/caps.ts tests/core/caps.test.ts
git commit -m "feat(engagements): add engagementCaps alongside capsFor"
```

---

## Task 7: Extract planQueue from planKind

This refactors live scheduling code that two pipelines already depend on. The regression snapshot is written and committed **before** the refactor so it captures current behaviour, then must survive it unchanged.

**Files:**
- Modify: `src/worker/scheduler-service.ts:72-131`
- Test: `tests/worker/plan-queue-regression.test.ts` (create)

- [ ] **Step 1: Write the regression snapshot against the CURRENT code**

Create `tests/worker/plan-queue-regression.test.ts`:

```ts
/**
 * Behavioural lock on the planner across the planQueue extraction.
 *
 * Written and committed BEFORE the refactor so the snapshot records how planKind behaves
 * today. If extracting planQueue changes a single slot assignment — including the order in
 * which rng values are consumed across kinds — these snapshots fail.
 */
import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { planAndAssignToday } from '../../src/worker/scheduler-service.js';

let repos: Repos;
beforeEach(() => { repos = new Repos(openDatabase(':memory:')); });

/** A fixed, repeating rng so the plan is fully deterministic. */
function seededRng(): () => number {
  const seq = [0.11, 0.37, 0.52, 0.68, 0.83, 0.05, 0.94, 0.21];
  let i = 0;
  return () => seq[i++ % seq.length];
}

function plan() {
  planAndAssignToday(repos, new Date('2026-08-03T08:00:00'), seededRng());
  return repos.profiles.all()
    .filter((p) => p.status === 'scheduled')
    .map((p) => `${p.kind} ${p.profile_url} @ ${p.scheduled_for}`)
    .sort();
}

test('invite-only plan is unchanged', () => {
  const c = repos.cohorts.create('inv', 'hi', true, 'invite');
  for (let i = 0; i < 9; i++) repos.profiles.add(c.id, `https://www.linkedin.com/in/i${i}`, null, 'invite');
  expect(plan()).toMatchSnapshot();
});

test('message-only plan is unchanged', () => {
  const c = repos.cohorts.create('msg', 'hi', false, 'message');
  for (let i = 0; i < 9; i++) repos.profiles.add(c.id, `https://www.linkedin.com/in/m${i}`, null, 'message');
  expect(plan()).toMatchSnapshot();
});

test('mixed plan is unchanged — this is the rng-ordering guard', () => {
  const inv = repos.cohorts.create('inv', 'hi', true, 'invite');
  const msg = repos.cohorts.create('msg', 'hi', false, 'message');
  for (let i = 0; i < 7; i++) repos.profiles.add(inv.id, `https://www.linkedin.com/in/i${i}`, null, 'invite');
  for (let i = 0; i < 7; i++) repos.profiles.add(msg.id, `https://www.linkedin.com/in/m${i}`, null, 'message');
  expect(plan()).toMatchSnapshot();
});

test('an empty invite queue costs zero rng draws, so the message plan is unshifted', () => {
  const msg = repos.cohorts.create('msg', 'hi', false, 'message');
  for (let i = 0; i < 7; i++) repos.profiles.add(msg.id, `https://www.linkedin.com/in/m${i}`, null, 'message');
  expect(plan()).toMatchSnapshot();
});
```

- [ ] **Step 2: Generate and commit the snapshot BEFORE refactoring**

```bash
npx vitest run tests/worker/plan-queue-regression.test.ts
```

Expected: PASS, and vitest writes `tests/worker/__snapshots__/plan-queue-regression.test.ts.snap`.

Open the snapshot file and sanity-check it: every entry must have a non-null ISO timestamp inside the 08:00–20:00 local window. If any is `null` or out of window, stop — the test is wrong, not the code.

```bash
git add tests/worker/plan-queue-regression.test.ts tests/worker/__snapshots__/plan-queue-regression.test.ts.snap
git commit -m "test(scheduler): lock current planner behaviour before extracting planQueue"
```

- [ ] **Step 3: Extract `planQueue`**

In `src/worker/scheduler-service.ts`, replace the whole `planKind` function (lines 72–131) with:

```ts
/**
 * One queue's worth of planning: pick today's slots, route around reservations, clamp to
 * the weekly/daily/slot budget, and assign.
 *
 * Extracted from planKind so the engagement pipeline reuses it rather than owning a second
 * near-copy of the slot maths. Takes no Repos: every database read is the adapter's job,
 * which also makes this directly unit-testable.
 *
 * ORDERING MATTERS. The three early returns happen BEFORE any rng value is drawn, so an
 * empty or capped-out queue costs zero draws and never shifts another queue's rng sequence.
 * Do not reorder them.
 */
export interface QueueSpec {
  /** Log label: 'invite' | 'message' | 'engagement'. */
  name: string;
  caps: KindCaps;
  /** Already spent in the rolling weekly window. */
  sentInWindow: number;
  /** Remaining for today. */
  dailyRemaining: number;
  /** Queued row ids in priority order, already clamped by any queue-specific rule. */
  queuedIds: number[];
  setScheduled(id: number, iso: string): void;
}

export function planQueue(
  s: Settings, now: Date, windowEnd: Date, rng: () => number,
  reserved: ReservationWindow[], spec: QueueSpec,
): void {
  const weeklyRemaining = remainingCapacity(spec.caps.weeklyCap, spec.sentInWindow);
  if (weeklyRemaining <= 0) return;

  // Pace by day, not just by week: the weekly cap is a backstop, but the intended daily
  // volume is batchesPerDay * batchSize. Without this, a single day could spend the
  // entire weekly allowance at once (and a late-day run would pile it onto one slot).
  const batchSize = Math.max(1, spec.caps.batchSize);
  if (spec.dailyRemaining <= 0) return;

  // Check the queue before drawing any rng values — see the ORDERING note above.
  if (spec.queuedIds.length === 0) return;

  const allTimes = planDailyBatches(now, {
    startHour: s.workday_start_hour, endHour: s.workday_end_hour, count: spec.caps.batchesPerDay,
  }, rng);
  // Route around held windows BEFORE the empty-times fallback, so the fallback cannot
  // reintroduce a collision the filter just removed.
  const runtimeMs = estimatedBatchRuntimeMs(s, batchSize);
  let times = filterReservedSlots(
    allTimes.filter((t) => t.getTime() > now.getTime()), reserved, runtimeMs);
  if (times.length === 0) {
    // Inside the window but every random slot fell before now (or every one collided with
    // a reservation): pick a random time in the remaining window [now, end) so the send
    // still lands within working hours. Retry a bounded number of times to dodge
    // reservations; if the window is so congested that we cannot find a free instant, leave
    // the queue alone rather than scheduling into a reservation — the next hourly tick
    // tries again.
    let at: Date | null = null;
    for (let i = 0; i < 12; i++) {
      const candidate = new Date(
        now.getTime() + Math.floor(rng() * Math.max(1, windowEnd.getTime() - now.getTime())));
      if (!conflictsWithReservation(candidate, reserved, runtimeMs)) { at = candidate; break; }
    }
    if (at === null) return;
    times = [at];
  }

  // Cap by (future slots * batch_size) so no single slot ever receives more than
  // batch_size — the assigner would otherwise clamp the overflow onto the last slot.
  const slotCapacity = times.length * batchSize;
  const budget = Math.min(weeklyRemaining, spec.dailyRemaining, slotCapacity);
  if (budget <= 0) return;

  const queued = spec.queuedIds.slice(0, budget);
  if (queued.length === 0) return;

  const assignments = assignSchedule(queued, times, batchSize);
  for (const a of assignments) spec.setScheduled(a.id, a.when.toISOString());

  log.debug('scheduler', 'assigned slots', {
    queue: spec.name, count: assignments.length, slots: times.length, budget,
  });
}

/**
 * Adapter: one CampaignKind's queue of profiles.
 *
 * Note this now reads the daily budget and the queue eagerly, where the old inline version
 * computed them lazily after the weekly check. That costs up to two extra indexed reads when
 * a cap is already exhausted and changes nothing observable — neither read touches rng.
 */
function planKind(
  repos: Repos, s: Settings, now: Date, kind: CampaignKind, windowEnd: Date,
  rng: () => number, reserved: ReservationWindow[] = [],
): void {
  planQueue(s, now, windowEnd, rng, reserved, {
    name: kind,
    caps: capsFor(s, kind),
    sentInWindow: repos.events.countSentSince(windowStartIso(now), kind),
    dailyRemaining: dailyRemainingFor(repos, s, now, kind),
    queuedIds: repos.profiles.queuedByPriorityKind(kind).map((p) => p.id),
    setScheduled: (id, iso) => repos.profiles.setScheduled(id, iso),
  });
}
```

Add `KindCaps` to the existing `capsFor` import at the top of the file:

```ts
import { capsFor, type KindCaps } from '../core/caps.js';
```

- [ ] **Step 4: Run the regression snapshot and the full suite**

```bash
npx vitest run tests/worker/plan-queue-regression.test.ts tests/worker/scheduler-service.test.ts
```

Expected: PASS with **zero snapshot updates**. If vitest reports a snapshot mismatch, the refactor changed behaviour — fix the code, never run `-u`.

```bash
npm test && npm run typecheck
```

Expected: the whole suite green.

- [ ] **Step 5: Commit**

```bash
git add src/worker/scheduler-service.ts
git commit -m "refactor(scheduler): extract planQueue so a third pipeline can reuse it"
```

---

## Task 8: planEngagements, overdue requeue and re-sort

**Files:**
- Modify: `src/worker/scheduler-service.ts`
- Test: `tests/worker/engagement-planning.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/worker/engagement-planning.test.ts`:

```ts
import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { planAndAssignToday, requeueOverdue, resortSchedule } from '../../src/worker/scheduler-service.js';

let repos: Repos;
beforeEach(() => { repos = new Repos(openDatabase(':memory:')); });

const NOW = new Date('2026-08-03T08:00:00'); // a Monday, inside the 8-20 window

function addEngagement(n: number, comment: string | null = null) {
  return repos.engagements.add(
    `https://www.linkedin.com/feed/update/urn:li:activity:${n}/`,
    `urn:li:activity:${n}`, 'like', comment,
  );
}

test('queued engagements get slots inside today\'s working-hours window', () => {
  for (let i = 1; i <= 5; i++) addEngagement(i);
  planAndAssignToday(repos, NOW, () => 0.5);
  const scheduled = repos.engagements.byStatus('scheduled');
  expect(scheduled).toHaveLength(5);
  for (const e of scheduled) {
    const at = new Date(e.scheduled_for!);
    expect(at.getHours()).toBeGreaterThanOrEqual(8);
    expect(at.getHours()).toBeLessThan(20);
    expect(at.getTime()).toBeGreaterThan(NOW.getTime());
  }
});

test('the weekly cap clamps how many are scheduled', () => {
  for (let i = 1; i <= 5; i++) addEngagement(i);
  repos.settings.update({ engage_weekly_cap: 2 });
  planAndAssignToday(repos, NOW, () => 0.5);
  expect(repos.engagements.byStatus('scheduled')).toHaveLength(2);
  expect(repos.engagements.byStatus('queued')).toHaveLength(3);
});

test('the daily comment cap limits how many comment-bearing tasks are PLANNED', () => {
  repos.settings.update({ engage_comment_daily_cap: 2 });
  for (let i = 1; i <= 5; i++) addEngagement(i, 'nice post');
  planAndAssignToday(repos, NOW, () => 0.5);
  expect(repos.engagements.byStatus('scheduled')).toHaveLength(2);
});

test('the comment cap does not hold back reaction-only tasks', () => {
  repos.settings.update({ engage_comment_daily_cap: 0 });
  for (let i = 1; i <= 3; i++) addEngagement(i);          // reaction only
  for (let i = 4; i <= 6; i++) addEngagement(i, 'hi');    // with a comment
  planAndAssignToday(repos, NOW, () => 0.5);
  const scheduled = repos.engagements.byStatus('scheduled');
  expect(scheduled).toHaveLength(3);
  expect(scheduled.every((e) => e.comment_text === null)).toBe(true);
});

test('comments already posted today count against the budget', () => {
  repos.settings.update({ engage_comment_daily_cap: 2 });
  const done = addEngagement(99, 'already said');
  const todayIso = new Date('2026-08-03T09:00:00').toISOString();
  repos.engagements.setStatus(done.id, 'sent', { reacted_at: todayIso, commented_at: todayIso });
  for (let i = 1; i <= 4; i++) addEngagement(i, 'hello');
  planAndAssignToday(repos, NOW, () => 0.5);
  expect(repos.engagements.byStatus('scheduled')).toHaveLength(1);
});

test('engagements route around an event reservation', () => {
  for (let i = 1; i <= 3; i++) addEngagement(i);
  // Hold the entire remaining working day.
  repos.reservations.create(
    new Date('2026-08-03T08:00:00').toISOString(),
    new Date('2026-08-03T20:00:00').toISOString(),
    'event_invite', 1,
  );
  planAndAssignToday(repos, NOW, () => 0.5);
  expect(repos.engagements.byStatus('scheduled')).toHaveLength(0);
  expect(repos.engagements.byStatus('queued')).toHaveLength(3);
});

test('nothing is planned while paused', () => {
  addEngagement(1);
  repos.settings.update({ paused: 1 });
  planAndAssignToday(repos, NOW, () => 0.5);
  expect(repos.engagements.byStatus('queued')).toHaveLength(1);
});

test('requeueOverdue returns a stale engagement slot to the queue', () => {
  const e = addEngagement(1);
  repos.engagements.setScheduled(e.id, '2026-08-03T07:00:00.000Z');
  requeueOverdue(repos, new Date('2026-08-03T09:00:00.000Z'));
  const row = repos.engagements.findById(e.id)!;
  expect(row.status).toBe('queued');
  expect(row.scheduled_for).toBeNull();
});

test('requeueOverdue leaves a slot inside the grace period alone', () => {
  const e = addEngagement(1);
  repos.engagements.setScheduled(e.id, '2026-08-03T08:58:00.000Z');
  requeueOverdue(repos, new Date('2026-08-03T09:00:00.000Z'));
  expect(repos.engagements.findById(e.id)!.status).toBe('scheduled');
});

test('resortSchedule re-flows every scheduled engagement', () => {
  for (let i = 1; i <= 4; i++) addEngagement(i);
  planAndAssignToday(repos, NOW, () => 0.5);
  const before = repos.engagements.byStatus('scheduled').map((e) => e.scheduled_for);
  resortSchedule(repos, NOW, () => 0.9);
  const after = repos.engagements.byStatus('scheduled').map((e) => e.scheduled_for);
  expect(after).toHaveLength(4);
  expect(after).not.toEqual(before);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/worker/engagement-planning.test.ts
```

Expected: FAIL — nothing plans engagements, so the first test finds 0 scheduled rows.

- [ ] **Step 3: Implement**

In `src/worker/scheduler-service.ts`:

**3a.** Add imports:

```ts
import { capsFor, engagementCaps, type KindCaps } from '../core/caps.js';
```

**3b.** Add the engagement adapter after `planKind`:

```ts
/** Local midnight for `now`. Local on purpose: mirrors the working-hours window. */
function dayStartIso(now: Date): string {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/**
 * How many engagements today's quota has already committed: rows still scheduled plus rows
 * that already reacted today. Subtracting this from the daily target keeps repeated planning
 * runs (startup + hourly) from stacking past the daily cap.
 */
export function engagementsCommittedToday(repos: Repos, now: Date): number {
  return repos.engagements.byStatus('scheduled').length
    + repos.engagements.countReactedSince(dayStartIso(now));
}

/**
 * Adapter: the engagement queue.
 *
 * The daily comment cap is applied HERE, not only in the sender. Without it, comment-bearing
 * tasks would be planned every day, deferred every day by the sender, and would consume slot
 * capacity that reaction-only tasks could have used. A task over the budget is held WHOLE —
 * never planned reaction-only — so it cannot straddle two days in a partial state.
 */
function planEngagements(
  repos: Repos, s: Settings, now: Date, windowEnd: Date,
  rng: () => number, reserved: ReservationWindow[] = [],
): void {
  const caps = engagementCaps(s);
  let commentsLeft = Math.max(0,
    s.engage_comment_daily_cap - repos.engagements.countCommentedSince(dayStartIso(now)));

  const queuedIds: number[] = [];
  for (const e of repos.engagements.queuedByPriority()) {
    if (e.comment_text !== null) {
      if (commentsLeft <= 0) continue;
      commentsLeft--;
    }
    queuedIds.push(e.id);
  }

  const dailyTarget = Math.max(0, caps.batchesPerDay * Math.max(1, caps.batchSize));
  planQueue(s, now, windowEnd, rng, reserved, {
    name: 'engagement',
    caps,
    sentInWindow: repos.engagements.countReactedSince(windowStartIso(now)),
    dailyRemaining: Math.max(0, dailyTarget - engagementsCommittedToday(repos, now)),
    queuedIds,
    setScheduled: (id, iso) => repos.engagements.setScheduled(id, iso),
  });
}
```

**3c.** Call it from `planAndAssignToday`, immediately after the `CAMPAIGN_KINDS` loop:

```ts
  for (const kind of CAMPAIGN_KINDS) {
    planKind(repos, s, now, kind, windowEnd, rng, reserved);
  }
  // The fourth pipeline. Not in the loop above because engagements are deliberately not a
  // CampaignKind — but they share the same window, the same reservations and the same
  // planner.
  planEngagements(repos, s, now, windowEnd, rng, reserved);
```

**3d.** Extend `requeueOverdue`. Replace its body with:

```ts
export function requeueOverdue(repos: Repos, now: Date, graceMs: number = OVERDUE_GRACE_MS): number {
  const cutoff = now.getTime() - graceMs;
  const isStale = (at: string | null) => at !== null && new Date(at).getTime() < cutoff;

  const stale = repos.profiles.byStatus('scheduled').filter((p) => isStale(p.scheduled_for));
  for (const p of stale) repos.profiles.setStatus(p.id, 'queued', { scheduled_for: null });

  const staleEng = repos.engagements.byStatus('scheduled').filter((e) => isStale(e.scheduled_for));
  for (const e of staleEng) repos.engagements.setStatus(e.id, 'queued', { scheduled_for: null });

  const total = stale.length + staleEng.length;
  if (total > 0) {
    log.info('scheduler', 'requeued overdue rows for re-scheduling',
      { profiles: stale.length, engagements: staleEng.length });
  }
  return total;
}
```

**3e.** Extend `resortSchedule`. Add before the `planAndAssignToday` call:

```ts
  for (const e of repos.engagements.byStatus('scheduled')) {
    repos.engagements.setStatus(e.id, 'queued', { scheduled_for: null });
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run tests/worker/engagement-planning.test.ts
```

Expected: PASS (10 tests).

```bash
npm test && npm run typecheck
```

Expected: whole suite green, snapshot from Task 7 still matching.

- [ ] **Step 5: Commit**

```bash
git add src/worker/scheduler-service.ts tests/worker/engagement-planning.test.ts
git commit -m "feat(engagements): plan engagement slots alongside invites and messages"
```

---

## Task 9: Driver interface and FakeDriver

The real `LinkedInDriver` gets a minimal, honest implementation here so every commit compiles and the interface is exercised. Task 12 replaces its internals with probe-derived selectors.

**Files:**
- Modify: `src/types.ts`, `src/browser/driver.ts`, `src/browser/linkedin-driver.ts`
- Test: covered by Task 10

- [ ] **Step 1: Add the outcome types to `src/types.ts`**

After the `Engagement` interface added in Task 4:

```ts
/**
 * What one engagement step did.
 *
 * `unverified` is COMMENT-ONLY: reactToPost never returns it, because an unconfirmed
 * reaction is safe to retry and so reports `error` instead. An unconfirmed COMMENT may
 * already be published under the operator's name, so it gets its own result that the sender
 * turns into needs_attention rather than a retry.
 *
 * `comments_disabled` is split from `unavailable` deliberately: an author who restricted
 * commenting is a per-post terminal fact, and folding it into `unavailable` would march a
 * batch of such posts toward a repeated_failures halt.
 */
export type EngagementResult =
  | 'done' | 'already' | 'not_found' | 'unavailable'
  | 'comments_disabled' | 'unverified' | 'checkpoint' | 'error';

export interface EngagementOutcome {
  result: EngagementResult;
  /** Set on `already`: the reaction found on the post. Logged, never persisted. */
  existingReaction?: string;
  /** Canonical URN read off the post container, when the DOM exposes one. */
  observedUrn?: string;
  error?: string;
  evidence?: SendEvidence;
}
```

Then add to the `BrowserDriver` interface, after `runEventBucket`:

```ts
  // --- Post engagements ---
  /** Place a reaction on a post. Idempotent: reports `already` if one is present, and
   *  never replaces a reaction that is already there. */
  reactToPost(postUrl: string, reaction: Reaction): Promise<EngagementOutcome>;
  /** Post a comment. Reports `unverified` rather than `error` when it cannot confirm the
   *  comment landed — the caller must NOT retry that. */
  commentOnPost(postUrl: string, text: string): Promise<EngagementOutcome>;
```

- [ ] **Step 2: Add the fake implementation to `src/browser/driver.ts`**

Add fields to `FakeDriver`, after `connectionCardsError`:

```ts
  /** Scripted per-URL reaction outcomes; default 'done'. */
  reactScripted = new Map<string, EngagementResult>();
  /** Scripted per-URL comment outcomes; default 'done'. */
  commentScripted = new Map<string, EngagementResult>();
  /** Records the reactions this fake "placed". */
  reactLog: { url: string; reaction: Reaction }[] = [];
  /** Records the comments this fake "posted". */
  commentLog: { url: string; text: string }[] = [];
  /** Reported alongside an `already` reaction outcome. */
  existingReaction = 'like';
```

And the two methods:

```ts
  async reactToPost(postUrl: string, reaction: Reaction): Promise<EngagementOutcome> {
    this.open = true;
    this.reactLog.push({ url: postUrl, reaction });
    const result = this.reactScripted.get(postUrl) ?? 'done';
    const evidence = (result === 'checkpoint' || result === 'error' || result === 'unavailable')
      ? this.evidence : undefined;
    return {
      result,
      ...(result === 'already' ? { existingReaction: this.existingReaction } : {}),
      ...(evidence ? { evidence } : {}),
    };
  }

  async commentOnPost(postUrl: string, text: string): Promise<EngagementOutcome> {
    this.open = true;
    this.commentLog.push({ url: postUrl, text });
    const result = this.commentScripted.get(postUrl) ?? 'done';
    const evidence = (result === 'checkpoint' || result === 'error' || result === 'unavailable')
      ? this.evidence : undefined;
    return { result, ...(evidence ? { evidence } : {}) };
  }
```

Add `EngagementOutcome`, `EngagementResult` and `Reaction` to the file's existing `import type` from `../types.js`.

- [ ] **Step 3: Add a minimal real implementation to `src/browser/linkedin-driver.ts`**

This keeps the build green between here and Task 12. It is deliberately honest — it reports `unavailable` rather than pretending to work.

```ts
  // --- Post engagements ---
  // PLACEHOLDER until the probe findings land (Task 12). Navigating is real so the URL
  // handling is exercised; the controls are not driven yet, and this reports `unavailable`
  // rather than silently claiming success.
  async reactToPost(postUrl: string, _reaction: Reaction): Promise<EngagementOutcome> {
    const page = await this.session.page();
    await page.goto(postUrl, { waitUntil: 'domcontentloaded' });
    return { result: 'unavailable', error: 'reaction driving not implemented yet' };
  }

  async commentOnPost(postUrl: string, _text: string): Promise<EngagementOutcome> {
    const page = await this.session.page();
    await page.goto(postUrl, { waitUntil: 'domcontentloaded' });
    return { result: 'unavailable', error: 'comment driving not implemented yet' };
  }
```

`await this.session.page()` then `page.goto(url, { waitUntil: 'domcontentloaded' })` is this file's
established page-acquisition idiom — see `sendConnectionRequest` at line 50.

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck && npm test
```

Expected: no errors, whole suite still green.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/browser/driver.ts src/browser/linkedin-driver.ts
git commit -m "feat(engagements): add the reaction and comment driver interface"
```

---

## Task 10: The sender's engagement pass

**Files:**
- Modify: `src/worker/sender.ts`
- Test: `tests/worker/sender-engagements.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/worker/sender-engagements.test.ts`:

```ts
import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { FakeDriver } from '../../src/browser/driver.js';
import { runSenderOnce, type SenderOptions } from '../../src/worker/sender.js';

let repos: Repos; let driver: FakeDriver;
beforeEach(() => {
  repos = new Repos(openDatabase(':memory:'));
  driver = new FakeDriver();
  repos.appState.setLogin({ loggedIn: true, cookieExpiry: null }, '2026-08-03T00:00:00.000Z');
});

function run(now: Date, opts: SenderOptions = {}) {
  return runSenderOnce(repos, driver, now, { sleep: async () => {}, ...opts });
}

const NOW = new Date('2026-08-03T10:00:00');

function seed(n: number, comment: string | null = null, reaction = 'insightful') {
  const url = `https://www.linkedin.com/feed/update/urn:li:activity:${n}/`;
  const e = repos.engagements.add(url, `urn:li:activity:${n}`, reaction as never, comment);
  repos.engagements.setScheduled(e.id, '2026-08-03T09:00:00.000Z');
  return { ...e, url };
}

test('a reaction-only task reacts, is marked sent, and stamps reacted_at', async () => {
  const e = seed(1);
  await run(NOW);
  expect(driver.reactLog).toEqual([{ url: e.url, reaction: 'insightful' }]);
  const row = repos.engagements.findById(e.id)!;
  expect(row.status).toBe('sent');
  expect(row.reacted_at).not.toBeNull();
  expect(row.commented_at).toBeNull();
  expect(row.attempts).toBe(1);
});

test('a comment task reacts FIRST, then comments, and stamps both', async () => {
  const e = seed(1, 'great post');
  await run(NOW);
  expect(driver.reactLog).toHaveLength(1);
  expect(driver.commentLog).toEqual([{ url: e.url, text: 'great post' }]);
  const row = repos.engagements.findById(e.id)!;
  expect(row.status).toBe('sent');
  expect(row.reacted_at).not.toBeNull();
  expect(row.commented_at).not.toBeNull();
});

test('the reaction and the comment are paced apart — two LinkedIn contacts', async () => {
  seed(1, 'hi');
  let sleeps = 0;
  await run(NOW, { sleep: async () => { sleeps++; }, rng: () => 0.5 });
  expect(sleeps).toBe(1);
});

test('already: the existing reaction is kept, not replaced, and the task completes', async () => {
  const e = seed(1);
  driver.reactScripted.set(e.url, 'already');
  driver.existingReaction = 'celebrate';
  await run(NOW);
  const row = repos.engagements.findById(e.id)!;
  expect(row.status).toBe('sent');
  expect(row.reacted_at).not.toBeNull();
  expect(row.reaction).toBe('insightful'); // the row is not rewritten
});

test('not_found: terminal skip, no failure streak', async () => {
  const e = seed(1);
  driver.reactScripted.set(e.url, 'not_found');
  await run(NOW);
  const row = repos.engagements.findById(e.id)!;
  expect(row.status).toBe('skipped');
  expect(row.skip_reason).toBe('not_found');
  expect(repos.appState.get().failure_streak).toBe(0);
});

test('unavailable: skip that DOES count toward the failure streak', async () => {
  const e = seed(1);
  driver.reactScripted.set(e.url, 'unavailable');
  await run(NOW);
  const row = repos.engagements.findById(e.id)!;
  expect(row.status).toBe('skipped');
  expect(row.skip_reason).toBe('unavailable');
  expect(repos.appState.get().failure_streak).toBe(1);
});

test('comments_disabled: the reaction is kept and reported, the task skips', async () => {
  const e = seed(1, 'hello');
  driver.commentScripted.set(e.url, 'comments_disabled');
  await run(NOW);
  const row = repos.engagements.findById(e.id)!;
  expect(row.status).toBe('skipped');
  expect(row.skip_reason).toBe('comments_disabled');
  expect(row.reacted_at).not.toBeNull();   // the reaction landed and is not lost
  expect(row.commented_at).toBeNull();
  expect(repos.appState.get().failure_streak).toBe(0); // terminal, not a streak failure
});

test('an unverified comment parks for the operator and is never auto-retried', async () => {
  const e = seed(1, 'hello');
  driver.commentScripted.set(e.url, 'unverified');
  await run(NOW);
  const row = repos.engagements.findById(e.id)!;
  expect(row.status).toBe('needs_attention');
  expect(row.reacted_at).not.toBeNull();
  expect(row.commented_at).toBeNull();
  expect(row.last_error).toMatch(/may have posted/);
});

test('a checkpoint during a reaction trips the shared guardrail and halts', async () => {
  const e = seed(1);
  driver.reactScripted.set(e.url, 'checkpoint');
  await run(NOW);
  expect(repos.appState.get().guardrail_tripped).toBe(1);
  expect(repos.engagements.findById(e.id)!.status).toBe('needs_attention');
});

test('the weekly cap clamps the batch', async () => {
  for (let i = 1; i <= 4; i++) seed(i);
  repos.settings.update({ engage_weekly_cap: 2 });
  await run(NOW);
  expect(driver.reactLog).toHaveLength(2);
});

test('the daily comment cap holds a comment task WHOLE — it does not react alone', async () => {
  repos.settings.update({ engage_comment_daily_cap: 0 });
  const e = seed(1, 'hi');
  await run(NOW);
  expect(driver.reactLog).toHaveLength(0);
  expect(driver.commentLog).toHaveLength(0);
  expect(repos.engagements.findById(e.id)!.status).toBe('scheduled');
});

test('a retried task whose reaction already landed does not react twice', async () => {
  const e = seed(1, 'hi');
  repos.engagements.setStatus(e.id, 'scheduled', { reacted_at: '2026-08-03T09:30:00.000Z' });
  await run(NOW);
  expect(driver.reactLog).toHaveLength(0);
  expect(driver.commentLog).toHaveLength(1);
  expect(repos.engagements.findById(e.id)!.status).toBe('sent');
});

test('engagements run AFTER invites and messages in one tick', async () => {
  const c = repos.cohorts.create('A', 'hi', true, 'invite');
  const p = repos.profiles.add(c.id, 'https://www.linkedin.com/in/a', null, 'invite');
  repos.profiles.setScheduled(p.id, '2026-08-03T09:00:00.000Z');
  seed(1);
  await run(NOW);
  expect(driver.sentLog).toHaveLength(1);
  expect(driver.reactLog).toHaveLength(1);
});

test('nothing due in any pipeline: the browser is never opened', async () => {
  await run(NOW);
  expect(driver.browserOpen()).toBe(false);
});

test('nothing runs while paused', async () => {
  seed(1);
  repos.settings.update({ paused: 1 });
  await run(NOW);
  expect(driver.reactLog).toHaveLength(0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/worker/sender-engagements.test.ts
```

Expected: FAIL — the sender does not touch engagements, so `driver.reactLog` is empty.

- [ ] **Step 3: Implement**

In `src/worker/sender.ts`:

**3a.** Extend the imports:

```ts
import type {
  BrowserDriver, Profile, Settings, CampaignKind, SendOutcome,
  Engagement, EngagementOutcome, EngagementSkipReason,
} from '../types.js';
import { capsFor, engagementCaps } from '../core/caps.js';
```

**3b.** Add the engagement helpers after `handleError`:

```ts
/** One human-readable line per engagement, mirroring logVerdict for profiles. */
function logEngagementVerdict(e: Engagement, verdict: string): void {
  log.info('sender', 'engagement verdict', { engagement: e.id, url: e.post_url, verdict });
}

/** Terminal skip that does NOT touch the failure streak — a per-post fact that can never
 *  succeed on retry (post deleted, commenting disabled). */
function skipEngagement(
  repos: Repos, e: Engagement, reason: EngagementSkipReason, detail: string,
): AttemptResult {
  repos.engagements.setStatus(e.id, 'skipped', { last_error: null, skip_reason: reason });
  logEngagementVerdict(e, `skipped: ${detail}`);
  return { halted: false, contacted: true };
}

/** Skip that DOES count toward the failure streak — the control was missing, which usually
 *  means a selector broke rather than anything being wrong with this post. */
function skipEngagementCounted(
  repos: Repos, e: Engagement, outcome: EngagementOutcome, clock: () => Date, label: string,
): boolean {
  repos.engagements.setStatus(e.id, 'skipped', { last_error: null, skip_reason: 'unavailable' });
  const shot = outcome.evidence?.screenshot;
  const detail = `${label}${shot ? ` — screenshot: /incidents/${shot}` : ''}`;
  logEngagementVerdict(e, `skipped: ${detail}`);
  return recordFailure(repos, detail, clock());
}

function failEngagement(
  repos: Repos, e: Engagement, outcome: EngagementOutcome, clock: () => Date,
): boolean {
  const shot = outcome.evidence?.screenshot;
  repos.engagements.setStatus(e.id, 'failed', { last_error: outcome.error ?? 'unknown' });
  logEngagementVerdict(e, `failed: ${outcome.error ?? 'unknown'}${shot ? ` — screenshot: /incidents/${shot}` : ''}`);
  return recordFailure(repos, outcome.error ?? 'unknown', clock());
}

/** A checkpoint halts the whole engine, not one pipeline — the LinkedIn account is the
 *  shared resource. Same shape as handleCheckpoint for profiles. */
function handleEngagementCheckpoint(
  repos: Repos, e: Engagement, outcome: EngagementOutcome, clock: () => Date,
): void {
  const ev = outcome.evidence;
  const detail = ev
    ? `Checkpoint/captcha page at ${ev.pageUrl}`
      + (ev.matched ? ` (matched "${ev.matched}")` : '')
      + (ev.screenshot ? ` — screenshot: /incidents/${ev.screenshot}` : '')
    : undefined;
  repos.engagements.setStatus(e.id, 'needs_attention', {
    last_error: ev?.matched ? `checkpoint (matched "${ev.matched}")` : 'checkpoint',
  });
  logEngagementVerdict(e, `needs attention: checkpoint / captcha${detail ? ` — ${detail}` : ''}`);
  tripCheckpoint(repos, clock(), detail);
}
```

**3c.** Add the due-selection and the pass:

```ts
/**
 * Due, capacity-clamped engagements (DB only, no browser).
 *
 * The comment budget is re-checked here as a backstop for the planner's own limit. A
 * comment-bearing task over budget is dropped from the batch WHOLE — never run
 * reaction-only — so one task cannot straddle two days in a partial state.
 */
function dueEngagements(repos: Repos, now: Date): Engagement[] {
  const s = repos.settings.get();
  const caps = engagementCaps(s);
  const reactedInWindow = repos.engagements.countReactedSince(windowStartIso(now));
  const remaining = remainingCapacity(caps.weeklyCap, reactedInWindow);
  if (remaining <= 0) return [];

  const scheduled = repos.engagements.byStatus('scheduled');
  const due = pickDue(scheduled, now, Math.min(remaining, caps.batchSize));

  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  let commentsLeft = Math.max(0,
    s.engage_comment_daily_cap - repos.engagements.countCommentedSince(dayStart.toISOString()));
  return due.filter((e) => {
    if (e.comment_text === null) return true;
    if (commentsLeft <= 0) return false;
    commentsLeft--;
    return true;
  });
}

/** One engagement batch. Returns true if a halt-worthy verdict stopped the pass.
 *  `delay` paces consecutive LinkedIn contacts — see runInvitePass for the same contract. */
async function runEngagementPass(
  repos: Repos, driver: BrowserDriver, due: Engagement[], clock: () => Date, delay: () => Promise<void>,
): Promise<boolean> {
  for (let i = 0; i < due.length; i++) {
    const { halted, contacted } = await attemptEngagement(repos, driver, due[i], clock, delay);
    if (halted) return true;
    if (contacted && i < due.length - 1) await delay();
  }
  return false;
}

/**
 * One post's engagement: react, then comment if the task carries one.
 *
 * The reaction step is guarded on `reacted_at === null`, so a task retried after a failed
 * comment never re-drives the reaction. That guard, and the split reacted_at/commented_at
 * timestamps behind it, are the whole reason this pipeline does not use a single sent_at.
 */
async function attemptEngagement(
  repos: Repos, driver: BrowserDriver, e: Engagement, clock: () => Date, delay: () => Promise<void>,
): Promise<AttemptResult> {
  repos.engagements.setStatus(e.id, 'sending', { attempts: e.attempts + 1 });
  log.debug('sender', 'attempting engagement', { engagement: e.id, url: e.post_url });

  if (e.reacted_at === null) {
    const outcome = await driver.reactToPost(e.post_url, e.reaction);

    // Reconcile the identity against what the live post actually calls itself. The URN
    // parsed from a URL is best-effort: a share-link slug carries a different number from
    // the post's own data-urn, so two URL forms of one post enqueue as two rows. This is
    // where that self-heals. A `duplicate` verdict means ANOTHER row already holds the
    // canonical URN — this one is redundant, and engaging again would react twice.
    if (outcome.observedUrn) {
      const verdict = repos.engagements.reconcileUrn(e.id, outcome.observedUrn);
      if (verdict === 'duplicate') {
        return skipEngagement(repos, e, 'dismissed',
          'the same post is already engaged under its canonical URN');
      }
    }

    switch (outcome.result) {
      case 'done':
        repos.engagements.setStatus(e.id, 'sending', { reacted_at: clock().toISOString() });
        break;
      case 'already':
        // A reaction of ours we never recorded — placed by hand, or orphaned by a crash.
        // We do NOT replace it with the requested one: overwriting a reaction the operator
        // placed themselves is a side effect nobody asked for.
        repos.engagements.setStatus(e.id, 'sending', { reacted_at: clock().toISOString() });
        logEngagementVerdict(e, `reaction already present (${outcome.existingReaction ?? 'unknown'}) — left as is`);
        break;
      case 'not_found':
        return skipEngagement(repos, e, 'not_found', 'post no longer exists (LinkedIn 404)');
      case 'unavailable':
      case 'comments_disabled': // not reachable from a reaction; the union is shared
        return {
          halted: skipEngagementCounted(repos, e, outcome, clock, 'reaction control unavailable'),
          contacted: true,
        };
      case 'checkpoint':
        handleEngagementCheckpoint(repos, e, outcome, clock);
        return { halted: true, contacted: true };
      case 'unverified': // comment-only in practice; treated as retryable here
      case 'error':
      default:
        return { halted: failEngagement(repos, e, outcome, clock), contacted: true };
    }
  }

  if (e.comment_text !== null && e.commented_at === null) {
    await delay(); // the reaction and the comment are two consecutive LinkedIn contacts
    const outcome = await driver.commentOnPost(e.post_url, e.comment_text);
    switch (outcome.result) {
      case 'done':
        repos.engagements.setStatus(e.id, 'sent', { commented_at: clock().toISOString() });
        recordSuccess(repos);
        logEngagementVerdict(e, `reacted (${e.reaction}) and commented`);
        return { halted: false, contacted: true };
      case 'comments_disabled':
        // The reaction landed and stays recorded — this is not a lost engagement.
        return skipEngagement(repos, e, 'comments_disabled',
          'commenting is disabled on this post (the reaction landed)');
      case 'not_found':
        return skipEngagement(repos, e, 'not_found', 'post no longer exists (LinkedIn 404)');
      case 'unverified':
        // NEVER auto-retry: the comment may already be published under the operator's name.
        repos.engagements.setStatus(e.id, 'needs_attention', {
          last_error: 'comment could not be verified — it may have posted; check the post before retrying',
        });
        logEngagementVerdict(e, 'needs attention: comment unverified');
        return { halted: false, contacted: true };
      case 'unavailable':
        return {
          halted: skipEngagementCounted(repos, e, outcome, clock, 'comment box unavailable'),
          contacted: true,
        };
      case 'checkpoint':
        handleEngagementCheckpoint(repos, e, outcome, clock);
        return { halted: true, contacted: true };
      case 'already':
      case 'error':
      default:
        return { halted: failEngagement(repos, e, outcome, clock), contacted: true };
    }
  }

  repos.engagements.setStatus(e.id, 'sent', {});
  recordSuccess(repos);
  logEngagementVerdict(e, `reacted (${e.reaction})`);
  return { halted: false, contacted: true };
}
```

**3d.** Wire it into `runSenderOnce`. Replace the due-computation and the two-pass tail:

```ts
  const invDue = dueForKind(repos, now, 'invite');
  const msgDue = dueForKind(repos, now, 'message');
  const engDue = dueEngagements(repos, now);
  if (invDue.length === 0 && msgDue.length === 0 && engDue.length === 0) return; // stay dark
```

and, after the existing `if (msgDue.length > 0) await runMessagePass(...)` line:

```ts
  if (invDue.length > 0) {
    const halted = await runInvitePass(repos, driver, invDue, clock, delay);
    if (halted) return;
    if (msgDue.length > 0 || engDue.length > 0) await delay();
  }
  if (msgDue.length > 0) {
    const halted = await runMessagePass(repos, driver, msgDue, clock, delay);
    if (halted) return;
    if (engDue.length > 0) await delay();
  }
  if (engDue.length > 0) await runEngagementPass(repos, driver, engDue, clock, delay);
```

Note this makes the message pass's halt return value load-bearing where it previously was not — a halted message pass must not start the engagement pass, for the same reason a halted invite pass does not start the message pass.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run tests/worker/sender-engagements.test.ts
```

Expected: PASS (15 tests).

```bash
npm test && npm run typecheck
```

Expected: whole suite green — pay attention to `tests/worker/sender.test.ts`, whose delay-counting tests are sensitive to the inter-pass change.

- [ ] **Step 5: Commit**

```bash
git add src/worker/sender.ts tests/worker/sender-engagements.test.ts
git commit -m "feat(engagements): drain engagements in the sender tick"
```

---

## Task 11: Crash recovery

**Files:**
- Modify: `src/worker/scheduler-service.ts`, `src/worker/orchestrator.ts:263`
- Test: `tests/worker/sender-engagements.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/worker/sender-engagements.test.ts`:

```ts
import { recoverOrphanedEngagements } from '../../src/worker/scheduler-service.js';

test('crash before the reaction: requeue — clicking Like twice is idempotent', () => {
  const e = seed(1, 'hi');
  repos.engagements.setStatus(e.id, 'sending', {});
  recoverOrphanedEngagements(repos);
  const row = repos.engagements.findById(e.id)!;
  expect(row.status).toBe('queued');
  expect(row.scheduled_for).toBeNull();
});

test('crash after a reaction-only task reacted: it provably finished', () => {
  const e = seed(1);
  repos.engagements.setStatus(e.id, 'sending', { reacted_at: '2026-08-03T09:00:00.000Z' });
  recoverOrphanedEngagements(repos);
  expect(repos.engagements.findById(e.id)!.status).toBe('sent');
});

test('crash straddling the comment: park, never requeue', () => {
  const e = seed(1, 'hi');
  repos.engagements.setStatus(e.id, 'sending', { reacted_at: '2026-08-03T09:00:00.000Z' });
  recoverOrphanedEngagements(repos);
  const row = repos.engagements.findById(e.id)!;
  expect(row.status).toBe('needs_attention');
  expect(row.last_error).toMatch(/may have posted/);
});

test('crash after everything landed: mark sent', () => {
  const e = seed(1, 'hi');
  repos.engagements.setStatus(e.id, 'sending', {
    reacted_at: '2026-08-03T09:00:00.000Z', commented_at: '2026-08-03T09:00:30.000Z',
  });
  recoverOrphanedEngagements(repos);
  expect(repos.engagements.findById(e.id)!.status).toBe('sent');
});

test('rows not in sending are untouched', () => {
  const e = seed(1);
  recoverOrphanedEngagements(repos);
  expect(repos.engagements.findById(e.id)!.status).toBe('scheduled');
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/worker/sender-engagements.test.ts
```

Expected: FAIL — `recoverOrphanedEngagements` is not exported.

- [ ] **Step 3: Implement**

Add to `src/worker/scheduler-service.ts`, after `recoverOrphanedSending`:

```ts
/**
 * Rescue engagements abandoned in 'sending' by an abrupt exit.
 *
 * Nothing in the row says whether the browser action landed, so recovery is decided by what
 * the timestamps PROVE — which is why this pipeline splits reacted_at from commented_at
 * instead of carrying one sent_at:
 *
 *  - no reacted_at: nothing was published. Requeue — a repeated Like is idempotent, and the
 *    driver reports `already` on the second pass.
 *  - reacted_at, no comment wanted: the task's only work provably completed. Mark it sent.
 *  - reacted_at, comment wanted, no commented_at: the crash straddled the comment. Park as
 *    needs_attention and NEVER requeue — a duplicate published comment is visible to real
 *    people and cannot be cleanly unsent. Same doctrine as an interrupted DM.
 *  - both stamped: everything landed. Mark it sent.
 *
 * STARTUP-ONLY: the browser is in-process, so a fresh process has nothing genuinely in
 * flight. Never call this mid-run, where a 'sending' row is a live engagement.
 */
export function recoverOrphanedEngagements(repos: Repos): number {
  const stuck = repos.engagements.byStatus('sending');
  let requeued = 0; let completed = 0; let parked = 0;
  for (const e of stuck) {
    if (e.reacted_at === null) {
      repos.engagements.setStatus(e.id, 'queued', { scheduled_for: null });
      requeued++;
    } else if (e.comment_text !== null && e.commented_at === null) {
      repos.engagements.setStatus(e.id, 'needs_attention', {
        scheduled_for: null,
        last_error: 'interrupted mid-comment — it may have posted; check the post before retrying',
      });
      parked++;
    } else {
      repos.engagements.setStatus(e.id, 'sent', {});
      completed++;
    }
  }
  if (stuck.length > 0) {
    log.info('scheduler', 'recovered orphaned engagements', { requeued, completed, needs_attention: parked });
  }
  return stuck.length;
}
```

In `src/worker/orchestrator.ts`, add the import and call it in `start()` immediately after `recoverOrphanedSending(this.repos);`:

```ts
import { planAndAssignToday, requeueOverdue, resortSchedule, recoverOrphanedSending, recoverOrphanedEngagements } from './scheduler-service.js';
```

```ts
    recoverOrphanedSending(this.repos);
    // Same reasoning for engagements — but a three-way split, because a task that already
    // reacted must not react again and a task that may have commented must not comment again.
    recoverOrphanedEngagements(this.repos);
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run tests/worker/sender-engagements.test.ts && npm test
```

Expected: PASS (20 tests in the file), whole suite green.

- [ ] **Step 5: Commit**

```bash
git add src/worker/scheduler-service.ts src/worker/orchestrator.ts tests/worker/sender-engagements.test.ts
git commit -m "feat(engagements): recover engagements orphaned by a crash"
```

---

## Task 12: Real driver implementation

The Task 1 findings are in the spec under `## Discovery findings (live-verified 2026-08-02)`. **Read that section before writing a line of this task** — it supersedes anything below that contradicts it.

**Three hazards the probe found that are not obvious from the design:**

1. **The reaction click is DESTRUCTIVE, not idempotent.** Clicking the trigger while `aria-pressed="true"` *removes* the existing reaction. The driver must read state first and return `already` — a blind click un-likes the post. This was caught live: the company-page post was already Liked and a naive implementation would have silently removed it.
2. **The action bar's first button is an identity toggle** (`aria-label="Open menu for switching identity when interacting with this post"`). On an account that administers company pages, clicking it switches the authoring identity. Never select the bar's first button positionally — always by the `aria-pressed` + `aria-label^="React "` predicate.
3. **The comment submit button does not exist until the editor has text**, has no `aria-label`, and its accessible name is **`Comment`** — not "Post". It must be scoped to `form.comments-comment-box__form`, because the action bar's own button shares that name. The editor is Quill, so drive it with `insertText` rather than per-key typing (emoji are astral-plane).

**Files:**
- Create: `src/browser/post-selectors.ts`
- Modify: `src/browser/linkedin-driver.ts`

- [ ] **Step 1: Write the selectors module**

Read `src/browser/event-selectors.ts` first and follow its structure exactly — exported constants with a comment on each explaining what it matches and why that form was chosen over the alternatives.

`src/browser/post-selectors.ts` must export, using the selectors recorded in Task 1:
- `REACTION_BAR` — the social action row
- `LIKE_BUTTON` — the primary reaction control
- `REACTION_FLYOUT` — the hover panel
- `reactionButton(reaction: Reaction): string` — the specific reaction inside the flyout
- `REACTED_STATE` — the attribute/selector proving a reaction is placed
- `COMMENT_BUTTON`, `COMMENT_BOX`, `COMMENT_SUBMIT`
- `POSTED_COMMENTS` — the thread, for verifying our comment appeared
- `COMMENTS_DISABLED` — what a restricted post shows instead

**No hashed class names.** The messaging discovery found the profile UI is obfuscated-class React; assume the feed is too, and anchor on `aria-*`, `role`, `data-*` and semantic elements.

- [ ] **Step 2: Implement `reactToPost`**

Replace the placeholder in `src/browser/linkedin-driver.ts`. Reuse the file's existing private helpers rather than writing new ones — `this.session.page()`, `this.scanCheckpoint(page)`, `isNotFoundUrl(page.url())` and `captureEvidence(page, …)` all already exist and are what `sendConnectionRequest` (line 50) uses. Add `checkpointOutcome`/`errorOutcome` equivalents that return an `EngagementOutcome` instead of a `SendOutcome`; the two unions differ, so they cannot be shared.

```
const page = await this.session.page()
await page.goto(postUrl, { waitUntil: 'domcontentloaded' })
await sleep(rand(1500, 3500))                      // the file's existing settle pause

if (isNotFoundUrl(page.url())) -> { result: 'not_found' }
const scan = await this.scanCheckpoint(page)
if (scan.hit) -> capture evidence, { result: 'checkpoint', evidence }

read the canonical URN off the post container if Task 1 found one -> observedUrn
if REACTED_STATE is already true -> { result: 'already', existingReaction: <read it>, observedUrn }
locate LIKE_BUTTON; if absent -> capture evidence, { result: 'unavailable' }

if (reaction === 'like'):
    click LIKE_BUTTON
else:
    hover LIKE_BUTTON
    wait for REACTION_FLYOUT
    click reactionButton(reaction)

wait for REACTED_STATE to become true (bounded)
    true  -> { result: 'done', observedUrn }
    false -> capture evidence, { result: 'error', error: 'reaction did not register' }
```

The reaction is idempotent, so an unconfirmed one reports `error` and is safe to retry. `unverified` is never returned here.

- [ ] **Step 3: Implement `commentOnPost`**

```
const page = await this.session.page()
await page.goto(postUrl, { waitUntil: 'domcontentloaded' })
await sleep(rand(1500, 3500))

if (isNotFoundUrl(page.url())) -> { result: 'not_found' }
const scan = await this.scanCheckpoint(page)
if (scan.hit) -> capture evidence, { result: 'checkpoint', evidence }

if COMMENTS_DISABLED present, or COMMENT_BUTTON absent -> { result: 'comments_disabled' }
click COMMENT_BUTTON to open the box
if COMMENT_BOX never appears -> capture evidence, { result: 'unavailable' }
fill COMMENT_BOX with text
click COMMENT_SUBMIT
wait for our text to appear in POSTED_COMMENTS (bounded)
    appeared     -> { result: 'done' }
    not appeared -> capture evidence, { result: 'unverified' }
```

**Never return `error` for an ambiguous comment outcome.** `unverified` is what stops the sender retrying, and a bare `error` would let a possibly-published comment be posted twice.

- [ ] **Step 4: Verify the build and the fake still agree**

```bash
npm run typecheck && npm test
```

Expected: no type errors; whole suite green (the suite exercises `FakeDriver`, not this code — the live check is Task 15).

- [ ] **Step 5: Commit**

```bash
git add src/browser/post-selectors.ts src/browser/linkedin-driver.ts
git commit -m "feat(engagements): drive the reaction flyout and the comment box"
```

---

## Task 13: API endpoints

**Files:**
- Modify: `src/api/server.ts`, `src/core/message.ts`
- Test: `tests/api/engagements.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/api/engagements.test.ts`. Read `tests/api/events.test.ts` first for the `buildServer` + `app.inject` harness this repo uses, and mirror its setup exactly.

```ts
import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { FakeDriver } from '../../src/browser/driver.js';
import { buildServer } from '../../src/api/server.js';

let repos: Repos; let app: ReturnType<typeof buildServer>;
beforeEach(() => {
  repos = new Repos(openDatabase(':memory:'));
  app = buildServer(repos, new FakeDriver());
});

const POST = 'https://www.linkedin.com/feed/update/urn:li:activity:7123456789012345678/';
const URN = 'urn:li:activity:7123456789012345678';

async function post(url: string, payload: unknown) {
  return app.inject({ method: 'POST', url, payload: payload as never });
}

test('creates a reaction-only engagement and defaults the reaction to like', async () => {
  const r = await post('/api/engagements', { post_url: POST });
  expect(r.statusCode).toBe(201);
  expect(r.json()).toMatchObject({ post_urn: URN, reaction: 'like', has_comment: false });
});

test('creates a reaction + comment engagement', async () => {
  const r = await post('/api/engagements', {
    post_url: POST, reaction: 'insightful', comment: 'Sharp take.',
  });
  expect(r.statusCode).toBe(201);
  expect(r.json()).toMatchObject({ reaction: 'insightful', has_comment: true });
  expect(repos.engagements.findByUrn(URN)!.comment_text).toBe('Sharp take.');
});

test('the /posts/ share form resolves to the same URN', async () => {
  await post('/api/engagements', { post_url: POST });
  const r = await post('/api/engagements', {
    post_url: 'https://www.linkedin.com/posts/x_y-activity-7123456789012345678-AbCd',
  });
  expect(r.statusCode).toBe(409);
  expect(repos.engagements.all()).toHaveLength(1);
});

test('a second engagement on the same post is a 409 naming the existing row', async () => {
  const first = await post('/api/engagements', { post_url: POST });
  const r = await post('/api/engagements', { post_url: POST, reaction: 'celebrate' });
  expect(r.statusCode).toBe(409);
  expect(r.json().error).toContain(String(first.json().id));
});

test('an unknown reaction is rejected by name', async () => {
  const r = await post('/api/engagements', { post_url: POST, reaction: 'thumbsup' });
  expect(r.statusCode).toBe(400);
  expect(r.json().error).toBe('unknown reaction: thumbsup');
});

test('an unparseable post URL is rejected', async () => {
  const r = await post('/api/engagements', { post_url: 'https://www.linkedin.com/in/jane' });
  expect(r.statusCode).toBe(400);
});

test('a shortlink that cannot be expanded is rejected with actionable guidance', async () => {
  // No network in tests: resolveShortlink's fetch is injected, and buildServer must be
  // given a stub that fails. See the note below the test block.
  const r = await post('/api/engagements', { post_url: 'https://lnkd.in/dead' });
  expect(r.statusCode).toBe(400);
  expect(r.json().error).toMatch(/full post URL/i);
});

test('a shortlink that resolves is enqueued under the expanded URL', async () => {
  const r = await post('/api/engagements', { post_url: 'https://lnkd.in/good' });
  expect(r.statusCode).toBe(201);
  expect(r.json().post_urn).toBe(URN);
});

test('an over-long comment is rejected', async () => {
  const r = await post('/api/engagements', { post_url: POST, comment: 'x'.repeat(1251) });
  expect(r.statusCode).toBe(400);
  expect(r.json().error).toMatch(/1250/);
});

test('an empty comment string is treated as no comment, not an empty one', async () => {
  await post('/api/engagements', { post_url: POST, comment: '   ' });
  expect(repos.engagements.findByUrn(URN)!.comment_text).toBeNull();
});

test('bulk creation reports rejects by name and reason', async () => {
  const r = await post('/api/engagements', {
    items: [
      { post_url: POST },
      { post_url: 'https://lnkd.in/abc' },
      { post_url: 'https://www.linkedin.com/feed/update/urn:li:activity:2/', reaction: 'nope' },
    ],
  });
  expect(r.statusCode).toBe(200);
  expect(r.json()).toMatchObject({
    added: 1,
    rejected: [
      { post_url: 'https://lnkd.in/abc', reason: 'shortlink_unsupported' },
      { post_url: 'https://www.linkedin.com/feed/update/urn:li:activity:2/', reason: 'unknown_reaction' },
    ],
  });
});

test('creation schedules immediately rather than waiting for the hourly tick', async () => {
  // Inside working hours so the planner will act.
  await post('/api/engagements', { post_url: POST });
  const row = repos.engagements.findByUrn(URN)!;
  expect(['queued', 'scheduled']).toContain(row.status);
});

test('listing filters by status', async () => {
  await post('/api/engagements', { post_url: POST });
  const r = await app.inject({ method: 'GET', url: '/api/engagements?status=queued' });
  expect(r.statusCode).toBe(200);
  expect(r.json()).toHaveLength(1);
});

test('GET by id 404s for an unknown row', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/engagements/999' });
  expect(r.statusCode).toBe(404);
});

test('retry is allowed on a parked comment row — that is what parking is for', async () => {
  await post('/api/engagements', { post_url: POST, comment: 'hi' });
  const e = repos.engagements.findByUrn(URN)!;
  repos.engagements.setStatus(e.id, 'needs_attention', { last_error: 'unverified' });
  const r = await post(`/api/engagements/${e.id}/retry`, {});
  expect(r.statusCode).toBe(200);
  const row = repos.engagements.findById(e.id)!;
  expect(row.status).toBe('queued');
  expect(row.last_error).toBeNull();
});

test('retry is refused on a row that already completed', async () => {
  await post('/api/engagements', { post_url: POST });
  const e = repos.engagements.findByUrn(URN)!;
  repos.engagements.setStatus(e.id, 'sent', { reacted_at: '2026-08-03T09:00:00.000Z' });
  const r = await post(`/api/engagements/${e.id}/retry`, {});
  expect(r.statusCode).toBe(409);
});

test('dismiss terminates a queued row', async () => {
  await post('/api/engagements', { post_url: POST });
  const e = repos.engagements.findByUrn(URN)!;
  const r = await post(`/api/engagements/${e.id}/dismiss`, {});
  expect(r.statusCode).toBe(200);
  const row = repos.engagements.findById(e.id)!;
  expect(row.status).toBe('skipped');
  expect(row.skip_reason).toBe('dismissed');
});

test('the engage_* settings are writable', async () => {
  const r = await post('/api/settings', { engage_batch_size: 20, engage_comment_daily_cap: 3 });
  expect(r.statusCode).toBe(200);
  const s = repos.settings.get();
  expect(s.engage_batch_size).toBe(20);
  expect(s.engage_comment_daily_cap).toBe(3);
});

test('/api/status carries the engagement block', async () => {
  await post('/api/engagements', { post_url: POST });
  const r = await app.inject({ method: 'GET', url: '/api/status' });
  expect(r.json().engagements).toMatchObject({
    weekly_cap: 500, comment_daily_cap: 10,
  });
  expect(r.json().engagements.counts).toBeDefined();
});

test('/api/attention tags each row with its source', async () => {
  await post('/api/engagements', { post_url: POST });
  const e = repos.engagements.findByUrn(URN)!;
  repos.engagements.setStatus(e.id, 'failed', { last_error: 'boom' });
  const rows = (await app.inject({ method: 'GET', url: '/api/attention' })).json();
  expect(rows.some((r: { source: string }) => r.source === 'engagement')).toBe(true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/api/engagements.test.ts
```

Expected: FAIL — `POST /api/engagements` 404s.

**Injecting the fetch so tests never hit the network.** `resolveShortlink` takes an optional `fetchImpl`. Thread it through `buildServer`'s existing `opts` object — the same injection pattern `apifyClientFactory` already uses, and for the same reason:

```ts
opts: {
  incidentsDir?: string;
  senderOptions?: Pick<SenderOptions, 'sleep' | 'rng'>;
  apifyClientFactory?: (token: string) => ApifyClient;
  /** Injected so tests never reach the network. Production uses global fetch. */
  fetchImpl?: typeof fetch;
} = {}
```

The route then calls `resolveShortlink(rawUrl, { fetchImpl: opts.fetchImpl })`. In `tests/api/engagements.test.ts`, pass a stub that 301s `https://lnkd.in/good` to the canonical `/feed/update/<URN>/` URL and fails `https://lnkd.in/dead`. **No test may make a real network request** — verify that by construction.

- [ ] **Step 3a: Add `MAX_COMMENT`**

In `src/core/message.ts`, beside the existing constants:

```ts
/** LinkedIn's comment length limit. */
export const MAX_COMMENT = 1250;
```

- [ ] **Step 3b: Add the routes to `src/api/server.ts`**

Extend the imports:

```ts
import {
  normalizeProfileUrl, extractProfileUrls, normalizePostUrl, isShortlink, resolveShortlink,
} from '../core/url.js';
import { parseReaction, DEFAULT_REACTION } from '../core/engagement-action.js';
import { deriveAllowNoNote, MAX_NOTE, MAX_MESSAGE, MAX_COMMENT } from '../core/message.js';
import type { BrowserDriver, CampaignKind, EngagementStatus, ProfileStatus, Settings } from '../types.js';
```

Add the four settings keys to `ALLOWED_SETTINGS_KEYS`:

```ts
  'engage_weekly_cap', 'engage_batch_size', 'engage_batches_per_day',
  'engage_comment_daily_cap',
```

Add the routes. Place them after the events block, before `app.get('/api/metrics', …)`:

```ts
  // --- Post engagements -----------------------------------------------------------------

  type EngagementReject = {
    post_url: string;
    reason: 'invalid_url' | 'shortlink_unresolvable' | 'duplicate' | 'unknown_reaction' | 'comment_too_long';
    /** Human-readable and already specific — it names the offending reaction or limit.
     *  Carried on the reject so the single-item path can send it verbatim as `error`
     *  without re-parsing anything. */
    message: string;
  };

  /**
   * Validate one item without touching the database.
   *
   * Returns either the normalized row to insert or a named reason. Bulk creation reports
   * these by name the way POST /api/events reports its rejected URLs: finding out mid-run
   * that a URL was junk is far too late.
   */
  function validateEngagement(raw: unknown):
    | { ok: true; postUrl: string; postUrn: string; reaction: Reaction; comment: string | null }
    | { ok: false; reject: EngagementReject } {
    const b = (raw ?? {}) as Record<string, unknown>;
    const post_url = typeof b.post_url === 'string' ? b.post_url : '';

    const parsed = parseReaction(b.reaction);
    if (!parsed.ok) {
      return { ok: false, reject: { post_url, reason: 'unknown_reaction', message: parsed.error } };
    }
    const reaction = parsed.reaction ?? DEFAULT_REACTION;

    const post = normalizePostUrl(post_url);
    if (post === null) {
      return { ok: false, reject: { post_url, reason: 'invalid_url', message: 'not a LinkedIn post URL' } };
    }

    // An all-whitespace comment is no comment, not an empty one — a blank comment would
    // otherwise make this a comment-bearing task that publishes nothing.
    const comment = typeof b.comment === 'string' && b.comment.trim() !== '' ? b.comment.trim() : null;
    if (comment !== null && comment.length > MAX_COMMENT) {
      return { ok: false, reject: { post_url, reason: 'comment_too_long',
        message: `comment too long (max ${MAX_COMMENT} characters)` } };
    }

    return { ok: true, postUrl: post.url, postUrn: post.urn, reaction, comment };
  }

  /**
   * Enqueue one engagement, or a batch via `items`.
   *
   * One row per post is the model AND the constraint: LinkedIn permits exactly one reaction
   * per member per post, so a second engagement on the same post is a contradiction rather
   * than a second task. Checked here so it returns a 409 naming the existing row, instead of
   * surfacing as an opaque SQLite constraint error.
   */
  app.post('/api/engagements', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const bulk = Array.isArray(b.items);
    const items = bulk ? (b.items as unknown[]) : [b];

    const rejected: EngagementReject[] = [];
    const created: number[] = [];

    for (const item of items) {
      // Expand a lnkd.in shortlink BEFORE validating. This is the one network call on the
      // enqueue path, and it is deliberate: the probe confirmed lnkd.in is a plain single-hop
      // 301 with no JS interstitial, and shortlinks turn out to be the common real-world
      // paste form (a mobile share sheet produces one). resolveShortlink is bounded and
      // returns null rather than throwing, so a dead or slow link degrades to a named reject.
      let resolved = item;
      const rawUrl = ((item ?? {}) as Record<string, unknown>).post_url;
      if (isShortlink(rawUrl)) {
        const expanded = await resolveShortlink(rawUrl as string);
        if (expanded === null) {
          const reject = {
            post_url: String(rawUrl),
            reason: 'shortlink_unresolvable' as const,
            message: 'that shortened link could not be expanded — paste the full post URL',
          };
          if (!bulk) return reply.code(400).send({ error: reject.message });
          rejected.push(reject);
          continue;
        }
        resolved = { ...(item as Record<string, unknown>), post_url: expanded };
      }

      const v = validateEngagement(resolved);
      if (!v.ok) {
        if (!bulk) return reply.code(400).send({ error: v.reject.message });
        rejected.push(v.reject);
        continue;
      }
      const existing = repos.engagements.findByUrn(v.postUrn);
      if (existing) {
        if (!bulk) {
          return reply.code(409).send({
            error: `this post already has engagement #${existing.id} (${existing.status})`,
          });
        }
        rejected.push({ post_url: v.postUrl, reason: 'duplicate' });
        continue;
      }
      const row = repos.engagements.add(v.postUrl, v.postUrn, v.reaction, v.comment);
      created.push(row.id);
    }

    // Give the new work real slots now rather than leaving it until the hourly planning
    // tick — same reasoning as /api/lists. planAndAssignToday declines on its own while
    // paused, halted, off-hours or on a non-sending day, so this adds no way to slip work
    // past those gates.
    if (created.length > 0) planAndAssignToday(repos, new Date());
    defaultLog.info('api', 'engagements enqueued', { added: created.length, rejected: rejected.length });

    if (bulk) return { added: created.length, rejected };
    const row = repos.engagements.findById(created[0])!;
    return reply.code(201).send({
      id: row.id,
      post_url: row.post_url,
      post_urn: row.post_urn,
      reaction: row.reaction,
      has_comment: row.comment_text !== null,
      status: row.status,
      scheduled_for: row.scheduled_for,
    });
  });

  app.get('/api/engagements', async (req) => {
    const q = req.query as { status?: string; limit?: string };
    const limit = Math.min(500, Math.max(1, Number(q.limit) || 200));
    const rows = q.status
      ? repos.engagements.byStatus(q.status as EngagementStatus)
      : repos.engagements.all();
    return rows.slice(-limit).reverse();
  });

  app.get('/api/engagements/:id', async (req, reply) => {
    const row = repos.engagements.findById(Number((req.params as { id: string }).id));
    if (!row) return reply.code(404).send({ error: 'engagement not found' });
    return row;
  });

  /**
   * Re-queue for a fresh attempt.
   *
   * `needs_attention` is explicitly retryable, and that is the point of parking an
   * unverified comment: the operator checks the post and decides. Retrying a `sent` row
   * would place a second comment on a post that already has one.
   */
  const RETRYABLE_ENGAGEMENTS = new Set<EngagementStatus>(['failed', 'needs_attention', 'skipped']);

  app.post('/api/engagements/:id/retry', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const row = repos.engagements.findById(id);
    if (!row) return reply.code(404).send({ error: 'engagement not found' });
    if (!RETRYABLE_ENGAGEMENTS.has(row.status)) {
      return reply.code(409).send({
        error: `cannot retry a ${row.status} engagement — retry only applies to failed, needs_attention or skipped`,
      });
    }
    repos.engagements.setStatus(id, 'queued', {
      scheduled_for: null, last_error: null, skip_reason: null,
    });
    planAndAssignToday(repos, new Date());
    return { ok: true };
  });

  /** Terminal. Also the cancel path for a row that has not run yet. */
  app.post('/api/engagements/:id/dismiss', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!repos.engagements.findById(id)) return reply.code(404).send({ error: 'engagement not found' });
    repos.engagements.setStatus(id, 'skipped', { last_error: null, skip_reason: 'dismissed' });
    return { ok: true };
  });
```

Add `Reaction` to the type imports at the top of the file.

- [ ] **Step 3c: Add the `/api/status` block**

Inside the `/api/status` return object, after the `event:` line:

```ts
      // The fourth conveyor. All indexed counts, on the same poll as the other three.
      engagements: (() => {
        const dayStart = new Date(now);
        dayStart.setHours(0, 0, 0, 0);
        const weeklyUsed = repos.engagements.countReactedSince(windowStartIso(now));
        const commentsToday = repos.engagements.countCommentedSince(dayStart.toISOString());
        return {
          counts: repos.engagements.countsByStatus(),
          weekly_used: weeklyUsed,
          weekly_cap: s.engage_weekly_cap,
          weekly_remaining: remainingCapacity(s.engage_weekly_cap, weeklyUsed),
          comments_today: commentsToday,
          comment_daily_cap: s.engage_comment_daily_cap,
          // Deliberately the earliest real slot, NOT an estimate. The invite-side forecast
          // pins `at = now` when nothing is scheduled, which reads as an imminent batch when
          // in fact nothing is planned; this pipeline reports null instead.
          next_at: repos.engagements.byStatus('scheduled')
            .map((e) => e.scheduled_for)
            .filter((v): v is string => v !== null)
            .sort()[0] ?? null,
        };
      })(),
```

- [ ] **Step 3d: Extend `/api/attention`**

Replace the handler:

```ts
  // Problem rows for the Attention tab: failed + needs_attention, from both the profile
  // pipelines and the engagement pipeline. `source` discriminates them — the two have
  // different identifying columns, so the client cannot infer it.
  app.get('/api/attention', async () => {
    const profiles = repos.db.prepare(`
      SELECT p.id, p.profile_url, p.kind, p.status, p.last_error, p.attempts,
             p.sent_at, p.scheduled_for, c.name AS cohort_name
      FROM profiles p JOIN cohorts c ON c.id = p.cohort_id
      WHERE p.status IN ('failed','needs_attention')
      ORDER BY p.id DESC
    `).all() as Record<string, unknown>[];
    const engagements = repos.db.prepare(`
      SELECT id, post_url, post_urn, reaction, comment_text, status, last_error, attempts,
             reacted_at, commented_at, scheduled_for
      FROM engagements
      WHERE status IN ('failed','needs_attention')
      ORDER BY id DESC
    `).all() as Record<string, unknown>[];
    return [
      ...profiles.map((p) => ({ ...p, source: 'profile' })),
      ...engagements.map((e) => ({ ...e, source: 'engagement' })),
    ];
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run tests/api/engagements.test.ts
```

Expected: PASS (19 tests).

```bash
npm test && npm run typecheck
```

Expected: whole suite green. `tests/api/server.test.ts` may assert on the `/api/attention` shape — if it does, update it to expect the `source` field rather than weakening the new test.

- [ ] **Step 5: Commit**

```bash
git add src/api/server.ts src/core/message.ts tests/api/engagements.test.ts
git commit -m "feat(engagements): expose the engagement pipeline over the API"
```

---

## Task 14: Read-only dashboard card

**Files:**
- Modify: `src/web/index.html`, `src/web/app.js`, `src/web/styles.css`

There is no automated test for this — the repo has no DOM test harness for `app.js`. Verification is by eye in Step 4.

- [ ] **Step 1: Read the event card as the pattern**

```bash
grep -n "renderEventGroup\|ev-card" src/web/app.js
```

Read that function and the `#tab-events` section in `index.html`. The engagement card mirrors its structure, class-naming and polling behaviour. Do not invent a new visual language.

- [ ] **Step 2: Add the markup**

In `index.html`, add a card to the dashboard beside the existing conveyors:

- Heading: "Engagements"
- A count row for: queued, scheduled, sent, needs attention, failed
- "This week: `<weekly_used>` / `<weekly_cap>`"
- "Comments today: `<comments_today>` / `<comment_daily_cap>`"
- Next scheduled time, or the literal text "Not scheduled" when `next_at` is null
- A list of up to five upcoming rows: time, reaction name, a "+ comment" marker when the row carries one, and the post URL as a link

Add the four `engage_*` inputs to the Settings panel beside the `event_*` ones, following the same `<div class="field">` markup.

- [ ] **Step 3: Render from the existing status poll**

`/api/status` already returns everything the card needs under `engagements` — do **not** add a second poll. Bind:

```js
// status.engagements = {
//   counts: { queued?, scheduled?, sending?, sent?, skipped?, failed?, needs_attention? },
//   weekly_used, weekly_cap, weekly_remaining,
//   comments_today, comment_daily_cap,
//   next_at: string | null
// }
```

`next_at` is null when nothing is scheduled. Render "Not scheduled" — never a time. This is deliberate: the invite-side next-batch pill has a known bug where an estimated forecast pins `at = now`, so an unplanned queue advertises an imminent batch. Do not copy that behaviour here.

In the attention list renderer, branch on `row.source`: `'profile'` rows keep the current rendering; `'engagement'` rows show the post URL, the reaction, and whether a comment was pending.

- [ ] **Step 4: Verify by eye**

```bash
npm start
```

Open the dashboard. Confirm:
1. The card renders with all-zero counts on an empty database and reads "Not scheduled".
2. `curl -X POST localhost:<port>/api/engagements -H 'content-type: application/json' -d '{"post_url":"https://www.linkedin.com/feed/update/urn:li:activity:7123456789012345678/","reaction":"insightful"}'` makes the queued count go to 1 within one poll.
3. The four new settings inputs save and survive a reload.

Stop the server gracefully — `.linkedin-profile` is single-instance and force-killing it orphans the browser.

- [ ] **Step 5: Commit**

```bash
git add src/web/index.html src/web/app.js src/web/styles.css
git commit -m "feat(engagements): show the engagement pipeline on the dashboard"
```

---

## Task 15: Live verification

**Files:**
- Create: `scripts/verify-post-engage.ts`

- [ ] **Step 1: Write the verification script**

Model it on `scripts/verify-event-invite.ts`. It must:
- take a post URL and a reaction as `process.argv[2]` / `[3]`
- take `--comment "<text>"` optionally
- build a real `LinkedInDriver`, call `reactToPost`, print the outcome, then call `commentOnPost` if a comment was supplied
- print the resulting `EngagementOutcome` objects verbatim

- [ ] **Step 2: Verify a reaction on your own post**

Stop the Relay server first.

```bash
npx tsx scripts/verify-post-engage.ts "<url-of-your-own-post>" insightful
```

Expected: `{ result: 'done' }`, and the reaction visible on the post in a browser.

- [ ] **Step 3: Verify idempotency**

Re-run the identical command.

Expected: `{ result: 'already', existingReaction: 'insightful' }` — and crucially the reaction must be **unchanged**, not re-placed.

- [ ] **Step 4: Verify a comment, and the terminal cases**

```bash
npx tsx scripts/verify-post-engage.ts "<url-of-your-own-post>" like --comment "Testing Relay engagements."
```

Expected: `{ result: 'done' }` and the comment visible on the post. Delete it by hand afterwards.

Then check the two terminal paths:
- a deleted or private post URL → `{ result: 'not_found' }`
- a post with commenting restricted → `{ result: 'comments_disabled' }`

- [ ] **Step 5: Record the results and commit**

Add a short "Live verification (2026-08-02)" note to the spec recording which cases were confirmed and any behaviour that differed from the design.

```bash
git add scripts/verify-post-engage.ts docs/superpowers/specs/2026-08-02-engagements-pipeline-design.md
git commit -m "test(engagements): verify reactions and comments against a live post"
```

---

## Final verification

- [ ] **Full suite and typecheck**

```bash
npm test && npm run typecheck
```

Expected: every test passing, no type errors, and the Task 7 snapshot unchanged.

- [ ] **Confirm the planner regression never moved**

```bash
git log --oneline -- tests/worker/__snapshots__/plan-queue-regression.test.ts.snap
```

Expected: exactly one commit — the one from Task 7 Step 2. If the snapshot was ever regenerated, the refactor changed planner behaviour and that needs explaining before merge.
