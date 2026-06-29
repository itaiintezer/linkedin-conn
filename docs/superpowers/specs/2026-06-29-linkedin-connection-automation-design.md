# LinkedIn Connection Automation — Design Spec

**Date:** 2026-06-29
**Status:** Approved for planning

## Purpose

A locally-run tool that takes lists of LinkedIn profile URLs (organized into named
cohorts), and sends connection requests automatically with a configured message —
carefully paced to stay within safe limits and avoid detection. It tracks which
requests are accepted and reports acceptance metrics per cohort. It is designed to be
portable and simple enough to ship to a team, where each teammate runs their own copy
against their own LinkedIn account.

## Key Decisions

- **Stack:** Node + TypeScript. Single language for the background worker, local web
  UI, and browser automation. `better-sqlite3` for storage.
- **Run model:** Single local web app. One command starts a background worker + a small
  web server; the user opens `http://localhost:PORT` to manage lists and watch progress.
- **Deployment:** Each teammate runs their own self-contained copy, logged into their
  own LinkedIn account. Rate limits are per-account, which matches this model.
- **Browser:** CloakBrowser (stealth Chromium, drop-in Playwright replacement),
  **visible/headed**. Pre-login and any checkpoint resolution happen in this window.
- **Process architecture:** Single Node process (web server + scheduler + browser worker
  + acceptance-checker), with SQLite as the source of truth. The worker is a separate
  module that could later be split into its own process without a rewrite.

## Architecture Overview

A single Node + TypeScript app with these internal modules around a SQLite database:

- **Web UI + API server** (Fastify/Express) — serves the dashboard and a documented,
  localhost-only REST API.
- **Scheduler** — decides *when* the next send batch runs: randomized times within the
  working-hours window (8am–8pm, weekdays), respecting the rolling 100/week + 5/batch
  caps.
- **Browser worker** — drives CloakBrowser (persistent context) to perform login and
  connection requests.
- **Acceptance-checker** — separate low-frequency job that infers which sent invites
  were accepted by reading two LinkedIn list pages.
- **SQLite store** (`better-sqlite3`) — cohorts, profiles, event log, send log, settings.

## Data Model (SQLite)

- **`cohorts`** — `id`, `name`, `message_template`, `allow_no_note` (bool), `created_at`.
- **`profiles`** — `id`, `cohort_id`, `profile_url` (normalized, **unique**),
  `first_name` (filled at send time), `custom_message` (nullable; set by API adds),
  `status`, `attempts`, `last_error`, `scheduled_for`, `sent_at`, `accepted_at`,
  `resolved_at`.
  - Status enum: `queued → scheduled → sending → sent → accepted | expired`,
    with branches `skipped`, `failed`, `needs_attention`.
- **`send_log`** — append-only record of every send attempt (`timestamp`, `profile_id`,
  `outcome`). The rolling 7-day cap counts against this.
- **`profile_events`** — append-only event stream (`profile_id`, `event_type`, `at`).
  `event_type` ∈ `sent | accepted | expired | skipped | failed`. Powers funnel and
  time-series metrics.
- **`settings`** — singleton: working-hours window, weekly cap, batch size, batches/day,
  acceptance-check cadence, `account_type` (free/premium/salesnav), `note_quota_state`.

## Connection-Send Flow (per profile)

1. Worker opens the profile URL in the warm CloakBrowser persistent context.
2. Reads the first name from the page (for the `{firstName}` token).
3. Resolves the message by precedence:
   **`custom_message` → cohort `message_template` (token-substituted, ≤300 chars) → no
   note** (only if the cohort's `allow_no_note` is set).
4. Clicks **Connect** — handles the case where it is hidden under the **More** menu —
   and adds the note if applicable.
5. Detects outcomes:
   - success → `sent` (+ `send_log`, + `profile_events`)
   - already connected / pending → `skipped`
   - Connect not available → `skipped`
   - note-quota hit → retry **without** note, update `note_quota_state`
   - captcha / checkpoint / unexpected → **pause queue** + `needs_attention` + UI alert
6. Human-like randomized delays between profiles within a batch.

## Scheduling & Safety

- On startup (and at day rollover) the scheduler plans the day: ~4 randomized batch
  times within the working-hours window, never exceeding caps.
- **Rolling 7-day window** enforced from `send_log` (not a calendar week).
- Defaults: **5 per batch, 100 per rolling 7 days, ~4 batches/day, weekdays, 8am–8pm**.
  Batch size, weekly cap, and batches/day are configurable in Settings.
- Only `sent` counts toward the cap. Skips and failures do not.
- Captcha / checkpoint / expired-login → global **pause** with a clear UI banner. The
  user resolves it in the visible browser, then resumes.
- LinkedIn DOM selectors are centralized in one module (the main maintenance point, since
  LinkedIn changes its markup).

## Acceptance Tracking (light-touch)

LinkedIn exposes no acceptance API/event, so acceptance is **inferred** by reading two
list pages on a slow schedule and diffing against the DB by profile URL:

1. **"Sent invitations" (pending) page** — the set of still-outstanding invites. Any
   profile marked `sent` that is no longer listed has resolved.
2. **"Connections → recently added"** — disambiguates a resolved invite: present →
   `accepted` (+ `accepted_at`); absent → `expired` (withdrawn/ignored).

- **Cadence:** once/day at a randomized time within working hours (~2–3 page loads).
- Reading these pages is normal browsing and does **not** consume the 100/week budget.
- Runs only when logged in; pauses on captcha/checkpoint like the sender.
- Acceptance is best-effort with a small ambiguity window; labeled as such in the UI.

## Metrics (by cohort)

Computed from `profile_events`:

- Per-cohort table: **sent / accepted / pending / expired**, **acceptance rate**, and
  **median time-to-accept**.
- A simple **acceptance-over-time** chart.
- Supports the core question: which cohort / message template performs best.

## Login / Pre-Login

- A **"Connect LinkedIn account"** button opens the visible CloakBrowser to
  linkedin.com; the user logs in manually.
- Session persists via a profile directory on disk (persistent context).
- A status indicator shows logged-in / expired; re-login reopens the same flow.

## Web UI

- **Add list:** paste URLs or upload CSV/TXT (extract any `linkedin.com/in/...` URLs);
  assign or create a cohort.
- **Cohorts:** create/edit cohort + message template + no-note toggle.
- **Dashboard:** live queue with per-profile status, today's planned batch times,
  this-week count vs cap (rolling), pause/resume, login status, needs-attention items.
- **Metrics:** per-cohort funnel table + acceptance-over-time chart.
- **Settings:** working hours, caps, batches/day, acceptance-check cadence, account type.

## Local API (for agents/integrations)

Localhost-only; optional simple token.

- `POST /api/profiles` `{ url, cohort, message? }` → enqueues with an optional
  per-contact message (creates the cohort if new). Enables an external AI agent to feed
  ultra-personalized invites into the queue.
- `GET /api/status` → queue summary + rolling weekly count.

## Testing

- Unit tests for pure logic: URL normalization/extraction, message resolution + token
  substitution, rolling-cap calculator, scheduler time-planning, acceptance diff logic.
- The browser automation sits behind a thin abstraction so the queue, scheduler, and
  acceptance diffing are tested without a live browser.
- The LinkedIn DOM layer (selectors, click flows) is verified manually against the
  visible browser.

## Out of Scope (v1)

- Auto follow-up messaging to accepted connections (data model supports adding it later).
- Multi-account in one instance / centralized server.
- Cloud hosting.
