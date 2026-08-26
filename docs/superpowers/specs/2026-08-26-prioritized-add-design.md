# Prioritized add — design

**Date:** 2026-08-26
**Status:** approved (brainstormed in-session 2026-08-26)

## Goal

Let an add carry urgency. `POST /api/profiles` and `POST /api/lists` gain a `prioritize`
flag that (1) puts the new rows at the front of the queue and (2) hands them today's
already-planned slots, pushing the current occupants down — without changing how many
sends happen today, when they happen, or touching any other pipeline.

The driving use case is **several** profiles added to the top, either as one pasted list
or one-by-one across separate calls, usually as a new cohort. Both paths must converge on
the same queue state.

## Current state (verified 2026-08-26)

The priority machinery already exists; it just isn't reachable at add time:

- `profiles.priority INTEGER NOT NULL DEFAULT 0` (schema.sql), migrated onto old DBs
  (database.ts `runMigrations`).
- `ProfileRepo.queuedByPriorityKind()` orders `(priority, id)`; `planKind` feeds that
  order into `assignSchedule`, so the lowest priority number gets the earliest slot.
- `POST /api/queue/profile/:id/move {to:'top'}` sets `MIN(queued priority) − 1` — but only
  for rows that are still `queued`.

Why the obvious two-step (add, then move-to-top) does not work: both add endpoints call
`planAndAssignToday()` **inside the request** (src/api/server.ts, deliberately — see the
"empty queue wondering what broke" comment). By the time a second request can move the
row, it is frequently already `scheduled`, where `priority` no longer orders anything.
The priority has to be written between the insert and the planning pass, i.e. inside the
add request itself.

Second gap: even with the priority written in time, a deep queue means today's
`batches_per_day × batch_size` budget is already committed by mid-morning
(`dailyRemainingFor` counts every row scheduled today), so a front-of-queue add gets no
slot until tomorrow. "Prioritized" that always means "tomorrow" is not what was asked for.

## Decisions (from brainstorm)

| Question | Decision |
|---|---|
| What does `prioritize` guarantee? | Front of the queue **and** occupancy of today's earliest remaining slots. Rows pushed past the last seat return to `queued` and lead tomorrow. |
| Reuse `resortSchedule()`? | **No.** It redraws slot times via `planDailyBatches`, which samples the whole workday window and discards draws `< now` — a 16:00 re-plan keeps ~1 of 4 slots, silently shedding sends the day had capacity for, by an rng roll, and the loss lands on the urgent batch itself. It also requeues DMs and engagements globally. We re-seat instead: same times, same volume, different occupants. |
| How do N calls stay in arrival order? | Prioritized rows **join the front block** instead of going one deeper: every touched row gets `MIN(queued priority)` if that is `< 0`, else `−1`. Equal priorities fall back to the `(priority, id)` tie-break = insertion order. A list and the same profiles added one-by-one produce identical queues. |
| Scope of the promotion | Only the rows the call touched — never the whole target cohort. Cohort-wide promotion (`prioritizeCohort`) is wrong for the default date-named cohort ("August 26, 2026"), which accumulates every cohort-less add of the day; 3 urgent adds must not promote 50 bystanders. |
| Which pipelines | `invite` and `message` kinds, each re-seated within its own kind only. Engagements and event invites out of scope. |
| Send immediately? | No. `run-now` composition doesn't work anyway (`promote()` drains scheduled rows first, never reaching a queued front block behind a full day), and an add endpoint must not fire irreversible sends. The operator can still click Run batch now afterwards — after a re-seat, the scheduled rows *are* the prioritized ones, so the composition now does what they expect. |

## API

Both endpoints accept one new optional field:

```jsonc
POST /api/profiles { "url": "…", "cohort": "…", "kind": "…", "message": "…", "prioritize": true }
POST /api/lists    { "text": "…", "cohort": "…", "kind": "…", "message_template": "…", "prioritize": true }
```

`prioritize` is a boolean, default `false`. Absent or `false`, behavior is byte-for-byte
today's. All existing validation (URL shape, kind/cohort 409, message-length and
DM-needs-a-body 400s) runs first and is unchanged — a rejected add prioritizes nothing.

Response additions when `prioritize: true`:

```jsonc
// POST /api/profiles
{ "id": 42, "profile_url": "…", "kind": "invite",
  "prioritized": true, "scheduled_for": "2026-08-26T11:40:12.000Z" }  // null if no seat today

// POST /api/lists
{ "added": 8, "found": 8,
  "prioritized": 8,                                   // rows front-blocked (see eligibility below)
  "first_scheduled_for": "2026-08-26T11:40:12.000Z" } // earliest seat any of them took; null if none
```

`scheduled_for` / `first_scheduled_for` is what lets an agent answer "when does it go?"
in one round trip — read back from the touched rows after the planning pass, so it is a
real slot, never a forecast.

**Eligibility.** `add()` can return a pre-existing row instead of inserting (same
url+kind). A returned row is front-blocked only if its status is `queued` or `scheduled`;
rows with real send history (`sent`, `accepted`, `skipped` with a LinkedIn verdict, …)
are left exactly as they are — prioritizing must never resurrect or re-send. `/api/lists`
counts only eligible rows in `prioritized`, so `prioritized < found` is the signal that
some pasted URLs were already past sending.

## Mechanics

Request flow with `prioritize: true` (after validation, replacing nothing):

1. **Insert** via the existing `repos.profiles.add(…)` calls, collecting the returned rows.
2. **Front-block**: new repo method `ProfileRepo.frontBlock(ids: number[])` — one
   `SELECT MIN(priority) FROM profiles WHERE status='queued'`, then
   `v = (min !== null && min < 0) ? min : -1`, one UPDATE over the ids. Uses the global
   queued bound, same as the existing `queuedBound()` primitives.
3. **Re-seat**: new `reseatKind(repos, kind, now)` in `src/worker/scheduler-service.ts`
   (see below).
4. **Plan**: the existing `planAndAssignToday(repos, new Date())` call, unchanged and
   unconditional (it still runs for non-prioritized adds exactly as today). After a
   re-seat it is a near-no-op for this kind — occupancy is unchanged, so
   `dailyRemainingFor` is unchanged — but it still covers the empty-morning case where no
   slots existed to re-seat and the day has fresh budget.

### `reseatKind(repos, kind, now): number`

```
future  = byStatusKind('scheduled', kind) where Date(scheduled_for) > now      // (a)
if future.length === 0 → return 0                                              // (b)
times   = distinct scheduled_for values of `future`, ascending, as Dates
seats   = future.length                                                        // (c)
requeue every row in `future` (status='queued', scheduled_for=null, priority untouched)
pool    = queuedByPriorityKind(kind)          // now includes displaced + new + old backlog
take    = pool.slice(0, seats)
for a of assignSchedule(take.map(id), times, max(1, capsFor(s, kind).batchSize)):
    setScheduled(a.id, a.when.toISOString())
return seats
```

The load-bearing choices:

- **(a) strictly future slots only.** A row whose slot is `<= now` is due: the sender's
  `pickDue` will take it on the next tick, and a row inside the 10-minute overdue grace
  window is *supposed* to be left alone (`requeueOverdue` owns staleness). Re-seating a
  due row would yank it out from under an imminent send. Rows in `sending` are untouched
  by construction — `byStatusKind('scheduled', …)` cannot see them.
- **(b) graceful degradation.** No future slots today (evening, weekend, paused-and-gone-
  stale, pre-plan morning) → pure front-of-queue behavior, step 4 handles any fresh
  budget, nothing else is disturbed.
- **(c) seats = displaced-row count, NOT `times.length × batch_size`.** The previous
  assignment may have under-filled the last slot (7 rows across 2 slots = 5+2). Re-seating
  to slot *capacity* would quietly add 3 sends to today — a cap violation smuggled in by a
  reordering operation. Committed volume must be exactly conserved, which also means
  `dailyRemainingFor` and the weekly budget are conserved without re-checking either.
- **Displacement order is fair.** Displaced rows keep `priority` (typically 0) and their
  original ids, and the old backlog was scheduled in id order to begin with — so the
  re-assignment reproduces the previous order minus whoever fell off the end, with the
  front block ahead. The fallen rows lead tomorrow's plan by the same `(priority, id)`
  rule; nothing needs to remember them.
- **No rng, no reservation re-check.** The times being reused already passed
  `filterReservedSlots` when they were planned. A reservation created *after* planning
  (arming an event) already overlaps existing scheduled rows today; re-seating neither
  worsens nor fixes that, and inherits whatever the planner's answer is.
- **Per-kind by construction.** A prioritized invite add re-seats only invite slots; DM
  and engagement schedules are never touched, and vice versa.

Worked example — 10:00, invite slots today 11:40 (5 rows) / 14:03 (5) / 17:22 (5),
prioritize a list of 8:

- The 8 join the front block at `−1`, in paste order.
- 15 future rows requeue; the same 3 times are re-filled with 15 seats:
  11:40 ← urgent 1–5, 14:03 ← urgent 6–8 + old rows 1–2, 17:22 ← old rows 3–7.
- Old rows 8–15 return to `queued` at priority 0 and lead tomorrow.
- Day still sends exactly 15 from this kind, at exactly the same three times.

## Folded-in fix: "Up next" cohort ordering

`GET /api/queue/grouped` sorts cohorts by `minPriority` computed **over queued rows
only**; a cohort whose rows are all `scheduled` keeps the `Infinity` sentinel and sorts
*last*. A prioritized add walks straight into this: the new cohort is small and fully
seated, so the UI would render the cohort that sends *first* at the *bottom*.

Fix (in the same change): sort key becomes

1. earliest `scheduled_for` among the cohort's scheduled rows, chronologically — cohorts
   with any scheduled row come first, in actual send order;
2. cohorts with only queued rows follow, by `minPriority`;
3. `id` as the final tie-break (unchanged).

This is also more truthful for cohorts that were never prioritized: scheduled sends
happen before any queued row can, so chronological-first reflects the real conveyor.
Row ordering inside a cohort (`orderUpcoming`) is already correct and unchanged.

## Documentation & skill updates

- **API.md** — `prioritize` on both endpoints (in the "For agents" section, since this is
  an agent-facing flag), the response additions, the eligibility rule, and one paragraph
  on re-seat semantics: same times, same volume, occupants change, displaced rows lead
  tomorrow. Note the grouped-order fix under `/api/queue/grouped`.
- **RUNBOOK.md** — operator phrasing: "add these people first in line" → the agent passes
  `prioritize`; what to expect ("they take today's next batches; whoever they displaced
  goes tomorrow morning first").
- **skill `themachine-add-profiles`** — when the user says "urgent", "first", "top of the
  queue", "before the others", pass `prioritize: true`; report back using
  `scheduled_for`/`first_scheduled_for` ("first ones go out at 11:40 today") and mention
  displaced work slides to tomorrow. Cohort-less DM reminder already applies (the derived
  date-cohort 409).

## Testing

- `ProfileRepo.frontBlock`: joins an existing negative block; creates `−1` when the queue
  floor is `0`/empty; list-then-singles convergence (same final order both ways).
- `reseatKind` (unit, fake clock): conserves seat count and slot times exactly; front
  block seated first, displaced rows keep priority and lead the queue for tomorrow;
  under-filled last slot does not gain seats (the `seats = future.length` rule); rows with
  `scheduled_for <= now` untouched; `sending` rows untouched; other kind's slots
  untouched; no scheduled rows → returns 0 and queue order still correct.
- API (`tests/api/server.test.ts`): flag default-off is byte-identical; `prioritize` +
  full day → new rows scheduled into existing times, response carries the real slot;
  `prioritize` with nothing scheduled → front-of-queue + fresh plan; pre-existing `sent`
  row in a prioritized list → not moved, `prioritized < found`; validation failures
  (409 kind, 400 message rules) leave no priority side effects.
- `GET /api/queue/grouped`: fully-scheduled cohort sorts by its first slot, not last;
  mixed cohorts in chronological-then-priority order.
- Idempotence: prioritized add mid-day, then `planAndAssignToday` again — no
  double-booking, `committedToday` unchanged.

## Out of scope

- Engagements and event invites (both have their own `priority`/window machinery; nothing
  here touches them).
- A "send immediately" flag (deliberately rejected — see Decisions).
- Displacement notification/UI beyond the existing queue view (the displaced rows are
  visible as ordinary queued rows at the top of tomorrow's order).
