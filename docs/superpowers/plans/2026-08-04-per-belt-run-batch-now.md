# Per-belt "Run batch now" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every pipeline — connection invites, messages, post engagements, event invites — its own manual "Run batch now" button, where a click promotes only that belt's backlog to due-now and every collision (busy browser, paused engine, tripped guardrail, exhausted cap) reports itself instead of being silently swallowed.

**Architecture:** A new `src/worker/run-now.ts` owns the three primitives — `preflight` (refuse before touching the schedule), `promote` (move one belt's backlog to due-now), `moveEventWindow` (rewrite the next-up campaign's reservation to now). `POST /api/run-now` becomes a thin dispatcher over them, taking an optional `belt` and returning one uniform response shape. The sender itself is untouched: promotion is the only scoping mechanism, and the existing `runSenderOnce` still drains whatever is due across all passes. The dashboard's single header button is replaced by four per-conveyor buttons driven by one delegated handler.

**Tech Stack:** TypeScript (ESM, Node 22), Fastify, better-sqlite3 via `src/db`, vanilla JS dashboard (`src/web/app.js`), Vitest (+ jsdom for web tests).

**Spec:** `docs/superpowers/specs/2026-08-04-per-belt-run-batch-now-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `src/worker/run-now.ts` **(new)** | The whole manual-trigger policy: belt parsing, pre-flight gates, per-belt promotion, event-window move. No HTTP, no browser. |
| `tests/worker/run-now.test.ts` **(new)** | Unit coverage for the above against an in-memory DB. |
| `src/api/server.ts` **(modify, ~line 1027)** | Replace the `/api/run-now` handler with a thin dispatcher. |
| `tests/api/server.test.ts` **(modify)** | Endpoint-level: belt scoping, refusals, busy lock, alias. |
| `tests/api/events.test.ts` **(modify)** | Event belt: reservation moved, `dueEventRun` picks it up, cap refusals. |
| `src/web/index.html` **(modify)** | Remove `#runNow`; add four `.run-belt` buttons, one per engine card. |
| `src/web/styles.css` **(modify)** | Style `.run-belt` to sit alongside `.epill` in the pills row. |
| `src/web/app.js` **(modify, ~line 1175)** | Replace the `#runNow` handler with a delegated `.run-belt` handler. |
| `tests/web/helpers/load-app.ts` **(modify)** | Let `stubFetchRoutes` return a full body on an error status. |
| `tests/web/dashboard.test.ts` **(modify)** | Four buttons, correct belt posted, refusal rendering, hidden when idle. |
| `API.md` **(modify, line 815)** | Document the `belt` parameter and the response shape. |

Why a new module rather than more of `server.ts`: that file is already 1,296 lines, and this
logic is pure policy over repos with no HTTP in it — exactly the kind of thing that is easier
to test directly than through `app.inject`.

---

## Task 1: The `run-now` policy module — belt parsing and weekly capacity

**Files:**
- Create: `src/worker/run-now.ts`
- Test: `tests/worker/run-now.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/worker/run-now.test.ts`:

```typescript
import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { parseBelt, weeklyRemaining } from '../../src/worker/run-now.js';

let repos: Repos;
const NOW = new Date('2026-08-04T10:00:00.000Z');

beforeEach(() => {
  repos = new Repos(openDatabase(':memory:'));
  repos.appState.setLogin({ loggedIn: true, cookieExpiry: null }, NOW.toISOString());
});

test('parseBelt accepts the four belts, defaults to all, rejects anything else', () => {
  expect(parseBelt('invite')).toBe('invite');
  expect(parseBelt('message')).toBe('message');
  expect(parseBelt('engagement')).toBe('engagement');
  expect(parseBelt('event')).toBe('event');
  expect(parseBelt('all')).toBe('all');
  expect(parseBelt(undefined)).toBe('all');
  expect(parseBelt(null)).toBe('all');
  expect(parseBelt('invites')).toBeNull();
  expect(parseBelt(7)).toBeNull();
});

test('weeklyRemaining reads each belt against its own cap', () => {
  repos.settings.update({ weekly_cap: 10, msg_weekly_cap: 20, engage_weekly_cap: 30 });
  expect(weeklyRemaining(repos, 'invite', NOW)).toBe(10);
  expect(weeklyRemaining(repos, 'message', NOW)).toBe(20);
  expect(weeklyRemaining(repos, 'engagement', NOW)).toBe(30);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/worker/run-now.test.ts`
Expected: FAIL — `Cannot find module '../../src/worker/run-now.js'`

- [ ] **Step 3: Create the module with just these two exports**

Create `src/worker/run-now.ts`:

```typescript
/**
 * The manual "Run batch now" trigger — one belt at a time.
 *
 * A click is always two separable steps: PROMOTE (a durable DB write that makes one belt's
 * backlog due now) and KICK (a best-effort attempt to grab the browser and send). Splitting
 * them is what lets the endpoint report honestly when the browser is busy: the promotion
 * definitely happened and the next 60s tick will drain it, even though this request sent
 * nothing.
 *
 * Nothing here touches HTTP or the browser, so the whole policy is testable against an
 * in-memory database.
 */
import type { Repos } from '../db/repositories.js';
import type { CampaignKind } from '../types.js';
import { capsFor, engagementCaps } from '../core/caps.js';
import { windowStartIso, remainingCapacity } from '../core/rate-limit.js';

/** The four conveyors on the dashboard, each with its own manual trigger. */
export type Belt = 'invite' | 'message' | 'engagement' | 'event';
/** `all` is the no-belt alias: every SENDER belt, which deliberately excludes events. */
export type BeltArg = Belt | 'all';

/**
 * The belts `runSenderOnce` drains. Events are excluded because they are not scheduled
 * rows at all — they are a reserved browser window, moved by `moveEventWindow`.
 */
export const SENDER_BELTS: readonly Exclude<Belt, 'event'>[] = ['invite', 'message', 'engagement'];

const BELT_ARGS: readonly BeltArg[] = ['invite', 'message', 'engagement', 'event', 'all'];

/** An unrecognised belt is null (a 400), not a silent fallback to 'all' — a typo'd belt
 *  must never quietly promote every pipeline. */
export function parseBelt(raw: unknown): BeltArg | null {
  if (raw === undefined || raw === null) return 'all';
  return BELT_ARGS.includes(raw as BeltArg) ? (raw as BeltArg) : null;
}

/**
 * Sends left this week on one sender belt, using the same computation the sender itself
 * uses — so the button can never promise a send `runSenderOnce` would then refuse.
 */
export function weeklyRemaining(
  repos: Repos, belt: Exclude<Belt, 'event'>, now: Date,
): number {
  const s = repos.settings.get();
  if (belt === 'engagement') {
    return remainingCapacity(
      engagementCaps(s).weeklyCap,
      repos.engagements.countReactedSince(windowStartIso(now)),
    );
  }
  const kind = belt as CampaignKind;
  return remainingCapacity(
    capsFor(s, kind).weeklyCap,
    repos.events.countSentSince(windowStartIso(now), kind),
  );
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/worker/run-now.test.ts`
Expected: PASS — 2 tests

- [ ] **Step 5: Commit**

```bash
git add src/worker/run-now.ts tests/worker/run-now.test.ts
git commit -m "feat(run-now): belt parsing and per-belt weekly capacity"
```

---

## Task 2: Pre-flight gates for the sender belts

The gates that refuse a click **before** it touches the schedule. Promoting a batch while
paused is the resume-burst hazard the spec exists to avoid: those rows would all fire the
instant the operator hits Resume, outside the planned spread.

**Files:**
- Modify: `src/worker/run-now.ts`
- Test: `tests/worker/run-now.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/worker/run-now.test.ts`:

```typescript
test('preflight refuses a paused engine and echoes the real pause reason', () => {
  repos.settings.update({ paused: 1, pause_reason: 'LinkedIn weekly invitation limit reached' });
  const r = preflight(repos, 'invite', NOW);
  expect(r?.code).toBe('paused');
  expect(r?.error).toContain('LinkedIn weekly invitation limit reached');
});

test('preflight refuses a tripped guardrail, showing the detail not the enum', () => {
  repos.appState.trip('repeated_failures', 'five in a row', NOW.toISOString());
  const r = preflight(repos, 'invite', NOW);
  expect(r?.code).toBe('guardrail');
  // `guardrail_reason` is the enum; only `guardrail_detail` is fit to show a human.
  expect(r?.error).toContain('five in a row');
});

test('preflight refuses when logged out', () => {
  repos.appState.setLogin({ loggedIn: false, cookieExpiry: null }, NOW.toISOString());
  expect(preflight(repos, 'invite', NOW)?.code).toBe('not_logged_in');
});

test('preflight refuses a belt whose weekly cap is spent, naming the cap', () => {
  repos.settings.update({ weekly_cap: 1 });
  const c = repos.cohorts.create('C', null, true);
  const p = repos.profiles.add(c.id, 'https://www.linkedin.com/in/spent', null);
  repos.events.recordSend(p.id, 'sent');
  const r = preflight(repos, 'invite', NOW);
  expect(r?.code).toBe('capped');
  expect(r?.error).toContain('1/1 invites');
});

test('a spent invite cap does not refuse the message belt', () => {
  repos.settings.update({ weekly_cap: 1 });
  const c = repos.cohorts.create('C', null, true);
  const p = repos.profiles.add(c.id, 'https://www.linkedin.com/in/spent', null);
  repos.events.recordSend(p.id, 'sent');
  expect(preflight(repos, 'message', NOW)).toBeNull();
});

test('the all alias checks only the shared gates, not any belt cap', () => {
  repos.settings.update({ weekly_cap: 0 });
  expect(preflight(repos, 'all', NOW)).toBeNull();
});
```

Add `preflight` to the import at the top of the file:

```typescript
import { parseBelt, preflight, weeklyRemaining } from '../../src/worker/run-now.js';
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/worker/run-now.test.ts`
Expected: FAIL — `preflight is not a function` (or a TS "no exported member" error)

Note: `repos.appState.trip(reason, detail, atIso)` is the real signature — `GuardrailReason`
is a union, so `'repeated_failures'` must be one of its members (check `src/types.ts`).

- [ ] **Step 3: Add the gates**

Append to `src/worker/run-now.ts`:

```typescript
/** A refused click: a machine-readable `code` for the UI to map to a short button label,
 *  and the sentence a human reads. `error` (not `message`) because the dashboard's api()
 *  helper reads `error` off a non-ok body, as does every other endpoint in this server. */
export interface Refusal { code: string; error: string }

/** Plural nouns for the capped message, per belt. */
const CAP_NOUN: Record<Exclude<Belt, 'event'>, string> = {
  invite: 'invites', message: 'messages', engagement: 'reactions',
};

/**
 * Why this click cannot run, or null to proceed.
 *
 * Called BEFORE any promotion, always. The three shared gates apply to every belt including
 * the `all` alias; the weekly cap is per-belt, so `all` skips it (a capped belt simply
 * promotes nothing when `promote` runs).
 */
export function preflight(repos: Repos, belt: BeltArg, now: Date): Refusal | null {
  const s = repos.settings.get();
  const a = repos.appState.get();
  if (s.paused === 1) {
    return { code: 'paused', error: s.pause_reason ? `Paused — ${s.pause_reason}` : 'Paused' };
  }
  if (a.guardrail_tripped === 1) {
    // `guardrail_detail` is the operator-facing sentence; `guardrail_reason` is the enum
    // ('checkpoint' | 'login_lost' | 'repeated_failures'). Showing the enum here would put
    // a machine token in the slot this type promises is human-readable.
    return {
      code: 'guardrail',
      error: a.guardrail_detail ?? (a.guardrail_reason
        ? `Halted — ${a.guardrail_reason}`
        : 'Halted by the guardrail'),
    };
  }
  if (a.login_logged_in !== 1) {
    return { code: 'not_logged_in', error: 'Not logged in to LinkedIn' };
  }
  if (belt === 'all') return null;
  if (belt === 'event') return eventPreflight(repos, now);

  if (weeklyRemaining(repos, belt, now) <= 0) {
    const cap = belt === 'engagement'
      ? engagementCaps(s).weeklyCap
      : capsFor(s, belt as CampaignKind).weeklyCap;
    return {
      code: 'capped',
      error: `Weekly cap reached — ${cap}/${cap} ${CAP_NOUN[belt]} this week`,
    };
  }
  return null;
}
```

Add a temporary stub above it so the file compiles — Task 3 fills it in:

```typescript
/** Filled in by Task 3. */
function eventPreflight(_repos: Repos, _now: Date): Refusal | null { return null; }
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/worker/run-now.test.ts`
Expected: PASS — 8 tests

- [ ] **Step 5: Commit**

```bash
git add src/worker/run-now.ts tests/worker/run-now.test.ts
git commit -m "feat(run-now): pre-flight gates that refuse before touching the schedule"
```

---

## Task 3: Event belt pre-flight

Three event-specific refusals. Order matters: "already running" and "nothing armed" are
checked **before** the daily cap, because a campaign that is currently running has already
incremented `countRunsOnDate`, and reporting "daily cap reached" for a run happening right
now would be actively misleading.

**Files:**
- Modify: `src/worker/run-now.ts`
- Test: `tests/worker/run-now.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/worker/run-now.test.ts`:

```typescript
/** An armed campaign with one bucket and one pending invitee — the minimum runnable state. */
function armedCampaign(): number {
  const conn = repos.connections.upsertMany([{
    profile_url: 'https://www.linkedin.com/in/ev-1',
    full_name: 'Ev One', first_name: 'Ev', linkedin_id: 'urn:li:member:1',
    location_country: 'Israel', location_country_code: 'IL', location_region: null,
  }]);
  expect(conn).toBeGreaterThan(0);
  const ev = repos.eventCampaigns.create('https://www.linkedin.com/events/7000000000000000000/', {
    eventUrn: '7000000000000000000', inviteCap: 100, bucketCeiling: 3,
  });
  repos.eventBuckets.replaceAll(ev.id, [
    { rank: 0, label: 'Israel', kind: 'country', key_id: 'c:IL', target_count: 1, roster_count: 1, geo_candidates: ['Israel'] },
  ]);
  const row = repos.connections.findByUrl('https://www.linkedin.com/in/ev-1')!;
  repos.eventInvitees.addMany(ev.id, [{
    profile_url: row.profile_url, connection_id: row.id,
    member_urn: row.linkedin_id, full_name: row.full_name,
  }]);
  repos.eventCampaigns.update(ev.id, { status: 'armed', armed_at: NOW.toISOString() });
  return ev.id;
}

test('event preflight refuses when nothing is armed', () => {
  expect(preflight(repos, 'event', NOW)?.code).toBe('nothing_armed');
});

test('event preflight refuses a campaign that is already running', () => {
  const id = armedCampaign();
  repos.eventCampaigns.update(id, { status: 'running' });
  expect(preflight(repos, 'event', NOW)?.code).toBe('already_running');
});

test('event preflight refuses once the day s run budget is spent', () => {
  const id = armedCampaign();
  repos.settings.update({ events_per_day: 1 });
  const run = repos.eventRuns.start(id, 'live', null);
  repos.eventRuns.finish(run.id, 'complete', 1, NOW.toISOString());
  const r = preflight(repos, 'event', NOW);
  expect(r?.code).toBe('daily_cap');
  expect(r?.error).toContain('1/1');
});

test('event preflight passes for a fresh armed campaign', () => {
  armedCampaign();
  expect(preflight(repos, 'event', NOW)).toBeNull();
});
```

Note on shapes: `repos.connections.upsertMany`, `repos.eventBuckets.replaceAll`'s
`PlannedBucket` fields, and `repos.eventRuns.start/finish` signatures must match the real
ones. Read `src/db/repositories.ts`, `src/db/event-repos.ts` and `src/core/event-buckets.ts`
and copy the exact shapes — `tests/worker/event-campaign.test.ts` already builds these
fixtures and is the fastest reference. Also check whether `countRunsOnDate` counts started
or finished runs, and stage the fixture accordingly.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/worker/run-now.test.ts`
Expected: FAIL — the stub returns null, so `nothing_armed`, `already_running` and
`daily_cap` all come back as `undefined`

- [ ] **Step 3: Replace the stub with the real gate**

In `src/worker/run-now.ts`, delete the temporary stub and add the import plus the real
function:

```typescript
import { nextEventRun, RESERVATION_PURPOSE } from './event-campaign.js';
```

```typescript
/**
 * The event belt's own gates.
 *
 * `nextEventRun` is reused rather than re-deriving the target, so this button can never
 * promise a different campaign than the planner would pick.
 *
 * Order is deliberate: a campaign that is running right now has ALREADY incremented
 * countRunsOnDate, so checking the daily cap first would report "already ran today" about
 * the run currently in progress.
 */
function eventPreflight(repos: Repos, now: Date): Refusal | null {
  const next = nextEventRun(repos, now);
  if (!next) return { code: 'nothing_armed', error: 'No armed event campaign to run' };

  const title = next.event.title ?? `Campaign #${next.event.id}`;
  if (next.event.status === 'running') {
    return { code: 'already_running', error: `${title} is already running` };
  }
  if (next.event.status !== 'armed') {
    return { code: 'nothing_armed', error: `${title} is ${next.event.status}, not armed` };
  }

  const s = repos.settings.get();
  const perDay = Math.max(1, s.events_per_day);
  const runsToday = repos.eventCampaigns.countRunsOnDate(now.toISOString());
  if (runsToday >= perDay) {
    return {
      code: 'daily_cap',
      error: `Already ran an event campaign today (${runsToday}/${perDay})`,
    };
  }
  return null;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/worker/run-now.test.ts`
Expected: PASS — 12 tests

- [ ] **Step 5: Commit**

```bash
git add src/worker/run-now.ts tests/worker/run-now.test.ts
git commit -m "feat(run-now): event belt pre-flight (armed, running, daily cap)"
```

---

## Task 4: Promotion — move one belt's backlog to due-now

**Files:**
- Modify: `src/worker/run-now.ts`
- Test: `tests/worker/run-now.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/worker/run-now.test.ts`:

```typescript
/** n queued profiles of one kind, in one cohort. */
function queueProfiles(kind: 'invite' | 'message', n: number): void {
  const c = repos.cohorts.create(`C-${kind}`, 'Hi', true, kind);
  for (let i = 0; i < n; i++) {
    repos.profiles.add(c.id, `https://www.linkedin.com/in/${kind}-${i}`, null);
  }
}

test('promote makes a belt s backlog due now, clamped to its batch size', () => {
  repos.settings.update({ batch_size: 2 });
  queueProfiles('invite', 5);
  expect(promote(repos, 'invite', NOW)).toBe(2);
  const due = repos.profiles.byStatusKind('scheduled', 'invite');
  expect(due).toHaveLength(2);
  for (const p of due) expect(new Date(p.scheduled_for!).getTime()).toBeLessThan(NOW.getTime());
});

test('promote touches only its own belt', () => {
  repos.settings.update({ batch_size: 5, msg_batch_size: 5 });
  queueProfiles('invite', 3);
  queueProfiles('message', 3);
  promote(repos, 'message', NOW);
  expect(repos.profiles.byStatusKind('scheduled', 'invite')).toHaveLength(0);
  expect(repos.profiles.byStatusKind('scheduled', 'message')).toHaveLength(3);
});

test('promote pulls already-scheduled rows forward, not just queued ones', () => {
  repos.settings.update({ batch_size: 5 });
  queueProfiles('invite', 1);
  const p = repos.profiles.all()[0];
  repos.profiles.setScheduled(p.id, '2099-01-01T00:00:00.000Z');
  expect(promote(repos, 'invite', NOW)).toBe(1);
  const after = repos.profiles.byStatusKind('scheduled', 'invite')[0];
  expect(new Date(after.scheduled_for!).getTime()).toBeLessThan(NOW.getTime());
});

test('promote is a no-op re-stamp on a second call', () => {
  repos.settings.update({ batch_size: 2 });
  queueProfiles('invite', 5);
  expect(promote(repos, 'invite', NOW)).toBe(2);
  expect(promote(repos, 'invite', NOW)).toBe(2);       // same rows, still due
  expect(repos.profiles.byStatusKind('scheduled', 'invite')).toHaveLength(2);
});

test('promote returns 0 rather than over-committing a spent weekly cap', () => {
  repos.settings.update({ weekly_cap: 1, batch_size: 5 });
  queueProfiles('invite', 3);
  const p = repos.profiles.all()[0];
  repos.events.recordSend(p.id, 'sent');
  expect(promote(repos, 'invite', NOW)).toBe(0);
});

test('promote schedules engagements against the engagement batch size', () => {
  repos.settings.update({ engage_batch_size: 2 });
  repos.engagements.add('https://www.linkedin.com/feed/update/urn:li:activity:1/', 'urn:li:activity:1', 'like', null);
  repos.engagements.add('https://www.linkedin.com/feed/update/urn:li:activity:2/', 'urn:li:activity:2', 'like', null);
  repos.engagements.add('https://www.linkedin.com/feed/update/urn:li:activity:3/', 'urn:li:activity:3', 'like', null);
  expect(promote(repos, 'engagement', NOW)).toBe(2);
  expect(repos.engagements.byStatus('scheduled')).toHaveLength(2);
});
```

Add `promote` to the import line. Check the real signature of `repos.cohorts.create` (it may
not take a `kind` 4th argument) against `src/db/repositories.ts` and adapt `queueProfiles` —
`tests/api/server.test.ts` and `tests/worker/scheduler-service.test.ts` show working
fixtures for both kinds.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/worker/run-now.test.ts`
Expected: FAIL — `promote is not a function`

- [ ] **Step 3: Implement promotion**

Append to `src/worker/run-now.ts`:

```typescript
/**
 * Make one belt's next batch due now, and report how many rows are due as a result.
 *
 * Pulls from queued first and then from already-scheduled (future) rows, so a manual run
 * always has something to send when work exists at all — the same order the old global
 * endpoint used.
 *
 * The returned count is "rows due now", NOT "rows newly moved": a second click re-stamps the
 * same rows to the same instant (a genuine no-op) and honestly reports the same number.
 *
 * The weekly cap is re-checked here as well as in preflight, because the `all` alias skips
 * the per-belt cap gate — a capped belt must promote nothing rather than stack up rows the
 * sender will then refuse.
 */
export function promote(repos: Repos, belt: Exclude<Belt, 'event'>, now: Date): number {
  if (weeklyRemaining(repos, belt, now) <= 0) return 0;
  // A second in the past, so the sender's `scheduled_for <= now` test is satisfied even
  // when the two timestamps would otherwise be identical to the millisecond.
  const dueIso = new Date(now.getTime() - 1000).toISOString();
  const s = repos.settings.get();

  if (belt === 'engagement') {
    const rows = [
      ...repos.engagements.queuedByPriority(),
      ...repos.engagements.byStatus('scheduled'),
    ].slice(0, engagementCaps(s).batchSize);
    for (const e of rows) repos.engagements.setScheduled(e.id, dueIso);
    return rows.length;
  }

  const kind = belt as CampaignKind;
  const rows = [
    ...repos.profiles.queuedByPriorityKind(kind),
    ...repos.profiles.byStatusKind('scheduled', kind),
  ].slice(0, capsFor(s, kind).batchSize);
  for (const p of rows) repos.profiles.setScheduled(p.id, dueIso);
  return rows.length;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/worker/run-now.test.ts`
Expected: PASS — 18 tests

- [ ] **Step 5: Commit**

```bash
git add src/worker/run-now.ts tests/worker/run-now.test.ts
git commit -m "feat(run-now): per-belt promotion to due-now"
```

---

## Task 5: Moving the event reservation to now

**Files:**
- Modify: `src/worker/run-now.ts`
- Test: `tests/worker/run-now.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/worker/run-now.test.ts`. Add `moveEventWindow` to the import, and
`dueEventRun` from `../../src/worker/event-campaign.js`:

```typescript
test('moveEventWindow opens the window now, and dueEventRun then returns the campaign', () => {
  const id = armedCampaign();
  repos.settings.update({ event_run_budget_minutes: 30 });

  const w = moveEventWindow(repos, NOW);

  expect(w.eventId).toBe(id);
  expect(new Date(w.from).getTime()).toBeLessThanOrEqual(NOW.getTime());
  expect(new Date(w.to).getTime()).toBe(new Date(w.from).getTime() + 30 * 60 * 1000);
  expect(dueEventRun(repos, NOW)?.event.id).toBe(id);
});

test('moveEventWindow replaces an existing reservation rather than stacking a second', () => {
  const id = armedCampaign();
  repos.reservations.create('2099-01-01T09:00:00.000Z', '2099-01-01T10:00:00.000Z', 'event_invite', id);

  moveEventWindow(repos, NOW);

  const held = repos.reservations.between('2000-01-01T00:00:00.000Z', '2100-01-01T00:00:00.000Z');
  expect(held).toHaveLength(1);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/worker/run-now.test.ts`
Expected: FAIL — `moveEventWindow is not a function`

- [ ] **Step 3: Implement the move**

Append to `src/worker/run-now.ts`:

```typescript
/** The window a manual event run just claimed. */
export interface EventWindow { eventId: number; from: string; to: string }

/**
 * Rewrite the next-up campaign's reserved window so it is open right now.
 *
 * This is the event belt's answer to `promote`: a scheduling modification and nothing else.
 * `runEventTick` fires within 60s, which is why the endpoint reports `started: false` — the
 * run has been handed over, not performed.
 *
 * Clear-then-create rather than an UPDATE: `clearFor` is the existing primitive for "this
 * campaign holds no window", and one campaign must never end up holding two.
 *
 * Call `preflight` first — this throws rather than inventing a target, because silently
 * picking a campaign nobody armed is exactly the kind of surprise an irreversible invite
 * pipeline must not have.
 */
export function moveEventWindow(repos: Repos, now: Date): EventWindow {
  const next = nextEventRun(repos, now);
  if (!next) throw new Error('moveEventWindow: no runnable campaign — call preflight first');

  const s = repos.settings.get();
  // A second in the past, so dueEventRun's `from_ts <= now` holds on the very next tick.
  const from = new Date(now.getTime() - 1000);
  const to = new Date(from.getTime() + Math.max(1, s.event_run_budget_minutes) * 60 * 1000);

  repos.reservations.clearFor(RESERVATION_PURPOSE, next.event.id);
  repos.reservations.create(from.toISOString(), to.toISOString(), RESERVATION_PURPOSE, next.event.id);

  return { eventId: next.event.id, from: from.toISOString(), to: to.toISOString() };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/worker/run-now.test.ts`
Expected: PASS — 20 tests

- [ ] **Step 5: Typecheck the module and commit**

```bash
npx tsc --noEmit
git add src/worker/run-now.ts tests/worker/run-now.test.ts
git commit -m "feat(run-now): move the next event campaign's reserved window to now"
```

---

## Task 6: Rewire `POST /api/run-now` as a thin dispatcher

**Files:**
- Modify: `src/api/server.ts` (the handler at ~line 1027, and the import block at the top)
- Test: `tests/api/server.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/api/server.test.ts`:

```typescript
test('POST /api/run-now with belt=message leaves the invite backlog alone', async () => {
  await app.inject({
    method: 'POST', url: '/api/lists',
    payload: { cohort: 'Inv', text: 'https://linkedin.com/in/belt-inv', message_template: 'Hi', allow_no_note: true },
  });
  await app.inject({
    method: 'POST', url: '/api/lists',
    payload: { cohort: 'Msg', text: 'https://linkedin.com/in/belt-msg', message_template: 'Hi', kind: 'message' },
  });

  const res = await app.inject({ method: 'POST', url: '/api/run-now', payload: { belt: 'message' } });

  expect(res.statusCode).toBe(200);
  const body = JSON.parse(res.body);
  expect(body.belt).toBe('message');
  expect(body.promoted).toBe(1);
  expect(ofKind('invite').every((p) => p.status !== 'sent')).toBe(true);
});

test('POST /api/run-now rejects an unknown belt', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/run-now', payload: { belt: 'invites' } });
  expect(res.statusCode).toBe(400);
});

test('POST /api/run-now refuses while paused and promotes nothing', async () => {
  await app.inject({
    method: 'POST', url: '/api/lists',
    payload: { cohort: 'P', text: 'https://linkedin.com/in/paused-1', message_template: 'Hi', allow_no_note: true },
  });
  // Park the backlog in the future so "promoted nothing" is observable.
  for (const p of repos.profiles.all()) repos.profiles.setScheduled(p.id, '2099-01-01T00:00:00.000Z');
  repos.settings.update({ paused: 1, pause_reason: 'Manual pause' });

  const res = await app.inject({ method: 'POST', url: '/api/run-now', payload: { belt: 'invite' } });

  expect(res.statusCode).toBe(409);
  expect(JSON.parse(res.body).code).toBe('paused');
  expect(repos.profiles.all()[0].scheduled_for).toBe('2099-01-01T00:00:00.000Z');
});

test('POST /api/run-now reports deferred rather than claiming a run it could not do', async () => {
  const driver2 = new FakeDriver();
  const lock = new Mutex();
  const app2 = buildServer(repos, driver2, lock, undefined, { senderOptions: { sleep: async () => {} } });
  await app2.inject({
    method: 'POST', url: '/api/lists',
    payload: { cohort: 'Busy', text: 'https://linkedin.com/in/busy-1', message_template: 'Hi', allow_no_note: true },
  });
  repos.appState.setLogin({ loggedIn: true, cookieExpiry: null }, '2026-06-29T00:00:00.000Z');

  let release!: () => void;
  const held = lock.run(() => new Promise<void>((r) => { release = r; }));

  const res = await app2.inject({ method: 'POST', url: '/api/run-now', payload: { belt: 'invite' } });

  const body = JSON.parse(res.body);
  expect(res.statusCode).toBe(200);
  expect(body.started).toBe(false);
  expect(body.deferred).toBe('browser busy');
  expect(body.promoted).toBe(1);                 // the schedule nudge still landed
  expect(driver2.sentLog).toHaveLength(0);

  release();
  await held;
});

test('POST /api/run-now with nothing queued says so instead of reporting a run', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/run-now', payload: { belt: 'invite' } });
  expect(res.statusCode).toBe(200);
  const body = JSON.parse(res.body);
  expect(body.promoted).toBe(0);
  expect(body.deferred).toBe('nothing queued');
});

test('POST /api/run-now with no belt promotes engagements too (the old gap)', async () => {
  repos.engagements.add('https://www.linkedin.com/feed/update/urn:li:activity:9/', 'urn:li:activity:9', 'like', null);
  const res = await app.inject({ method: 'POST', url: '/api/run-now' });
  expect(res.statusCode).toBe(200);
  expect(JSON.parse(res.body).belt).toBe('all');
  expect(repos.engagements.byStatus('queued')).toHaveLength(0);
});
```

Check `POST /api/lists` actually accepts a `kind` field for the message fixture — read the
handler at `src/api/server.ts:158`. If it takes a different key, use it.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/api/server.test.ts`
Expected: FAIL — the current handler ignores `belt`, never returns 400/409, and never
returns `started`/`deferred`

- [ ] **Step 3: Replace the handler**

Add to the import block at the top of `src/api/server.ts`:

```typescript
import {
  moveEventWindow, parseBelt, preflight, promote, SENDER_BELTS,
} from '../worker/run-now.js';
```

Replace the whole `app.post('/api/run-now', …)` handler (and its comment block) at ~line 1027
with:

```typescript
  /**
   * Manual trigger, one belt at a time.
   *
   * Two separable steps, and the response reports each honestly: PROMOTE is a durable DB
   * write making that belt's backlog due now, KICK is a best-effort attempt to grab the
   * shared browser. When the lock is held the promotion still stands and the next 60s tick
   * drains it — so `started: false, deferred: 'browser busy'` is the truth, where the old
   * handler answered a flat `{ok:true}`.
   *
   * Refusals are pre-flighted BEFORE promoting: a batch promoted while paused would all fire
   * the instant the operator resumes, outside the planned spread.
   *
   * `belt` omitted means every sender belt (invite + message + engagement). Events are never
   * part of that alias — they are a reserved window, not a queue of due rows.
   *
   * Deliberately NOT skipping the inter-send delay: this hits the same LinkedIn account
   * through the same automation, so a manual batch firing several sends back-to-back is
   * exactly the burst pattern min_delay_ms/max_delay_ms exist to prevent. `force: true` is
   * kept — a manual trigger may run outside working hours by design.
   */
  app.post('/api/run-now', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const belt = parseBelt(body.belt);
    if (belt === null) {
      return reply.code(400).send({ ok: false, error: `unknown belt: ${String(body.belt)}` });
    }

    const now = new Date();
    const refusal = preflight(repos, belt, now);
    if (refusal) {
      defaultLog.info('api', 'run-now refused', { belt, code: refusal.code });
      return reply.code(409).send({ ok: false, belt, ...refusal });
    }

    // The event belt has no due-now queue: move its reserved window and let runEventTick
    // (≤60s) fire it. Nothing to kick here, hence started: false.
    if (belt === 'event') {
      const w = moveEventWindow(repos, now);
      defaultLog.info('api', 'run-now', { belt, event: w.eventId, from: w.from, to: w.to });
      return {
        ok: true, belt, started: false,
        // No `promoted` here on purpose. On the sender belts that field counts rows moved
        // to due-now; there is no equivalent count for an event run, and reporting a
        // hardcoded 1 would put a different unit behind the same name. The window is the
        // payload.
        event_id: w.eventId, from: w.from, to: w.to,
      };
    }

    const belts = belt === 'all' ? SENDER_BELTS : [belt];
    let promoted = 0;
    for (const b of belts) promoted += promote(repos, b, now);
    defaultLog.info('api', 'run-now', { belt, promoted });
    if (promoted === 0) {
      return { ok: true, belt, promoted: 0, started: false, deferred: 'nothing queued' };
    }

    // tryRun resolves to undefined when the lock was held. runSenderOnce itself returns
    // void, so the callback returns a sentinel — otherwise "did it run?" is unanswerable.
    const ran = await browserLock.tryRun(async () => {
      await runSenderOnce(repos, driver, now, {
        force: true, clock: () => new Date(), ...senderOptions,
      });
      return true as const;
    });
    return ran === true
      ? { ok: true, belt, promoted, started: true }
      : { ok: true, belt, promoted, started: false, deferred: 'browser busy' };
  });
```

- [ ] **Step 4: Run the API suite**

Run: `npx vitest run tests/api/server.test.ts`
Expected: PASS, including the pre-existing
`POST /api/run-now promotes queued profiles and sends a batch immediately` and
`POST /api/run-now is skipped (no send) while the shared browser lock is held`.

If `capsFor` / `engagementCaps` are now unused in `server.ts`, remove them from its imports;
run `npx tsc --noEmit` to confirm.

- [ ] **Step 5: Commit**

```bash
git add src/api/server.ts tests/api/server.test.ts
git commit -m "feat(api): per-belt run-now with honest busy and refusal reporting"
```

---

## Task 7: Event belt end-to-end through the endpoint

**Files:**
- Modify: `tests/api/events.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/api/events.test.ts`, following that file's existing fixture helpers for
creating and arming a campaign (read the top of the file and reuse them rather than
hand-rolling new ones):

```typescript
test('POST /api/run-now belt=event opens the window now for the armed campaign', async () => {
  const id = await armAnEventCampaign();          // this file's existing helper

  const res = await app.inject({ method: 'POST', url: '/api/run-now', payload: { belt: 'event' } });

  expect(res.statusCode).toBe(200);
  const body = JSON.parse(res.body);
  expect(body.belt).toBe('event');
  expect(body.event_id).toBe(id);
  expect(body.started).toBe(false);               // runEventTick fires it, not this request
  expect(dueEventRun(repos, new Date())?.event.id).toBe(id);
});

test('POST /api/run-now belt=event refuses once the daily run budget is spent', async () => {
  const id = await armAnEventCampaign();
  repos.settings.update({ events_per_day: 1 });
  const run = repos.eventRuns.start(id, 'live', null);
  repos.eventRuns.finish(run.id, 'complete', 1, new Date().toISOString());

  const res = await app.inject({ method: 'POST', url: '/api/run-now', payload: { belt: 'event' } });

  expect(res.statusCode).toBe(409);
  expect(JSON.parse(res.body).code).toBe('daily_cap');
});

test('POST /api/run-now belt=event refuses when no campaign is armed', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/run-now', payload: { belt: 'event' } });
  expect(res.statusCode).toBe(409);
  expect(JSON.parse(res.body).code).toBe('nothing_armed');
});

test('the per-campaign run-now stays uncapped as the deliberate override', async () => {
  const id = await armAnEventCampaign();
  repos.settings.update({ events_per_day: 1 });
  const run = repos.eventRuns.start(id, 'live', null);
  repos.eventRuns.finish(run.id, 'complete', 1, new Date().toISOString());

  const res = await app.inject({ method: 'POST', url: `/api/events/${id}/run-now` });

  expect(res.statusCode).toBe(200);
});
```

Import `dueEventRun` from `../../src/worker/event-campaign.js` if the file does not already.
If the last test's campaign is left in a non-`armed` status by the finished run, re-arm it
before the call — the point of the assertion is the cap, not the status gate.

- [ ] **Step 2: Run them**

Run: `npx vitest run tests/api/events.test.ts`

This is an **integration check, not a red-green step**: Tasks 3, 5 and 6 already implement
this path, so these should pass on the first run. Expected: PASS.

- [ ] **Step 3: If any fail, fix the cause, not the test**

A failure here means a defect in `eventPreflight` (Task 3), `moveEventWindow` (Task 5) or the
dispatcher (Task 6). Fix it there — do not special-case the endpoint to make the assertion
green.

Two things worth checking if the first test fails: `nextEventRun` only returns campaigns
whose event has not already started (`hasStarted(starts_at, now)`), so a fixture with a past
`starts_at` yields `nothing_armed`; and the reservation must survive
`ensureEventReservation`, which returns early when a window is already held.

- [ ] **Step 5: Commit**

```bash
git add tests/api/events.test.ts
git commit -m "test(api): event belt run-now, daily cap, and the uncapped override"
```

---

## Task 8: The four dashboard buttons (markup + styles)

**Files:**
- Modify: `src/web/index.html` (line 131; and the four `.engine-pills` blocks)
- Modify: `src/web/styles.css` (near line 347, beside `.epill`)

- [ ] **Step 1: Remove the global header button**

In `src/web/index.html`, delete line 131:

```html
          <button class="btn" id="runNow" title="Send one batch right now">Run batch now</button>
```

- [ ] **Step 2: Add a button to each engine's pills row**

Add as the LAST child of each `.engine-pills` div — four edits, one per card:

Invites (`#engine`, the pills div containing `#nextTxt`):

```html
            <button class="run-belt" type="button" data-belt="invite" title="Send one invite batch right now">Run now</button>
```

Messages (`#msgEngine`, the pills div containing `#msgNextTxt`):

```html
            <button class="run-belt" type="button" data-belt="message" title="Send one message batch right now">Run now</button>
```

Event invites (`#evEngine`, the pills div containing `#evNextTxt`):

```html
            <button class="run-belt" type="button" data-belt="event" title="Start the next event run now">Run now</button>
```

Engagements (`#engEngine`, the pills div containing `#engNextTxt`):

```html
            <button class="run-belt" type="button" data-belt="engagement" title="Run one engagement batch right now">Run now</button>
```

- [ ] **Step 3: Style it**

Add to `src/web/styles.css` immediately after the `.epill-sending` rules (~line 405):

```css
/* The per-conveyor manual trigger. Shaped like an .epill so it reads as part of the pills
   row rather than a floating action, but interactive: brand-tinted on hover/focus. */
.run-belt { display: inline-flex; align-items: center; gap: 6px; font: inherit; font-size: 12.5px;
  font-weight: 600; color: var(--ink-2); background: var(--panel-2); border: 1px solid var(--line);
  border-radius: 100px; padding: 7px 14px; cursor: pointer; transition: color .15s, border-color .15s, background .15s; }
.run-belt:hover { color: var(--brand-700); border-color: var(--brand-100); background: var(--brand-50); }
.run-belt:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
.run-belt:disabled { cursor: default; opacity: 0.6; color: var(--ink-2); background: var(--panel-2);
  border-color: var(--line); }
/* An idle conveyor has no campaigns at all, so there is nothing for its button to run. */
.engine.is-idle .run-belt { display: none; }
```

- [ ] **Step 4: Verify the markup loads**

Run: `npx vitest run tests/web/dashboard.test.ts`
Expected: PASS — the existing suite must not regress. It never referenced `#runNow`, so
removing it is safe; if anything fails, the failure names the element.

- [ ] **Step 5: Commit**

```bash
git add src/web/index.html src/web/styles.css
git commit -m "feat(web): a Run now button on each conveyor, replacing the global one"
```

---

## Task 9: The delegated button handler

**Files:**
- Modify: `src/web/app.js` (replace the `#runNow` handler at ~line 1175)
- Modify: `tests/web/helpers/load-app.ts`
- Test: `tests/web/dashboard.test.ts`

- [ ] **Step 1: Let the test helper return a full body on an error status**

In `tests/web/helpers/load-app.ts`, replace the error branch inside `stubFetchRoutes`:

```typescript
    if (stub.error !== undefined) {
      return { ok: false, status: stub.status ?? 400, statusText: 'Bad Request', json: async () => ({ error: stub.error }) };
    }
```

with:

```typescript
    // A refusal can carry a whole body (code + error), not just a message: the run-now
    // buttons map `code` to a short label and `error` to the tooltip.
    if (stub.error !== undefined || (stub.status ?? 200) >= 400) {
      const body = stub.body ?? { error: stub.error };
      return { ok: false, status: stub.status ?? 400, statusText: 'Bad Request', json: async () => body };
    }
```

- [ ] **Step 2: Write the failing test**

Append to `tests/web/dashboard.test.ts` (add `stubFetchRoutes` to the import from
`./helpers/load-app.js`):

```typescript
/** Click a conveyor's Run now button and let the handler's promise chain settle. */
async function clickBelt(belt: string): Promise<void> {
  const btn = document.querySelector<HTMLButtonElement>(`.run-belt[data-belt="${belt}"]`);
  if (!btn) throw new Error(`no Run now button for belt ${belt}`);
  btn.click();
  await new Promise((r) => setTimeout(r, 0));
}

test('every conveyor has its own Run now button', () => {
  const belts = [...document.querySelectorAll('.run-belt')].map((b) => (b as HTMLElement).dataset.belt);
  expect(belts.sort()).toEqual(['engagement', 'event', 'invite', 'message']);
});

test('a Run now click posts its own belt and reports what happened', async () => {
  const calls = stubFetchRoutes({
    '/api/run-now': { body: { ok: true, belt: 'message', promoted: 4, started: true } },
    '/api/status': { body: status() },
    '/api/queue': { body: [] },
    '/api/queue/grouped': { body: [] },
  });
  app.initDashboard();

  await clickBelt('message');

  const post = calls.find((c) => c.path === '/api/run-now');
  expect(post?.method).toBe('POST');
  expect(post?.body).toEqual({ belt: 'message' });
  const btn = document.querySelector<HTMLButtonElement>('.run-belt[data-belt="message"]')!;
  expect(btn.textContent).toBe('Triggered 4');
});

test('a busy browser reads as queued, not as a send that happened', async () => {
  stubFetchRoutes({
    '/api/run-now': { body: { ok: true, belt: 'invite', promoted: 3, started: false, deferred: 'browser busy' } },
    '/api/status': { body: status() },
    '/api/queue': { body: [] },
    '/api/queue/grouped': { body: [] },
  });
  app.initDashboard();

  await clickBelt('invite');

  const btn = document.querySelector<HTMLButtonElement>('.run-belt[data-belt="invite"]')!;
  expect(btn.textContent).toBe('Queued 3');
});

test('a refusal shows its short label and puts the reason in the tooltip', async () => {
  stubFetchRoutes({
    '/api/run-now': {
      status: 409,
      body: { ok: false, belt: 'invite', code: 'paused', error: 'Paused — Manual pause' },
    },
    '/api/status': { body: status() },
    '/api/queue': { body: [] },
    '/api/queue/grouped': { body: [] },
  });
  app.initDashboard();

  await clickBelt('invite');

  const btn = document.querySelector<HTMLButtonElement>('.run-belt[data-belt="invite"]')!;
  expect(btn.textContent).toBe('Paused');
  expect(btn.title).toContain('Manual pause');
});
```

`initDashboard` may call other endpoints on wiring; if the run throws `unrouted fetch in
test: /api/…`, add that path to the `stubFetchRoutes` map with an empty body. That loud
failure is the helper working as designed.

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/web/dashboard.test.ts`
Expected: FAIL — `no Run now button for belt message` is impossible after Task 8, so the
failures will be the label assertions (`''` or `'Run now'` instead of `'Triggered 4'`),
because nothing is wired yet.

- [ ] **Step 4: Wire the handler**

In `src/web/app.js`, replace the entire `$('#runNow').addEventListener(…)` block (~lines
1175-1190) with a call, and add the two functions above `initDashboard`:

```javascript
/**
 * Short button labels for each pre-flight refusal code. The full sentence goes in the
 * tooltip — a button is too narrow for "Paused — LinkedIn weekly invitation limit reached",
 * and truncating the reason is how an operator ends up guessing at it.
 */
const RUN_BELT_LABELS = {
  paused: 'Paused',
  guardrail: 'Halted',
  not_logged_in: 'Not logged in',
  capped: 'Capped',
  nothing_armed: 'Nothing armed',
  already_running: 'Running',
  daily_cap: 'Daily cap',
};

/**
 * One conveyor's manual trigger.
 *
 * Uses fetch directly rather than api(): a refusal body carries BOTH a `code` (which picks
 * the label) and an `error` (the tooltip), and api() throws away everything but `error`.
 */
async function runBelt(btn) {
  const belt = btn.dataset.belt;
  const original = btn.textContent;
  const originalTitle = btn.title;
  btn.disabled = true;
  btn.textContent = 'Running…';
  try {
    const res = await fetch('/api/run-now', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ belt }),
    });
    let data = {};
    try { data = await res.json(); } catch (_) { /* keep the empty object */ }

    if (!res.ok) {
      btn.textContent = RUN_BELT_LABELS[data.code] || 'Failed';
      btn.title = data.error || 'Could not run this batch';
    } else if (belt === 'event') {
      // No send happened here: the reserved window was moved and the event tick picks it up.
      btn.textContent = 'Starting…';
    } else if (!data.promoted) {
      btn.textContent = 'Nothing queued';
    } else if (data.started) {
      btn.textContent = `Triggered ${data.promoted}`;
    } else {
      btn.textContent = `Queued ${data.promoted}`;
    }
    await refreshStatus();
    await refreshQueue();
  } catch (_) {
    btn.textContent = 'Failed';
  }
  setTimeout(() => {
    btn.textContent = original;
    btn.title = originalTitle;
    btn.disabled = false;
  }, 2500);
}
```

And inside `initDashboard`, where the old handler was:

```javascript
  // One handler per conveyor's manual trigger; the belt travels in data-belt.
  for (const btn of document.querySelectorAll('.run-belt')) {
    btn.addEventListener('click', () => runBelt(btn));
  }
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run tests/web/dashboard.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/web/app.js tests/web/dashboard.test.ts tests/web/helpers/load-app.ts
git commit -m "feat(web): wire the per-conveyor Run now buttons"
```

---

## Task 10: Documentation

**Files:**
- Modify: `API.md` (line 815)
- Modify: `README.md` (line 417) and `RUNBOOK.md` (line 212) — verify only

- [ ] **Step 1: Update the endpoint reference**

In `API.md`, replace the `POST /api/run-now` bullet at line 815 with:

```markdown
- `POST /api/run-now` — promote one pipeline's next batch to due-now and try to send it
  immediately, even outside working hours.

  Body: `{ "belt": "invite" | "message" | "engagement" | "event" }`. Omit `belt` (or send
  `"all"`) for every sender belt — invite, message and engagement together. Events are never
  part of `all`.

  A click is two steps, reported separately: `promoted` is the number of rows now due (a
  durable DB write), `started` says whether this request actually got the browser. When the
  shared browser lock is held the answer is `{ "started": false, "deferred": "browser busy" }`
  and the next 60-second sender tick drains the promoted rows.

  The `event` belt has no due-now queue: it rewrites the next armed campaign's reserved
  window to start now and answers `{ "started": false, "event_id": N, "from": …, "to": … }`.
  The run itself begins within 60 seconds, when `runEventTick` next fires.

  Refuses with **409** and a `code` + `error` before promoting anything when the engine is
  paused (`paused`), the guardrail is tripped (`guardrail`), the session is logged out
  (`not_logged_in`), the belt's weekly cap is spent (`capped`), or — for events — nothing is
  armed (`nothing_armed`), a run is already in progress (`already_running`), or the day's
  `events_per_day` budget is spent (`daily_cap`). An unknown belt is a **400**.

  Sends are still spaced by `min_delay_ms`/`max_delay_ms`; a manual batch is not a fast path.
```

- [ ] **Step 2: Check the two prose mentions still read true**

Run: `grep -n "Run batch now" README.md RUNBOOK.md`

Both describe the inter-send delay applying to manual batches, which is still true. Update
the *name* only if the surrounding sentence implies a single global button; the buttons are
now labelled "Run now" and live on each conveyor.

- [ ] **Step 3: Commit**

```bash
git add API.md README.md RUNBOOK.md
git commit -m "docs: per-belt run-now, its response shape, and its refusals"
```

---

## Task 11: Full verification

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0

- [ ] **Step 2: Full suite**

Run: `npm test`
Expected: all tests pass. Pay attention to `tests/worker/orchestrator.test.ts` and
`tests/e2e/full-pipeline.test.ts` — they exercise the sender and event ticks this change
sits next to.

- [ ] **Step 3: Report honestly**

If anything fails, fix it before claiming completion. Do not report success without pasting
the passing output. Per the user's standing preference, an end-to-end check against the
running app is expected before merge: start Relay, open the dashboard, and confirm each of
the four buttons promotes only its own belt and reports the right label — including one
deliberate refusal (pause the engine, click a button, expect "Paused" with the reason in the
tooltip).

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix: address issues found in full-suite verification"
```

---

## Self-Review Notes

Spec coverage checked section by section:

| Spec section | Task |
|---|---|
| Uniform API + `belt` parsing + `all` alias | 1, 6 |
| Per-belt promote (invite / message / engagement) | 4 |
| Event = move the reservation | 5, 7 |
| Pre-flight gates (paused / guardrail / logout / capped) | 2 |
| Event gates (nothing armed / running / daily cap) | 3, 7 |
| Busy lock → `deferred`, promotion still stands | 6 |
| Double-click idempotence | 4 |
| Per-campaign `/api/events/:id/run-now` stays uncapped | 7 |
| Four buttons, hidden while idle | 8 |
| Label mapping, refusal tooltip | 9 |
| Docs | 10 |

Known deviations from the spec, both deliberate and both already patched back into the spec:
`error` carries the human sentence with `code` alongside it (the dashboard's `api()` helper
reads `error`), and `promoted` means "rows due now" rather than "rows newly moved", so a
second click repeats the count instead of reporting 0.
