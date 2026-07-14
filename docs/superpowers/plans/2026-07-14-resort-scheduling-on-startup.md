# Re-sort Scheduling to Policy on Startup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On startup (and every plan), re-sort the outreach backlog to policy so past-due tasks never suppress the daily budget or fire as a burst — each batch keeps its intended size and spacing.

**Architecture:** Two changes in `src/worker/scheduler-service.ts` — (1) fold `requeueOverdue` into `planAndAssignToday` so stale rows can't inflate `committedToday()`; (2) add `resortSchedule()` that requeues *every* scheduled row then re-plans (full rebuild). Wire `Orchestrator.start()` to call `resortSchedule` instead of the bare planner.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node ≥22, vitest, better-sqlite3 (synchronous).

**Spec:** `docs/superpowers/specs/2026-07-14-resort-scheduling-on-startup-design.md`

---

## File Structure

- **Modify** `src/worker/scheduler-service.ts` — add `requeueOverdue` call inside `planAndAssignToday`; add exported `resortSchedule`.
- **Modify** `src/worker/orchestrator.ts:93` — call `resortSchedule` in `start()`.
- **Test** `tests/worker/scheduler-service.test.ts` — budget-suppression, full-rebuild, priority, mid-day restart, paused.
- **Test** `tests/worker/orchestrator.test.ts` — `start()` wiring.

---

### Task 1: Fold overdue-requeue into `planAndAssignToday` (root-cause fix)

**Files:**
- Modify: `src/worker/scheduler-service.ts` (body of `planAndAssignToday`, starts line 25)
- Test: `tests/worker/scheduler-service.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/worker/scheduler-service.test.ts`:

```ts
test('planAndAssignToday requeues stale scheduled so they do not suppress the daily budget', () => {
  const c = repos.cohorts.create('A', 'hi', true);
  // 25 stale scheduled rows (a day overdue) would inflate committedToday past the daily target (20)
  for (let i = 0; i < 25; i++) {
    const p = repos.profiles.add(c.id, `https://www.linkedin.com/in/stale${i}`, null);
    repos.profiles.setScheduled(p.id, '2026-06-28T09:00:00.000Z');
  }
  // plus fresh queued work
  for (let i = 0; i < 10; i++) repos.profiles.add(c.id, `https://www.linkedin.com/in/q${i}`, null);
  let i = 0; const seq = [0.1, 0.35, 0.6, 0.85];
  planAndAssignToday(repos, new Date('2026-06-29T09:00:00'), () => seq[(i++) % seq.length]);
  // Without the fold: committedToday=25 -> daily budget 0 -> nothing scheduled.
  // With the fold: the 25 stale rows are requeued first, so the full daily target flows.
  expect(repos.profiles.byStatus('scheduled').length).toBe(20);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/worker/scheduler-service.test.ts -t "do not suppress the daily budget"`
Expected: FAIL — `scheduled.length` is `0` (stale rows suppressed the budget).

- [ ] **Step 3: Write minimal implementation**

In `src/worker/scheduler-service.ts`, add `requeueOverdue` as the first statement of `planAndAssignToday`. Change:

```ts
export function planAndAssignToday(repos: Repos, now: Date, rng: () => number = Math.random): void {
  const s = repos.settings.get();
```

to:

```ts
export function planAndAssignToday(repos: Repos, now: Date, rng: () => number = Math.random): void {
  // Self-heal first: stale past-due slots must not inflate committedToday() and zero out
  // the daily budget. Runs on every path (startup, hourly tick, resume, guardrail-ack).
  requeueOverdue(repos, now);
  const s = repos.settings.get();
```

(`requeueOverdue` is already defined above in this file — no new import.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/worker/scheduler-service.test.ts`
Expected: PASS — the new test plus all existing scheduler tests (healthy future slots are untouched because their times are not past the grace cutoff).

- [ ] **Step 5: Commit**

```bash
git add src/worker/scheduler-service.ts tests/worker/scheduler-service.test.ts
git commit -m "fix: requeue overdue before budgeting so stale slots don't suppress the daily plan"
```

---

### Task 2: Add `resortSchedule()` full rebuild

**Files:**
- Modify: `src/worker/scheduler-service.ts` (new exported function)
- Test: `tests/worker/scheduler-service.test.ts`

- [ ] **Step 1: Add `resortSchedule` to the test import**

In `tests/worker/scheduler-service.test.ts`, change the import line:

```ts
import { planAndAssignToday, requeueOverdue } from '../../src/worker/scheduler-service.js';
```

to:

```ts
import { planAndAssignToday, requeueOverdue, resortSchedule } from '../../src/worker/scheduler-service.js';
```

- [ ] **Step 2: Write the failing tests**

Append to `tests/worker/scheduler-service.test.ts`:

```ts
test('resortSchedule rebuilds all scheduled slots to policy (batch size preserved)', () => {
  const c = repos.cohorts.create('A', 'hi', true);
  // 30 profiles crammed into a single future slot (a bad/legacy plan)
  for (let i = 0; i < 30; i++) {
    const p = repos.profiles.add(c.id, `https://www.linkedin.com/in/p${i}`, null);
    repos.profiles.setScheduled(p.id, '2026-06-29T18:00:00.000Z');
  }
  let i = 0; const seq = [0.1, 0.35, 0.6, 0.85];
  resortSchedule(repos, new Date('2026-06-29T08:00:00'), () => seq[(i++) % seq.length]);
  const scheduled = repos.profiles.byStatus('scheduled');
  expect(scheduled.length).toBe(20);                          // daily target: 4 batches * 5, not 30
  expect(repos.profiles.byStatus('queued').length).toBe(10);
  const counts: Record<string, number> = {};
  for (const p of scheduled) counts[p.scheduled_for!] = (counts[p.scheduled_for!] ?? 0) + 1;
  for (const k of Object.keys(counts)) expect(counts[k]).toBeLessThanOrEqual(5); // batch_size
});

test('resortSchedule preserves priority order across a rebuild', () => {
  const c = repos.cohorts.create('Prio', null, true);
  const a = repos.profiles.add(c.id, 'https://www.linkedin.com/in/a', null);
  const b = repos.profiles.add(c.id, 'https://www.linkedin.com/in/b', null);
  repos.profiles.setScheduled(a.id, '2026-07-01T09:00:00.000Z');
  repos.profiles.setScheduled(b.id, '2026-07-01T09:00:00.000Z');
  repos.profiles.setPriority(b.id, -5); // higher priority (lower number) wins the single slot
  repos.settings.update({ weekly_cap: 1, batch_size: 1, batches_per_day: 1 });
  resortSchedule(repos, new Date('2026-07-01T09:00:00'), () => 0.5);
  expect(repos.profiles.findById(b.id)!.status).toBe('scheduled');
  expect(repos.profiles.findById(a.id)!.status).toBe('queued');
});

test('resortSchedule after a mid-day restart honours sends already made today', () => {
  const c = repos.cohorts.create('A', 'hi', true);
  // 18 already sent today -> only 2 of today's target of 20 remain
  for (let i = 0; i < 18; i++) {
    const p = repos.profiles.add(c.id, `https://www.linkedin.com/in/sent${i}`, null);
    repos.profiles.setStatus(p.id, 'sent', { sent_at: new Date('2026-06-29T08:30:00').toISOString() });
  }
  for (let i = 0; i < 30; i++) repos.profiles.add(c.id, `https://www.linkedin.com/in/q${i}`, null);
  let i = 0; const seq = [0.1, 0.35, 0.6, 0.85];
  resortSchedule(repos, new Date('2026-06-29T09:00:00'), () => seq[(i++) % seq.length]);
  expect(repos.profiles.byStatus('scheduled').length).toBe(2); // 20 target - 18 sent today
});

test('resortSchedule while paused requeues everything but schedules nothing', () => {
  const c = repos.cohorts.create('A', 'hi', true);
  for (let i = 0; i < 5; i++) {
    const p = repos.profiles.add(c.id, `https://www.linkedin.com/in/p${i}`, null);
    repos.profiles.setScheduled(p.id, '2026-06-29T18:00:00.000Z');
  }
  repos.settings.update({ paused: 1 });
  resortSchedule(repos, new Date('2026-06-29T08:00:00'), () => 0.5);
  expect(repos.profiles.byStatus('scheduled')).toHaveLength(0);
  expect(repos.profiles.byStatus('queued')).toHaveLength(5);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/worker/scheduler-service.test.ts -t "resortSchedule"`
Expected: FAIL — `resortSchedule is not a function` / import error.

- [ ] **Step 4: Write minimal implementation**

Append to `src/worker/scheduler-service.ts` (after `planAndAssignToday`):

```ts
/**
 * Full rebuild: return EVERY scheduled profile to the queue (clearing its slot), then
 * re-flow the whole backlog into fresh policy-compliant batches. Called at startup so a
 * backlog of past-due (or otherwise stale) slots is re-sorted to policy — same batch size
 * and spacing — instead of firing as a burst or suppressing today's plan. `scheduled_for`
 * is always today-or-past (the planner never schedules beyond today's window), so requeuing
 * all scheduled rows is safe. Priority order is preserved: requeue leaves `priority` intact
 * and queuedByPriority() re-orders by (priority, id).
 */
export function resortSchedule(repos: Repos, now: Date, rng: () => number = Math.random): void {
  for (const p of repos.profiles.byStatus('scheduled')) {
    repos.profiles.setStatus(p.id, 'queued', { scheduled_for: null });
  }
  planAndAssignToday(repos, now, rng);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/worker/scheduler-service.test.ts`
Expected: PASS — all `resortSchedule` tests plus the existing suite.

- [ ] **Step 6: Commit**

```bash
git add src/worker/scheduler-service.ts tests/worker/scheduler-service.test.ts
git commit -m "feat: resortSchedule() rebuilds the whole backlog to policy on demand"
```

---

### Task 3: Wire `Orchestrator.start()` to re-sort on startup

**Files:**
- Modify: `src/worker/orchestrator.ts` (import line 4; `start()` line 93)
- Test: `tests/worker/orchestrator.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/worker/orchestrator.test.ts`:

```ts
test('start() re-sorts a stale scheduled backlog off its past slots', () => {
  const c = repos.cohorts.create('A', 'hi', true);
  const p = repos.profiles.add(c.id, 'https://www.linkedin.com/in/stale', null);
  const staleIso = '2026-06-28T09:00:00.000Z'; // a day overdue
  repos.profiles.setScheduled(p.id, staleIso);
  const orch = new Orchestrator(repos, driver);
  orch.start();
  orch.stop(); // clear the timers start() registered so the test process exits
  // resortSchedule ran synchronously at startup: the row is off its stale slot — re-queued
  // (scheduled_for null), or re-scheduled to a fresh future time if inside working hours.
  expect(repos.profiles.findById(p.id)!.scheduled_for).not.toBe(staleIso);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/worker/orchestrator.test.ts -t "re-sorts a stale scheduled backlog"`
Expected: FAIL — `scheduled_for` is still `staleIso` (current `start()` calls `planAndAssignToday`, which leaves the row scheduled at its stale time because a day-old row is neither queued nor re-flowed by the planner).

- [ ] **Step 3: Write minimal implementation**

In `src/worker/orchestrator.ts`, update the import (line 4):

```ts
import { planAndAssignToday, requeueOverdue } from './scheduler-service.js';
```

to:

```ts
import { planAndAssignToday, requeueOverdue, resortSchedule } from './scheduler-service.js';
```

Then in `start()` (line 93), change:

```ts
    planAndAssignToday(this.repos, new Date());
```

to:

```ts
    // Startup re-sort: rebuild the whole backlog to policy so a pile of past-due slots
    // (after downtime) is re-flowed into correctly-sized batches, not fired as a burst.
    resortSchedule(this.repos, new Date());
```

Leave the hourly timer on the next line calling `planAndAssignToday` unchanged (it now self-heals via Task 1).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/worker/orchestrator.test.ts`
Expected: PASS — the new wiring test plus all existing orchestrator tests.

- [ ] **Step 5: Commit**

```bash
git add src/worker/orchestrator.ts tests/worker/orchestrator.test.ts
git commit -m "feat: re-sort the schedule to policy on startup"
```

---

### Task 4: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: all tests pass (green), including the pre-existing suites.

- [ ] **Step 3: End-to-end verification against the running app**

Per project convention (verify e2e before merge), exercise the real startup path — do NOT rely on unit tests alone:
1. Ensure the Relay server is stopped gracefully (avoid orphaning the cloak browser — see RUNBOOK).
2. Seed the queue so several profiles end up `scheduled` with past `scheduled_for` (e.g. let a plan run, then move the clock forward / restart after the window). `data/app.db` is production — if you seed test rows, clean them up afterward.
3. Start the server (`npm start`) inside working hours and confirm from the dashboard/logs that the past-due backlog is re-flowed into future batches of ≤ `batch_size`, with no burst of sends and a non-empty daily plan.
4. Confirm a mid-day restart does not exceed the daily target (already-sent-today rows still counted).

- [ ] **Step 4: Report results** — paste the typecheck + test output and a one-line e2e observation before merging.

---

## Self-Review

- **Spec coverage:** `resortSchedule` full rebuild (Task 2) ✓; overdue-requeue folded into planner / root-cause (Task 1) ✓; orchestrator wiring (Task 3) ✓; all five spec test scenarios present (budget-suppression → Task 1; full-rebuild, priority, mid-day restart, paused → Task 2; startup wiring → Task 3) ✓; e2e verification (Task 4) ✓.
- **Placeholder scan:** none — every code/command step is concrete.
- **Type/name consistency:** `resortSchedule(repos, now, rng?)` signature matches its definition, its import in both test files, and its call site in `orchestrator.ts`. `requeueOverdue` reused as-is (already exported).
