# Per-belt "Run batch now" — design

**Date:** 2026-08-04
**Status:** approved pending user review

## Goal

Every pipeline gets its own manual "Run batch now", not just connection invites. Today one
global button on the dashboard header promotes invite **and** message rows and kicks the
sender; engagements have no manual trigger at all; event invites have one, but only on the
Events tab, per campaign. Replace that with a per-conveyor button on each of the four engine
cards, backed by a single endpoint with a uniform response — and make every collision the
operator can hit report itself instead of being swallowed.

## Current state (verified 2026-08-04)

| Pipeline | Manual trigger today | Where |
|---|---|---|
| Conn invites | `POST /api/run-now` — promotes queued/scheduled invites to due-now, then runs the sender | Dashboard header button `#runNow` |
| Messages | Piggybacks on the *same* endpoint (it promotes `message` rows too) — no button on the messages conveyor | Dashboard header button |
| Engagements | None. `runSenderOnce` runs an engagement pass, but `/api/run-now` never promotes engagements, so a manual run only catches rows already due | — |
| Event invites | `POST /api/events/:id/run-now` — armed campaigns only, ignores the reserved window and the daily cap | Events tab, per campaign |

Two collision defects in what exists:

1. `/api/run-now` uses `browserLock.tryRun`. If the periodic sender, an event run, the reply
   check or the roster sync holds the lock, the run is **dropped and the endpoint still
   answers `{ok:true}`**.
2. `/api/run-now` also answers `{ok:true}` when the engine is paused, the guardrail is
   tripped, or the session is logged out — `runSenderOnce` returns early and nothing says why.

## Decisions (from brainstorm)

| Question | Decision |
|---|---|
| Scope of a click | Promote **only** the clicked belt's backlog to due-now, then kick the shared sender, which drains whatever is due across all passes. A scheduling modification and nothing else — no pass-scoping inside `runSenderOnce`. |
| Event invites | No due-now queue exists, so "promote" means **move the reservation to now** (clear + recreate for the next-up campaign) and let the existing `runEventTick` fire it within 60s. |
| Browser busy | Promote anyway — the DB write is durable and the next tick will send it — and report `started: false, deferred: 'browser busy'` rather than claiming a run happened. |
| Paused / guardrail / logged out | **Refuse with the reason**, promoting nothing. Pre-flighting avoids the resume-burst hazard: a batch promoted while paused would all fire the instant the operator resumes, outside the planned spread. |
| `events_per_day` | The new dashboard button respects it and refuses clearly. The existing per-campaign `POST /api/events/:id/run-now` stays uncapped as the deliberate operator override. |
| Global header button | Removed, replaced by four per-conveyor buttons. Accepted cost: promoting invites *and* messages is now two clicks instead of one. |

## API

One endpoint, one response shape, four belts:

```
POST /api/run-now  { belt?: 'invite' | 'message' | 'engagement' | 'event' }
```

Omitting `belt` is the documented alias for API and RUNBOOK callers and promotes all three
**sender** belts — invite, message and engagement. That is a deliberate widening of today's
behavior (which skips engagements) and closes the gap that left the engagement pipeline with
no manual trigger.

Responses:

```jsonc
200 { ok: true,  belt: 'invite', promoted: 7, started: true }
200 { ok: true,  belt: 'invite', promoted: 7, started: false, deferred: 'browser busy' }
200 { ok: true,  belt: 'invite', promoted: 0, started: false, deferred: 'nothing queued' }
409 { ok: false, belt: 'invite', error: 'paused', message: 'Paused — LinkedIn weekly invitation limit reached' }
```

`promoted` is what definitely happened (a durable DB write); `started` is what may not have.
Splitting them is what makes the busy case honest.

The no-belt alias answers `belt: 'all'` with `promoted` as the sum across the three sender
belts, so a client never has to special-case a missing field.

For `belt: 'event'`, `promoted` is `1` when a reservation was moved (`0` never occurs — a
belt with nothing to run refuses at pre-flight), and the payload additionally carries
`event_id` and the new `from`/`to` window. `started` is always `false`: the run is handed to
`runEventTick`, which fires within 60s.

## Behaviour per belt

Every click is two separable steps — **promote**, then **kick**.

| Belt | Promote | Kick |
|---|---|---|
| `invite` | `profiles.queuedByPriorityKind('invite')` then `profiles.byStatusKind('scheduled','invite')`, sliced to `capsFor(s,'invite').batchSize`, each `setScheduled(now - 1s)` | `browserLock.tryRun(() => runSenderOnce(…, { force: true }))` |
| `message` | Same, `kind = 'message'`, sliced to `capsFor(s,'message').batchSize` | Same shared kick |
| `engagement` | `engagements.queuedByPriority()` then `engagements.byStatus('scheduled')`, sliced to `engagementCaps(s).batchSize`, each `setScheduled(now - 1s)` | Same shared kick |
| `event` | `reservations.clearFor('event_invite', id)` then `reservations.create(now, now + event_run_budget_minutes, 'event_invite', id)` for the campaign `nextEventRun()` names | None — `runEventTick` picks it up |

`force: true` on the sender is retained: a manual trigger may run outside working hours by
design. The inter-send delay (`min_delay_ms`/`max_delay_ms`) is **not** bypassed, for the
reason already documented on the existing endpoint — a manual batch hits the same LinkedIn
account through the same automation, and back-to-back sends are exactly the burst pattern
those settings exist to prevent.

The event belt reuses `nextEventRun()` rather than inventing a second selection rule, so the
button can never promise a different campaign than the planner would pick. `ensureEventReservation`
is idempotent against this: it returns early when a window is already claimed for today, so
the moved reservation is left alone by the hourly planner tick.

## Collision handling

### Pre-flight gates

Checked **before** any promotion, so a refused click never mutates the schedule.

| Condition | `error` | Message |
|---|---|---|
| `settings.paused` | `paused` | echoes the real `pause_reason` |
| `app_state.guardrail_tripped` | `guardrail` | echoes the trip reason |
| `app_state.login_logged_in !== 1` | `not_logged_in` | "Not logged in to LinkedIn" |
| Weekly cap exhausted for that belt | `capped` | e.g. "18/18 invites this week" |
| `event` · no armed campaign whose event has not started | `nothing_armed` | — |
| `event` · the campaign is already `running` | `already_running` | — |
| `event` · `countRunsOnDate(now) >= events_per_day` | `daily_cap` | "already ran an event campaign today (1/1)" |

The weekly-cap gate uses the same `remainingCapacity(caps.weeklyCap, sentInWindow)` the
sender itself uses, so the button cannot promise a send the sender would then refuse. The
daily budget is deliberately **not** pre-flighted — bypassing the day's spread is the whole
point of a manual run.

For the no-belt alias, a gate that fails is fatal for the whole request (all three sender
belts share the pause/guardrail/login state); the per-belt weekly cap simply skips that belt.

### Post-promotion

- **Browser lock held.** `tryRun` returns `undefined` → `started: false, deferred: 'browser busy'`.
  The promoted rows are due, so the next 60s sender tick sends them. Nothing is lost and
  nothing is falsely claimed.
- **Double-click.** The second promote finds the rows already due and promotes 0 more; its
  kick is dropped by the lock. Answers `promoted: 0, deferred: 'browser busy'`. Idempotence
  falls out of the design — no in-flight registry is needed.
- **Two belts in quick succession.** The first kick takes the lock and drains both, because
  the second belt's rows were promoted before the passes reach them; the second request
  answers `deferred`. Correct either way.
- **Events vs sender.** An event run holds the lock with blocking `run()` for its whole
  budget, so a sender click during it defers. That is the existing designed trade-off
  (a reserved window outranks a sender tick) — now *reported* instead of swallowed.

## UI

The global header button `#runNow` is removed. Each of the four engine cards gains a small
labeled button in its `.engine-pills` row:

- `#engine` (invites) → `data-belt="invite"`
- `#msgEngine` → `data-belt="message"`
- `#evEngine` → `data-belt="event"`
- `#engEngine` → `data-belt="engagement"`

One delegated handler reads `data-belt`, POSTs it, and renders the uniform response. Buttons
are hidden while their card is in the collapsed `is-idle` state — a belt with no campaigns
has nothing to run.

Transient feedback reuses the existing `#runNow` idiom (disable → label swap → revert after
2.5s), driven by the response:

| Response | Label |
|---|---|
| `started: true, promoted: n` | `Triggered n` |
| `deferred: 'browser busy'` | `Queued n` |
| `deferred: 'nothing queued'` | `Nothing queued` |
| `belt: 'event'`, ok | `Starting…` |
| 409 | the gate's short reason, e.g. `Paused`, `Capped`, `Not logged in` |

## Testing

- `tests/api/server.test.ts` — belt scoping (a `message` click leaves invite rows untouched);
  each 409 gate refuses **and promotes nothing**; busy lock → `started: false` with rows still
  promoted; double-click idempotence; the no-belt alias promotes all three sender belts
  including engagements.
- `tests/api/events.test.ts` — reservation rewritten to now and `dueEventRun` then returns it;
  `events_per_day` refusal; no-armed-campaign refusal; already-running refusal; the
  per-campaign `/api/events/:id/run-now` remains uncapped.
- `tests/web/dashboard.test.ts` — four buttons present, each posts its own belt, refusal
  reason rendered, button hidden while the card is `is-idle`.

## Out of scope

- Pass-scoping inside `runSenderOnce` (rejected in favour of promotion-only scoping).
- Capping the existing per-campaign `POST /api/events/:id/run-now`.
- Any change to the periodic tick cadence, the planner, or the caps themselves.
