# Message Campaigns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add automated message-sending to existing 1st-degree connections as a second campaign kind — same queue/batch/cohort machinery, separate pacing caps, reply tracking, and a second conveyor on the dashboard.

**Architecture:** A cohort (and denormalized onto each profile) carries `kind: 'invite' | 'message'`. The scheduler and sender run once per kind with per-kind caps; a new reply-checker worker mirrors the acceptance-checker (slot-gated inbox scan). The browser driver gains `sendMessage` (compose deep-link route, live-verified 2026-07-28) and `readInboxSnapshot`. Spec: `docs/superpowers/specs/2026-07-28-message-campaigns-design.md`.

**Tech Stack:** Node 22 (`node:sqlite`), TypeScript ESM, Fastify, playwright-core via cloakbrowser, vitest, vanilla-JS frontend (`src/web/`).

**Execution notes:**
- Run all commands from the repo root. Tests: `npx vitest run <file>` (or `npm test` for all). Typecheck: `npm run typecheck`.
- `data/app.db` is PRODUCTION. Never seed test data into it; unit tests use `openDatabase(':memory:')`.
- Live browser verification (Task 12) may only message `https://www.linkedin.com/in/keren-tevet-3453a079` — never anyone else.
- User preference (memory): UI tasks (13–15) should be executed by an Opus subagent with the `frontend-design` skill; mechanical tasks can use Sonnet. Verify e2e before merge.
- Commit after every task (steps include the commands).

---

## File Structure

| File | Change |
|---|---|
| `src/types.ts` | `CampaignKind`, `kind`/`full_name`/`thread_url`/`replied_at` fields, `replied` status, `not_connected` skip reason + send result, driver interface additions |
| `src/db/schema.sql` | New columns on cohorts/profiles/settings/app_state; `UNIQUE(profile_url, kind)` |
| `src/db/database.ts` | Migrations incl. profiles-table rebuild for the uniqueness change |
| `src/db/repositories.ts` | Kind-aware add/dedupe/queries; new columns whitelisted; `setRepliesChecked` |
| `src/core/caps.ts` (new) | `capsFor(settings, kind)` → the per-kind pacing numbers |
| `src/core/message.ts` | Length limit parameterized (300 note / 2000 message) |
| `src/core/metrics.ts` | `kind`, `replied`, `reply_rate`, `median_time_to_reply_days` |
| `src/core/daily-budget.ts` | Per-kind daily target/committed/remaining |
| `src/worker/scheduler-service.ts` | Plan both kinds per tick |
| `src/worker/sender.ts` | Message pass alongside the invite pass |
| `src/worker/reply-checker.ts` (new) | Slot-gated inbox scan → `replied` |
| `src/worker/orchestrator.ts` | Reply tick (reuses `acceptanceSlot`) |
| `src/browser/driver.ts` | FakeDriver: `sendMessage`, `readInboxSnapshot` |
| `src/browser/linkedin-selectors.ts` | Messaging selectors + compose-link helpers |
| `src/browser/linkedin-driver.ts` | `sendMessage`, `readInboxSnapshot` |
| `src/api/server.ts` | kind on lists/profiles/cohorts, per-kind status, metrics, recheck-replies, settings keys, kind filter on drill-down |
| `src/web/index.html` | Second (messages) conveyor, Add-List kind toggle, message metrics table, settings block |
| `src/web/app.js` | Render both engines, kind-aware forms/tables/drawers |
| `src/web/styles.css` | Message-engine accent, idle-collapse, kind badges |
| `API.md`, `README.md` | Document the new kind, endpoints, settings |

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
import { DatabaseSync } from 'node:sqlite';
import { runMigrations, openDatabase } from '../../src/db/database.js';
import { test, expect } from 'vitest';

test('migrates a pre-kind database: adds kind columns and rebuilds profiles uniqueness', () => {
  const db = new DatabaseSync(':memory:');
  // Minimal pre-messaging schema (what a 2026-07 production DB looks like).
  db.exec(`
    CREATE TABLE cohorts (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
      message_template TEXT, allow_no_note INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE profiles (id INTEGER PRIMARY KEY AUTOINCREMENT,
      cohort_id INTEGER NOT NULL REFERENCES cohorts(id), profile_url TEXT NOT NULL UNIQUE,
      first_name TEXT, custom_message TEXT, status TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, skip_reason TEXT,
      scheduled_for TEXT, sent_at TEXT, accepted_at TEXT, resolved_at TEXT,
      priority INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO cohorts (name) VALUES ('old');
    INSERT INTO profiles (cohort_id, profile_url, status) VALUES (1, 'https://www.linkedin.com/in/x', 'accepted');
  `);
  runMigrations(db);
  const cohortCols = (db.prepare('PRAGMA table_info(cohorts)').all() as { name: string }[]).map((c) => c.name);
  expect(cohortCols).toContain('kind');
  const profCols = (db.prepare('PRAGMA table_info(profiles)').all() as { name: string }[]).map((c) => c.name);
  for (const col of ['kind', 'full_name', 'thread_url', 'replied_at']) expect(profCols).toContain(col);
  // Row survived the rebuild with its id and status, defaulted to kind 'invite'.
  const row = db.prepare('SELECT * FROM profiles WHERE id = 1').get() as any;
  expect(row.status).toBe('accepted');
  expect(row.kind).toBe('invite');
  // Same URL is now insertable under kind 'message', but not twice under 'invite'.
  db.prepare("INSERT INTO profiles (cohort_id, profile_url, kind) VALUES (1, 'https://www.linkedin.com/in/x', 'message')").run();
  expect(() =>
    db.prepare("INSERT INTO profiles (cohort_id, profile_url, kind) VALUES (1, 'https://www.linkedin.com/in/x', 'invite')").run(),
  ).toThrow();
});

test('fresh database has message settings defaults and replies_checked_at', () => {
  const db = openDatabase(':memory:');
  const s = db.prepare('SELECT * FROM settings WHERE id = 1').get() as any;
  expect(s.msg_weekly_cap).toBe(200);
  expect(s.msg_batch_size).toBe(5);
  expect(s.msg_batches_per_day).toBe(4);
  expect(s.reply_checks_per_day).toBe(2);
  const a = db.prepare('SELECT * FROM app_state WHERE id = 1').get() as any;
  expect(a.replies_checked_at).toBeNull();
});
```

(If those imports already exist at the top of the file, don't duplicate them.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/db/database.test.ts`
Expected: FAIL (missing `kind` column and settings defaults).

- [ ] **Step 3: Update `src/types.ts`**

Apply these changes:

```ts
export type CampaignKind = 'invite' | 'message';

export type ProfileStatus =
  | 'queued' | 'scheduled' | 'sending' | 'sent'
  | 'accepted' | 'replied' | 'expired' | 'skipped' | 'failed' | 'needs_attention';

/** Why a skipped profile was skipped (terminal — the engine never retries these). */
export type SkipReason =
  | 'already_connected' | 'email_required' | 'not_found' | 'unavailable' | 'dismissed'
  | 'not_connected';

export type EventType = 'sent' | 'accepted' | 'replied' | 'expired' | 'skipped' | 'failed';
```

Add to `Cohort`: `kind: CampaignKind;` (after `name`).
Add to `Profile`: `kind: CampaignKind;` (after `cohort_id`), and `full_name: string | null; thread_url: string | null; replied_at: string | null;` (after `accepted_at`).
Add to `Settings`: `msg_weekly_cap: number; msg_batch_size: number; msg_batches_per_day: number; reply_checks_per_day: number;` (after `acceptance_checks_per_day`).
Add to `AppState`: `replies_checked_at: string | null;` (after `acceptance_checked_at`).
Extend `SendResult` with `| 'not_connected'`.
Add to `SendOutcome`: `fullName?: string; threadUrl?: string;`.
Add to `BrowserDriver` (after `sendConnectionRequest`):

```ts
  /** Send a plain message to an existing 1st-degree connection. `message` still
   *  contains {firstName}; the driver substitutes the live name it reads. */
  sendMessage(url: string, message: string): Promise<SendOutcome>;
  /** One-page scan of the messaging inbox conversation list. */
  readInboxSnapshot(): Promise<InboxRow[]>;
```

And the row type (top-level, near `LoginSnapshot`):

```ts
/** One conversation row from the messaging inbox list. */
export interface InboxRow {
  name: string;        // participant display name as rendered
  snippet: string;     // last-message preview text
  youSentLast: boolean; // snippet started with the "You:" prefix
}
```

- [ ] **Step 4: Update `src/db/schema.sql`**

Cohorts — add after `name`:

```sql
  kind TEXT NOT NULL DEFAULT 'invite',
```

Profiles — the table becomes (full replacement; note the composite UNIQUE moves to a table constraint):

```sql
CREATE TABLE IF NOT EXISTS profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cohort_id INTEGER NOT NULL REFERENCES cohorts(id),
  kind TEXT NOT NULL DEFAULT 'invite',
  profile_url TEXT NOT NULL,
  first_name TEXT,
  full_name TEXT,
  custom_message TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  -- Why a skipped profile was skipped: already_connected | email_required |
  -- unavailable | dismissed | not_found | not_connected. NULL for legacy rows.
  skip_reason TEXT,
  scheduled_for TEXT,
  sent_at TEXT,
  accepted_at TEXT,
  replied_at TEXT,
  resolved_at TEXT,
  thread_url TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (profile_url, kind)
);
```

Settings — add after `acceptance_checks_per_day`:

```sql
  msg_weekly_cap INTEGER NOT NULL DEFAULT 200,
  msg_batch_size INTEGER NOT NULL DEFAULT 5,
  msg_batches_per_day INTEGER NOT NULL DEFAULT 4,
  -- Reply-check passes per day (messages funnel), same slot mechanism as acceptance.
  reply_checks_per_day INTEGER NOT NULL DEFAULT 2,
```

App state — add after `acceptance_checked_at`:

```sql
  replies_checked_at TEXT
```

(mind the comma on the previous line).

- [ ] **Step 5: Add migrations to `src/db/database.ts`**

Append inside `runMigrations`, after the existing cohort `archived` block:

```ts
  // --- Message campaigns (2026-07-28) ---
  if (cohortCols.length > 0 && !cohortCols.includes('kind')) {
    db.exec("ALTER TABLE cohorts ADD COLUMN kind TEXT NOT NULL DEFAULT 'invite'");
  }
  if (cols.length > 0 && !cols.includes('msg_weekly_cap')) {
    db.exec('ALTER TABLE settings ADD COLUMN msg_weekly_cap INTEGER NOT NULL DEFAULT 200');
    db.exec('ALTER TABLE settings ADD COLUMN msg_batch_size INTEGER NOT NULL DEFAULT 5');
    db.exec('ALTER TABLE settings ADD COLUMN msg_batches_per_day INTEGER NOT NULL DEFAULT 4');
    db.exec('ALTER TABLE settings ADD COLUMN reply_checks_per_day INTEGER NOT NULL DEFAULT 2');
  }
  if (appCols.length > 0 && !appCols.includes('replies_checked_at')) {
    db.exec('ALTER TABLE app_state ADD COLUMN replies_checked_at TEXT');
  }
  // profiles: kind/full_name/thread_url/replied_at + UNIQUE(profile_url) -> UNIQUE(profile_url, kind).
  // SQLite cannot alter a column-level UNIQUE, so rebuild the table once. Detection: the
  // kind column is absent exactly on pre-messaging databases. IDs are preserved, so
  // send_log/profile_events FKs stay valid; FKs are suspended for the swap.
  if (profileCols.length > 0 && !profileCols.includes('kind')) {
    db.exec('PRAGMA foreign_keys = OFF;');
    db.exec(`
      CREATE TABLE profiles_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cohort_id INTEGER NOT NULL REFERENCES cohorts(id),
        kind TEXT NOT NULL DEFAULT 'invite',
        profile_url TEXT NOT NULL,
        first_name TEXT,
        full_name TEXT,
        custom_message TEXT,
        status TEXT NOT NULL DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        skip_reason TEXT,
        scheduled_for TEXT,
        sent_at TEXT,
        accepted_at TEXT,
        replied_at TEXT,
        resolved_at TEXT,
        thread_url TEXT,
        priority INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (profile_url, kind)
      );
      INSERT INTO profiles_new (id, cohort_id, profile_url, first_name, custom_message, status,
        attempts, last_error, skip_reason, scheduled_for, sent_at, accepted_at, resolved_at,
        priority, created_at)
      SELECT id, cohort_id, profile_url, first_name, custom_message, status,
        attempts, last_error, skip_reason, scheduled_for, sent_at, accepted_at, resolved_at,
        priority, created_at FROM profiles;
      DROP TABLE profiles;
      ALTER TABLE profiles_new RENAME TO profiles;
      CREATE INDEX IF NOT EXISTS idx_profiles_status ON profiles(status);
      CREATE INDEX IF NOT EXISTS idx_profiles_cohort ON profiles(cohort_id);
    `);
    db.exec('PRAGMA foreign_keys = ON;');
  }
```

Note: `profileCols` was computed BEFORE this block in the existing function — that's the pre-migration column list, which is exactly what the detection needs. Do not recompute it.

- [ ] **Step 6: Run tests**

Run: `npx vitest run tests/db/database.test.ts`
Expected: PASS (all, including pre-existing tests).

- [ ] **Step 7: Typecheck and fix fallout**

Run: `npm run typecheck`
Expected: errors only where new Settings/Profile fields are missing from test fixtures or object literals, if any — fix those; no logic changes.

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/db/schema.sql src/db/database.ts tests/db/database.test.ts
git commit -m "feat: campaign kind schema — cohort/profile kind, message settings, reply columns, per-kind uniqueness"
```

---

### Task 2: Kind-aware repositories

**Files:**
- Modify: `src/db/repositories.ts`
- Test: `tests/db/repositories.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `tests/db/repositories.test.ts` (reuse the file's existing `repos` setup pattern — it builds `new Repos(openDatabase(':memory:'))` in `beforeEach`):

```ts
test('cohort kind: create carries kind; getOrCreate defaults to invite', () => {
  const m = repos.cohorts.create('Msgs Q3', 'Hey {firstName}', true, 'message');
  expect(m.kind).toBe('message');
  const i = repos.cohorts.getOrCreate('Inv Q3', null, true);
  expect(i.kind).toBe('invite');
});

test('profile add dedupes per (url, kind) and stamps the cohort kind', () => {
  const inv = repos.cohorts.create('I', null, true);
  const msg = repos.cohorts.create('M', 'hi', true, 'message');
  const a = repos.profiles.add(inv.id, 'https://www.linkedin.com/in/x', null);
  const b = repos.profiles.add(msg.id, 'https://www.linkedin.com/in/x', null, 'message');
  expect(a.id).not.toBe(b.id);
  expect(a.kind).toBe('invite');
  expect(b.kind).toBe('message');
  // Same (url, kind) returns the existing row.
  expect(repos.profiles.add(msg.id, 'https://www.linkedin.com/in/x', null, 'message').id).toBe(b.id);
});

test('byStatusKind filters by kind; setStatus accepts the new columns', () => {
  const msg = repos.cohorts.create('M', 'hi', true, 'message');
  const p = repos.profiles.add(msg.id, 'https://www.linkedin.com/in/y', null, 'message');
  repos.profiles.setStatus(p.id, 'sent', {
    sent_at: '2026-07-28T10:00:00.000Z', full_name: 'Y Person', thread_url: 'https://www.linkedin.com/messaging/thread/t1/',
  });
  expect(repos.profiles.byStatusKind('sent', 'message')).toHaveLength(1);
  expect(repos.profiles.byStatusKind('sent', 'invite')).toHaveLength(0);
  repos.profiles.setStatus(p.id, 'replied', { replied_at: '2026-07-29T10:00:00.000Z', resolved_at: '2026-07-29T10:00:00.000Z' });
  expect(repos.profiles.findById(p.id)!.replied_at).toBe('2026-07-29T10:00:00.000Z');
});

test('countSentSince counts per kind via the profile join', () => {
  const inv = repos.cohorts.create('I', null, true);
  const msg = repos.cohorts.create('M', 'hi', true, 'message');
  const a = repos.profiles.add(inv.id, 'https://www.linkedin.com/in/a', null);
  const b = repos.profiles.add(msg.id, 'https://www.linkedin.com/in/b', null, 'message');
  repos.events.recordSend(a.id, 'sent');
  repos.events.recordSend(b.id, 'sent');
  expect(repos.events.countSentSince('1970-01-01T00:00:00Z', 'invite')).toBe(1);
  expect(repos.events.countSentSince('1970-01-01T00:00:00Z', 'message')).toBe(1);
});

test('appState.setRepliesChecked stamps replies_checked_at', () => {
  repos.appState.setRepliesChecked('2026-07-28T12:00:00.000Z');
  expect(repos.appState.get().replies_checked_at).toBe('2026-07-28T12:00:00.000Z');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/db/repositories.test.ts`
Expected: FAIL (`create` arity, `byStatusKind` undefined, etc.).

- [ ] **Step 3: Implement in `src/db/repositories.ts`**

Import `CampaignKind` from types. Update the whitelist:

```ts
const PROFILE_COLUMNS = new Set([
  'first_name', 'full_name', 'custom_message', 'attempts', 'last_error', 'skip_reason',
  'scheduled_for', 'sent_at', 'accepted_at', 'replied_at', 'resolved_at', 'thread_url',
]);
const SETTINGS_COLUMNS = new Set([
  'workday_start_hour', 'workday_end_hour', 'weekdays_only', 'weekly_cap',
  'batch_size', 'batches_per_day', 'acceptance_checks_per_day',
  'msg_weekly_cap', 'msg_batch_size', 'msg_batches_per_day', 'reply_checks_per_day',
  'note_quota_exhausted', 'min_delay_ms', 'max_delay_ms', 'paused', 'pause_reason',
  'onboarded', 'failure_threshold', 'expiry_days',
]);
```

`CohortRepo.create` and `getOrCreate` gain a trailing `kind: CampaignKind = 'invite'` parameter:

```ts
  create(name: string, template: string | null, allowNoNote: boolean, kind: CampaignKind = 'invite'): Cohort {
    this.db.prepare(
      'INSERT INTO cohorts (name, message_template, allow_no_note, kind) VALUES (?, ?, ?, ?)',
    ).run(name, template, allowNoNote ? 1 : 0, kind);
    return this.findByName(name)!;
  }
  // getOrCreate: pass kind through to create(); resurrection path unchanged (kind is fixed at creation).
```

`ProfileRepo.add` gains `kind: CampaignKind = 'invite'` and dedupes per (url, kind):

```ts
  add(cohortId: number, normalizedUrl: string, customMessage: string | null, kind: CampaignKind = 'invite'): Profile {
    const existing = this.db
      .prepare('SELECT * FROM profiles WHERE profile_url = ? AND kind = ?')
      .get(normalizedUrl, kind) as unknown as Profile | undefined;
    if (existing) return existing;
    this.db.prepare(
      'INSERT INTO profiles (cohort_id, profile_url, custom_message, kind) VALUES (?, ?, ?, ?)',
    ).run(cohortId, normalizedUrl, customMessage, kind);
    return this.db.prepare('SELECT * FROM profiles WHERE profile_url = ? AND kind = ?')
      .get(normalizedUrl, kind) as unknown as Profile;
  }
```

Add to `ProfileRepo`:

```ts
  byStatusKind(status: ProfileStatus, kind: CampaignKind): Profile[] {
    return this.db.prepare('SELECT * FROM profiles WHERE status = ? AND kind = ? ORDER BY id')
      .all(status, kind) as unknown as Profile[];
  }
  queuedByPriorityKind(kind: CampaignKind): Profile[] {
    return this.db.prepare("SELECT * FROM profiles WHERE status='queued' AND kind = ? ORDER BY priority, id")
      .all(kind) as unknown as Profile[];
  }
```

`EventRepo.countSentSince` becomes kind-aware (update ALL existing callers in this task only where the compiler forces it — `sender.ts`, `scheduler-service.ts`, `server.ts` pass `'invite'` for now; later tasks parameterize them):

```ts
  countSentSince(iso: string, kind: CampaignKind): number {
    return (this.db.prepare(`
      SELECT COUNT(*) c FROM send_log s JOIN profiles p ON p.id = s.profile_id
      WHERE s.outcome='sent' AND s.at >= ? AND p.kind = ?`).get(iso, kind) as unknown as { c: number }).c;
  }
```

Add to `AppStateRepo`:

```ts
  setRepliesChecked(iso: string): void {
    this.db.prepare('UPDATE app_state SET replies_checked_at = ? WHERE id = 1').run(iso);
  }
```

- [ ] **Step 4: Run tests + typecheck; fix forced call sites**

Run: `npx vitest run tests/db/repositories.test.ts && npm run typecheck`
Expected: repo tests PASS. Typecheck errors at `countSentSince` call sites (`src/worker/sender.ts:42`, `src/worker/scheduler-service.ts:43`, `src/api/server.ts:85`) — append `, 'invite'` at each. Then `npm test` — all green.

- [ ] **Step 5: Commit**

```bash
git add src/db/repositories.ts src/worker/sender.ts src/worker/scheduler-service.ts src/api/server.ts tests/db/repositories.test.ts
git commit -m "feat: kind-aware repositories — per-kind dedupe, queries, sent counts, replies stamp"
```

---

### Task 3: Core helpers — caps, message length, metrics

**Files:**
- Create: `src/core/caps.ts`
- Modify: `src/core/message.ts`
- Modify: `src/core/metrics.ts`
- Test: `tests/core/caps.test.ts` (new), `tests/core/message.test.ts` (append), `tests/core/metrics.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

`tests/core/caps.test.ts`:

```ts
import { test, expect } from 'vitest';
import { capsFor } from '../../src/core/caps.js';

const settings = {
  weekly_cap: 100, batch_size: 5, batches_per_day: 4,
  msg_weekly_cap: 200, msg_batch_size: 7, msg_batches_per_day: 3,
} as any;

test('capsFor returns the invite numbers for invite', () => {
  expect(capsFor(settings, 'invite')).toEqual({ weeklyCap: 100, batchSize: 5, batchesPerDay: 4 });
});

test('capsFor returns the message numbers for message', () => {
  expect(capsFor(settings, 'message')).toEqual({ weeklyCap: 200, batchSize: 7, batchesPerDay: 3 });
});
```

Append to `tests/core/message.test.ts`:

```ts
test('applyFirstName honors a custom max length (messages are 2000, notes 300)', () => {
  const long = 'x'.repeat(2500);
  expect(applyFirstName(long, 'A').length).toBe(300);
  expect(applyFirstName(long, 'A', 2000).length).toBe(2000);
});
```

Append to `tests/core/metrics.test.ts`:

```ts
test('message cohorts report replied counts, reply rate, and median days to reply', () => {
  const rows = [
    { cohort_id: 9, cohort_name: 'M', kind: 'message', status: 'replied', sent_at: '2026-07-01T00:00:00Z', accepted_at: null, replied_at: '2026-07-03T00:00:00Z' },
    { cohort_id: 9, cohort_name: 'M', kind: 'message', status: 'sent', sent_at: '2026-07-02T00:00:00Z', accepted_at: null, replied_at: null },
    { cohort_id: 9, cohort_name: 'M', kind: 'message', status: 'skipped', sent_at: null, accepted_at: null, replied_at: null },
  ];
  const [m] = computeCohortMetrics(rows as any);
  expect(m.kind).toBe('message');
  expect(m.replied).toBe(1);
  expect(m.pending).toBe(1);
  expect(m.reply_rate).toBeCloseTo(0.5);
  expect(m.median_time_to_reply_days).toBe(2);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/core/caps.test.ts tests/core/message.test.ts tests/core/metrics.test.ts`
Expected: FAIL (module missing, arity, fields missing).

- [ ] **Step 3: Implement**

`src/core/caps.ts`:

```ts
import type { Settings, CampaignKind } from '../types.js';

export interface KindCaps { weeklyCap: number; batchSize: number; batchesPerDay: number; }

/** The pacing numbers for a campaign kind. Working hours/weekday rules stay shared. */
export function capsFor(s: Settings, kind: CampaignKind): KindCaps {
  return kind === 'message'
    ? { weeklyCap: s.msg_weekly_cap, batchSize: s.msg_batch_size, batchesPerDay: s.msg_batches_per_day }
    : { weeklyCap: s.weekly_cap, batchSize: s.batch_size, batchesPerDay: s.batches_per_day };
}
```

`src/core/message.ts` — parameterize the limit and export both constants:

```ts
export const MAX_NOTE = 300;
export const MAX_MESSAGE = 2000;

/** Substitute {firstName} (falling back to 'there') and truncate to the length limit
 *  (300 for invite notes; pass MAX_MESSAGE for direct messages). */
export function applyFirstName(text: string, firstName: string | null, max: number = MAX_NOTE): string {
  return text.replace(/\{firstName\}/g, (firstName ?? '').trim() || 'there').slice(0, max);
}
```

(Remove the old `const MAX_NOTE = 300;` line; other exports unchanged.)

`src/core/metrics.ts` — extend the row and output types and computation:

```ts
export interface MetricRow {
  cohort_id: number;
  cohort_name: string;
  kind: string;
  status: string;
  sent_at: string | null;
  accepted_at: string | null;
  replied_at: string | null;
}

export interface CohortMetrics {
  cohort_id: number;
  cohort_name: string;
  kind: string;
  total: number;
  sent: number;
  pending: number;
  accepted: number;
  replied: number;
  expired: number;
  skipped: number;
  acceptance_rate: number;
  reply_rate: number;
  median_time_to_accept_days: number | null;
  median_time_to_reply_days: number | null;
}
```

In `computeCohortMetrics`, inside the per-group loop add:

```ts
    const replied = grp.filter((r) => r.status === 'replied').length;
    const msgAttempted = replied + pending; // messages have no expiry
    const ttrDays = grp
      .filter((r) => r.status === 'replied' && r.sent_at && r.replied_at)
      .map((r) => (new Date(r.replied_at!).getTime() - new Date(r.sent_at!).getTime()) / 86400000);
```

and extend the pushed object:

```ts
      kind: grp[0].kind,
      replied,
      sent: grp[0].kind === 'message' ? msgAttempted : attempted,
      reply_rate: msgAttempted > 0 ? replied / msgAttempted : 0,
      median_time_to_reply_days: median(ttrDays),
```

(keeping every existing field; `sent` for invite cohorts is unchanged).

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run tests/core && npm run typecheck`
Expected: PASS. If `/api/metrics` SQL in `server.ts` now type-errors on MetricRow, extend that SELECT with `p.kind, p.replied_at` (it must anyway — done properly in Task 10, minimal fix now).

- [ ] **Step 5: Commit**

```bash
git add src/core/caps.ts src/core/message.ts src/core/metrics.ts src/api/server.ts tests/core
git commit -m "feat: per-kind caps helper, message length limit, reply metrics"
```

---

### Task 4: Per-kind daily budget

**Files:**
- Modify: `src/core/daily-budget.ts`
- Test: `tests/core/daily-budget.test.ts` (update + append)

- [ ] **Step 1: Write the failing test**

Append to `tests/core/daily-budget.test.ts`:

```ts
test('daily budget is computed per kind from that kind caps and rows', () => {
  const repos = new Repos(openDatabase(':memory:'));
  repos.settings.update({ batches_per_day: 2, batch_size: 3, msg_batches_per_day: 4, msg_batch_size: 5 });
  const inv = repos.cohorts.create('I', null, true);
  const msg = repos.cohorts.create('M', 'hi', true, 'message');
  const pi = repos.profiles.add(inv.id, 'https://www.linkedin.com/in/i1', null);
  const pm = repos.profiles.add(msg.id, 'https://www.linkedin.com/in/m1', null, 'message');
  repos.profiles.setScheduled(pi.id, '2026-07-28T09:00:00.000Z');
  repos.profiles.setScheduled(pm.id, '2026-07-28T09:00:00.000Z');
  const now = new Date('2026-07-28T10:00:00');
  const s = repos.settings.get();
  expect(dailyTargetFor(s, 'invite')).toBe(6);
  expect(dailyTargetFor(s, 'message')).toBe(20);
  expect(dailyRemainingFor(repos, s, now, 'invite')).toBe(5);   // 6 - 1 scheduled invite
  expect(dailyRemainingFor(repos, s, now, 'message')).toBe(19); // 20 - 1 scheduled message
});
```

(Add the `Repos`/`openDatabase` imports if the file lacks them, and `dailyTargetFor`/`dailyRemainingFor` are already imported by the existing tests.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/core/daily-budget.test.ts`
Expected: FAIL (arity).

- [ ] **Step 3: Implement in `src/core/daily-budget.ts`**

```ts
import type { Repos } from '../db/repositories.js';
import type { Settings, CampaignKind } from '../types.js';
import { capsFor } from './caps.js';

/** Intended sends per day for a kind: batchesPerDay * batchSize (batchSize floored at 1). */
export function dailyTargetFor(s: Settings, kind: CampaignKind): number {
  const caps = capsFor(s, kind);
  return Math.max(0, caps.batchesPerDay * Math.max(1, caps.batchSize));
}

/**
 * How many sends today's quota has already committed FOR THIS KIND: profiles still
 * scheduled plus profiles already sent today. Subtracting this from the daily target
 * keeps repeated planning runs (startup + hourly) from stacking past the daily cap.
 */
export function committedToday(repos: Repos, now: Date, kind: CampaignKind): number {
  const dayStart = new Date(now);
  // Local day boundary on purpose: mirrors the scheduler's local-time working-hours window.
  dayStart.setHours(0, 0, 0, 0);
  const startIso = dayStart.toISOString();
  const scheduled = repos.profiles.byStatusKind('scheduled', kind).length;
  const sentToday = repos.profiles.all()
    .filter((p) => p.kind === kind && p.sent_at !== null && p.sent_at >= startIso).length;
  return scheduled + sentToday;
}

/** Remaining daily quota for the kind, never negative. */
export function dailyRemainingFor(repos: Repos, s: Settings, now: Date, kind: CampaignKind): number {
  return Math.max(0, dailyTargetFor(s, kind) - committedToday(repos, now, kind));
}
```

- [ ] **Step 4: Fix forced call sites, run tests**

Callers to update with an explicit kind: `src/worker/scheduler-service.ts` (`dailyRemainingFor(repos, s, now, 'invite')` for now), `src/api/server.ts` (`dailyRemainingFor(repos, s, now, 'invite')`), `src/core/forecast.ts` (`dailyTargetFor` — give `dailySendRate` a `kind` parameter defaulting to `'invite'`: `function dailySendRate(s: Settings, kind: CampaignKind = 'invite')` and pass through from its exported callers with a default so existing behavior is unchanged).

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/daily-budget.ts src/core/forecast.ts src/worker/scheduler-service.ts src/api/server.ts tests/core/daily-budget.test.ts
git commit -m "feat: per-kind daily budget"
```

---

### Task 5: Scheduler plans both kinds

**Files:**
- Modify: `src/worker/scheduler-service.ts`
- Test: `tests/worker/scheduler-service.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/worker/scheduler-service.test.ts` (mirror the file's existing setup helpers):

```ts
test('planAndAssignToday schedules invite and message queues independently with their own caps', () => {
  const repos = new Repos(openDatabase(':memory:'));
  repos.settings.update({
    weekly_cap: 100, batch_size: 2, batches_per_day: 1,
    msg_weekly_cap: 200, msg_batch_size: 3, msg_batches_per_day: 1,
    workday_start_hour: 8, workday_end_hour: 20, weekdays_only: 0,
  });
  const inv = repos.cohorts.create('I', null, true);
  const msg = repos.cohorts.create('M', 'hi', true, 'message');
  for (let i = 0; i < 5; i++) repos.profiles.add(inv.id, `https://www.linkedin.com/in/i${i}`, null);
  for (let i = 0; i < 5; i++) repos.profiles.add(msg.id, `https://www.linkedin.com/in/m${i}`, null, 'message');

  planAndAssignToday(repos, new Date('2026-07-28T09:00:00'), () => 0.5);

  expect(repos.profiles.byStatusKind('scheduled', 'invite')).toHaveLength(2);   // 1 batch x 2
  expect(repos.profiles.byStatusKind('scheduled', 'message')).toHaveLength(3);  // 1 batch x 3
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/worker/scheduler-service.test.ts`
Expected: FAIL (messages not scheduled / invite count wrong).

- [ ] **Step 3: Implement**

In `src/worker/scheduler-service.ts`, rename the body of `planAndAssignToday` to a private per-kind function and loop over kinds. Imports: add `import type { CampaignKind } from '../types.js';` and `import { capsFor } from '../core/caps.js';`.

```ts
export function planAndAssignToday(repos: Repos, now: Date, rng: () => number = Math.random): void {
  // Self-heal first: stale past-due slots must not inflate committedToday() and zero out
  // the daily budget. Runs on every path (startup, hourly tick, resume, guardrail-ack).
  requeueOverdue(repos, now);
  const s = repos.settings.get();
  // While paused or halted the sender won't run — don't materialize slots that will
  // only go stale. /api/resume and a guardrail acknowledge re-plan immediately.
  if (s.paused || repos.appState.get().guardrail_tripped) return;
  if (s.weekdays_only && (now.getDay() === 0 || now.getDay() === 6)) return;

  const windowEnd = new Date(now);
  windowEnd.setHours(s.workday_end_hour, 0, 0, 0);
  if (now.getTime() >= windowEnd.getTime()) return;

  for (const kind of ['invite', 'message'] as CampaignKind[]) {
    planKind(repos, now, kind, windowEnd, rng);
  }
}

function planKind(repos: Repos, now: Date, kind: CampaignKind, windowEnd: Date, rng: () => number): void {
  const s = repos.settings.get();
  const caps = capsFor(s, kind);
  const sentInWindow = repos.events.countSentSince(windowStartIso(now), kind);
  const weeklyRemaining = remainingCapacity(caps.weeklyCap, sentInWindow);
  if (weeklyRemaining <= 0) return;

  const batchSize = Math.max(1, caps.batchSize);
  const dailyBudget = dailyRemainingFor(repos, s, now, kind);
  if (dailyBudget <= 0) return;

  const allTimes = planDailyBatches(now, {
    startHour: s.workday_start_hour, endHour: s.workday_end_hour, count: caps.batchesPerDay,
  }, rng);
  let times = allTimes.filter((t) => t.getTime() > now.getTime());
  if (times.length === 0) {
    const at = new Date(now.getTime() + Math.floor(rng() * Math.max(1, windowEnd.getTime() - now.getTime())));
    times = [at];
  }

  const slotCapacity = times.length * batchSize;
  const budget = Math.min(weeklyRemaining, dailyBudget, slotCapacity);
  if (budget <= 0) return;

  const queued = repos.profiles.queuedByPriorityKind(kind).slice(0, budget);
  if (queued.length === 0) return;

  const assignments = assignSchedule(queued.map((p) => p.id), times, batchSize);
  for (const a of assignments) repos.profiles.setScheduled(a.id, a.when.toISOString());

  log.debug('scheduler', 'assigned slots', { kind, count: assignments.length, slots: times.length, budget });
}
```

Preserve the existing comments where the lines carry over. `requeueOverdue`, `resortSchedule`, `recoverOrphanedSending` are status-based and stay kind-agnostic.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS — existing scheduler tests still pass because invite caps/behavior are unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/worker/scheduler-service.ts tests/worker/scheduler-service.test.ts
git commit -m "feat: scheduler plans invite and message queues independently"
```

---

### Task 6: Driver contract + FakeDriver

**Files:**
- Modify: `src/browser/driver.ts`
- Test: none new (FakeDriver is test infrastructure; its behavior is exercised by Tasks 7–8)

- [ ] **Step 1: Extend FakeDriver in `src/browser/driver.ts`**

Add imports for `InboxRow` and `MAX_MESSAGE`; add to the class:

```ts
  /** Scripted per-URL message outcomes; default 'sent'. */
  msgScripted = new Map<string, SendResult>();
  /** Records messages "sent" (after {firstName} substitution). */
  msgLog: { url: string; message: string }[] = [];
  /** Full name this fake "reads" from profiles. */
  fullName = 'Test Person';
  /** Inbox rows returned by readInboxSnapshot. */
  inboxRows: InboxRow[] = [];
  /** When set, readInboxSnapshot throws (read-failure paths). */
  inboxError: string | null = null;

  async sendMessage(url: string, message: string): Promise<SendOutcome> {
    this.open = true;
    const text = applyFirstName(message, this.firstName, MAX_MESSAGE);
    this.msgLog.push({ url, message: text });
    const result = this.msgScripted.get(url) ?? 'sent';
    const evidence = (result === 'checkpoint' || result === 'error' || result === 'unavailable')
      ? this.evidence : undefined;
    return {
      result,
      firstName: this.firstName,
      fullName: this.fullName,
      ...(result === 'sent' ? { threadUrl: `https://www.linkedin.com/messaging/thread/fake-${slug(url)}/` } : {}),
      ...(evidence ? { evidence } : {}),
    };
  }

  async readInboxSnapshot(): Promise<InboxRow[]> {
    this.open = true;
    if (this.inboxError) throw new Error(this.inboxError);
    return this.inboxRows;
  }
```

with a module-local helper:

```ts
const slug = (url: string) => url.match(/\/in\/([^/?#]+)/)?.[1] ?? 'x';
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (FakeDriver satisfies the extended `BrowserDriver`; the real `LinkedInDriver` will FAIL the interface until Task 9 — if so, add temporary stubs there that `throw new Error('not implemented')` so the tree compiles, and note Task 9 replaces them).

- [ ] **Step 3: Commit**

```bash
git add src/browser/driver.ts src/browser/linkedin-driver.ts
git commit -m "feat: driver contract for sendMessage + readInboxSnapshot; FakeDriver support"
```

---

### Task 7: Sender — message pass

**Files:**
- Modify: `src/worker/sender.ts`
- Test: `tests/worker/sender.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `tests/worker/sender.test.ts`:

```ts
function seedScheduledMsg(url: string, whenIso: string, cohortId: number) {
  const p = repos.profiles.add(cohortId, url, null, 'message');
  repos.profiles.setScheduled(p.id, whenIso);
  return p;
}

test('message pass: sends due message profiles, stamps full_name/thread_url, counts per kind', async () => {
  const c = repos.cohorts.create('M', 'Hey {firstName}', true, 'message');
  seedScheduledMsg('https://www.linkedin.com/in/m1', '2026-06-29T09:00:00.000Z', c.id);
  await runSenderOnce(repos, driver, new Date('2026-06-29T10:00:00Z'));
  expect(driver.msgLog).toHaveLength(1);
  expect(driver.msgLog[0].message).toBe('Hey Test');
  const [p] = repos.profiles.byStatusKind('sent', 'message');
  expect(p.full_name).toBe('Test Person');
  expect(p.thread_url).toContain('/messaging/thread/');
  expect(repos.events.countSentSince('1970-01-01T00:00:00Z', 'message')).toBe(1);
  expect(repos.events.countSentSince('1970-01-01T00:00:00Z', 'invite')).toBe(0);
});

test('message pass: not_connected is a terminal skip that never touches the failure streak', async () => {
  const c = repos.cohorts.create('M', 'hi', true, 'message');
  const p = seedScheduledMsg('https://www.linkedin.com/in/m2', '2026-06-29T09:00:00.000Z', c.id);
  driver.msgScripted.set('https://www.linkedin.com/in/m2', 'not_connected');
  await runSenderOnce(repos, driver, new Date('2026-06-29T10:00:00Z'));
  const row = repos.profiles.findById(p.id)!;
  expect(row.status).toBe('skipped');
  expect(row.skip_reason).toBe('not_connected');
  expect(repos.appState.get().failure_streak).toBe(0);
});

test('message pass: a profile without any message text goes to needs_attention, not to LinkedIn', async () => {
  const c = repos.cohorts.create('M-blank', null, true, 'message'); // no template (API forbids this; engine must still be safe)
  const p = seedScheduledMsg('https://www.linkedin.com/in/m3', '2026-06-29T09:00:00.000Z', c.id);
  await runSenderOnce(repos, driver, new Date('2026-06-29T10:00:00Z'));
  expect(repos.profiles.findById(p.id)!.status).toBe('needs_attention');
  expect(driver.msgLog).toHaveLength(0);
});

test('message pass: checkpoint trips the shared guardrail and halts', async () => {
  const c = repos.cohorts.create('M', 'hi', true, 'message');
  seedScheduledMsg('https://www.linkedin.com/in/m4', '2026-06-29T09:00:00.000Z', c.id);
  driver.msgScripted.set('https://www.linkedin.com/in/m4', 'checkpoint');
  await runSenderOnce(repos, driver, new Date('2026-06-29T10:00:00Z'));
  expect(repos.appState.get().guardrail_tripped).toBe(1);
});

test('message weekly cap is independent of the invite cap', async () => {
  repos.settings.update({ msg_weekly_cap: 1, weekly_cap: 100, msg_batch_size: 5 });
  const c = repos.cohorts.create('M', 'hi', true, 'message');
  seedScheduledMsg('https://www.linkedin.com/in/m5', '2026-06-29T09:00:00.000Z', c.id);
  seedScheduledMsg('https://www.linkedin.com/in/m6', '2026-06-29T09:00:00.000Z', c.id);
  await runSenderOnce(repos, driver, new Date('2026-06-29T10:00:00Z'));
  expect(repos.profiles.byStatusKind('sent', 'message')).toHaveLength(1);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/worker/sender.test.ts`
Expected: new tests FAIL (message profiles never picked up).

- [ ] **Step 3: Implement in `src/worker/sender.ts`**

Restructure: `runSenderOnce` keeps its gates (paused, guardrail, send window, login), then runs the invite pass and the message pass. The existing loop body becomes `runInvitePass`; add `runMessagePass`. Shared pieces:

```ts
import { capsFor } from '../core/caps.js';
import type { CampaignKind } from '../types.js';

export async function runSenderOnce(
  repos: Repos, driver: BrowserDriver, now: Date, opts: SenderOptions = {},
): Promise<void> {
  const settings = repos.settings.get();
  if (settings.paused) return;
  if (isTripped(repos)) return;
  if (!opts.force && !withinSendWindow(now, settings)) return;

  const clock = opts.clock ?? (() => now);

  // Capacity + due work are computed from the DB only — so idle ticks never open the browser.
  const invDue = dueForKind(repos, now, 'invite');
  const msgDue = dueForKind(repos, now, 'message');
  if (invDue.length === 0 && msgDue.length === 0) return; // nothing due -> stay dark

  // Cached-login gate (no browser): login only ever happens through our own browser, so
  // the cache is authoritative. Not logged in is transient — skip, the dashboard surfaces it.
  if (repos.appState.get().login_logged_in !== 1) return;

  // Committing to act: confirm live (this lazily opens the browser and keeps it open).
  const snap = await driver.readLoginState();
  repos.appState.setLogin(snap, now.toISOString());
  if (!snap.loggedIn) { tripLoginLost(repos, now); return; }

  if (invDue.length > 0) {
    const halted = await runInvitePass(repos, driver, invDue, clock);
    if (halted) return; // checkpoint / weekly-limit / streak trip — don't start the other pass
  }
  if (msgDue.length > 0) await runMessagePass(repos, driver, msgDue, clock);
}

/** Due, capacity-clamped profiles for one kind (DB only, no browser). */
function dueForKind(repos: Repos, now: Date, kind: CampaignKind): Profile[] {
  const caps = capsFor(repos.settings.get(), kind);
  const sentInWindow = repos.events.countSentSince(windowStartIso(now), kind);
  const remaining = remainingCapacity(caps.weeklyCap, sentInWindow);
  if (remaining <= 0) return [];
  const scheduled = repos.profiles.byStatusKind('scheduled', kind);
  return pickDue(scheduled, now, Math.min(remaining, caps.batchSize));
}
```

`runInvitePass(repos, driver, due, clock): Promise<boolean>` is the existing per-profile loop verbatim (return `true` on the paths that currently `return` from inside the loop — checkpoint, weekly_limit, streak trip — and `false` at the end; drop the internal `remaining` bookkeeping in favor of the pre-clamped `due` list, which preserves behavior because `due.length <= min(remaining, batch_size)`).

`runMessagePass`:

```ts
/** One message batch. Returns true if a halt-worthy verdict stopped the pass. */
async function runMessagePass(
  repos: Repos, driver: BrowserDriver, due: Profile[], clock: () => Date,
): Promise<boolean> {
  for (const p of due) {
    const cohort = repos.cohorts.findById(p.cohort_id)!;
    // Messages REQUIRE text: the API validates this at enqueue, but the engine must
    // never fall through to an empty send if a row slips past (imports, manual edits).
    const text = selectNoteSource(p.custom_message, cohort.message_template);
    if (text === null) {
      repos.profiles.setStatus(p.id, 'needs_attention', { last_error: 'message cohort has no template or custom message' });
      logVerdict(p, 'needs attention: no message text');
      continue;
    }
    repos.profiles.setStatus(p.id, 'sending', { attempts: p.attempts + 1 });
    log.debug('sender', 'attempting message', { profile: p.id, url: p.profile_url });

    const outcome = await driver.sendMessage(p.profile_url, text);
    if (outcome.firstName) repos.profiles.setStatus(p.id, 'sending', { first_name: outcome.firstName });

    switch (outcome.result) {
      case 'sent':
        repos.profiles.setStatus(p.id, 'sent', {
          sent_at: clock().toISOString(),
          full_name: outcome.fullName ?? null,
          thread_url: outcome.threadUrl ?? null,
        });
        repos.events.recordSend(p.id, 'sent');
        recordSuccess(repos);
        logVerdict(p, 'message sent');
        break;
      case 'not_connected':
        // Not a 1st-degree connection — per-profile, terminal, never InMail, no streak.
        repos.profiles.setStatus(p.id, 'skipped', { last_error: null, skip_reason: 'not_connected' });
        repos.events.recordEvent(p.id, 'skipped');
        logVerdict(p, 'skipped: not a 1st-degree connection');
        break;
      case 'not_found':
        repos.profiles.setStatus(p.id, 'skipped', { last_error: null, skip_reason: 'not_found' });
        repos.events.recordEvent(p.id, 'skipped');
        logVerdict(p, 'skipped: profile no longer exists (LinkedIn 404)');
        break;
      case 'unavailable': {
        repos.profiles.setStatus(p.id, 'skipped', { last_error: null, skip_reason: 'unavailable' });
        repos.events.recordEvent(p.id, 'skipped');
        const shot = outcome.evidence?.screenshot;
        const detail = `message composer unavailable${shot ? ` — screenshot: /incidents/${shot}` : ''}`;
        logVerdict(p, `skipped: ${detail}`);
        if (recordFailure(repos, detail, clock())) return true;
        break;
      }
      case 'checkpoint': {
        const ev = outcome.evidence;
        const detail = ev
          ? `Checkpoint/captcha page at ${ev.pageUrl}`
            + (ev.matched ? ` (matched "${ev.matched}")` : '')
            + (ev.screenshot ? ` — screenshot: /incidents/${ev.screenshot}` : '')
          : undefined;
        repos.profiles.setStatus(p.id, 'needs_attention', {
          last_error: ev?.matched ? `checkpoint (matched "${ev.matched}")` : 'checkpoint',
        });
        logVerdict(p, `needs attention: checkpoint / captcha${detail ? ` — ${detail}` : ''}`);
        tripCheckpoint(repos, clock(), detail);
        return true;
      }
      case 'error':
      default: {
        const shot = outcome.evidence?.screenshot;
        repos.profiles.setStatus(p.id, 'failed', { last_error: outcome.error ?? 'unknown' });
        repos.events.recordEvent(p.id, 'failed');
        logVerdict(p, `failed: ${outcome.error ?? 'unknown'}${shot ? ` — screenshot: /incidents/${shot}` : ''}`);
        if (recordFailure(repos, outcome.error ?? 'unknown', clock())) return true;
        break;
      }
    }
  }
  return false;
}
```

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: PASS, including all pre-existing sender tests (invite behavior unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/worker/sender.ts tests/worker/sender.test.ts
git commit -m "feat: sender runs an independent message pass with per-kind capacity"
```

---

### Task 8: Reply checker

**Files:**
- Create: `src/worker/reply-checker.ts`
- Test: `tests/worker/reply-checker.test.ts` (new)

- [ ] **Step 1: Write the failing tests**

`tests/worker/reply-checker.test.ts`:

```ts
import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { FakeDriver } from '../../src/browser/driver.js';
import { runReplyCheck } from '../../src/worker/reply-checker.js';

let repos: Repos; let driver: FakeDriver;
const NOW = new Date('2026-07-28T12:00:00Z');

beforeEach(() => {
  repos = new Repos(openDatabase(':memory:'));
  driver = new FakeDriver();
  repos.appState.setLogin({ loggedIn: true, cookieExpiry: null }, '2026-07-28T00:00:00.000Z');
});

function seedSentMsg(url: string, fullName: string) {
  const c = repos.cohorts.getOrCreate('M', 'hi', true, 'message');
  const p = repos.profiles.add(c.id, url, null, 'message');
  repos.profiles.setStatus(p.id, 'sent', { sent_at: '2026-07-27T10:00:00.000Z', full_name: fullName });
  return p;
}

test('marks replied when the inbox row for a messaged contact is not You-prefixed', async () => {
  const p = seedSentMsg('https://www.linkedin.com/in/k', 'Keren Tevet');
  driver.inboxRows = [{ name: 'Keren Tevet', snippet: 'Keren: sounds good!', youSentLast: false }];
  const res = await runReplyCheck(repos, driver, NOW);
  expect(res.ran).toBe(true);
  expect(res.replied).toBe(1);
  const row = repos.profiles.findById(p.id)!;
  expect(row.status).toBe('replied');
  expect(row.replied_at).toBe(NOW.toISOString());
  expect(repos.appState.get().replies_checked_at).toBe(NOW.toISOString());
});

test('You-prefixed rows and unmatched names change nothing', async () => {
  const p = seedSentMsg('https://www.linkedin.com/in/k', 'Keren Tevet');
  driver.inboxRows = [
    { name: 'Keren Tevet', snippet: 'You: Hi Keren', youSentLast: true },
    { name: 'Somebody Else', snippet: 'Somebody: hello', youSentLast: false },
  ];
  const res = await runReplyCheck(repos, driver, NOW);
  expect(res.ran).toBe(true);
  expect(res.replied).toBe(0);
  expect(repos.profiles.findById(p.id)!.status).toBe('sent');
});

test('ambiguous display names are left pending (fail-safe)', async () => {
  const a = seedSentMsg('https://www.linkedin.com/in/k1', 'Keren Tevet');
  const b = seedSentMsg('https://www.linkedin.com/in/k2', 'Keren Tevet');
  driver.inboxRows = [{ name: 'Keren Tevet', snippet: 'Keren: hi!', youSentLast: false }];
  const res = await runReplyCheck(repos, driver, NOW);
  expect(res.replied).toBe(0);
  expect(repos.profiles.findById(a.id)!.status).toBe('sent');
  expect(repos.profiles.findById(b.id)!.status).toBe('sent');
});

test('empty inbox read is a no-op that does NOT stamp replies_checked_at', async () => {
  seedSentMsg('https://www.linkedin.com/in/k', 'Keren Tevet');
  driver.inboxRows = [];
  const res = await runReplyCheck(repos, driver, NOW);
  expect(res.ran).toBe(false);
  expect(res.reason).toBe('empty_read');
  expect(repos.appState.get().replies_checked_at).toBeNull();
});

test('no pending messages -> stays dark; paused -> skipped unless forced', async () => {
  expect((await runReplyCheck(repos, driver, NOW)).reason).toBe('no_pending');
  seedSentMsg('https://www.linkedin.com/in/k', 'Keren Tevet');
  repos.settings.update({ paused: 1 });
  expect((await runReplyCheck(repos, driver, NOW)).reason).toBe('paused');
  driver.inboxRows = [{ name: 'Keren Tevet', snippet: 'Keren: yo', youSentLast: false }];
  expect((await runReplyCheck(repos, driver, NOW, { force: true })).replied).toBe(1);
});

test('read error feeds the failure streak via recordReadError', async () => {
  seedSentMsg('https://www.linkedin.com/in/k', 'Keren Tevet');
  driver.inboxError = 'boom';
  const res = await runReplyCheck(repos, driver, NOW);
  expect(res.reason).toBe('read_error');
  expect(repos.appState.get().failure_streak).toBe(1);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/worker/reply-checker.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/worker/reply-checker.ts`**

```ts
import type { Repos } from '../db/repositories.js';
import type { BrowserDriver } from '../types.js';
import { isTripped, tripLoginLost, recordReadError, recordSuccess } from './guardrail.js';
import { log } from '../core/log.js';

/** Outcome of a reply pass — mirrors AcceptanceRunResult so the UI can reuse its wording. */
export interface ReplyRunResult {
  ran: boolean;
  reason?: 'paused' | 'guardrail' | 'no_pending' | 'logged_out' | 'login_lost' | 'read_error' | 'empty_read';
  replied: number;
  checkedAt?: string;
}

/**
 * One reply pass: a single navigation to the messaging inbox, then match conversation
 * rows to pending (status 'sent', kind 'message') profiles by the display name captured
 * at send time. A row whose last message was NOT ours ("You:" prefix absent) is a reply.
 * Upgrade-only: nothing here can ever un-reply or expire anything (acceptance lesson).
 */
export async function runReplyCheck(
  repos: Repos,
  driver: BrowserDriver,
  now: Date,
  opts: { force?: boolean } = {},
): Promise<ReplyRunResult> {
  if (!opts.force && repos.settings.get().paused) return { ran: false, reason: 'paused', replied: 0 };
  if (isTripped(repos)) return { ran: false, reason: 'guardrail', replied: 0 };

  const pending = repos.profiles.byStatusKind('sent', 'message');
  if (pending.length === 0) return { ran: false, reason: 'no_pending', replied: 0 };

  if (repos.appState.get().login_logged_in !== 1) return { ran: false, reason: 'logged_out', replied: 0 };
  const snap = await driver.readLoginState();
  repos.appState.setLogin(snap, now.toISOString());
  if (!snap.loggedIn) { tripLoginLost(repos, now); return { ran: false, reason: 'login_lost', replied: 0 }; }

  let rows;
  try {
    rows = await driver.readInboxSnapshot();
  } catch (e) {
    recordReadError(repos, (e as Error).message ?? 'inbox read failed', now);
    return { ran: false, reason: 'read_error', replied: 0 };
  }

  // Fail-safe: an empty inbox read means the page didn't render (a real inbox that has
  // pending outbound messages is never empty) — no state change, no slot stamp, retry later.
  if (rows.length === 0) {
    log.warn('replies', 'inbox read returned nothing — skipping (no state change)');
    return { ran: false, reason: 'empty_read', replied: 0 };
  }

  // Group pending by display name; a name shared by 2+ pending contacts is ambiguous and
  // is left pending (fail-safe — thread_url is stored if a per-thread check is ever needed).
  const norm = (s: string) => s.trim().toLowerCase();
  const byName = new Map<string, typeof pending>();
  for (const p of pending) {
    if (!p.full_name) continue; // no name captured at send time — cannot match
    const k = norm(p.full_name);
    byName.set(k, [...(byName.get(k) ?? []), p]);
  }

  const iso = now.toISOString();
  let replied = 0;
  for (const row of rows) {
    if (row.youSentLast) continue;
    const matches = byName.get(norm(row.name));
    if (!matches) continue;
    if (matches.length > 1) {
      log.warn('replies', 'ambiguous display name — leaving pending', { name: row.name, count: matches.length });
      continue;
    }
    const p = matches[0];
    repos.profiles.setStatus(p.id, 'replied', { replied_at: iso, resolved_at: iso });
    repos.events.recordEvent(p.id, 'replied');
    log.info('replies', 'verdict', { profile: p.id, url: p.profile_url, verdict: 'replied' });
    replied++;
  }

  repos.appState.setRepliesChecked(iso);
  recordSuccess(repos); // a clean read clears any accumulated streak
  log.info('replies', 'checked', { replied, rows: rows.length, pending: pending.length });
  return { ran: true, replied, checkedAt: iso };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/worker/reply-checker.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/worker/reply-checker.ts tests/worker/reply-checker.test.ts
git commit -m "feat: reply checker — slot-friendly inbox scan, upgrade-only, fail-safe on empty/ambiguous"
```

---

### Task 9: Orchestrator reply tick

**Files:**
- Modify: `src/worker/orchestrator.ts`
- Test: `tests/worker/orchestrator.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/worker/orchestrator.test.ts` (mirror the existing acceptance-tick tests in that file — they build an `Orchestrator` with a `FakeDriver`):

```ts
test('reply tick runs at most once per slot and stamps replies_checked_at on success', async () => {
  const repos = new Repos(openDatabase(':memory:'));
  const driver = new FakeDriver();
  repos.appState.setLogin({ loggedIn: true, cookieExpiry: null }, '2026-07-28T00:00:00.000Z');
  const c = repos.cohorts.create('M', 'hi', true, 'message');
  const p = repos.profiles.add(c.id, 'https://www.linkedin.com/in/k', null, 'message');
  repos.profiles.setStatus(p.id, 'sent', { sent_at: '2026-07-27T10:00:00.000Z', full_name: 'Keren Tevet' });
  driver.inboxRows = [{ name: 'Keren Tevet', snippet: 'Keren: hey', youSentLast: false }];

  const orch = new Orchestrator(repos, driver);
  const morning = new Date('2026-07-28T09:00:00');
  await orch.runReplyTick(morning);
  expect(repos.profiles.findById(p.id)!.status).toBe('replied');

  // Same slot again: must not re-read (make a second read fail loudly if attempted).
  driver.inboxError = 'should not be called';
  await orch.runReplyTick(new Date('2026-07-28T09:20:00'));
  expect(repos.appState.get().failure_streak).toBe(0);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/worker/orchestrator.test.ts`
Expected: FAIL (`runReplyTick` missing).

- [ ] **Step 3: Implement in `src/worker/orchestrator.ts`**

Import `runReplyCheck`. Add the method (a sibling of `runAcceptanceTick`, same slot gating via the existing `acceptanceSlot` helper — it's a generic day-slicer):

```ts
  /**
   * Reply pass, at most once per slot (slot math shared with acceptance checks via
   * acceptanceSlot). The gate reads the PERSISTED replies_checked_at, which
   * runReplyCheck stamps only on a clean, non-empty read — a bailed-out pass leaves
   * the stamp untouched so the next 30-minute tick retries (acceptance-checker lesson).
   */
  async runReplyTick(now: Date = new Date()): Promise<void> {
    const s = this.repos.settings.get();
    const app = this.repos.appState.get();
    if (s.paused || app.guardrail_tripped === 1) return;
    const slot = acceptanceSlot(now, s.reply_checks_per_day);
    if (app.replies_checked_at
      && acceptanceSlot(new Date(app.replies_checked_at), s.reply_checks_per_day) === slot) return;
    try {
      await this.browserLock.run(() => runReplyCheck(this.repos, this.driver, now));
    } catch (err) {
      this.handleTickError('replies', err);
    }
  }
```

In `start()`, next to the acceptance timer:

```ts
    this.timers.push(setInterval(() => { void this.runReplyTick(); }, 30 * 60 * 1000));
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/worker/orchestrator.ts tests/worker/orchestrator.test.ts
git commit -m "feat: orchestrator reply tick, slot-gated like acceptance"
```

---

### Task 10: LinkedIn driver — sendMessage + readInboxSnapshot

**Files:**
- Modify: `src/browser/linkedin-selectors.ts`
- Modify: `src/browser/linkedin-driver.ts`
- Test: `tests/browser/linkedin-selectors.test.ts` (append)

All selectors below were live-verified 2026-07-28 (see spec §Discovery; evidence scripts `scripts/probe-compose.ts`, `scripts/inspect-message-send.ts`).

- [ ] **Step 1: Write the failing selector tests**

Append to `tests/browser/linkedin-selectors.test.ts`:

```ts
test('messaging selectors and compose-href helper', () => {
  expect(SEL.msgComposeLink).toBe('a[href*="/messaging/compose/"]');
  expect(SEL.msgBox).toBe('div.msg-form__contenteditable[contenteditable="true"]');
  expect(SEL.msgSendButton).toBe('button.msg-form__send-button');
  expect(SEL.msgEvent).toBe('[class*="msg-s-event"]');
  expect(SEL.inboxList).toBe('ul.msg-conversations-container__conversations-list');
  expect(SEL.inboxRow).toBe('li.msg-conversation-listitem');
  expect(URLS.messaging).toBe('https://www.linkedin.com/messaging/');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/browser/linkedin-selectors.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add selectors to `src/browser/linkedin-selectors.ts`**

Add to `SEL` (with this comment block):

```ts
  // Messaging (live-verified 2026-07-28). The profile's Message control is an anchor to
  // /messaging/compose/?profileUrn=… — navigate to its href instead of clicking hashed-
  // class UI. That route renders the CLASSIC messaging surface with stable classes.
  msgComposeLink: 'a[href*="/messaging/compose/"]',
  msgBox: 'div.msg-form__contenteditable[contenteditable="true"]',
  // Disabled until text is typed; re-disabled after a successful send.
  msgSendButton: 'button.msg-form__send-button',
  // Thread history items — a sent message appears as the last of these.
  msgEvent: '[class*="msg-s-event"]',
  // Inbox conversation list. Snippets are prefixed "You:" when we sent last.
  inboxList: 'ul.msg-conversations-container__conversations-list',
  inboxRow: 'li.msg-conversation-listitem',
  inboxRowName: '[class*="participant-names"]',
  inboxRowSnippet: '[class*="message-snippet"]',
```

Add to `URLS`:

```ts
  messaging: 'https://www.linkedin.com/messaging/',
```

- [ ] **Step 4: Implement the driver methods in `src/browser/linkedin-driver.ts`**

Replace the Task-6 stubs. Import `MAX_MESSAGE` from `../core/message.js`.

```ts
  /**
   * Send a direct message to an existing 1st-degree connection.
   * Flow (live-verified 2026-07-28): profile page → 1st-degree gate (the production-proven
   * isAlreadyConnected signal — NOT the degree badge, which renders unreliably) → navigate
   * to the profile's own /messaging/compose/ deep link → type into the classic msg-form →
   * Send → verify structurally (composer cleared + button re-disabled + text in thread).
   * Anything not clearly a 1st-degree connection is 'not_connected' — never InMail.
   */
  async sendMessage(url: string, message: string): Promise<SendOutcome> {
    const page = await this.session.page();
    try {
      // 1) Profile pre-visit: name capture + gates.
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await sleep(rand(1500, 3500));
      if (isNotFoundUrl(page.url())) return this.notFoundOutcome(page);
      const fullName = await this.readFullName(page);
      const firstName = fullName?.split(/\s+/)[0];
      {
        const scan = await this.scanCheckpoint(page);
        if (scan.hit) return this.checkpointOutcome(page, scan, firstName);
      }
      // 1st-degree gate: must be an existing connection (fail-safe: skip, never InMail).
      if (!(await this.isAlreadyConnected(page, url))) {
        return { result: 'not_connected', firstName, fullName };
      }
      // 2) The Message control is an anchor to the compose route; its absence on a
      //    connection's profile means messaging is unavailable for them — skip.
      const composeHref = await page.locator(SEL.msgComposeLink).first()
        .getAttribute('href').catch(() => null);
      if (!composeHref) return { result: 'not_connected', firstName, fullName };

      // 3) Compose route → classic msg-form overlay with stable selectors.
      await page.goto(new URL(composeHref, 'https://www.linkedin.com').href, { waitUntil: 'domcontentloaded' });
      await sleep(rand(3000, 5000));
      const box = page.locator(SEL.msgBox).last();
      if (!(await box.isVisible().catch(() => false))) {
        const scan = await this.scanCheckpoint(page);
        if (scan.hit) return this.checkpointOutcome(page, scan, firstName);
        const ev = await captureEvidence(page, 'msg-composer-unavailable', {});
        return {
          result: 'unavailable', firstName, fullName,
          evidence: { pageUrl: page.url(), screenshot: ev?.screenshot ?? null },
        };
      }

      // 4) Type like a human; the send button flips enabled only when text registered.
      const text = applyFirstName(message, firstName ?? null, MAX_MESSAGE);
      await box.click();
      await page.keyboard.type(text, { delay: rand(25, 60) });
      await sleep(rand(800, 1600));
      const send = page.locator(SEL.msgSendButton).last();
      if (await send.isDisabled().catch(() => true)) {
        // errorOutcome captures the evidence snapshot itself.
        return this.errorOutcome(page, 'send button never enabled after typing', firstName);
      }
      await send.click();
      await sleep(rand(3000, 5000));

      // 5) Structural confirmation: composer cleared + our text is in the thread.
      const confirmed = await page.evaluate(({ boxSel, evSel, sent }) => {
        const box = document.querySelector(boxSel);
        const cleared = !(box?.textContent || '').includes(sent.slice(0, 30));
        const events = Array.from(document.querySelectorAll(evSel))
          .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim());
        const inThread = events.some((e) => e.includes(sent.slice(0, 40)));
        const failed = /failed to send|couldn.t send|message not sent/i.test(document.body.textContent || '');
        return { cleared, inThread, failed };
      }, { boxSel: SEL.msgBox, evSel: SEL.msgEvent, sent: text });

      if (confirmed.failed || !(confirmed.cleared && confirmed.inThread)) {
        const scan = await this.scanCheckpoint(page);
        if (scan.hit) return this.checkpointOutcome(page, scan, firstName);
        return this.errorOutcome(page, 'message send not confirmed (composer/thread state)', firstName);
      }
      const threadUrl = /\/messaging\/thread\//.test(page.url()) ? page.url() : undefined;
      return { result: 'sent', firstName, fullName, ...(threadUrl ? { threadUrl } : {}) };
    } catch (e) {
      const scan = await this.scanCheckpoint(page);
      if (scan.hit) return this.checkpointOutcome(page, scan);
      return this.errorOutcome(page, (e as Error).message);
    }
  }

  /** One-page inbox scan (no scrolling: same top-slice tradeoff as the acceptance read). */
  async readInboxSnapshot(): Promise<InboxRow[]> {
    const page = await this.session.page();
    await page.goto(URLS.messaging, { waitUntil: 'domcontentloaded' });
    await sleep(rand(3000, 5000));
    if ((await this.scanCheckpoint(page)).hit) {
      await captureEvidence(page, 'checkpoint', { during: 'inbox read' });
      throw new Error('checkpoint detected during inbox read');
    }
    return page.evaluate(({ rowSel, nameSel, snipSel }) => {
      return Array.from(document.querySelectorAll(rowSel)).map((li) => {
        const name = (li.querySelector(nameSel)?.textContent || '').trim();
        const snippet = (li.querySelector(snipSel)?.textContent || '').trim();
        return { name, snippet, youSentLast: /^you:/i.test(snippet) };
      }).filter((r) => r.name);
    }, { rowSel: SEL.inboxRow, nameSel: SEL.inboxRowName, snipSel: SEL.inboxRowSnippet });
  }
```

Add `InboxRow` to the type imports from `../types.js`.

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run tests/browser/linkedin-selectors.test.ts && npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/browser/linkedin-selectors.ts src/browser/linkedin-driver.ts tests/browser/linkedin-selectors.test.ts
git commit -m "feat: LinkedInDriver.sendMessage via compose deep link + inbox snapshot reader"
```

---

### Task 11: API — kind everywhere it matters

**Files:**
- Modify: `src/api/server.ts`
- Test: `tests/api/server.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `tests/api/server.test.ts` (reuse its existing app/repos setup pattern):

```ts
test('POST /api/lists with kind=message requires a template and creates a message cohort', async () => {
  const bad = await app.inject({ method: 'POST', url: '/api/lists', payload: {
    cohort: 'Msgs', kind: 'message', text: 'https://www.linkedin.com/in/a',
  } });
  expect(bad.statusCode).toBe(400);

  const ok = await app.inject({ method: 'POST', url: '/api/lists', payload: {
    cohort: 'Msgs', kind: 'message', text: 'https://www.linkedin.com/in/a', message_template: 'Hey {firstName}',
  } });
  expect(ok.statusCode).toBe(200);
  expect(ok.json().added).toBe(1);
  const cohort = repos.cohorts.findByName('Msgs')!;
  expect(cohort.kind).toBe('message');
  expect(repos.profiles.byStatusKind('queued', 'message')).toHaveLength(1);
});

test('POST /api/lists rejects adding to a cohort of the other kind', async () => {
  await app.inject({ method: 'POST', url: '/api/lists', payload: { cohort: 'InvC', text: 'https://www.linkedin.com/in/z' } });
  const res = await app.inject({ method: 'POST', url: '/api/lists', payload: {
    cohort: 'InvC', kind: 'message', text: 'https://www.linkedin.com/in/y', message_template: 'hi',
  } });
  expect(res.statusCode).toBe(409);
});

test('GET /api/status exposes per-kind counts, caps, and replies_checked_at', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/status' });
  const body = res.json();
  expect(body.counts).toBeDefined();
  expect(body.msg_counts).toBeDefined();
  expect(body.msg_weekly_cap).toBe(200);
  expect(body).toHaveProperty('replies_checked_at');
  expect(body.forecast.msg_next_batch !== undefined).toBe(true);
});

test('GET /api/profiles?status=sent&kind=message filters by kind', async () => {
  const m = repos.cohorts.create('MM', 'hi', true, 'message');
  const p = repos.profiles.add(m.id, 'https://www.linkedin.com/in/mk', null, 'message');
  repos.profiles.setStatus(p.id, 'sent', { sent_at: '2026-07-28T00:00:00.000Z' });
  const res = await app.inject({ method: 'GET', url: '/api/profiles?status=sent&kind=message' });
  expect(res.json()).toHaveLength(1);
  const inv = await app.inject({ method: 'GET', url: '/api/profiles?status=sent&kind=invite' });
  expect(inv.json()).toHaveLength(0);
});

test('POST /api/recheck-replies runs a forced reply pass', async () => {
  const m = repos.cohorts.create('MR', 'hi', true, 'message');
  const p = repos.profiles.add(m.id, 'https://www.linkedin.com/in/kr', null, 'message');
  repos.profiles.setStatus(p.id, 'sent', { sent_at: '2026-07-27T00:00:00.000Z', full_name: 'K R' });
  driver.inboxRows = [{ name: 'K R', snippet: 'K: hi', youSentLast: false }];
  const res = await app.inject({ method: 'POST', url: '/api/recheck-replies' });
  expect(res.json().replied).toBe(1);
});

test('POST /api/settings accepts the message pacing keys', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/settings', payload: { msg_weekly_cap: 150, reply_checks_per_day: 1 } });
  expect(res.json().msg_weekly_cap).toBe(150);
  expect(res.json().reply_checks_per_day).toBe(1);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/api/server.test.ts`
Expected: new tests FAIL.

- [ ] **Step 3: Implement in `src/api/server.ts`**

1. Extend `ALLOWED_SETTINGS_KEYS` with `'msg_weekly_cap', 'msg_batch_size', 'msg_batches_per_day', 'reply_checks_per_day'`.
2. Imports: `runReplyCheck` from `../worker/reply-checker.js`; `capsFor` from `../core/caps.js`; `MAX_NOTE, MAX_MESSAGE` from `../core/message.js`; `CampaignKind` type.
3. `POST /api/lists` — kind + validation:

```ts
  app.post('/api/lists', async (req, reply) => {
    const { cohort, text, message_template, kind: kindRaw } =
      req.body as { cohort?: string; text: string; message_template?: string; kind?: string };
    const kind: CampaignKind = kindRaw === 'message' ? 'message' : 'invite';
    const template = message_template?.trim() || undefined;
    if (kind === 'message' && !template) {
      return reply.code(400).send({ error: 'message campaigns require a message template' });
    }
    const max = kind === 'message' ? MAX_MESSAGE : MAX_NOTE;
    if (template && template.length > max) {
      return reply.code(400).send({ error: `template too long (max ${max} characters)` });
    }
    const cohortName = (cohort && cohort.trim()) || defaultCohortName(new Date());
    const allowNoNote = deriveAllowNoNote(template);
    const existing = repos.cohorts.findByName(cohortName);
    if (existing && existing.kind !== kind) {
      return reply.code(409).send({ error: `cohort "${cohortName}" is a ${existing.kind} cohort` });
    }
    const c = repos.cohorts.getOrCreate(cohortName, template ?? null, allowNoNote, kind);
    repos.db.prepare('UPDATE cohorts SET message_template = ?, allow_no_note = ? WHERE id = ?')
      .run(template ?? c.message_template, allowNoNote ? 1 : 0, c.id);
    const urls = extractProfileUrls(text ?? '');
    const before = repos.profiles.countAll();
    for (const u of urls) repos.profiles.add(c.id, u, null, kind);
    const added = repos.profiles.countAll() - before;
    return { added, found: urls.length };
  });
```

4. `GET /api/status` — per-kind counts and forecast. Replace the counts computation and extend the payload:

```ts
    const counts: Record<string, number> = {};
    const msg_counts: Record<string, number> = {};
    for (const p of repos.profiles.all()) {
      const bucket = p.kind === 'message' ? msg_counts : counts;
      bucket[p.status] = (bucket[p.status] ?? 0) + 1;
    }
```

Existing invite fields keep their names (`weekly_sent`, `weekly_cap`, `forecast.next_batch` — pass `'invite'` to `countSentSince`/`dailyRemainingFor`). Add message-side fields:

```ts
      msg_counts,
      msg_weekly_sent: repos.events.countSentSince(windowStartIso(now), 'message'),
      msg_weekly_cap: s.msg_weekly_cap,
      replies_checked_at: a.replies_checked_at,
```

and inside `forecast`, a message next-batch using a per-kind settings view (forecast reads `weekly_cap/batch_size/batches_per_day` off the settings object, so hand it a remapped copy):

```ts
        msg_next_batch: nextBatchForecast(
          repos.profiles.byStatusKind('scheduled', 'message'),
          {
            backlog: (msg_counts.queued ?? 0) + (msg_counts.scheduled ?? 0),
            weeklyRemaining: remainingCapacity(s.msg_weekly_cap, repos.events.countSentSince(windowStartIso(now), 'message')),
            dailyRemaining: dailyRemainingFor(repos, s, now, 'message'),
            guardrailTripped: a.guardrail_tripped === 1,
            paused: s.paused === 1,
            settings: { ...s, weekly_cap: s.msg_weekly_cap, batch_size: s.msg_batch_size, batches_per_day: s.msg_batches_per_day },
          }, now),
```

(the invite `queue_remaining`/`eta`/`next_batch` computations must now use the invite-only `counts` object, which they already do; also update the invite `next_batch.backlog` to use invite-only numbers — it already reads `queueRemaining` computed from `counts`.)

5. `GET /api/metrics` — add `p.kind, p.replied_at` to the SELECT.
6. `GET /api/profiles` — optional `kind` filter and `replied_at` in the SELECT:

```ts
    const { status, kind } = req.query as { status?: string; kind?: string };
    const conds: string[] = []; const args: unknown[] = [];
    if (status) { conds.push('p.status = ?'); args.push(status); }
    if (kind === 'invite' || kind === 'message') { conds.push('p.kind = ?'); args.push(kind); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
```

(keep the rest of the query; add `p.kind, p.replied_at` to the selected columns and use `stmt.all(...args)`).
7. `GET /api/queue` and `GET /api/queue/grouped` — add `p.kind` to both SELECTs and pass it through in the returned row objects.
8. `POST /api/cohorts` — accept `kind` on create (reject changing kind on an existing cohort):

```ts
    const { name, message_template, kind: kindRaw } = req.body as { name: string; message_template?: string; kind?: string };
    const kind: CampaignKind = kindRaw === 'message' ? 'message' : 'invite';
    const existing = repos.cohorts.findByName(name);
    if (existing && existing.kind !== kind && kindRaw !== undefined) {
      return reply.code(409).send({ error: `cohort "${name}" is a ${existing.kind} cohort` });
    }
```

(then `getOrCreate(name, template ?? null, allowNoNote, kind)`; handler signature gains `reply`).
9. `POST /api/run-now` — promote per kind so both engines fire:

```ts
    const s = repos.settings.get();
    const promote = (kind: CampaignKind, batch: number) =>
      [...repos.profiles.queuedByPriorityKind(kind),
       ...repos.profiles.byStatusKind('scheduled', kind)].slice(0, batch);
    const candidates = [...promote('invite', s.batch_size), ...promote('message', s.msg_batch_size)];
```

(rest unchanged).
10. New endpoint next to `recheck-acceptance`:

```ts
  // Manual, on-demand reply reconciliation — read-only against LinkedIn (same contract
  // as recheck-acceptance: runs while paused, respects guardrail/login/empty-read gates).
  app.post('/api/recheck-replies', async () => {
    defaultLog.info('api', 'recheck-replies');
    return browserLock.run(() => runReplyCheck(repos, driver, new Date(), { force: true }));
  });
```

- [ ] **Step 4: Run the suite**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/server.ts tests/api/server.test.ts
git commit -m "feat: kind-aware API — lists/cohorts/status/metrics/profiles/run-now + recheck-replies"
```

---

### Task 12: Live driver verification (manual, approved test profile ONLY)

**Files:** none (verification step)

- [ ] **Step 1: Stop the app if running** (Ctrl+C in its terminal; `.linkedin-profile` is single-instance).

- [ ] **Step 2: Write and run a one-shot verify script**

Create `scripts/verify-message-send.ts` modeled on `scripts/send-one.ts`, calling the REAL driver end-to-end:

```ts
// One-shot live check of LinkedInDriver.sendMessage against the APPROVED test profile.
// Usage (app stopped): npx tsx scripts/verify-message-send.ts
import { LinkedInDriver } from '../src/browser/linkedin-driver.js';

const APPROVED = 'https://www.linkedin.com/in/keren-tevet-3453a079';
const driver = new LinkedInDriver();
try {
  const out = await driver.sendMessage(APPROVED, 'Hi {firstName} - second automated test from The Machine, validating the real driver. Please ignore :)');
  console.log(JSON.stringify(out, null, 2));
  const inbox = await driver.readInboxSnapshot();
  console.log('inbox rows:', inbox.length, JSON.stringify(inbox.slice(0, 3), null, 2));
} finally {
  await driver.close();
}
```

Run: `npx tsx scripts/verify-message-send.ts`
Expected: `result: "sent"` with `fullName` and (usually) `threadUrl`; inbox rows include `{ name: "Keren Tevet", youSentLast: true }`.

- [ ] **Step 3: Verify the not-connected gate (read-only)**

Temporarily point the same script at a pending (non-connected) profile from the production DB (e.g. `https://www.linkedin.com/in/tanner-f-6830a1236`) — expected outcome: `result: "not_connected"`, and **no message sent** (the flow never reaches a composer). Revert the script to the approved URL afterwards.

- [ ] **Step 4: Commit the script**

```bash
git add scripts/verify-message-send.ts
git commit -m "test: live verification script for the message driver (approved test profile only)"
```

---

### Task 13: Dashboard — dual conveyors

Execution note (user preference): run this and Tasks 14–15 with an Opus subagent using the `frontend-design` skill; match the existing visual language (`styles.css` custom properties, station/puck/outcome patterns).

**Files:**
- Modify: `src/web/index.html`
- Modify: `src/web/app.js`
- Modify: `src/web/styles.css`

- [ ] **Step 1: index.html — restructure the engine area**

Wrap the existing `.engine` markup and add a messages sibling. The invite engine keeps every existing id. Insert directly after the invite engine's closing `</div>` (the one with id `engine`):

```html
      <!-- Messages engine: same conveyor language, its own fuel + stations.
           Stations: Queued → Scheduled → Sent → Replied. Collapses to a slim
           summary row (engine-idle) when the messages funnel is empty. -->
      <div class="engine engine-msg" id="msgEngine" aria-label="Message engine status">
        <div class="engine-top">
          <div class="engine-fuel">
            <div class="fuel-meta">
              <span class="label">This week · messages</span>
              <div class="fuel-val">
                <span class="bignum" id="msgFuelSent">0</span>
                <span class="fuel-cap">/ <span id="msgFuelCap">0</span> messages</span>
              </div>
            </div>
            <div class="fuelbar" aria-hidden="true"><i id="msgFuelBar" style="width:0%"></i></div>
          </div>
          <div class="engine-pills">
            <span class="epill">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
              <span id="msgNextTxt">—</span>
            </span>
          </div>
        </div>
        <div class="track">
          <div class="flowline" aria-hidden="true"></div>
          <div class="dotflow" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
          <div class="station queued">
            <div class="puck"><span class="n" id="msgQueued">0</span></div>
            <span class="nm">Queued<small>waiting</small></span>
          </div>
          <div class="station sched">
            <div class="puck"><span class="n" id="msgScheduled">0</span></div>
            <span class="nm">Scheduled<small>has a slot</small></span>
          </div>
          <div class="station pending is-drill" data-drill="sent" data-drill-kind="message" data-drill-title="Messages sent" role="button" tabindex="0" title="View messaged profiles">
            <div class="puck"><span class="n" id="msgSent">0</span></div>
            <span class="nm">Sent<small>message delivered</small></span>
          </div>
          <div class="station accepted is-drill" data-drill="replied" data-drill-kind="message" data-drill-title="Replied" role="button" tabindex="0" title="View replies" aria-label="View replied profiles">
            <div class="puck"><span class="n" id="msgReplied">0</span></div>
            <span class="nm">Replied<small id="repliedFoot">checked never</small>
              <button class="recheck-btn" id="recheckReplies" type="button" title="Recheck replies now" aria-label="Recheck replies now">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </button>
              <span class="visually-hidden" id="recheckRepliesStatus" role="status" aria-live="polite"></span>
            </span>
          </div>
        </div>
        <div class="engine-idle" id="msgEngineIdle" hidden>
          <span class="engine-idle-label">Messages</span>
          <span class="engine-idle-sub">No message campaigns yet — create one from Add List.</span>
        </div>
      </div>
```

Also add an engine label line to the invite engine's fuel meta: change its `<span class="label">This week</span>` to `<span class="label">This week · invites</span>`.

- [ ] **Step 2: app.js — render the second engine**

In `renderEngine(status)` append:

```js
  // --- Messages engine ---
  const mc = status.msg_counts || {};
  const msgPct = status.msg_weekly_cap ? Math.min(100, Math.round(((status.msg_weekly_sent || 0) / status.msg_weekly_cap) * 100)) : 0;
  setText('msgFuelSent', status.msg_weekly_sent ?? 0);
  setText('msgFuelCap', status.msg_weekly_cap ?? 0);
  const msgFuelBar = document.getElementById('msgFuelBar');
  if (msgFuelBar) msgFuelBar.style.width = `${msgPct}%`;

  const mnb = f.msg_next_batch;
  if (!mnb) fillPill('msgNextTxt', null, null, 'no batch queued');
  else if (mnb.blocked) fillPill('msgNextTxt', null, null, mnb.reason);
  else if (mnb.estimated === false) fillPill('msgNextTxt', 'next batch', mnb.count, `at ${fmtClock(mnb.at)}`);
  else fillPill('msgNextTxt', 'next batch', `~${mnb.count}`, `${fmtRelDay(mnb.at)} ~${fmtClock(mnb.at)}`);

  setText('msgQueued', mc.queued || 0);
  setText('msgScheduled', mc.scheduled || 0);
  setText('msgSent', mc.sent || 0);
  setText('msgReplied', mc.replied || 0);
  setText('repliedFoot', `checked ${status.replies_checked_at ? fmtClock(status.replies_checked_at) : 'never'}`);

  // Idle collapse: no message profiles at all -> slim summary row instead of a dead conveyor.
  const msgTotal = Object.values(mc).reduce((n, v) => n + v, 0);
  const msgEngine = document.getElementById('msgEngine');
  if (msgEngine) {
    msgEngine.classList.toggle('is-idle', msgTotal === 0);
    const idle = document.getElementById('msgEngineIdle');
    if (idle) idle.hidden = msgTotal !== 0;
  }
```

In `applyEngineState(status)`, apply the run-state classes to both engines:

```js
  for (const eng of [$('#engine'), $('#msgEngine')]) {
    if (!eng) continue;
    eng.classList.toggle('is-paused', paused || tripped);
    eng.classList.toggle('is-halted', tripped);
  }
```

(keep the badge logic on the invite engine as-is).

Drill-downs: `openDrawer(status, title)` gains a kind — change `initDrawer` to pass `card.dataset.drillKind` and `openDrawer` to append `&kind=...` when present:

```js
  const open = () => openDrawer(card.dataset.drill, card.dataset.drillTitle, card.dataset.drillKind);
  // openDrawer(status, title, kind): fetch `/api/profiles?status=...` + (kind ? `&kind=${kind}` : '')
```

The invite engine's existing drill stations get `data-drill-kind="invite"` in index.html (Pending, Accepted, Expired stations; Skipped stays kind-less so both kinds show). Add `replied: { field: 'replied_at', label: 'replied' }` to `DRILL_DATE` and `not_connected: 'not a 1st-degree connection'` to `SKIP_REASON_LABEL`.

Reply recheck button — clone the `recheckAccept` handler in `initDashboard` for `#recheckReplies`, calling `/api/recheck-replies` and reading `res.replied` (label `Found ${res.replied}` / `'No new replies'`).

Queue rows — in `renderCohortGroup`, prefix each row's slug with a kind glyph so interleaved kinds are tellable apart. Where the row is built, add before the slug link:

```js
    el('span', { class: `qg-kind ${p.kind || 'invite'}`, title: p.kind === 'message' ? 'Message' : 'Connection request', 'aria-hidden': 'true' },
      p.kind === 'message' ? '✉' : '+'),
```

- [ ] **Step 3: styles.css — message accent + idle collapse**

Add (using the sheet's existing custom-property idiom — pick the accent variable names that match; the sheet defines greens for the invite engine, use the existing purple/violet tokens if present, otherwise define `--msg-accent`):

```css
/* Messages engine: same anatomy, its own accent. */
.engine-msg { margin-top: 14px; }
.engine-msg .puck { border-color: var(--msg-accent, #7c6cd8); }
.engine-msg .station .n { color: var(--msg-accent, #7c6cd8); }
.engine-msg .fuelbar i { background: var(--msg-accent, #7c6cd8); }

/* Idle collapse: hide the conveyor, show the one-line summary. */
.engine.is-idle .engine-top, .engine.is-idle .track { display: none; }
.engine-idle { display: flex; gap: 10px; align-items: baseline; padding: 6px 2px; }
.engine-idle-label { font-weight: 600; }
.engine-idle-sub { color: var(--muted, #8a8f98); font-size: 0.85em; }

/* Kind glyph on queue rows. */
.qg-kind { width: 1.4em; text-align: center; opacity: 0.7; }
.qg-kind.message { color: var(--msg-accent, #7c6cd8); }
```

(Adjust to the sheet's real variables/structure while implementing — visual parity with the invite engine matters more than these literal hexes.)

- [ ] **Step 4: Manual verification**

Run: `npm start`, open http://localhost:4400.
Expected: invite engine unchanged; beneath it the messages engine shows the idle summary (no message profiles yet). Pause/halt states tint both engines. No console errors.

- [ ] **Step 5: Commit**

```bash
git add src/web/index.html src/web/app.js src/web/styles.css
git commit -m "feat(ui): stacked dual conveyors — messages engine with fuel, stations, reply recheck, idle collapse"
```

---

### Task 14: Add List + Cohorts UI

**Files:**
- Modify: `src/web/index.html`
- Modify: `src/web/app.js`
- Modify: `src/web/styles.css`

- [ ] **Step 1: index.html — Add List kind toggle**

In the Add List aside (`.add-rail`), insert as the FIRST field:

```html
          <div class="field">
            <label>Campaign type</label>
            <div class="kind-toggle" role="radiogroup" aria-label="Campaign type">
              <label class="kind-opt"><input type="radio" name="listKind" value="invite" checked />
                <span>+ Connection requests</span></label>
              <label class="kind-opt"><input type="radio" name="listKind" value="message" />
                <span>✉ Messages <small>to existing connections</small></span></label>
            </div>
          </div>
```

Update the template field label/hint ids stay the same; the JS below adapts the counter max and required-ness.

- [ ] **Step 2: index.html — cohorts screen message table + modal kind**

After the existing metrics `table-wrap`, add:

```html
      <div class="panel-head sub"><div class="panel-title"><h3>Message cohorts</h3></div></div>
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr><th>Cohort</th><th class="num">Total</th><th class="num">Sent</th><th class="num">Replied</th><th class="num">Pending</th><th>Reply rate</th><th class="num">Median days</th></tr>
          </thead>
          <tbody id="msgMetricsBody"></tbody>
        </table>
        <div class="empty" id="msgMetricsEmpty" hidden>No message cohorts yet.</div>
      </div>
```

In the cohort modal form, before the name field:

```html
        <div class="field">
          <label for="cohortKind">Type</label>
          <select id="cohortKind">
            <option value="invite">Connection requests</option>
            <option value="message">Messages</option>
          </select>
        </div>
```

- [ ] **Step 3: app.js — kind-aware forms and tables**

Add List (`initAddList` + submit):

```js
  const kindInputs = $$('input[name="listKind"]');
  const selectedKind = () => (kindInputs.find((r) => r.checked) || {}).value || 'invite';
  const applyKindUi = () => {
    const msg = selectedKind() === 'message';
    tpl.maxLength = msg ? 2000 : 300;
    updateTplCount(); // counter reads tpl.maxLength (update its text to `${len} / ${tpl.maxLength}`)
    tpl.placeholder = msg ? 'Hey {firstName}, great to be connected…' : 'Hi {firstName}, I came across your work and…';
    $('#listTemplate').closest('.field').querySelector('label').childNodes[0].textContent = msg ? 'Message ' : 'Message template ';
    loadCohortOptions(); // re-filter dropdown to the selected kind
  };
  kindInputs.forEach((r) => r.addEventListener('change', applyKindUi));
```

`loadCohortOptions` filters: `cohorts.filter((c) => (c.kind || 'invite') === selectedKind())`.
`updateTplCount` becomes `counter.textContent = `${tpl.value.length} / ${tpl.maxLength || 300}``.
Submit payload gains `kind: selectedKind()`; before submitting, when kind is message and the template is blank, show `toast(result, 'Messages need a template.', true)` and return.

Cohorts screen (`loadCohortsScreen`/`renderMetricsTable`): split rows by kind:

```js
  renderMetricsTable(metrics.filter((m) => (m.kind || 'invite') === 'invite'));
  renderMsgMetricsTable(metrics.filter((m) => m.kind === 'message'));
```

New renderer (same shape as `renderMetricsTable`, reply columns):

```js
function renderMsgMetricsTable(rows) {
  const body = $('#msgMetricsBody'), empty = $('#msgMetricsEmpty');
  if (!body) return;
  if (!rows.length) { body.replaceChildren(); empty.hidden = false; return; }
  empty.hidden = true;
  body.replaceChildren(...rows.map((m) => {
    const pct = Math.round((m.reply_rate || 0) * 100);
    const rateCell = el('div', { class: 'rate-cell' },
      el('div', { class: 'rate-bar' }, el('i', { style: `width:${pct}%` })),
      el('span', { class: 'rate-val', text: `${pct}%` }),
    );
    const median = (m.median_time_to_reply_days == null) ? '—' : m.median_time_to_reply_days.toFixed(1);
    return el('tr', {},
      el('td', { class: 'mono' }, m.cohort_name || '—'),
      el('td', { class: 'num mono' }, String(m.total)),
      el('td', { class: 'num mono' }, String(m.sent)),
      el('td', { class: 'num mono' }, String(m.replied)),
      el('td', { class: 'num mono' }, String(m.pending)),
      el('td', {}, rateCell),
      el('td', { class: 'num mono' }, median),
    );
  }));
}
```

Cohort cards: in `renderCohortCard`, add a kind badge next to the name and message-appropriate stat line:

```js
  const kind = c.kind || 'invite';
  const stat = m
    ? (kind === 'message'
      ? `${m.total} profiles · ${m.sent} sent · ${Math.round((m.reply_rate || 0) * 100)}% replied`
      : `${m.total} profiles · ${m.sent} sent · ${Math.round((m.acceptance_rate || 0) * 100)}% accepted`)
    : 'no sends yet';
```

and inside the name div: `el('span', { class: `kind-badge ${kind}`, text: kind === 'message' ? '✉ messages' : '+ invites' })`.

Cohort editor: `openCohortEditor` sets `$('#cohortKind').value = c ? (c.kind || 'invite') : 'invite'; $('#cohortKind').disabled = !!c;` (kind fixed after creation); the submit payload gains `kind: $('#cohortKind').value`; the modal's template counter uses 2000 when kind is message (listen on the select's `change`).

- [ ] **Step 4: styles.css**

```css
.kind-toggle { display: grid; gap: 6px; }
.kind-opt { display: flex; gap: 8px; align-items: baseline; cursor: pointer; }
.kind-opt small { color: var(--muted, #8a8f98); }
.kind-badge { font-size: 0.72em; padding: 1px 8px; border-radius: 999px; border: 1px solid currentColor; opacity: 0.75; margin-left: 8px; }
.kind-badge.message { color: var(--msg-accent, #7c6cd8); }
```

- [ ] **Step 5: Manual verification**

Run: `npm start`.
Expected: Add List toggle switches counter to `/ 2000`, filters cohort dropdown, blocks blank-template message submits with a toast; a submitted message list appears in the messages engine's Queued station; Cohorts tab shows the message table and badges.

- [ ] **Step 6: Commit**

```bash
git add src/web/index.html src/web/app.js src/web/styles.css
git commit -m "feat(ui): campaign-type toggle on Add List, message cohort metrics + kind badges"
```

---

### Task 15: Settings UI

**Files:**
- Modify: `src/web/index.html`
- Modify: `src/web/app.js`

- [ ] **Step 1: index.html — message pacing block**

Inside the settings form, after the existing five fields:

```html
        <div class="field span-all"><h3 class="settings-sub">Messages</h3></div>
        <div class="field"><label for="setMsgWeeklyCap">Weekly cap (messages)</label><input id="setMsgWeeklyCap" type="number" min="0" /></div>
        <div class="field"><label for="setMsgBatchSize">Batch size (messages)</label><input id="setMsgBatchSize" type="number" min="1" /></div>
        <div class="field"><label for="setMsgBatchesPerDay">Batches / day (messages)</label><input id="setMsgBatchesPerDay" type="number" min="0" /></div>
        <div class="field"><label for="setReplyChecks">Reply checks / day</label><input id="setReplyChecks" type="number" min="1" max="24" /></div>
```

- [ ] **Step 2: app.js — load/save**

`loadSettings` additions:

```js
    $('#setMsgWeeklyCap').value = s.msg_weekly_cap ?? '';
    $('#setMsgBatchSize').value = s.msg_batch_size ?? '';
    $('#setMsgBatchesPerDay').value = s.msg_batches_per_day ?? '';
    $('#setReplyChecks').value = s.reply_checks_per_day ?? '';
```

`initSettings` patch additions:

```js
      msg_weekly_cap: num('#setMsgWeeklyCap'),
      msg_batch_size: num('#setMsgBatchSize'),
      msg_batches_per_day: num('#setMsgBatchesPerDay'),
      reply_checks_per_day: num('#setReplyChecks'),
```

- [ ] **Step 3: Manual verification**

Run: `npm start` → Settings → change message caps → Save → reload → values persist; messages engine fuel cap reflects the new number.

- [ ] **Step 4: Commit**

```bash
git add src/web/index.html src/web/app.js
git commit -m "feat(ui): message pacing + reply-check settings"
```

---

### Task 16: Docs, full suite, e2e

**Files:**
- Modify: `API.md`, `README.md`

- [ ] **Step 1: Update `API.md`** — document: `kind` on `POST /api/lists` and `POST /api/cohorts`; the `kind` query filter on `GET /api/profiles`; new `GET /api/status` fields (`msg_counts`, `msg_weekly_sent`, `msg_weekly_cap`, `replies_checked_at`, `forecast.msg_next_batch`); `POST /api/recheck-replies`; new settings keys; the `replied` status and `not_connected` skip reason. Follow the file's existing format.

- [ ] **Step 2: Update `README.md`** — a "Message campaigns" section: what it does (messages to existing 1st-degree connections), the kind toggle on Add List, separate caps (defaults 200/week, 5×4), reply checking (default 2/day, upgrade-only), the not-connected skip, and that checkpoints halt both engines.

- [ ] **Step 3: Full verification**

Run: `npm test && npm run typecheck`
Expected: everything green.

- [ ] **Step 4: E2E (user preference: verify before merge)** — with the app running and the browser linked: create a one-profile message cohort pointed at the approved test profile, `Run batch now`, watch it flow Queued → Sent on the messages conveyor; then reply from the test account and hit the Replied station's recheck — status flips to Replied.

- [ ] **Step 5: Commit**

```bash
git add API.md README.md
git commit -m "docs: message campaigns — API and README"
```
