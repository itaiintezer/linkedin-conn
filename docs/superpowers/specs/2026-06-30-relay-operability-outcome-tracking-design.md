# Relay operability & outcome-tracking upgrade — design

**Date:** 2026-06-30
**Status:** Approved (design forks confirmed via clarifying questions)

## Goal

Make Relay easier to operate and far more transparent about what happens to each
connection request. Bundle of operator-facing improvements plus a sales-team runbook
and a Cowork skill. Acceptance accept/expire *robustness* is explicitly deferred — this
round only surfaces "last checked" and documents the mechanism.

## Decisions (from clarifying questions)

1. **Problem-profile visibility:** a new **Attention tab** listing every failed /
   needs-attention profile with its error, cohort, attempts, and per-row actions.
2. **Already-connected:** a new terminal status `already_connected` (not folded into
   `skipped`), counted on the dashboard and shown as its own column in Metrics.
3. **Cowork skill:** auto-detects single vs bulk — one URL → `/api/profiles`, multiple →
   `/api/lists`. Targets the self-hosted API, base URL `http://localhost:4400`
   (overridable via `RELAY_URL`).
4. **Acceptance robustness:** deferred. This round adds the last-checked timestamp and
   documents how acceptance tracking works; the grace-period / expiry rework is a later
   round.

## 1. Data model (additive, migration-safe)

- **`already_connected` status.** `profiles.status` is free-text TEXT, so no schema
  change is required. Add `'already_connected'` to the `ProfileStatus` and `EventType`
  unions in `src/types.ts`. The sender's `'already'` outcome sets
  `status='already_connected'` and records an `already_connected` event (today it folds
  into `skipped` with `last_error='already'`).
- **`app_state.acceptance_checked_at TEXT`** (ISO, nullable). Added via a `runMigrations`
  ALTER following the existing `failure_threshold` pattern in `src/db/database.ts`. Also
  added to `schema.sql` for fresh DBs. Set on every *successful* acceptance read in
  `runAcceptanceCheck`.

## 2. Backend compute — pure helpers in `src/core/`

A new `src/core/forecast.ts` with three pure, unit-tested functions:

- `estimateQueueCompletion(remaining, settings, sentInWindow, now)` →
  `{ sendingDays: number, finishDate: string | null }`.
  Daily send rate = `min(batches_per_day * batch_size, weeklyHeadroom)` where
  `weeklyHeadroom = max(0, weekly_cap - sentInWindow)` is treated as the first-week
  ceiling. Walk forward day by day (skipping weekends when `weekdays_only`), subtracting
  the daily rate, until `remaining` is exhausted; `finishDate` is that calendar day.
  `remaining === 0` → `{ sendingDays: 0, finishDate: null }`. Rate `0` → `finishDate:
  null` (never).
- `nextBatch(scheduledRows, now)` → `{ at: string, count: number } | null`.
  Among `scheduled` profiles with `scheduled_for > now`, find the earliest
  `scheduled_for`; `count` = how many share that exact timestamp (assignSchedule groups a
  batch onto one `when`). Returns `null` when nothing is scheduled in the future.
- `orderUpcoming(rows)` → profiles "up for processing" in true send order:
  `scheduled` (ascending `scheduled_for`) first, then `queued` (ascending `id`). Used to
  pick the top-N for the dashboard.

## 3. API (`src/api/server.ts`)

- `GET /api/status` additions:
  - `acceptance_checked_at` (from `app_state`).
  - `forecast: { queue_remaining, eta: { sendingDays, finishDate }, next_batch }`
    where `queue_remaining = counts.queued + counts.scheduled`.
- `GET /api/queue?limit=10` → `{ upcoming: [...top N via orderUpcoming...],
  total_remaining }`. Each row: id, profile_url, cohort_name, status, scheduled_for.
- `GET /api/attention` → profiles with status in (`failed`, `needs_attention`), with
  `id, profile_url, cohort_name, status, last_error, attempts, sent_at, scheduled_for`,
  newest first.
- `POST /api/profiles/:id/retry` → reset that one profile to `queued`
  (`scheduled_for=null`, `last_error=null`).
- `POST /api/profiles/:id/dismiss` → set that profile to `skipped`, clear `last_error`
  (acknowledged / won't retry).
- `GET /api/metrics` / `computeCohortMetrics` gains `already_connected` count per cohort.

The existing bulk `POST /api/retry` stays (the Attention tab keeps a "Retry all" too).

## 4. Frontend (`src/web/{index.html,app.js,styles.css}`)

- **Notification placement.** Move `#listResult` from below the whole form into the
  right rail (`.add-rail`), directly under the Enqueue button, so it's always in view;
  `scrollIntoView({block:'nearest'})` after enqueue as a belt-and-braces.
- **Dashboard cards** (`renderCards`):
  - **Time to finish queue** — from `forecast.eta` (e.g. "~3 working days · by Jul 3", or
    "—" when nothing queued, "paused" / "no capacity" when rate is 0).
  - **Next batch** — from `forecast.next_batch` (e.g. "4 · 2:40 PM" or "—").
  - **Already connected** — `counts.already_connected`.
  - **Accepted** card subtext `(last checked: <fmtTime(acceptance_checked_at)>)` or
    "(never)".
  - **Needs attention** card now shows `failed + needs_attention` (matches the Retry
    button), and is clickable → switches to the Attention tab.
- **Queue trim.** Dashboard "Queue" section calls `/api/queue?limit=10`, shows the
  upcoming 10 and `total_remaining`. A **View more** button raises the limit (loads the
  rest). Removes the flat 500-row `/api/profiles` dump from the dashboard.
- **New "Attention" tab.** Nav tab between Dashboard and Add List (or after Metrics).
  Table: Profile · Cohort · Status · Attempts · Error, with per-row **Retry** and
  **Dismiss** buttons plus a header **Retry all**. Polls with the dashboard tick.

## 5. Docs & Skill

- **`RUNBOOK.md`** (repo root). Non-technical, sales-team-oriented:
  install Node 22.5+ → `npm install` → `npm start` → open `localhost:4400` → Connect
  LinkedIn → Add List → reading the dashboard (each card) → safety (captcha auto-pause,
  weekly cap) → **how acceptance tracking works** (the daily two-page read + diff;
  documents goal item 8) → troubleshooting via the Attention tab.
- **`.claude/skills/relay-add-profiles/SKILL.md`** — Cowork skill. Given LinkedIn profile
  URLs (and optional cohort + message template), POSTs to the self-hosted API:
  exactly one URL → `POST /api/profiles`; multiple → `POST /api/lists`. Base URL from
  `RELAY_URL` env, default `http://localhost:4400`. Uses `curl` via Bash. Reports how
  many were added vs found.

## 6. Testing (TDD)

- `tests/core/forecast.test.ts` — `estimateQueueCompletion` (weekend skip, weekly-cap
  clamp, empty, zero-rate), `nextBatch` (grouping, no-future), `orderUpcoming` (ordering).
- `tests/core/metrics.test.ts` — `already_connected` counted per cohort.
- `tests/worker/sender.test.ts` — `'already'` → `already_connected` status + event.
- `tests/worker/acceptance-checker.test.ts` — sets `acceptance_checked_at` on success;
  not set when nothing to verify / login lost.
- `tests/api/server.test.ts` — `/api/queue` shape + ordering + total; `/api/attention`
  contents; per-id retry & dismiss transitions; `/api/status` forecast +
  `acceptance_checked_at` fields.

## Out of scope (this round)

- Acceptance accept/expire grace-period / real-expiry rework.
- Auth on the localhost API (it remains localhost-only, unauthenticated as today).
- Persisting "dismissed" as a distinct status (we reuse `skipped`).
