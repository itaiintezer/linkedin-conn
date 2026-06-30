# Browser Lifecycle, Persisted Login & Guardrails — Design

**Date:** 2026-06-30
**Status:** Approved (pending spec review)

## Problem

Today the browser (CloakBrowser persistent context) is opened lazily on first use and
kept open until process shutdown, but two things make it brittle:

1. **Login is coupled to a live browser.** `LinkedInDriver.isLoggedIn()` returns `false`
   whenever the context isn't launched, and otherwise reads `li_at` from the live context.
   The dashboard's 30s poll calls this. After a machine/app restart the browser isn't
   launched, so the dashboard shows "not logged in" and **nothing sends until the user
   manually clicks Connect** — even though valid cookies still sit in `.linkedin-profile`.
2. **No hard guardrail.** A checkpoint sets `paused`, but there's no distinct, loud,
   account-protecting halt for the range of "LinkedIn isn't cooperating" signals
   (captcha, lost session, broken DOM, repeated failures), and acceptance checks keep
   running through a checkpoint-induced pause is reserved only for sends.

## Goals

- **Lazy open, never close.** The browser opens only when work is actually due, then
  stays open for the process lifetime (human-like for anti-bot). After a crash/restart it
  re-opens on the next due job with no manual maintenance — "it just works."
- **Persisted login.** A DB-cached login flag drives the dashboard indicator without
  touching the browser, so status is correct even before the browser has opened.
- **Guardrails.** When LinkedIn (or the scrape) looks uncooperative, halt all automated
  browser activity, raise a prominent dashboard alert, and require an explicit
  user-acknowledged re-verification before resuming.

## Non-goals

- Reading Chromium's on-disk encrypted cookie store directly (rejected: fragile on
  Windows — encrypted values, file locks).
- Closing the browser on idle (explicitly rejected by the user in favor of never-close).
- Headless operation (stays `headless: false` so the user can solve captchas / log in).

## Decisions (from brainstorming)

| Decision | Choice |
| --- | --- |
| Open trigger | **Lazily, when work is due** (send due, or acceptance slot with pending sents). Never close. |
| Login source while browser closed | **Cached flag in our DB**, refreshed while the browser is open. |
| Guardrail triggers | **All four**: checkpoint/captcha, login lost mid-run, DOM/selectors broke, repeated errors/nav failures. |
| Abort action | **Halt everything** (sends + acceptance) into a distinct `tripped` state separate from manual `paused`. Browser stays open. |
| Recovery | **Manual acknowledge + re-verify** before resuming. |
| Failure counter + login cache location | **Persisted in `app_state`** (survives restart). |

## Architecture

### 1. Browser lifecycle — lazy open, never close

`CloakSession` already opens lazily (`context()`/`page()`) and only closes on shutdown.
The change is to **decouple the work-gate from the dashboard check** so that *due work*
is what triggers an open, and idle ticks never open the browser.

`runSenderOnce` reorders to:

1. `settings.paused?` → return
2. `app_state.guardrail_tripped?` → return
3. Compute due profiles **from the DB only** (`byStatus('scheduled')` + `pickDue`,
   bounded by remaining weekly capacity). **If none due, return without opening the
   browser.**
4. Check **cached** login (`app_state.login_logged_in`). If not logged in, return
   (dashboard already surfaces "log in"); do not open a pointless window.
5. Call the driver — which lazily opens the browser (and it stays open). Before the
   first send, confirm login **live** (see §3 "login lost").

`runAcceptanceCheck` reorders similarly: `paused?` → `tripped?` → there are `sent`
profiles to check? (DB only) → cached login? → then open + read.

Net effect: the 60s send loop stays browser-free on idle ticks; the window comes up the
first time a profile is genuinely due and then stays up. Self-healing after a restart
because `.linkedin-profile` cookies + the DB login cache both persist.

### 2. Persisted login — DB cache

New single-row **`app_state`** table, kept separate from user `settings` (this is runtime
state, not configuration). Login-related columns:

- `login_logged_in INTEGER NOT NULL DEFAULT 0`
- `login_cookie_expiry TEXT` — ISO expiry of `li_at` if known
- `login_confirmed_at TEXT` — ISO timestamp the cache was last written from a live read

**Login refresher** (in `Orchestrator`): a timer every ~10s that, **only if the browser
is already open**, reads `li_at` via `ctx.cookies()` (cheap, no navigation) and upserts
the cache. When the browser is closed it is a no-op — the cache holds last-known state.
This keeps the dashboard accurate during/after a manual login (LED flips within ~10s of
`li_at` appearing) without ever opening the browser just to poll.

Driver split:

- `isLoggedIn()` stays as the **live** check (uses the context), used *inside* a run to
  confirm before sending and during acknowledge re-verification.
- The dashboard no longer calls the live check. `GET /api/login-status` reads **the cache
  only**.

### 3. Guardrail — detection (`worker/guardrail.ts`, new, isolated & testable)

A small module evaluates outcomes and owns the trip decision + failure counter. Two tiers:

**Immediate trip (single occurrence):**

- **Checkpoint / captcha** — driver returns `checkpoint`, or `looksLikeCheckpoint` is
  true during an acceptance read. Reason: `checkpoint`.
- **Login lost mid-run** — a live `li_at` check fails after the cache said logged-in
  (e.g. confirmed before a send, or mid-run). Also flips the login cache to logged-out.
  Reason: `login_lost`.

**Threshold trip (persisted consecutive-failure counter in `app_state`):**

- `failure_streak INTEGER NOT NULL DEFAULT 0`.
- **Incremented** on `error` and `unavailable` send outcomes and on navigation throws.
- **Reset to 0** on any `sent` outcome.
- Crossing **N** (`settings.failure_threshold`, default 3) trips with reason
  `repeated_failures` and a detail string naming the last error. Covers both
  "DOM/selectors broke" and "repeated errors/nav failures" without false-tripping on a
  single legitimate skip.
- **Empty acceptance scrapes are NOT counted** — an empty pending/connections list is
  often legitimate. Only a *thrown* error or a checkpoint during a read trips.

`note_quota` is benign (handled by the existing no-note fallback) and never counts.
`already`/`skipped` are benign and never count.

### 4. Guardrail — halt + recovery

New `app_state` columns:

- `guardrail_tripped INTEGER NOT NULL DEFAULT 0`
- `guardrail_reason TEXT` — `checkpoint` | `login_lost` | `repeated_failures`
- `guardrail_detail TEXT` — human-readable detail (last error, etc.)
- `guardrail_tripped_at TEXT` — ISO timestamp

**Halt:** all jobs short-circuit when `guardrail_tripped` — `runSenderOnce`,
`runAcceptanceCheck`, and the daily planning/acceptance ticks. The browser **stays open**
so the user can solve the captcha / re-login in the live window. This replaces the current
`checkpoint → settings.paused` behavior: checkpoint now trips the guardrail instead of
setting the manual pause.

**Recovery:** `POST /api/guardrail/acknowledge`:

1. Use the open browser to **re-verify**: confirm `li_at` present and the current/feed
   page is not a checkpoint.
2. Clean → clear `guardrail_*`, reset `failure_streak` to 0, refresh login cache, resume.
3. Still bad → stay tripped, update `guardrail_reason`/`guardrail_detail`.

Manual-ack-without-re-check is intentionally not offered.

### 5. UI

- **Prominent red alert banner** (visually distinct from the existing amber pause banner)
  shown whenever `guardrail_tripped`. Shows the reason, tripped-at time, and an
  **"I've fixed it — re-check & resume"** button that calls the acknowledge endpoint.
  Re-check failure keeps the banner up with the updated reason.
- **Login LED** sourced from the cache; when the browser is closed, an "as of &lt;time&gt;"
  tooltip from `login_confirmed_at`.
- `GET /api/status` (or an extension of `login-status`) returns
  `{ loggedIn, asOf, guardrail: { tripped, reason, detail, trippedAt } }` for the existing
  30s dashboard poll.

## Components / files touched

| File | Change |
| --- | --- |
| `src/db/schema.sql` | New `app_state` single-row table (login cache, guardrail state, `failure_streak` counter); idempotent column-add migration (same pattern as the `onboarded` settings column); new `failure_threshold` config column on `settings` (default 3). |
| `src/db/repositories.ts` (+ repo) | New `app_state` repo: get/set login cache, get/set guardrail, get/inc/reset failure streak. |
| `src/worker/guardrail.ts` (new) | Pure-ish evaluation: `evaluateSendOutcome(state, outcome)` and `evaluateReadError(...)` → `{ trip?, reason, detail, streak }`. Unit-testable without a browser. |
| `src/worker/sender.ts` | Reordered gating (paused → tripped → due-from-DB → cached login → open → live confirm); route outcomes through guardrail; checkpoint trips guardrail instead of `paused`. |
| `src/worker/acceptance-checker.ts` | Reordered gating; checkpoint/throw during reads trips guardrail. |
| `src/worker/orchestrator.ts` | Login-cache refresher timer (only acts while browser open); honor `tripped` in all ticks. |
| `src/browser/linkedin-driver.ts` | Keep live `isLoggedIn()`; expose a cheap `readLiAt()`/cookie read for the refresher; checkpoint surfacing unchanged. |
| `src/api/server.ts` | `login-status` reads cache; add `GET /api/status`; add `POST /api/guardrail/acknowledge`. |
| `src/web/{index.html, app.js, styles}` | Red guardrail banner + re-check button; LED from cache with "as of" tooltip. |

## Testing

- **Unit (no browser):** `worker/guardrail.ts` — streak increment/reset, threshold trip,
  immediate-trip reasons, empty-scrape-does-not-trip. `app_state` repo round-trips.
- **Worker logic:** `runSenderOnce`/`runAcceptanceCheck` with a fake `BrowserDriver`:
  asserts no browser call when nothing due / not logged-in / tripped; asserts trip on
  checkpoint, on N consecutive errors, and on login-lost; asserts cache write on confirm.
- **API:** `login-status` returns cache without driver interaction; `acknowledge`
  re-verifies and only clears on a clean check (fake driver).
- **Manual / e2e:** restart with valid cookies → LED correct from cache → first due job
  opens browser and sends; force a checkpoint → banner appears, all activity halts,
  acknowledge re-checks.

## Open questions / explicitly deferred

- Exact default for the failure threshold N (proposed 3) — tunable, low-risk to change.
- Whether `GET /api/status` replaces or extends `GET /api/login-status` — decide during
  implementation to minimize web/app.js churn.
