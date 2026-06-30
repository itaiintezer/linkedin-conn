# Next-batch Prediction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the dashboard "Next batch" card always informative — show an exact slot when one exists, a predicted next-window start when a backlog is waiting, or a blocked reason when sending is prevented — instead of a bare "None Scheduled".

**Architecture:** A pure decision function `nextBatchForecast` in `src/core/forecast.ts` returns a discriminated union (`null` | exact | predicted | blocked). `/api/status` computes the DB-derived inputs (backlog, weekly/daily remaining, paused, guardrail) and calls it. The daily-budget math is extracted into `src/core/daily-budget.ts` so the API and the scheduler share one source of truth. The web card renders the union with a relative-day label.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Fastify, better-sqlite3, Vitest. Vanilla-JS frontend in `src/web/app.js`.

**Spec:** `docs/superpowers/specs/2026-06-30-next-batch-prediction-design.md`

---

## File Structure

- **Create** `src/core/daily-budget.ts` — pure-ish daily-quota helpers (`dailyTargetFor`, `committedToday`, `dailyRemainingFor`). Owns the "how much of today's quota is spent" math.
- **Modify** `src/worker/scheduler-service.ts` — delete its private `committedToday`/inline `dailyTarget`; import them from `daily-budget.ts`. No behavior change.
- **Modify** `src/core/forecast.ts` — add the `NextBatch` type and `nextBatchForecast(...)`. Keep the existing `nextBatch` primitive (earliest future slot) and reuse it internally.
- **Modify** `src/api/server.ts` — compute inputs in `/api/status` and return `forecast.next_batch = nextBatchForecast(...)`.
- **Modify** `src/web/app.js` — render the union in `renderCards`; add a `fmtRelDay` helper.
- **Tests:** `tests/core/daily-budget.test.ts` (new), extend `tests/core/forecast.test.ts`, extend `tests/api/server.test.ts`.

**Timezone note (read before Task 2):** the real scheduler (`scheduler-service.ts`) decides sending days and window hours in **local time** (`now.getDay()`, `setHours(...)`). The prediction must mirror that to be accurate, so `nextBatchForecast`'s prediction branch uses local-time helpers (`getDay`, `setHours`) — distinct from the existing UTC-based `isSendingDay`/`addSendingDays` used by `estimateQueueCompletion`. Tests therefore construct `now` with `new Date(y, mIndex, d, h, m)` (local) and assert on `getDay()`/`getHours()` (local), making them timezone-independent.

---

## Task 1: Extract daily-budget helpers (refactor, no behavior change)

**Files:**
- Create: `src/core/daily-budget.ts`
- Modify: `src/worker/scheduler-service.ts:5-17` (remove local `committedToday`) and `:38-40` (use `dailyTargetFor`)
- Test: `tests/core/daily-budget.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/core/daily-budget.test.ts`:

```ts
import { test, expect } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { dailyTargetFor, committedToday, dailyRemainingFor } from '../../src/core/daily-budget.js';
import type { Settings } from '../../src/types.js';

function settings(over: Partial<Settings> = {}): Settings {
  return {
    id: 1, workday_start_hour: 8, workday_end_hour: 20, weekdays_only: 1,
    weekly_cap: 100, batch_size: 5, batches_per_day: 4, acceptance_checks_per_day: 1,
    account_type: 'unknown', note_quota_exhausted: 0, min_delay_ms: 20000, max_delay_ms: 90000,
    paused: 0, pause_reason: null, onboarded: 1, failure_threshold: 3, ...over,
  };
}

test('dailyTargetFor: batches_per_day * max(1, batch_size)', () => {
  expect(dailyTargetFor(settings())).toBe(20);          // 4 * 5
  expect(dailyTargetFor(settings({ batch_size: 0 }))).toBe(4); // 4 * max(1,0)
});

test('committedToday counts scheduled rows plus profiles sent today', () => {
  const repos = new Repos(openDatabase(':memory:'));
  const c = repos.cohorts.create('C', null, true);
  const a = repos.profiles.add(c.id, 'https://www.linkedin.com/in/a', null);
  const b = repos.profiles.add(c.id, 'https://www.linkedin.com/in/b', null);
  const now = new Date(2026, 6, 1, 12, 0); // local noon, Wed 2026-07-01
  repos.profiles.setScheduled(a.id, new Date(2026, 6, 1, 15, 0).toISOString()); // -> scheduled
  repos.profiles.setStatus(b.id, 'sent', { sent_at: new Date(2026, 6, 1, 9, 0).toISOString() });
  expect(committedToday(repos, now)).toBe(2);
});

test('dailyRemainingFor never goes negative', () => {
  const repos = new Repos(openDatabase(':memory:'));
  const now = new Date(2026, 6, 1, 12, 0);
  expect(dailyRemainingFor(repos, settings({ batches_per_day: 0 }), now)).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/daily-budget.test.ts`
Expected: FAIL — cannot resolve `../../src/core/daily-budget.js` (module not found).

- [ ] **Step 3: Create the helper module**

Create `src/core/daily-budget.ts`:

```ts
import type { Repos } from '../db/repositories.js';
import type { Settings } from '../types.js';

/** Intended sends per day: batches_per_day * batch_size (batch_size floored at 1). */
export function dailyTargetFor(s: Settings): number {
  return Math.max(0, s.batches_per_day * Math.max(1, s.batch_size));
}

/**
 * How many sends today's quota has already committed: profiles still scheduled
 * plus profiles already sent today. Subtracting this from the daily target keeps
 * repeated planning runs (startup + hourly) from stacking past the daily cap.
 */
export function committedToday(repos: Repos, now: Date): number {
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const startIso = dayStart.toISOString();
  const scheduled = repos.profiles.byStatus('scheduled').length;
  const sentToday = repos.profiles.all().filter((p) => p.sent_at !== null && p.sent_at >= startIso).length;
  return scheduled + sentToday;
}

/** Remaining daily quota, never negative. */
export function dailyRemainingFor(repos: Repos, s: Settings, now: Date): number {
  return Math.max(0, dailyTargetFor(s) - committedToday(repos, now));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/daily-budget.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Point scheduler-service at the shared helpers**

In `src/worker/scheduler-service.ts`, delete the local `committedToday` function (lines 5-17) and update the import block + daily-target line.

Replace the top import:

```ts
import type { Repos } from '../db/repositories.js';
import { planDailyBatches, assignSchedule } from '../core/schedule.js';
import { windowStartIso, remainingCapacity } from '../core/rate-limit.js';
import { dailyTargetFor, committedToday } from '../core/daily-budget.js';
```

Replace the daily-budget lines inside `planAndAssignToday` (was lines 38-40):

```ts
  const batchSize = Math.max(1, s.batch_size);
  const dailyTarget = dailyTargetFor(s);
  const dailyBudget = Math.max(0, dailyTarget - committedToday(repos, now));
  if (dailyBudget <= 0) return;
```

(The local `committedToday` definition and the old `const dailyTarget = Math.max(0, s.batches_per_day * batchSize)` line are now gone.)

- [ ] **Step 6: Verify scheduler behavior is unchanged**

Run: `npx vitest run tests/worker/scheduler-service.test.ts`
Expected: PASS (all existing scheduler tests still green).

- [ ] **Step 7: Commit**

```bash
git add src/core/daily-budget.ts src/worker/scheduler-service.ts tests/core/daily-budget.test.ts
git commit -m "refactor(core): extract daily-budget helpers shared by scheduler"
```

---

## Task 2: `nextBatchForecast` decision function

**Files:**
- Modify: `src/core/forecast.ts` (add type + function; keep existing `nextBatch` primitive)
- Test: `tests/core/forecast.test.ts` (append cases)

- [ ] **Step 1: Write the failing tests**

Append to `tests/core/forecast.test.ts`. Add `nextBatchForecast` and `NextBatch` to the existing import on line 2:

```ts
import { estimateQueueCompletion, nextBatch, nextBatchForecast, orderUpcoming } from '../../src/core/forecast.js';
```

Then append these tests (the `settings` helper already exists in this file):

```ts
const baseCtx = {
  backlog: 30, weeklyRemaining: 100, dailyRemaining: 20,
  guardrailTripped: false, paused: false, settings: settings(),
};

test('nextBatchForecast: empty backlog => null', () => {
  expect(nextBatchForecast([], { ...baseCtx, backlog: 0 }, new Date(2026, 6, 1, 12, 0))).toBeNull();
});

test('nextBatchForecast: guardrail beats paused beats weekly-cap', () => {
  const now = new Date(2026, 6, 1, 12, 0);
  expect(nextBatchForecast([], { ...baseCtx, guardrailTripped: true, paused: true, weeklyRemaining: 0 }, now))
    .toEqual({ blocked: true, reason: 'Guardrail tripped' });
  expect(nextBatchForecast([], { ...baseCtx, paused: true, weeklyRemaining: 0 }, now))
    .toEqual({ blocked: true, reason: 'Paused' });
});

test('nextBatchForecast: paused overrides an existing exact slot', () => {
  const rows = [{ scheduled_for: new Date(2026, 6, 1, 15, 0).toISOString() }];
  const now = new Date(2026, 6, 1, 12, 0);
  expect(nextBatchForecast(rows, { ...baseCtx, paused: true }, now))
    .toEqual({ blocked: true, reason: 'Paused' });
});

test('nextBatchForecast: zero send rate => Sending disabled', () => {
  const now = new Date(2026, 6, 1, 12, 0);
  expect(nextBatchForecast([], { ...baseCtx, settings: settings({ batches_per_day: 0 }) }, now))
    .toEqual({ blocked: true, reason: 'Sending disabled' });
});

test('nextBatchForecast: weekly cap reached => Weekly cap reached', () => {
  const now = new Date(2026, 6, 1, 12, 0);
  expect(nextBatchForecast([], { ...baseCtx, weeklyRemaining: 0 }, now))
    .toEqual({ blocked: true, reason: 'Weekly cap reached' });
});

test('nextBatchForecast: exact future slot => estimated false', () => {
  const at = new Date(2026, 6, 1, 15, 0).toISOString();
  const rows = [{ scheduled_for: at }, { scheduled_for: at }];
  const now = new Date(2026, 6, 1, 12, 0);
  expect(nextBatchForecast(rows, baseCtx, now)).toEqual({ estimated: false, at, count: 2 });
});

test('nextBatchForecast: backlog + budget left today => predict today window', () => {
  const now = new Date(2026, 6, 1, 10, 0); // Wed, before end hour 20
  const r = nextBatchForecast([], baseCtx, now);
  expect(r).toMatchObject({ estimated: true, count: 5 }); // min(batch_size 5, backlog 30)
  const at = new Date((r as { at: string }).at);
  expect(at.getDay()).toBe(3);     // same day (Wed)
  expect(at.getHours()).toBe(10);  // max(now, workday_start 8) => now
});

test('nextBatchForecast: today budget spent => predict next sending day start', () => {
  const now = new Date(2026, 6, 1, 10, 0); // Wed
  const r = nextBatchForecast([], { ...baseCtx, dailyRemaining: 0 }, now);
  const at = new Date((r as { at: string }).at);
  expect(at.getDay()).toBe(4);    // Thursday
  expect(at.getHours()).toBe(8);  // workday_start_hour
});

test('nextBatchForecast: after hours => next sending day start', () => {
  const now = new Date(2026, 6, 1, 21, 0); // Wed 21:00, past end hour 20
  const r = nextBatchForecast([], baseCtx, now);
  const at = new Date((r as { at: string }).at);
  expect(at.getDay()).toBe(4);    // Thursday
  expect(at.getHours()).toBe(8);
});

test('nextBatchForecast: weekend + weekdays_only => predict Monday', () => {
  const now = new Date(2026, 6, 4, 10, 0); // Saturday 2026-07-04
  const r = nextBatchForecast([], baseCtx, now);
  const at = new Date((r as { at: string }).at);
  expect(at.getDay()).toBe(1);    // Monday
  expect(at.getHours()).toBe(8);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/core/forecast.test.ts`
Expected: FAIL — `nextBatchForecast is not exported` / not a function.

- [ ] **Step 3: Implement the type and function**

In `src/core/forecast.ts`, no new imports are needed — the function reuses the existing `dailySendRate` and `nextBatch` already defined in this file. Add the exported type and function (place after the existing `nextBatch` function so `nextBatch` is in scope):

```ts
export type NextBatch =
  | null
  | { estimated: false; at: string; count: number }
  | { estimated: true; at: string; count: number }
  | { blocked: true; reason: string };

export interface NextBatchContext {
  backlog: number;        // queued + scheduled remaining
  weeklyRemaining: number;
  dailyRemaining: number;
  guardrailTripped: boolean;
  paused: boolean;
  settings: Settings;
}

/** Local-time sending-day test, mirroring scheduler-service (which uses local time). */
function isLocalSendingDay(d: Date, weekdaysOnly: boolean): boolean {
  if (!weekdaysOnly) return true;
  const day = d.getDay();
  return day !== 0 && day !== 6;
}

function localWindowStart(day: Date, startHour: number): Date {
  const d = new Date(day);
  d.setHours(startHour, 0, 0, 0);
  return d;
}

/** Start of the next sending day's working window, strictly after `now`'s day. */
function nextSendingWindowStart(now: Date, s: Settings): Date {
  const d = new Date(now);
  for (let guard = 0; guard < 14; guard++) {
    d.setDate(d.getDate() + 1);
    if (isLocalSendingDay(d, s.weekdays_only === 1)) return localWindowStart(d, s.workday_start_hour);
  }
  return localWindowStart(d, s.workday_start_hour);
}

/**
 * Resolve what the "next batch" card should show. Priority order (first match wins):
 * empty backlog -> guardrail -> paused -> sending-disabled -> weekly-cap ->
 * exact materialized slot -> predicted next window.
 */
export function nextBatchForecast(
  scheduledRows: { scheduled_for: string | null }[],
  ctx: NextBatchContext,
  now: Date,
): NextBatch {
  const s = ctx.settings;
  if (ctx.backlog <= 0) return null;
  if (ctx.guardrailTripped) return { blocked: true, reason: 'Guardrail tripped' };
  if (ctx.paused) return { blocked: true, reason: 'Paused' };
  if (dailySendRate(s) <= 0) return { blocked: true, reason: 'Sending disabled' };
  if (ctx.weeklyRemaining <= 0) return { blocked: true, reason: 'Weekly cap reached' };

  const exact = nextBatch(scheduledRows, now);
  if (exact) return { estimated: false, at: exact.at, count: exact.count };

  const count = Math.min(Math.max(1, s.batch_size), ctx.backlog);
  const endToday = new Date(now);
  endToday.setHours(s.workday_end_hour, 0, 0, 0);
  const canRunToday =
    isLocalSendingDay(now, s.weekdays_only === 1) &&
    now.getTime() < endToday.getTime() &&
    ctx.dailyRemaining > 0;

  let at: Date;
  if (canRunToday) {
    const start = localWindowStart(now, s.workday_start_hour);
    at = now.getTime() > start.getTime() ? now : start;
  } else {
    at = nextSendingWindowStart(now, s);
  }
  return { estimated: true, at: at.toISOString(), count };
}
```

Note: `dailySendRate` and `nextBatch` already exist in this file and are reused as-is.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core/forecast.test.ts`
Expected: PASS (existing tests + 9 new ones).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/core/forecast.ts tests/core/forecast.test.ts
git commit -m "feat(core): nextBatchForecast (exact / predicted window / blocked reason)"
```

---

## Task 3: Wire `nextBatchForecast` into `/api/status`

**Files:**
- Modify: `src/api/server.ts:9` (import), `:61-90` (the `/api/status` handler)
- Test: `tests/api/server.test.ts` (append cases)

- [ ] **Step 1: Write the failing tests**

Append to `tests/api/server.test.ts`:

```ts
test('GET /api/status: next_batch predicts a window when queued but unscheduled', async () => {
  const c = repos.cohorts.create('Pred', null, true);
  for (let i = 0; i < 5; i++) repos.profiles.add(c.id, `https://www.linkedin.com/in/p${i}`, null);
  const res = await app.inject({ method: 'GET', url: '/api/status' });
  expect(res.statusCode).toBe(200);
  const nb = JSON.parse(res.body).forecast.next_batch;
  expect(nb.estimated).toBe(true);
  expect(typeof nb.at).toBe('string');
  expect(nb.count).toBeGreaterThan(0);
});

test('GET /api/status: next_batch is blocked when paused with a backlog', async () => {
  const c = repos.cohorts.create('Blk', null, true);
  repos.profiles.add(c.id, 'https://www.linkedin.com/in/blocked', null);
  repos.settings.update({ paused: 1, pause_reason: 'Manual pause' });
  const res = await app.inject({ method: 'GET', url: '/api/status' });
  const nb = JSON.parse(res.body).forecast.next_batch;
  expect(nb).toEqual({ blocked: true, reason: 'Paused' });
});

test('GET /api/status: next_batch is null when nothing is queued', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/status' });
  expect(JSON.parse(res.body).forecast.next_batch).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/api/server.test.ts`
Expected: FAIL — predicted case returns `null` (old `nextBatch` only reads scheduled rows); paused case returns `null` instead of the blocked object.

- [ ] **Step 3: Update the imports**

In `src/api/server.ts`, the current imports are:
- line 9: `import { estimateQueueCompletion, nextBatch, orderUpcoming } from '../core/forecast.js';`
- line 10: `import { windowStartIso } from '../core/rate-limit.js';`

Replace line 9 with (drop the now-unused `nextBatch`, add `nextBatchForecast`):

```ts
import { estimateQueueCompletion, nextBatchForecast, orderUpcoming } from '../core/forecast.js';
```

Replace line 10 with (add `remainingCapacity`):

```ts
import { windowStartIso, remainingCapacity } from '../core/rate-limit.js';
```

Add a new import line directly after it:

```ts
import { dailyRemainingFor } from '../core/daily-budget.js';
```

- [ ] **Step 4: Update the `/api/status` handler**

Replace the body of the `/api/status` handler so the forecast block uses `nextBatchForecast`. The handler becomes:

```ts
  app.get('/api/status', async () => {
    const counts: Record<string, number> = {};
    for (const p of repos.profiles.all()) counts[p.status] = (counts[p.status] ?? 0) + 1;
    const s = repos.settings.get();
    const a = repos.appState.get();
    const now = new Date();
    const queueRemaining = (counts.queued ?? 0) + (counts.scheduled ?? 0);
    const scheduledRows = repos.profiles.byStatus('scheduled');
    const weeklyRemaining = remainingCapacity(s.weekly_cap, repos.events.countSentSince(windowStartIso(now)));
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
        next_batch: nextBatchForecast(scheduledRows, {
          backlog: queueRemaining,
          weeklyRemaining,
          dailyRemaining: dailyRemainingFor(repos, s, now),
          guardrailTripped: a.guardrail_tripped === 1,
          paused: s.paused === 1,
          settings: s,
        }, now),
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

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/api/server.test.ts`
Expected: PASS (existing + 3 new). Then `npm run typecheck` — no errors.

- [ ] **Step 6: Commit**

```bash
git add src/api/server.ts tests/api/server.test.ts
git commit -m "feat(api): /api/status next_batch uses forecast (predict + blocked)"
```

---

## Task 4: Render the union in the dashboard card

**Files:**
- Modify: `src/web/app.js` (add `fmtRelDay`; update the "Next batch" card in `renderCards`)

No unit-test harness exists for `app.js`; this task is verified by typecheck-free manual inspection plus the running app (Task 5 verification).

- [ ] **Step 1: Add the relative-day helper**

In `src/web/app.js`, add after `fmtClock` (around line 119):

```js
function fmtRelDay(iso, now = new Date()) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(d) - startOf(now)) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  return d.toLocaleDateString(undefined, { weekday: 'short' });
}
```

- [ ] **Step 2: Replace the "Next batch" card definition**

In `renderCards`, replace the single `accent-next` card line (currently line 142) with a small block that builds `value`/`foot` from the union. Replace this line:

```js
    { cls: 'accent-next', label: 'Next batch', value: nb ? nb.count : '—', foot: nb ? `at ${fmtClock(nb.at)}` : 'none scheduled' },
```

with (defining `nextVal`/`nextFoot` just above the `cards` array, then referencing them):

```js
    { cls: 'accent-next', label: 'Next batch', value: nextVal, foot: nextFoot },
```

And immediately before `const cards = [` insert:

```js
  let nextVal = '—';
  let nextFoot = 'none queued';
  if (nb && nb.blocked) {
    nextFoot = nb.reason;
  } else if (nb && nb.estimated === false) {
    nextVal = nb.count;
    nextFoot = `at ${fmtClock(nb.at)}`;
  } else if (nb && nb.estimated === true) {
    nextVal = `~${nb.count}`;
    nextFoot = `${fmtRelDay(nb.at)} ~${fmtClock(nb.at)}`;
  }
```

(`nb` is already defined on line 135 as `const nb = f.next_batch;`.)

- [ ] **Step 3: Sanity-check the JS parses**

Run: `node --check src/web/app.js`
Expected: no output (exit 0) — the file is valid JavaScript.

- [ ] **Step 4: Commit**

```bash
git add src/web/app.js
git commit -m "feat(web): next-batch card shows predicted window and blocked reason"
```

---

## Task 5: Full verification

- [ ] **Step 1: Run the entire test suite**

Run: `npm test`
Expected: all suites PASS.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Manual smoke (real app)**

Run the app (`npm start`), open the dashboard, and confirm the "Next batch" card across states:
- Add a batch of profiles while outside working hours (or with today's budget spent) → card shows `~N` and `tomorrow ~08:00` (or the next weekday).
- Pause → card foot shows `Paused`.
- Empty queue → card shows `—` / `none queued`.

(See the `run` / `verify` skills for driving the app if needed.)

- [ ] **Step 4: Final commit (if any doc/checkbox updates remain)**

```bash
git add -A
git commit -m "chore: verify next-batch prediction end-to-end"
```

---

## Self-Review Notes

- **Spec coverage:** union shape (Task 2/3), priority chain incl. all four blocked reasons (Task 2 tests), today-vs-next-day prediction (Task 2 tests), `committedToday` extraction/shared source of truth (Task 1), relative-day display (Task 4), `null`-on-empty-backlog (Tasks 2 & 3). All covered.
- **Type consistency:** `NextBatch` union and `NextBatchContext` defined in Task 2 are the exact shapes consumed in Task 3 (`nextBatchForecast(scheduledRows, ctx, now)`) and Task 4 (`nb.blocked` / `nb.estimated` / `nb.reason` / `nb.at` / `nb.count`). `dailyTargetFor`/`committedToday`/`dailyRemainingFor` names are consistent across Tasks 1 and 3.
- **No placeholders:** every code step shows complete code and exact commands.
