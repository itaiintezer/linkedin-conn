# Relay operability & outcome-tracking upgrade — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Relay transparent about per-request outcomes (already-connected tracking, an Attention view for failures, last-checked timestamp) and easier to operate (queue ETA, next-batch info, trimmed dashboard queue, in-view enqueue notification), plus a sales runbook and a Cowork skill for appending profiles via the self-hosted API.

**Architecture:** Additive data-model changes (one new status string, one new `app_state` column). Pure, unit-tested helpers in `src/core/forecast.ts` for ETA / next-batch / queue ordering. New read endpoints (`/api/queue`, `/api/attention`) and per-id action endpoints. Vanilla-JS frontend changes to dashboard cards, queue section, and a new Attention tab. Docs + a Claude skill.

**Tech Stack:** Node ≥22.5 (`node:sqlite`), Fastify, TypeScript (`tsx`), Vitest, vanilla JS frontend.

**Spec:** `docs/superpowers/specs/2026-06-30-relay-operability-outcome-tracking-design.md`

---

## File Structure

- `src/types.ts` — add `already_connected` to `ProfileStatus` & `EventType`; add `acceptance_checked_at` to `AppState`.
- `src/worker/sender.ts` — `'already'` outcome → `already_connected` status + event.
- `src/core/metrics.ts` — count `already_connected` per cohort.
- `src/db/schema.sql` + `src/db/database.ts` — add `app_state.acceptance_checked_at`.
- `src/db/repositories.ts` — `AppStateRepo.setAcceptanceChecked`; `ProfileRepo.findById`.
- `src/worker/acceptance-checker.ts` — stamp `acceptance_checked_at` on a clean read.
- `src/core/forecast.ts` (new) — `estimateQueueCompletion`, `nextBatch`, `orderUpcoming`.
- `src/api/server.ts` — `/api/status` forecast fields; `/api/queue`; `/api/attention`; per-id retry/dismiss; metrics already_connected.
- `src/web/{index.html,app.js,styles.css}` — notification placement, dashboard cards, queue trim, Attention tab.
- `RUNBOOK.md` (new) — sales-team guide.
- `.claude/skills/relay-add-profiles/SKILL.md` (new) — Cowork skill.
- Tests: `tests/core/forecast.test.ts` (new), and additions to existing metrics/sender/acceptance-checker/server tests.

---

## Task 1: `already_connected` status

**Files:**
- Modify: `src/types.ts`
- Modify: `src/worker/sender.ts:60-62`
- Test: `tests/worker/sender.test.ts:34-41` (update existing)

- [ ] **Step 1: Update the existing sender test to expect the new status**

Replace the test at `tests/worker/sender.test.ts` lines 34–41 with:

```typescript
test('already-connected -> already_connected status + event, not counted as sent', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  seedScheduled('https://www.linkedin.com/in/a', '2026-06-29T09:00:00.000Z', c.id);
  driver.scripted.set('https://www.linkedin.com/in/a', 'already');
  await runSenderOnce(repos, driver, new Date('2026-06-29T10:00:00Z'));
  expect(repos.profiles.byStatus('already_connected')).toHaveLength(1);
  expect(repos.profiles.byStatus('skipped')).toHaveLength(0);
  expect(repos.events.countSentSince('1970-01-01T00:00:00Z')).toBe(0);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/worker/sender.test.ts`
Expected: FAIL — `byStatus('already_connected')` returns 0 (status is still `skipped`).

- [ ] **Step 3: Add the status to the type unions**

In `src/types.ts`, change the `ProfileStatus` union (line 1-3) to include `already_connected`:

```typescript
export type ProfileStatus =
  | 'queued' | 'scheduled' | 'sending' | 'sent'
  | 'accepted' | 'expired' | 'skipped' | 'failed' | 'needs_attention'
  | 'already_connected';
```

And change `EventType` (line 5) to:

```typescript
export type EventType = 'sent' | 'accepted' | 'expired' | 'skipped' | 'failed' | 'already_connected';
```

- [ ] **Step 4: Update the sender's `already` branch**

In `src/worker/sender.ts`, replace the `case 'already':` block (lines 60-62):

```typescript
      case 'already':
        repos.profiles.setStatus(p.id, 'already_connected', { last_error: null });
        repos.events.recordEvent(p.id, 'already_connected');
        break;
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- tests/worker/sender.test.ts`
Expected: PASS (all sender tests).

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/worker/sender.ts tests/worker/sender.test.ts
git commit -m "feat(core): track already-connected as a distinct terminal status"
```

---

## Task 2: Count `already_connected` in cohort metrics

**Files:**
- Modify: `src/core/metrics.ts`
- Test: `tests/core/metrics.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/core/metrics.test.ts`:

```typescript
test('counts already_connected separately and excludes it from acceptance rate', () => {
  const rows: MetricRow[] = [
    { cohort_id: 1, cohort_name: 'A', status: 'accepted', sent_at: '2026-06-20T00:00:00Z', accepted_at: '2026-06-21T00:00:00Z' },
    { cohort_id: 1, cohort_name: 'A', status: 'already_connected', sent_at: null, accepted_at: null },
    { cohort_id: 1, cohort_name: 'A', status: 'sent', sent_at: '2026-06-20T00:00:00Z', accepted_at: null },
  ];
  const [m] = computeCohortMetrics(rows);
  expect(m.already_connected).toBe(1);
  // acceptance rate denominator = accepted + pending + expired = 2, not 3
  expect(m.acceptance_rate).toBeCloseTo(0.5);
});
```

Ensure the file imports `MetricRow` (it already imports from `metrics.js` — add the type to the import if missing).

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/core/metrics.test.ts`
Expected: FAIL — `m.already_connected` is `undefined`.

- [ ] **Step 3: Implement**

In `src/core/metrics.ts`, add `already_connected: number;` to the `CohortMetrics` interface (after `expired`). In `computeCohortMetrics`, inside the loop add:

```typescript
    const alreadyConnected = grp.filter((r) => r.status === 'already_connected').length;
```

and add `already_connected: alreadyConnected,` to the pushed object (after `expired,`). Leave `attempted`/`acceptance_rate` unchanged (already excludes `already_connected`).

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- tests/core/metrics.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/metrics.ts tests/core/metrics.test.ts
git commit -m "feat(metrics): count already-connected per cohort"
```

---

## Task 3: `acceptance_checked_at` column, setter, and stamping

**Files:**
- Modify: `src/db/schema.sql:73` (app_state columns)
- Modify: `src/db/database.ts` (runMigrations)
- Modify: `src/types.ts` (AppState)
- Modify: `src/db/repositories.ts` (AppStateRepo)
- Modify: `src/worker/acceptance-checker.ts`
- Test: `tests/worker/acceptance-checker.test.ts`, `tests/db/app-state.test.ts`

- [ ] **Step 1: Write the failing acceptance-checker test**

Append to `tests/worker/acceptance-checker.test.ts`:

```typescript
test('stamps acceptance_checked_at after a clean read', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  seedSent('https://www.linkedin.com/in/a', c.id);
  driver.connections = ['https://www.linkedin.com/in/a'];
  const now = new Date('2026-06-29T12:00:00Z');
  await runAcceptanceCheck(repos, driver, now);
  expect(repos.appState.get().acceptance_checked_at).toBe(now.toISOString());
});

test('does not stamp acceptance_checked_at when there is nothing to verify', async () => {
  await runAcceptanceCheck(repos, driver, new Date('2026-06-29T12:00:00Z'));
  expect(repos.appState.get().acceptance_checked_at).toBeNull();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/worker/acceptance-checker.test.ts`
Expected: FAIL — `acceptance_checked_at` is not a property / undefined.

- [ ] **Step 3: Add the column to schema and migration**

In `src/db/schema.sql`, add a column to `app_state` (after `failure_streak INTEGER NOT NULL DEFAULT 0`, before the closing paren) — change line 73 region to:

```sql
  failure_streak INTEGER NOT NULL DEFAULT 0,
  acceptance_checked_at TEXT
);
```

In `src/db/database.ts`, inside `runMigrations`, after the `failure_threshold` block add:

```typescript
  const appCols = (db.prepare('PRAGMA table_info(app_state)').all() as { name: string }[]).map((c) => c.name);
  if (!appCols.includes('acceptance_checked_at')) {
    db.exec('ALTER TABLE app_state ADD COLUMN acceptance_checked_at TEXT');
  }
```

- [ ] **Step 4: Add to the AppState type and the repo**

In `src/types.ts`, add to the `AppState` interface (after `failure_streak: number;`):

```typescript
  acceptance_checked_at: string | null; // ISO, last successful acceptance read
```

In `src/db/repositories.ts`, add a method to `AppStateRepo` (after `resetFailureStreak`):

```typescript
  setAcceptanceChecked(iso: string): void {
    this.db.prepare('UPDATE app_state SET acceptance_checked_at = ? WHERE id = 1').run(iso);
  }
```

- [ ] **Step 5: Stamp it on a clean read**

In `src/worker/acceptance-checker.ts`, replace the final line `recordSuccess(repos); // a clean read clears any accumulated streak` with:

```typescript
  repos.appState.setAcceptanceChecked(iso);
  recordSuccess(repos); // a clean read clears any accumulated streak
```

(`iso` is already defined earlier in the function as `now.toISOString()`.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- tests/worker/acceptance-checker.test.ts tests/db/app-state.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.sql src/db/database.ts src/types.ts src/db/repositories.ts src/worker/acceptance-checker.ts tests/worker/acceptance-checker.test.ts
git commit -m "feat(acceptance): record last-checked timestamp on clean reads"
```

---

## Task 4: Forecast helpers (`src/core/forecast.ts`)

**Files:**
- Create: `src/core/forecast.ts`
- Test: `tests/core/forecast.test.ts`

> Note: the helper is a deliberate *estimate*. Daily rate = average sends per sending-day, where weekly throughput is clamped by `weekly_cap`. `sentInWindow` from the spec is intentionally omitted (YAGNI for an average-rate estimate); the result is labelled an estimate in the UI.

- [ ] **Step 1: Write the failing tests**

Create `tests/core/forecast.test.ts`:

```typescript
import { test, expect } from 'vitest';
import { estimateQueueCompletion, nextBatch, orderUpcoming } from '../../src/core/forecast.js';
import type { Settings } from '../../src/types.js';

function settings(over: Partial<Settings> = {}): Settings {
  return {
    id: 1, workday_start_hour: 8, workday_end_hour: 20, weekdays_only: 1,
    weekly_cap: 100, batch_size: 5, batches_per_day: 4, acceptance_checks_per_day: 1,
    account_type: 'unknown', note_quota_exhausted: 0, min_delay_ms: 20000, max_delay_ms: 90000,
    paused: 0, pause_reason: null, onboarded: 1, failure_threshold: 3, ...over,
  };
}

test('estimateQueueCompletion: empty queue finishes now', () => {
  expect(estimateQueueCompletion(0, settings(), new Date('2026-06-30T10:00:00Z')))
    .toEqual({ sendingDays: 0, finishDate: null });
});

test('estimateQueueCompletion: 20/day rate, 40 remaining => 2 sending days', () => {
  // batches_per_day*batch_size = 20; weekly clamp 100 > 20*5 -> rate 20/day
  const r = estimateQueueCompletion(40, settings(), new Date('2026-06-30T10:00:00Z')); // Tue
  expect(r.sendingDays).toBe(2);
});

test('estimateQueueCompletion: weekly cap clamps the daily rate', () => {
  // dailyTarget 20*? set batches high so dailyTarget=200, weekly_cap=100 -> weeklyThroughput=100 over 5 days = 20/day
  const r = estimateQueueCompletion(40, settings({ batches_per_day: 40 }), new Date('2026-06-30T10:00:00Z'));
  expect(r.sendingDays).toBe(2);
});

test('estimateQueueCompletion: zero rate => never (null finishDate)', () => {
  const r = estimateQueueCompletion(10, settings({ batches_per_day: 0 }), new Date('2026-06-30T10:00:00Z'));
  expect(r).toEqual({ sendingDays: 0, finishDate: null });
});

test('estimateQueueCompletion: weekend-aware finish date (Fri + 2 sending days => Mon)', () => {
  // 2026-07-03 is a Friday. 40 remaining at 20/day = 2 sending days: Fri(1), Mon(2).
  const r = estimateQueueCompletion(40, settings(), new Date('2026-07-03T10:00:00Z'));
  expect(new Date(r.finishDate!).getUTCDay()).toBe(1); // Monday
});

test('nextBatch: earliest future timestamp and its group size', () => {
  const rows = [
    { scheduled_for: '2026-06-30T09:00:00.000Z' },
    { scheduled_for: '2026-06-30T11:00:00.000Z' },
    { scheduled_for: '2026-06-30T11:00:00.000Z' },
  ];
  const now = new Date('2026-06-30T10:00:00.000Z'); // 09:00 is past
  expect(nextBatch(rows, now)).toEqual({ at: '2026-06-30T11:00:00.000Z', count: 2 });
});

test('nextBatch: null when nothing scheduled in the future', () => {
  const rows = [{ scheduled_for: '2026-06-30T08:00:00.000Z' }];
  expect(nextBatch(rows, new Date('2026-06-30T10:00:00.000Z'))).toBeNull();
});

test('orderUpcoming: scheduled (by time) before queued (by id)', () => {
  const rows = [
    { id: 3, status: 'queued', scheduled_for: null },
    { id: 1, status: 'scheduled', scheduled_for: '2026-06-30T11:00:00.000Z' },
    { id: 2, status: 'scheduled', scheduled_for: '2026-06-30T09:00:00.000Z' },
    { id: 4, status: 'queued', scheduled_for: null },
    { id: 5, status: 'sent', scheduled_for: null },
  ];
  expect(orderUpcoming(rows).map((r) => r.id)).toEqual([2, 1, 3, 4]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- tests/core/forecast.test.ts`
Expected: FAIL — module `forecast.js` not found.

- [ ] **Step 3: Implement `src/core/forecast.ts`**

```typescript
import type { Settings } from '../types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Average sends per *sending day*, clamped by the weekly cap. 0 => never. */
function dailySendRate(s: Settings): number {
  const dailyTarget = Math.max(0, s.batches_per_day * Math.max(1, s.batch_size));
  const sendingDaysPerWeek = s.weekdays_only ? 5 : 7;
  if (dailyTarget <= 0 || sendingDaysPerWeek <= 0) return 0;
  const weeklyThroughput = Math.min(s.weekly_cap, dailyTarget * sendingDaysPerWeek);
  return weeklyThroughput / sendingDaysPerWeek;
}

function isSendingDay(d: Date, weekdaysOnly: boolean): boolean {
  if (!weekdaysOnly) return true;
  const day = d.getUTCDay();
  return day !== 0 && day !== 6;
}

/** The calendar date of the n-th sending day counting from `start` (inclusive). */
function addSendingDays(start: Date, n: number, weekdaysOnly: boolean): Date {
  let d = new Date(start);
  let counted = 0;
  // Walk forward until we've passed `n` sending days.
  for (let guard = 0; guard < 10000; guard++) {
    if (isSendingDay(d, weekdaysOnly)) {
      counted++;
      if (counted >= n) return d;
    }
    d = new Date(d.getTime() + DAY_MS);
  }
  return d;
}

export function estimateQueueCompletion(
  remaining: number,
  s: Settings,
  now: Date,
): { sendingDays: number; finishDate: string | null } {
  if (remaining <= 0) return { sendingDays: 0, finishDate: null };
  const rate = dailySendRate(s);
  if (rate <= 0) return { sendingDays: 0, finishDate: null };
  const sendingDays = Math.ceil(remaining / rate);
  return { sendingDays, finishDate: addSendingDays(now, sendingDays, s.weekdays_only === 1).toISOString() };
}

export function nextBatch(
  rows: { scheduled_for: string | null }[],
  now: Date,
): { at: string; count: number } | null {
  const future = rows
    .map((r) => r.scheduled_for)
    .filter((t): t is string => t !== null && new Date(t).getTime() > now.getTime());
  if (future.length === 0) return null;
  const at = future.reduce((min, t) => (t < min ? t : min), future[0]);
  return { at, count: future.filter((t) => t === at).length };
}

export function orderUpcoming<T extends { id: number; status: string; scheduled_for: string | null }>(
  rows: T[],
): T[] {
  const scheduled = rows
    .filter((r) => r.status === 'scheduled')
    .sort((a, b) => (a.scheduled_for ?? '').localeCompare(b.scheduled_for ?? ''));
  const queued = rows.filter((r) => r.status === 'queued').sort((a, b) => a.id - b.id);
  return [...scheduled, ...queued];
}
```

> Note: `addSendingDays` uses `getUTCDay`; tests pin times in UTC so the weekend logic is deterministic. The dashboard only renders the date, so UTC vs local drift of a few hours is acceptable for an estimate.

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- tests/core/forecast.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/forecast.ts tests/core/forecast.test.ts
git commit -m "feat(core): add queue forecast helpers (eta, next batch, ordering)"
```

---

## Task 5: `/api/status` forecast + `acceptance_checked_at`

**Files:**
- Modify: `src/api/server.ts:60-80`
- Test: `tests/api/server.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/api/server.test.ts`:

```typescript
test('GET /api/status includes forecast and acceptance_checked_at', async () => {
  const c = repos.cohorts.create('F', 'hi', true);
  const p1 = repos.profiles.add(c.id, 'https://www.linkedin.com/in/q1', null);
  const p2 = repos.profiles.add(c.id, 'https://www.linkedin.com/in/q2', null);
  repos.profiles.setScheduled(p2.id, '2099-01-01T10:00:00.000Z');
  repos.appState.setAcceptanceChecked('2026-06-30T07:00:00.000Z');
  const res = await app.inject({ method: 'GET', url: '/api/status' });
  const body = JSON.parse(res.body);
  expect(body.acceptance_checked_at).toBe('2026-06-30T07:00:00.000Z');
  expect(body.forecast.queue_remaining).toBe(2); // 1 queued + 1 scheduled
  expect(body.forecast).toHaveProperty('eta');
  expect(body.forecast.next_batch).toEqual({ at: '2099-01-01T10:00:00.000Z', count: 1 });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- tests/api/server.test.ts`
Expected: FAIL — `body.forecast` undefined.

- [ ] **Step 3: Implement**

In `src/api/server.ts`, add imports at the top (next to the existing core imports):

```typescript
import { estimateQueueCompletion, nextBatch } from '../core/forecast.js';
```

Replace the `/api/status` handler body (lines 60-80) with:

```typescript
  app.get('/api/status', async () => {
    const counts: Record<string, number> = {};
    for (const p of repos.profiles.all()) counts[p.status] = (counts[p.status] ?? 0) + 1;
    const s = repos.settings.get();
    const a = repos.appState.get();
    const now = new Date();
    const queueRemaining = (counts.queued ?? 0) + (counts.scheduled ?? 0);
    const scheduledRows = repos.profiles.byStatus('scheduled');
    return {
      paused: s.paused,
      pause_reason: s.pause_reason,
      weekly_sent: repos.events.countSentSince(windowStartIso(now)),
      weekly_cap: s.weekly_cap,
      counts,
      loggedIn: a.login_logged_in === 1,
      login_as_of: a.login_confirmed_at,
      acceptance_checked_at: a.acceptance_checked_at,
      forecast: {
        queue_remaining: queueRemaining,
        eta: estimateQueueCompletion(queueRemaining, s, now),
        next_batch: nextBatch(scheduledRows, now),
      },
      guardrail: {
        tripped: a.guardrail_tripped,
        reason: a.guardrail_reason,
        detail: a.guardrail_detail,
        trippedAt: a.guardrail_tripped_at,
      },
    };
  });
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- tests/api/server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/server.ts tests/api/server.test.ts
git commit -m "feat(api): expose queue forecast and last-checked in /api/status"
```

---

## Task 6: `/api/queue` (top-N up for processing)

**Files:**
- Modify: `src/api/server.ts`
- Test: `tests/api/server.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/api/server.test.ts`:

```typescript
test('GET /api/queue returns ordered upcoming work and total', async () => {
  const c = repos.cohorts.create('Q', 'hi', true);
  const a = repos.profiles.add(c.id, 'https://www.linkedin.com/in/sched-late', null);
  const b = repos.profiles.add(c.id, 'https://www.linkedin.com/in/sched-early', null);
  repos.profiles.add(c.id, 'https://www.linkedin.com/in/queued', null);
  repos.profiles.setScheduled(a.id, '2099-01-02T10:00:00.000Z');
  repos.profiles.setScheduled(b.id, '2099-01-01T10:00:00.000Z');
  const res = await app.inject({ method: 'GET', url: '/api/queue?limit=2' });
  const body = JSON.parse(res.body);
  expect(body.total_remaining).toBe(3);
  expect(body.upcoming).toHaveLength(2);
  // earliest scheduled first
  expect(body.upcoming[0].profile_url).toBe('https://www.linkedin.com/in/sched-early');
  expect(body.upcoming[1].profile_url).toBe('https://www.linkedin.com/in/sched-late');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- tests/api/server.test.ts`
Expected: FAIL — 404 / no such route.

- [ ] **Step 3: Implement**

In `src/api/server.ts`, add `orderUpcoming` to the forecast import:

```typescript
import { estimateQueueCompletion, nextBatch, orderUpcoming } from '../core/forecast.js';
```

Add this route after the `/api/profiles` GET handler:

```typescript
  app.get('/api/queue', async (req) => {
    const limitRaw = Number((req.query as { limit?: string }).limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 10;
    const rows = repos.db.prepare(`
      SELECT p.id, p.profile_url, p.status, p.scheduled_for, c.name AS cohort_name
      FROM profiles p JOIN cohorts c ON c.id = p.cohort_id
      WHERE p.status IN ('queued','scheduled')
    `).all() as unknown as { id: number; profile_url: string; status: string; scheduled_for: string | null; cohort_name: string }[];
    const ordered = orderUpcoming(rows);
    return { upcoming: ordered.slice(0, limit), total_remaining: ordered.length };
  });
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- tests/api/server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/server.ts tests/api/server.test.ts
git commit -m "feat(api): add /api/queue for top-N upcoming work"
```

---

## Task 7: `/api/attention` + per-id retry / dismiss

**Files:**
- Modify: `src/db/repositories.ts` (ProfileRepo.findById)
- Modify: `src/api/server.ts`
- Test: `tests/api/server.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/api/server.test.ts`:

```typescript
test('GET /api/attention lists failed and needs_attention with errors', async () => {
  const c = repos.cohorts.create('At', null, true);
  const a = repos.profiles.add(c.id, 'https://www.linkedin.com/in/fail', null);
  const b = repos.profiles.add(c.id, 'https://www.linkedin.com/in/attn', null);
  repos.profiles.add(c.id, 'https://www.linkedin.com/in/ok', null);
  repos.profiles.setStatus(a.id, 'failed', { last_error: 'boom' });
  repos.profiles.setStatus(b.id, 'needs_attention', { last_error: 'note quota' });
  const res = await app.inject({ method: 'GET', url: '/api/attention' });
  const body = JSON.parse(res.body);
  expect(body).toHaveLength(2);
  expect(body.map((r: { last_error: string }) => r.last_error).sort()).toEqual(['boom', 'note quota']);
});

test('POST /api/profiles/:id/retry requeues a single profile', async () => {
  const c = repos.cohorts.create('R1', null, true);
  const a = repos.profiles.add(c.id, 'https://www.linkedin.com/in/r1', null);
  repos.profiles.setStatus(a.id, 'failed', { last_error: 'boom' });
  const res = await app.inject({ method: 'POST', url: `/api/profiles/${a.id}/retry` });
  expect(res.statusCode).toBe(200);
  expect(repos.profiles.findById(a.id)!.status).toBe('queued');
  expect(repos.profiles.findById(a.id)!.last_error).toBeNull();
});

test('POST /api/profiles/:id/dismiss marks it skipped', async () => {
  const c = repos.cohorts.create('D1', null, true);
  const a = repos.profiles.add(c.id, 'https://www.linkedin.com/in/d1', null);
  repos.profiles.setStatus(a.id, 'needs_attention', { last_error: 'x' });
  const res = await app.inject({ method: 'POST', url: `/api/profiles/${a.id}/dismiss` });
  expect(res.statusCode).toBe(200);
  expect(repos.profiles.findById(a.id)!.status).toBe('skipped');
});

test('POST /api/profiles/:id/retry 404s for an unknown id', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/profiles/99999/retry' });
  expect(res.statusCode).toBe(404);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- tests/api/server.test.ts`
Expected: FAIL — `repos.profiles.findById` not a function / routes 404.

- [ ] **Step 3: Add `findById` to ProfileRepo**

In `src/db/repositories.ts`, add to `ProfileRepo` (after `add`):

```typescript
  findById(id: number): Profile | undefined {
    return this.db.prepare('SELECT * FROM profiles WHERE id = ?').get(id) as unknown as Profile | undefined;
  }
```

- [ ] **Step 4: Add the routes**

In `src/api/server.ts`, after the bulk `/api/retry` route, add:

```typescript
  app.get('/api/attention', async () =>
    repos.db.prepare(`
      SELECT p.id, p.profile_url, p.status, p.last_error, p.attempts,
             p.sent_at, p.scheduled_for, c.name AS cohort_name
      FROM profiles p JOIN cohorts c ON c.id = p.cohort_id
      WHERE p.status IN ('failed','needs_attention')
      ORDER BY p.id DESC
    `).all());

  app.post('/api/profiles/:id/retry', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!repos.profiles.findById(id)) return reply.code(404).send({ error: 'profile not found' });
    repos.profiles.setStatus(id, 'queued', { scheduled_for: null, last_error: null });
    return { ok: true };
  });

  app.post('/api/profiles/:id/dismiss', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!repos.profiles.findById(id)) return reply.code(404).send({ error: 'profile not found' });
    repos.profiles.setStatus(id, 'skipped', { last_error: null });
    return { ok: true };
  });
```

- [ ] **Step 5: Run to verify it passes**

Run: `npm test -- tests/api/server.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db/repositories.ts src/api/server.ts tests/api/server.test.ts
git commit -m "feat(api): add /api/attention and per-profile retry/dismiss"
```

---

## Task 8: Backend regression gate

**Files:** none (verification only)

- [ ] **Step 1: Run the full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all tests PASS, no type errors.

- [ ] **Step 2: If anything fails, fix before proceeding.** Do not start frontend tasks on a red suite.

---

## Task 9: Frontend — enqueue notification near the button

**Files:**
- Modify: `src/web/index.html:155-173`
- Modify: `src/web/app.js:325-343`

- [ ] **Step 1: Move the result toast into the right rail**

In `src/web/index.html`, remove the line `<div class="toast" id="listResult" hidden></div>` (line 172, just before `</section>` of `#tab-add`). Add it inside the `.add-rail` aside, immediately after the Enqueue button (`<button class="btn btn-green add-submit" type="submit">Enqueue</button>`):

```html
          <button class="btn btn-green add-submit" type="submit">Enqueue</button>
          <div class="toast" id="listResult" hidden></div>
```

- [ ] **Step 2: Scroll the toast into view after enqueue**

In `src/web/app.js`, in the `#listForm` submit handler, after `toast(result, \`Added ${r.added} of ${r.found} found.\`);` add:

```javascript
      result.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
```

- [ ] **Step 3: Verify manually**

Run: `npm start`, open http://localhost:4400, go to **Add List**, paste two profile URLs, click **Enqueue**. Confirm the "Added N of M found." toast appears directly under the Enqueue button without scrolling.

- [ ] **Step 4: Commit**

```bash
git add src/web/index.html src/web/app.js
git commit -m "fix(web): show enqueue result next to the Enqueue button"
```

---

## Task 10: Frontend — dashboard cards (ETA, next batch, already connected, last-checked, attention)

**Files:**
- Modify: `src/web/app.js:108-136` (renderCards)

- [ ] **Step 1: Replace `renderCards` with the extended version**

In `src/web/app.js`, replace the whole `renderCards` function (lines 108-136) with:

```javascript
function fmtClock(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function fmtEta(eta) {
  if (!eta || eta.finishDate == null) {
    return { value: '—', foot: eta && eta.sendingDays === 0 ? 'queue empty' : 'no capacity' };
  }
  const d = eta.sendingDays;
  const by = new Date(eta.finishDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return { value: `~${d}d`, foot: `by ${by}` };
}

function renderCards(status) {
  const c = status.counts || {};
  const f = status.forecast || {};
  const pct = status.weekly_cap ? Math.min(100, Math.round((status.weekly_sent / status.weekly_cap) * 100)) : 0;
  const eta = fmtEta(f.eta);
  const nb = f.next_batch;
  const attention = (c.failed || 0) + (c.needs_attention || 0);
  const cards = [
    { cls: 'accent-week', label: 'This week', value: `${status.weekly_sent}`, sub: ` / ${status.weekly_cap}`, meter: pct },
    { cls: 'accent-queued', label: 'Queued', value: c.queued || 0 },
    { cls: 'accent-sched', label: 'Scheduled', value: c.scheduled || 0 },
    { cls: 'accent-eta', label: 'Time to finish', value: eta.value, foot: eta.foot },
    { cls: 'accent-next', label: 'Next batch', value: nb ? nb.count : '—', foot: nb ? `at ${fmtClock(nb.at)}` : 'none scheduled' },
    { cls: 'accent-sent', label: 'Sent', value: c.sent || 0 },
    { cls: 'accent-accepted', label: 'Accepted', value: c.accepted || 0, foot: `checked ${status.acceptance_checked_at ? fmtClock(status.acceptance_checked_at) : 'never'}` },
    { cls: 'accent-already', label: 'Already connected', value: c.already_connected || 0 },
    { cls: 'accent-attn', label: 'Needs attention', value: attention, tab: attention > 0 ? 'attention' : null },
  ];
  // Show the bulk Retry button only when there's something to retry.
  const retryBtn = $('#retryFailed');
  if (retryBtn) {
    retryBtn.hidden = attention === 0;
    retryBtn.textContent = attention ? `Retry failed (${attention})` : 'Retry failed';
  }
  const wrap = $('#statCards');
  wrap.replaceChildren(...cards.map((card) => {
    const valNode = el('div', { class: 'value' }, String(card.value));
    if (card.sub) valNode.appendChild(el('span', { class: 'sub', text: card.sub }));
    const children = [el('div', { class: 'label', text: card.label }), valNode];
    if (card.meter != null) {
      children.push(el('div', { class: 'meter' }, el('i', { style: `width:${card.meter}%` })));
    }
    if (card.foot) children.push(el('div', { class: 'card-foot', text: card.foot }));
    const node = el('div', { class: `card ${card.cls}${card.tab ? ' is-clickable' : ''}` }, ...children);
    if (card.tab) node.addEventListener('click', () => switchTab(card.tab));
    return node;
  }));
}
```

- [ ] **Step 2: Add a `switchTab` helper used by the clickable card**

In `src/web/app.js`, inside `initTabs` the click handler is inline. Add a reusable `switchTab` function just above `initTabs` (around line 63):

```javascript
function switchTab(name) {
  const tab = $$('.tab').find((t) => t.dataset.tab === name);
  if (tab) tab.click();
}
```

- [ ] **Step 3: Verify manually**

Run: `npm start`. On the dashboard confirm new cards render: **Time to finish**, **Next batch**, **Already connected**, the **Accepted** card shows "checked …", and clicking **Needs attention** (when > 0) jumps to the Attention tab (built in Task 11; until then the click is a no-op).

- [ ] **Step 4: Commit**

```bash
git add src/web/app.js
git commit -m "feat(web): dashboard cards for eta, next batch, already-connected, last-checked"
```

---

## Task 11: Frontend — trimmed queue + View more, and the Attention tab

**Files:**
- Modify: `src/web/index.html` (tabs nav, queue section, new Attention panel)
- Modify: `src/web/app.js` (refreshQueue, Attention tab logic, tab wiring)

- [ ] **Step 1: Add the Attention tab button and trim the queue header**

In `src/web/index.html`, change the tabs nav (lines 96-102) to add an Attention tab:

```html
  <nav class="tabs" id="tabs">
    <button class="tab is-active" data-tab="dashboard">Dashboard</button>
    <button class="tab" data-tab="attention">Attention</button>
    <button class="tab" data-tab="add">Add List</button>
    <button class="tab" data-tab="cohorts">Cohorts</button>
    <button class="tab" data-tab="metrics">Metrics</button>
    <button class="tab" data-tab="settings">Settings</button>
  </nav>
```

Change the dashboard Queue sub-head (lines 122-127) to add a "View more" button:

```html
      <div class="panel-head sub">
        <div class="panel-title">
          <h3>Up next</h3>
        </div>
        <div class="panel-actions">
          <span class="muted" id="queueCount"></span>
          <button class="btn btn-ghost" id="queueMore" hidden>View more</button>
        </div>
      </div>
```

- [ ] **Step 2: Add the Attention panel**

In `src/web/index.html`, immediately after the closing `</section>` of `#tab-dashboard` (line 137), insert:

```html
    <!-- ATTENTION -->
    <section class="panel" id="tab-attention" hidden>
      <div class="panel-head">
        <div class="panel-title">
          <h2>Needs attention</h2>
          <p class="panel-sub">Profiles that failed or need a manual look</p>
        </div>
        <div class="panel-actions">
          <button class="btn" id="attentionRetryAll" title="Requeue everything here">Retry all</button>
        </div>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr><th>Profile</th><th>Cohort</th><th>Status</th><th class="num">Attempts</th><th>Error</th><th>Actions</th></tr>
          </thead>
          <tbody id="attentionBody"></tbody>
        </table>
        <div class="empty" id="attentionEmpty" hidden>Nothing needs attention. 🎉</div>
      </div>
    </section>
```

- [ ] **Step 3: Add Attention tab loading to the tab router**

In `src/web/app.js`, in `initTabs` add a branch so switching to the tab loads it. Change the block (lines 70-74) to:

```javascript
      if (name === 'add') loadCohortOptions();
      if (name === 'cohorts') loadCohorts();
      if (name === 'metrics') loadMetrics();
      if (name === 'settings') loadSettings();
      if (name === 'attention') loadAttention();
```

- [ ] **Step 4: Replace `refreshQueue` to use `/api/queue` with View more**

In `src/web/app.js`, replace `refreshQueue` (lines 177-192) with:

```javascript
let queueLimit = 10;

async function refreshQueue() {
  const body = $('#queueBody'), empty = $('#queueEmpty'), count = $('#queueCount'), more = $('#queueMore');
  try {
    const { upcoming, total_remaining } = await api(`/api/queue?limit=${queueLimit}`);
    count.textContent = `${total_remaining} up for processing`;
    if (more) more.hidden = total_remaining <= upcoming.length;
    if (!upcoming.length) { body.replaceChildren(); empty.hidden = false; return; }
    empty.hidden = true;
    body.replaceChildren(...upcoming.map((p) => el('tr', {},
      el('td', {}, el('a', { href: p.profile_url, target: '_blank', rel: 'noopener', text: slugFromUrl(p.profile_url) })),
      el('td', { class: 'mono' }, p.cohort_name || '—'),
      el('td', {}, el('span', { class: `pill ${p.status}`, text: p.status.replace('_', ' ') })),
      el('td', { class: 'mono' }, fmtTime(p.scheduled_for)),
      el('td', { class: 'mono' }, '—'),
    )));
  } catch (_) { /* transient */ }
}
```

> Note: the queue table header still has a "Note" column from the old markup; the last cell now renders "—". That's fine — leave the header as-is to avoid churn, or (optional) the engineer may relabel the 5th `<th>` to "Scheduled note". Not required.

- [ ] **Step 5: Add the Attention tab controller**

In `src/web/app.js`, add these functions (place them after `refreshQueue`):

```javascript
async function loadAttention() {
  const body = $('#attentionBody'), empty = $('#attentionEmpty');
  try {
    const rows = await api('/api/attention');
    if (!rows.length) { body.replaceChildren(); empty.hidden = false; return; }
    empty.hidden = true;
    body.replaceChildren(...rows.map((p) => el('tr', {},
      el('td', {}, el('a', { href: p.profile_url, target: '_blank', rel: 'noopener', text: slugFromUrl(p.profile_url) })),
      el('td', { class: 'mono' }, p.cohort_name || '—'),
      el('td', {}, el('span', { class: `pill ${p.status}`, text: p.status.replace('_', ' ') })),
      el('td', { class: 'num mono' }, String(p.attempts ?? 0)),
      el('td', { class: 'err', title: p.last_error || '' }, p.last_error || '—'),
      el('td', { class: 'row-actions' },
        el('button', { class: 'btn btn-ghost', onclick: () => actOnProfile(p.id, 'retry') }, 'Retry'),
        el('button', { class: 'btn btn-ghost', onclick: () => actOnProfile(p.id, 'dismiss') }, 'Dismiss'),
      ),
    )));
  } catch (_) { empty.hidden = false; }
}

async function actOnProfile(id, action) {
  try {
    await api(`/api/profiles/${id}/${action}`, { method: 'POST' });
    await loadAttention();
    await refreshStatus();
  } catch (_) { /* ignore */ }
}

function initAttention() {
  const more = $('#queueMore');
  if (more) more.addEventListener('click', () => { queueLimit = queueLimit >= 1000 ? 10 : 1000; more.textContent = queueLimit >= 1000 ? 'Show less' : 'View more'; refreshQueue(); });
  const retryAll = $('#attentionRetryAll');
  if (retryAll) retryAll.addEventListener('click', async () => {
    retryAll.disabled = true;
    try { await api('/api/retry', { method: 'POST' }); await loadAttention(); await refreshStatus(); }
    catch (_) { /* ignore */ }
    retryAll.disabled = false;
  });
}
```

- [ ] **Step 6: Wire `initAttention` into boot**

In `src/web/app.js`, in `init()` (around line 493-500), add `initAttention();` after `initSettings();`.

- [ ] **Step 7: Verify manually**

Run: `npm start`. 
1. Dashboard "Up next" shows ≤10 rows; if you enqueue >10 profiles, **View more** appears and expands the list.
2. Use the API to force a failure (or set a profile to `failed` in the DB), open **Attention**: the row shows status + error + attempts, and **Retry**/**Dismiss** work (row disappears, dashboard count drops). **Retry all** clears the list.

- [ ] **Step 8: Commit**

```bash
git add src/web/index.html src/web/app.js
git commit -m "feat(web): trim dashboard queue with View more + add Attention tab"
```

---

## Task 12: Styles for new cards, tab, and row actions

**Files:**
- Modify: `src/web/styles.css`

- [ ] **Step 1: Inspect existing card/accent styles**

Open `src/web/styles.css` and find the `.card` accent rules (e.g. `.accent-week`, `.accent-accepted`) and the `.card .sub` rule. Match their visual language.

- [ ] **Step 2: Append new styles**

Append to `src/web/styles.css`:

```css
/* New dashboard card accents */
.card.accent-eta   { --accent: #7c9cff; }
.card.accent-next  { --accent: #5fd0c0; }
.card.accent-already { --accent: #b48ce0; }
.card-foot { margin-top: 4px; font-size: 0.72rem; color: var(--muted, #8a8f98); font-variant-numeric: tabular-nums; }
.card.is-clickable { cursor: pointer; }
.card.is-clickable:hover { filter: brightness(1.08); }

/* Attention tab row actions */
.row-actions { display: flex; gap: 6px; }
.row-actions .btn { padding: 2px 10px; font-size: 0.78rem; }
```

> Note: if `styles.css` defines accent colors via a different mechanism than a `--accent` custom property, adapt these three accent rules to match the existing pattern (the engineer should read the file first — Step 1). The `.card-foot`, `.is-clickable`, and `.row-actions` rules are pattern-independent.

- [ ] **Step 3: Verify manually**

Run: `npm start`. Confirm the new cards have distinct accents, footnotes render small/muted, the clickable Needs-attention card has a hover cue, and Attention row buttons are compact.

- [ ] **Step 4: Commit**

```bash
git add src/web/styles.css
git commit -m "style(web): styles for new cards, footnotes, and attention actions"
```

---

## Task 13: `RUNBOOK.md` for the sales team

**Files:**
- Create: `RUNBOOK.md`

- [ ] **Step 1: Write the runbook**

Create `RUNBOOK.md`:

```markdown
# Relay — Sales Team Runbook

Relay sends LinkedIn connection requests for you, slowly and safely, from your own
LinkedIn account on your own machine. This guide gets you from zero to running.

## 1. One-time setup
1. Install **Node.js 22.5 or newer** from https://nodejs.org (the "LTS" build is fine if
   it's ≥ 22.5; otherwise pick "Current").
2. Get the Relay folder onto your machine (ask whoever shared it for the zip or repo link).
3. Open a terminal **in the Relay folder** and run:
   ```
   npm install
   npm start
   ```
4. Open your browser to **http://localhost:4400**.

Leave the terminal window open — that's the engine. Closing it stops sending.

## 2. Connect your LinkedIn (first run)
A setup wizard appears the first time.
1. Click **Open LinkedIn login**. A browser window opens — log in to LinkedIn normally.
   Relay never sees or stores your password; it just borrows the logged-in window.
2. When the dashboard shows **linked** (green dot, top right), click **Continue**.
3. Pick your **account type** (Free / Premium / Sales Navigator) so limits match your plan.
   Click **Finish setup**.

## 3. Add people to contact
1. Go to **Add List**.
2. Paste LinkedIn profile URLs (one per line), or drag a `.csv` / `.txt` file into the box.
3. (Optional) Give the cohort a name and a **message template**. Use `{firstName}` to
   personalize, e.g. `Hi {firstName}, loved your post on…`. Leave it blank to send a bare
   request with no note.
4. Click **Enqueue**. A confirmation ("Added X of Y found.") appears right under the button.

Relay then schedules sends at random times inside your working hours, a few per batch,
never exceeding your weekly cap.

## 4. Reading the dashboard
Each card:
- **This week** — how many requests went out in the last 7 days vs your cap.
- **Queued / Scheduled** — waiting to be scheduled / already given a send time.
- **Time to finish** — rough estimate of how long the current queue will take.
- **Next batch** — how many go out next and at what time.
- **Sent** — requests delivered.
- **Accepted** — people who accepted. "checked …" shows when acceptance was last verified
  (Relay checks about once a day — see below).
- **Already connected** — people you were *already* connected to (skipped, not re-sent).
- **Needs attention** — anything that failed. Click it to open the **Attention** tab.

**Up next** lists the next 10 profiles to be processed. **View more** shows the rest.

## 5. The Attention tab
If something fails (LinkedIn UI hiccup, a profile that can't receive requests, etc.) it
lands here with the reason. For each row you can:
- **Retry** — put it back in the queue to try again.
- **Dismiss** — give up on it (marks it skipped).
Or use **Retry all** to requeue everything at once.

## 6. How acceptance tracking works
About once a day, Relay opens two LinkedIn pages in the background:
1. **Sent invitations** — anything still listed here is **pending**.
2. **Recent connections** — anyone here that you sent a request to is marked **accepted**.
A sent request that is no longer pending and not found in recent connections is marked
**expired**. This read is lightweight and does **not** count against your weekly send cap.
The "checked …" time on the Accepted card tells you when this last ran.

## 7. Safety
- If LinkedIn shows a **captcha or security check**, Relay pauses itself and shows a red
  banner. Solve the challenge in the LinkedIn browser window, then click
  **"I've fixed it — re-check & resume."**
- You can **Pause** / **Resume** anytime from the dashboard.
- Relay caps sends per week (default 100) and per day to stay well within safe limits.

## 8. Troubleshooting
- **Dashboard says "not logged in"** → click **Connect LinkedIn** and log in again.
- **Nothing is sending** → check you're not Paused, that it's within working hours
  (default 8am–8pm, weekdays), and that the queue isn't empty.
- **Lots of failures in Attention** → LinkedIn may have changed its page layout; contact
  whoever maintains Relay. Pause until it's fixed.
- **Stop everything** → close the terminal window running `npm start`.
```

- [ ] **Step 2: Commit**

```bash
git add RUNBOOK.md
git commit -m "docs: add sales-team runbook"
```

---

## Task 14: Cowork skill to append profiles via the API

**Files:**
- Create: `.claude/skills/relay-add-profiles/SKILL.md`

- [ ] **Step 1: Write the skill**

Create `.claude/skills/relay-add-profiles/SKILL.md`:

```markdown
---
name: relay-add-profiles
description: Append LinkedIn profile URLs to the self-hosted Relay outreach queue via its local API. Use when the user wants to add one or more LinkedIn profiles (paste URLs, "add these to Relay", "queue these people", "send connection requests to…") to their running Relay instance. Supports an optional cohort name and message template.
---

# Add profiles to Relay

Relay runs locally and exposes an HTTP API. This skill POSTs LinkedIn profile URLs to it.

## Base URL
Default `http://localhost:4400`. If `RELAY_URL` is set in the environment, use that instead.
Relay must be running (`npm start` in its folder) for these calls to succeed.

## Decide which endpoint
- **Exactly one** profile URL → `POST /api/profiles`
  body: `{ "url": "<profile url>", "cohort": "<optional>", "message": "<optional template>" }`
- **Two or more** URLs → `POST /api/lists`
  body: `{ "text": "<all urls, newline-separated>", "cohort": "<optional>", "message_template": "<optional template>" }`

`{firstName}` in a message/template is substituted by Relay at send time. Omit the
message entirely to send bare requests (no note).

## Steps
1. Collect the LinkedIn profile URL(s) from the user. Validate each looks like
   `https://www.linkedin.com/in/<slug>`.
2. Determine `BASE = ${RELAY_URL:-http://localhost:4400}`.
3. If exactly one URL, run:
   ```bash
   curl -sS -X POST "$BASE/api/profiles" \
     -H 'Content-Type: application/json' \
     -d '{"url":"<URL>","cohort":"<COHORT or omit>","message":"<MESSAGE or omit>"}'
   ```
4. If multiple URLs, join them with newlines into TEXT and run:
   ```bash
   curl -sS -X POST "$BASE/api/lists" \
     -H 'Content-Type: application/json' \
     -d '{"text":"<URL1\nURL2\n…>","cohort":"<COHORT or omit>","message_template":"<TEMPLATE or omit>"}'
   ```
5. Report the result. `/api/lists` returns `{ added, found }` — tell the user how many were
   added vs found (duplicates already in the queue are not re-added). `/api/profiles`
   returns the created `{ id, profile_url }`.

## Errors
- Connection refused / cannot reach `$BASE` → Relay isn't running. Tell the user to start
  it (`npm start` in the Relay folder) or check `RELAY_URL`.
- `400 invalid linkedin profile url` → the URL wasn't a recognizable `/in/<slug>` link.
```

- [ ] **Step 2: Verify the skill end-to-end (optional, requires a running Relay)**

If a Relay instance is available: `npm start`, then
```bash
curl -sS -X POST "http://localhost:4400/api/profiles" -H 'Content-Type: application/json' -d '{"url":"https://www.linkedin.com/in/test-skill","cohort":"SkillTest"}'
```
Expected: JSON with `id` and `profile_url`; the profile appears in **Up next** on the dashboard.

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/relay-add-profiles/SKILL.md
git commit -m "feat(skill): Cowork skill to append profiles to Relay via the API"
```

---

## Task 15: Final verification

**Files:** none

- [ ] **Step 1: Full automated gate**

Run: `npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 2: Manual smoke of the running app**

Run: `npm start`, open http://localhost:4400. Confirm, in one pass:
- Add List → Enqueue shows the toast next to the button.
- Dashboard shows all new cards with sensible values; "Up next" ≤10 with View more.
- Attention tab lists failures with Retry/Dismiss/Retry-all working.
- Metrics tab is unbroken (it still renders; already_connected is counted server-side).

- [ ] **Step 3: Update README pointer (small)**

In `README.md`, under a suitable spot (e.g. after "## Setup"), add a line:
```markdown
Non-technical operators: see [RUNBOOK.md](RUNBOOK.md).
```
Commit:
```bash
git add README.md
git commit -m "docs: link the runbook from the README"
```

- [ ] **Step 4: Hand off** — use `superpowers:finishing-a-development-branch` to decide merge/PR.

---

## Self-Review (completed)

- **Spec coverage:** notification placement (T9), ETA card (T4/T5/T10), last-checked (T3/T5/T10), next-batch (T4/T5/T10), runbook (T13), Cowork skill (T14), top-10 queue + View more (T6/T11), already-connected status+metric (T1/T2/T10), Attention tab + better outcome tracking (T7/T11), acceptance mechanism documented (T13). Acceptance robustness explicitly deferred per spec. ✓
- **Placeholders:** none — all code blocks are concrete. The two "optional" notes (queue header relabel, accent-color adaptation) are clearly optional and pattern-dependent. ✓
- **Type consistency:** `already_connected` used identically across types/sender/metrics; `acceptance_checked_at` consistent across schema/migration/type/repo/checker/api; forecast function names (`estimateQueueCompletion`, `nextBatch`, `orderUpcoming`) match between `forecast.ts`, its tests, and `server.ts`; `findById` added before use. ✓
```
