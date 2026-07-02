# UX batch fixes — design

Date: 2026-07-02
Scope: 12 user-reported fixes across Run Log, Cohorts, Attention, and Dashboard.
Decisions #6/#8/#12 were confirmed with the user (archive-only, drawer drill-down,
auto re-schedule).

## 1. Run Log

### 1.1 Cap rendered lines (perf)
- Keep fetching `/api/logs?tail=1000`.
- Render only the **last 300** lines (`LOG_RENDER_CAP`). The filter box searches all
  fetched lines, then the render cap applies to the matches.
- Header line above the view: `showing last 300 of N lines — Download for the full log`.

### 1.2 Auto-scroll to newest
- After every render (and when the Settings tab is opened), scroll `#logView` to the
  bottom inside `requestAnimationFrame` so layout is final before scrolling.

### 1.3 Per-profile verdict lines (verbose log)
- `sender.ts`: log an INFO `verdict` line per profile with the slug and a human
  verdict (`sent`, `already connected`, `failed: <err>`, `needs attention: <why>`,
  `skipped: unavailable`).
- `acceptance-checker.ts`: log an INFO `verdict` line per newly `accepted` / `expired`
  profile (slug included), in addition to the existing summary line.
- Log view renders per-line `<div>`s colorized by level (ERROR red, WARN amber,
  verdict lines highlighted) instead of one text blob — cheap now that rendering is
  capped.

## 2. Cohorts

### 2.1 Total profiles column
- `computeCohortMetrics` already returns `total`. Add a "Total" column to the
  metrics table (first numeric column).

### 2.2 Median days to 1 decimal
- Frontend: `median_time_to_accept_days.toFixed(1)`.

### 2.3 Archive cohorts (user decision: archive-only)
- Migration: `ALTER TABLE cohorts ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`
  (+ schema.sql for fresh DBs).
- `CohortRepo.list()` returns non-archived only; new `listArchived()`,
  `setArchived(id, flag)`.
- `getOrCreate` un-archives on name match, so re-adding a list under an archived
  name resurrects the cohort instead of writing into a hidden one.
- API: `POST /api/cohorts/:id/archive` (also skips its queued/scheduled profiles so
  nothing keeps sending), `POST /api/cohorts/:id/unarchive`.
- UI: an "Archive" button on each cohort card (with confirm), plus a collapsed
  "Archived" section at the bottom of the Cohorts screen with a Restore button.
  Metrics rows for archived cohorts are hidden with the cohort.

## 3. Attention

### 3.1 Retry feedback
- `/api/retry` already returns `{ retried }` — surface it.
- "Retry all" / dashboard "Retry failed": button shows `Retrying…` then `Requeued N`
  for 2.5s before reverting; list refreshes.
- Per-row Retry: button shows `…` while in flight; a toast under the table confirms
  `Requeued <slug>`; row disappears on refresh.

## 4. Dashboard

### 4.1 Status drill-down (user decision: clickable cards → drawer)
- API: `GET /api/profiles?status=<s>` optional filter (limit 500 as today).
- The engine's **Pending** and **Accepted** stations and the **Expired** /
  **Already connected** outcome cards become clickable; each opens a right-hand
  slide-over drawer titled with the status, listing slug (link), cohort, and the
  status-relevant date (sent_at / accepted_at). Backdrop click or Esc closes.
  "Needs attention" keeps its existing jump to the Attention tab.

### 4.2 Collapse cohorts in queue
- Chevron toggle in each queue-group header. Collapsed = header only (name + count
  + actions stay). Collapsed cohort ids persist in `localStorage`
  (`relay.collapsedCohorts`) so state survives the 15s re-render and reloads.

### 4.3 Now processing
- `/api/status` gains `sending: [{ id, profile_url }]` (profiles in status
  `sending`).
- Engine shows a pulsing "now processing <slug>" pill next to the ETA/next-batch
  pills while non-empty.

### 4.4 Paused engine visual
- `#engine` gets `.is-paused` when paused (and when the guardrail is tripped):
  conveyor dots stop (`animation-play-state: paused`, dimmed), stations desaturate,
  and a "PAUSED" / "HALTED" badge appears on the track. The pulsing refresh dot
  also stops while paused.

### 4.5 Re-schedule when the slot is in the past (user decision: auto re-schedule)
Root cause: the sender sends anything `scheduled_for <= now` on its next tick with
no working-hours check, so items that missed their slot while paused / halted /
logged-out / app-off fire immediately on resume — possibly late at night — and
until then the UI shows a stale past time.

Changes:
- `runSenderOnce` gains a working-hours + sending-day guard (skip outside the
  window) unless called with `force` — `/api/run-now` passes `force: true` so
  "Run batch now" still works at any hour.
- New `requeueOverdue(repos, now, graceMs = 10 min)` in scheduler-service: any
  `scheduled` profile overdue by more than the grace period returns to `queued`
  (scheduled_for = null, priority untouched). Runs on every sender tick (DB-only,
  cheap), so stale times self-heal even while paused.
- `planAndAssignToday` skips when paused or the guardrail is tripped (no point
  materializing slots the sender won't run); `/api/resume` and a successful
  guardrail acknowledge call it immediately so sending resumes without waiting for
  the hourly tick.
- UI: a `scheduled` row whose time is in the past renders `due now` instead of the
  stale timestamp (it will either send within a minute or be re-queued at the
  grace boundary).

Flow after the change: pause → slots pass → items re-queue within ~10 min →
resume → slots re-assigned immediately, always inside working hours. "Run now"
unchanged.

## Testing
- Unit: requeueOverdue (grace boundary), sender window guard (+force bypass),
  planAndAssignToday pause/guardrail skip, cohort archive repo + API
  (archive/unarchive/list filtering, getOrCreate resurrect), `/api/profiles?status=`
  filter, `/api/status` sending list.
- Existing suite must stay green; `npm run typecheck` clean.
- Manual e2e pass on a scratch DB (never data/app.db) before merge.
