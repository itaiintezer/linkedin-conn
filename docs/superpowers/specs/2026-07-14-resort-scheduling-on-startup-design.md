# Re-sort scheduling to policy on startup

**Date:** 2026-07-14
**Status:** Approved

## Problem

`Orchestrator.start()` calls `planAndAssignToday()` immediately, but overdue
`scheduled` rows are only cleared by `requeueOverdue()`, which runs inside the
sender tick (every 60s) — never at startup, and never inside the planner itself.

After downtime (overnight, weekend, or a multi-day gap) many profiles sit in
`scheduled` status with a past `scheduled_for`. On the next start this causes two
failures:

1. **Budget suppression.** `committedToday()` counts *all* `scheduled` rows.
   Stale past-due rows inflate that count, so `dailyRemainingFor()` can compute to
   `0` and the startup plan schedules *nothing*.
2. **Latency.** Overdue rows are not re-flowed into fresh batches until the first
   sender tick requeues them **and** the next hourly plan runs — up to ~1 hour of
   dead time.

The batch-size / spacing policy itself is already correct (`planDailyBatches` +
`assignSchedule`, plus the sender's per-tick `batch_size` cap). What is missing is
**re-sorting the backlog before planning** so past-due items don't distort or
suppress today's schedule, and so each batch keeps its intended size regardless of
how many tasks are past due.

## Decisions

- **Full rebuild on startup** (chosen over "only re-sort past-due"): clear *all*
  `scheduled_for`, return everything to `queued`, then re-flow the whole backlog
  into fresh policy-compliant batches. Reshuffles healthy future slots on each
  restart — accepted for a single coherent behavior.
- **Root-cause fix** (chosen over "startup-only"): fold overdue-requeue into the
  planner so startup, the hourly tick, `/api/resume`, and
  `/api/guardrail/acknowledge` all self-heal.

## Design

Two coordinated changes in `src/worker/scheduler-service.ts`; one call-site change
in `src/worker/orchestrator.ts`.

### 1. `resortSchedule(repos, now, rng?)` — full rebuild

New exported function:

1. Requeue **every** `scheduled` profile back to `queued`, clearing `scheduled_for`
   (`repos.profiles.setStatus(id, 'queued', { scheduled_for: null })`).
2. Delegate to `planAndAssignToday(repos, now, rng)`.

Single purpose, independently testable. `scheduled_for` is always today-or-past
(the planner never schedules beyond today's window), so requeuing all `scheduled`
rows is safe and rebuilds the whole day's plan from a clean slate. Priority order
is preserved because requeue does not touch the `priority` column and
`queuedByPriority()` orders by `priority, id`.

### 2. Overdue requeue folded into `planAndAssignToday`

Add `requeueOverdue(repos, now)` as the **first statement** of `planAndAssignToday`,
before any budget computation. Stale past-due rows (>`OVERDUE_GRACE_MS`) can no
longer inflate `committedToday()`. `requeueOverdue` is retained and still called by
the sender tick; the two calls are idempotent.

### 3. Orchestrator wiring

In `Orchestrator.start()`, replace the bare
`planAndAssignToday(this.repos, new Date())` with
`resortSchedule(this.repos, new Date())`. The hourly timer keeps calling
`planAndAssignToday` (now self-healing via change #2). No other call sites change.

## Data flow (startup after 3-day downtime)

1. `start()` → `resortSchedule(now)`.
2. All `scheduled` rows (3-day-old past-due) → `queued`, `scheduled_for = null`.
3. `planAndAssignToday(now)`:
   - `requeueOverdue` — no-op (nothing left in `scheduled`).
   - `committedToday()` = `0 scheduled + sentToday` → daily budget reflects only
     today's real sends.
   - `queuedByPriority()` re-flowed into today's future slots via
     `planDailyBatches` + `assignSchedule`, capped at
     `min(weeklyRemaining, dailyBudget, futureSlots * batch_size)`.
4. Items beyond today's capacity stay `queued`, scheduled on later ticks/days.

## Safety / edge cases

- **Mid-day restart:** `sent`/`sending` rows are never touched; `sentToday` still
  counts against the daily budget, so no double-send.
- **Paused / halted at startup:** `resortSchedule` requeues all, then
  `planAndAssignToday` no-ops on its existing `paused`/`guardrail_tripped` guard.
  Rows sit `queued` (harmless — the sender won't run); `/api/resume` re-plans.
- **Concurrency:** `resortSchedule` and `planAndAssignToday` are fully synchronous
  DB operations (better-sqlite3); setInterval callbacks cannot interleave mid-call,
  so no race with the sender tick's own `requeueOverdue`.
- **No burst:** past-due items become `queued` and are assigned `batch_size` per
  future slot; the sender's per-tick `min(remaining, batch_size)` cap is the
  backstop. Batch size is preserved no matter how many tasks were past due.

## Testing

Extend `tests/worker/scheduler-service.test.ts`:

1. **Full rebuild re-flows past-due backlog** — seed N `scheduled` rows with
   past `scheduled_for`; `resortSchedule` at an in-window `now` leaves each future
   slot with ≤ `batch_size` items and schedules up to the daily target.
2. **Stale scheduled no longer suppresses budget** — seed enough past-due
   `scheduled` rows to exceed the daily target; assert `planAndAssignToday` (via the
   folded `requeueOverdue`) still schedules queued items rather than computing a
   zero budget.
3. **Priority order preserved** across a rebuild.
4. **Mid-day restart** — with some `sent` rows dated today, `resortSchedule` does
   not exceed `dailyTarget - sentToday`.
5. **Paused at startup** — `resortSchedule` requeues all but schedules nothing.

Verify end-to-end against the running Relay instance before merge (per project
convention).
