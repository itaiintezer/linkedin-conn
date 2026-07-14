# On-demand acceptance recheck — design

**Date:** 2026-07-14

## Problem

Acceptance reconciliation (promoting a pending `sent` invite to `accepted` once the
person appears in the connections list) runs only on a **daily** cadence via the
orchestrator (`runAcceptanceTick`, once per calendar day). An operator who wants to
know "did anyone accept just now?" has no way to trigger the check — they wait for
the next day's pass. Add a trigger near the "Accepted" station that rechecks
acceptance on demand.

## Goals

- A visible trigger next to the Accepted station's `checked <time>` footnote that runs
  an acceptance check immediately and updates the dashboard.
- Reuse the existing, well-tested `runAcceptanceCheck` logic and browser-lock
  discipline — no new scraping paths.
- Give the operator clear feedback about what happened (found N, none new, or why it
  couldn't run).

## Non-goals

- No change to the daily automatic cadence.
- No change to acceptance semantics (still additive-only: appearance in the
  connections list promotes to `accepted`; the age-backstop expiry is unchanged).
- No new LinkedIn interaction — the check remains read-only against the connections
  list.

## Behavior decisions

- **Runs even when paused.** Acceptance is read-only against LinkedIn, so a manual
  recheck bypasses the `paused` flag. It still respects every safety gate: guardrail
  tripped, logged out, empty/failed read. If a checkpoint is present or the session is
  gone, it does nothing (never opens the browser to a checkpoint).
- **Trigger form:** a small circular-arrow refresh icon button, placed inside the
  Accepted station's label next to the `checked <time>` footnote.

## Design

### 1. `runAcceptanceCheck` — force flag + return value

File: `src/worker/acceptance-checker.ts`

- Add an options parameter: `runAcceptanceCheck(repos, driver, now, opts?: { force?: boolean })`.
  - `opts.force === true` bypasses **only** the `paused` early-return
    (`if (repos.settings.get().paused) return;`). Every other gate is unchanged:
    `isTripped(repos)`, the `sent.length === 0` short-circuit, the login check,
    live login re-confirmation, the read-error path, and the empty-read fail-safe.
- Change the return type from `void` to a small structured result so callers can
  report outcomes:

  ```ts
  export interface AcceptanceRunResult {
    ran: boolean;   // true only if we actually read the connections list
    reason?: 'paused' | 'guardrail' | 'no_pending' | 'logged_out'
           | 'login_lost' | 'read_error' | 'empty_read';
    accepted: number;   // profiles promoted to accepted this run
    expired: number;    // profiles expired by the age backstop this run
    checkedAt?: string; // ISO timestamp stamped on a successful run
  }
  ```

  - Each early return yields `{ ran: false, reason, accepted: 0, expired: 0 }` with the
    matching reason (`paused` only reachable when `force` is not set).
  - A completed read returns `{ ran: true, accepted, expired, checkedAt: iso }`.

- Orchestrator callers (`runAcceptanceTick`, `start`) are unchanged: they ignore the
  return value and do not pass `force`, so the daily pass still respects pause exactly
  as before.

### 2. New endpoint

File: `src/api/server.ts`

- `POST /api/recheck-acceptance`:
  ```ts
  const result = await browserLock.run(
    () => runAcceptanceCheck(repos, driver, new Date(), { force: true }),
  );
  return result;
  ```
- Uses `browserLock.run` (not `tryRun`) so the request queues behind any in-flight
  sender/acceptance batch rather than being silently dropped — same discipline as
  `/api/login`. Logs the trigger via `defaultLog.info('api', 'recheck-acceptance', …)`.

### 3. Frontend trigger

Files: `src/web/index.html`, `src/web/app.js`, `src/web/styles.css`

- **HTML** ([index.html] Accepted station): add a small refresh icon `<button
  id="recheckAccept" type="button" title="Recheck acceptance now">` next to
  `#acceptedFoot`. The button contains a circular-arrow SVG.
- **JS** ([app.js]): wire a click handler that
  - calls `event.stopPropagation()` (the station is `is-drill`; the button must not open
    the drawer),
  - disables the button and adds a spinning state to the icon,
  - `POST /api/recheck-acceptance`,
  - calls `refreshStatus()` (updates `#stAccepted` and the `checked <time>` footnote),
  - shows a transient result label/title for ~2.5s: `Found N` when `accepted > 0`,
    `No new` when `ran && accepted === 0`, or a short reason otherwise
    (e.g. `Logged out`, `Checkpoint`), then restores the idle icon.
  - A `keydown` guard also stops Enter/Space from bubbling to the station drill.
- **CSS** ([styles.css]): style `#recheckAccept` as a subtle icon button scaled to the
  footnote; add a `.spin` animation used while the request is in flight.

## Error handling

- Endpoint errors surface through the existing Fastify error handler; the button shows a
  transient `Failed` state on a rejected fetch.
- All acceptance safety gates are preserved; a manual recheck can never mutate state on a
  suspiciously empty or failed read, and never runs during a tripped guardrail.

## Testing

Unit tests for `runAcceptanceCheck` (following the existing acceptance-checker test
harness):

- `force: true` runs the check and promotes accepted profiles **while paused**; the
  result is `{ ran: true, accepted: n, … }`.
- Without `force`, a paused engine short-circuits with `{ ran: false, reason: 'paused' }`
  and no state change.
- The result object reports `accepted`/`expired` counts and `checkedAt` on a successful
  run.
- Early-return reasons are surfaced correctly (`guardrail`, `no_pending`, `logged_out`,
  `empty_read`).

Existing acceptance-checker and API tests must continue to pass.
