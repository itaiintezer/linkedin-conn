# Next-batch prediction — design

**Date:** 2026-06-30
**Status:** approved (pending spec review)

## Problem

The dashboard "Next batch" card shows `None Scheduled` whenever no profile is
currently in status `scheduled` with a future `scheduled_for` time — even when a
large backlog of `queued` profiles exists. This is the common state because:

- Batch times are random and materialized **only for the current day**, at the
  scheduler tick (`planAndAssignToday`, hourly). Tomorrow's times don't exist yet.
- Once today's batches send (`scheduled → sent`), no `scheduled` rows remain.
- Outside working hours / on weekends nothing is planned for "today".

So the data backing the card legitimately doesn't exist between the last batch
of the day and the next day's first planning tick. The whole point of the
project is timed batches, so the user should always be able to see *when the
next batch will run* (or *why it won't*).

## Goal

`forecast.next_batch` always answers one of three things:

1. **Exact** — a real, materialized future slot exists → show it (today).
2. **Predicted window** — no slot yet, but a backlog exists and sending is
   possible → show the next sending-day working-hours window and approximate
   count.
3. **Blocked** — a backlog exists but sending is currently prevented → show the
   reason instead of a time.

Only return `null` when there is genuinely nothing to send (empty backlog).

## API shape

`forecast.next_batch` becomes a discriminated union (was `{ at, count } | null`):

```ts
type NextBatch =
  | null                                                  // nothing queued
  | { estimated: false; at: string; count: number }       // exact future slot(s)
  | { estimated: true;  at: string; until: string; count: number } // predicted window
  | { blocked: true; reason: string };                    // sending prevented
```

- `estimated: false` — `at` is the earliest future `scheduled_for`; `count` is
  how many profiles share that exact slot (unchanged from today's behavior, plus
  the explicit flag).
- `estimated: true` — `at`/`until` are ISO bounds of the predicted working-hours
  window; `count = min(batch_size, backlog)` (one batch).
- `blocked` — `reason` is a short human string (see priority chain).

## Decision logic (priority chain)

Evaluated in order; first match wins. Inputs are primitives so the function
stays pure and unit-testable (no DB).

```
nextBatch(scheduledRows, ctx, now) where ctx = {
  backlog,           // queued + scheduled remaining (number)
  weeklyRemaining,   // remainingCapacity(weekly_cap, sentInWindow)
  dailyRemaining,    // dailyTarget - committedToday  (>= 0)
  guardrailTripped,  // boolean
  paused,            // boolean
  settings,
}
```

1. `backlog <= 0` → `null` — nothing to send; the card shows "none queued".
2. `guardrailTripped` → `{ blocked, reason: 'Guardrail tripped' }`.
3. `paused` → `{ blocked, reason: 'Paused' }`.
   - Rationale: the scheduler keeps planning while paused, but the sender does
     not send, so any `scheduled` rows won't fire. The reason is the honest
     answer, so it overrides exact slots.
4. `dailySendRate(settings) <= 0` → `{ blocked, reason: 'Sending disabled' }`
   — config makes sending impossible (`batches_per_day`, `batch_size`, or
   `weekly_cap` is 0).
5. `weeklyRemaining <= 0` → `{ blocked, reason: 'Weekly cap reached' }`.
6. Exact: `nextBatch` over `scheduledRows` finds a future slot →
   `{ estimated: false, at, count }`.
7. Predicted window (the fallback that fixes the reported bug):
   - **Today** if today is a sending day, `now` is before `workday_end_hour`,
     **and** `dailyRemaining > 0`: window = `[max(now, workday_start), workday_end]`
     for today.
   - **Otherwise** the next sending day's full `[workday_start, workday_end]`
     window (honoring `weekdays_only`).
   - `count = min(batch_size, backlog)`.

The "today vs next day" branch is what correctly handles the two reported
cases: after today's batches fire, `dailyRemaining` is 0 → predicts tomorrow;
after hours / weekend → predicts the next weekday.

## Code locations

- **`src/core/forecast.ts`** — replace/extend `nextBatch` with the pure
  decision function above. Reuse the existing `isSendingDay` / sending-day
  walking helpers; add a helper to compute a day's window bounds. Export
  `dailySendRate` (already present, currently private) if needed by the server,
  or keep the rate check internal by passing a precomputed flag.
- **`src/worker/scheduler-service.ts`** — extract `committedToday` so the server
  can reuse the exact same daily-budget math (single source of truth). Move it
  to a shared module (e.g. `src/core/` or export from scheduler-service) without
  changing scheduler behavior.
- **`src/api/server.ts`** (`/api/status`) — compute `backlog`,
  `weeklyRemaining` (`remainingCapacity` + `countSentSince(windowStartIso)`),
  `dailyRemaining` (`dailyTarget - committedToday`), `guardrailTripped`
  (`appState.guardrail_tripped === 1`), `paused` (`settings.paused`), then call
  the new forecast function.
- **`src/web/app.js`** (`renderCards`) — render the union:
  - `null` → value `—`, foot `none queued`.
  - `blocked` → value `—`, foot `reason`.
  - `estimated: false` → value `count`, foot `at HH:MM` (unchanged).
  - `estimated: true` → value `~count`, foot like `Tue 09:00–17:00`
    (weekday + window). A small date/clock formatting helper alongside the
    existing `fmtClock`.

## Testing (TDD — tests first)

`tests/core/forecast.test.ts` — new cases:
- exact future slot → `estimated: false`, correct `at`/`count`.
- backlog, before end-of-day, daily budget left → predicts **today** window.
- backlog, daily budget spent → predicts **next sending day**.
- backlog, after hours → predicts next sending day.
- weekend + `weekdays_only` → predicts Monday.
- `weeklyRemaining <= 0` → blocked "Weekly cap reached".
- `paused` → blocked "Paused" (even with exact slots present).
- `guardrailTripped` → blocked "Guardrail tripped" (highest precedence).
- zero send rate → blocked "Sending disabled".
- empty backlog → `null`.
- precedence: guardrail beats paused beats weekly-cap.

`tests/api/server.test.ts` — `/api/status` returns the new `next_batch` shape
for at least one predicted and one blocked scenario.

## Out of scope (YAGNI)

- Pre-rolling/committing tomorrow's random times (the rejected alternative).
- Predicting exact times in the future window (we show the window, preserving
  jitter).
- Multi-day "next N batches" forecast.
