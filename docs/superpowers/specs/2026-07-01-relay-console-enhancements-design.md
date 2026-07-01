# Relay Console Enhancements — Design

**Date:** 2026-07-01
**Status:** Approved (brainstorm)

Five additive changes to the Relay LinkedIn outreach console. All are additive; no
existing endpoint changes behavior except the two queued-ordering call sites noted in §5.

Decisions were made interactively: menu = A, merged Cohorts = B, queue management = B,
log detail = full debug, API doc = dedicated `API.md` + live "Docs" tab.

---

## 1. Full run log (debug-level, file-based, viewable in Settings)

### Goal
A complete, human-readable run log for audit and debugging, viewable and downloadable
from the Settings tab.

### Backend
- New module `src/core/logger.ts`: a process-wide singleton that appends structured
  lines to a log file and echoes to the console (so `npm start` output is unchanged).
- **Line format:** `<ISO8601> <LEVEL> <component> <message> [key=value …]`
  e.g. `2026-07-01T15:04:05.123Z INFO sender sent profile=123 cohort="Security VPs"`.
  Values with spaces are quoted. Lines are single-line (newlines in values escaped).
- **Levels:** `debug | info | warn | error`. This build logs at **debug** (everything).
- **What is logged (debug = everything operational + internal):**
  - startup / shutdown (`index.ts`)
  - scheduler passes: planned slots, counts, skips-with-reason (`scheduler-service.ts`)
  - each send: attempt, outcome, and failure error text (`sender.ts`)
  - acceptance checks: started/finished, counts (`acceptance-checker.ts`)
  - guardrail trips and clears (`guardrail.ts`, `app_state` transitions)
  - pause / resume, run-now, retry, dismiss, login open (`server.ts` handlers)
  - login-state changes (`orchestrator.ts` refreshLoginCache)
  - browser driver actions — navigation, clicks, checkpoint detection (`linkedin-driver.ts`)
- **Rotation:** size-based. When the active file exceeds ~5 MB, rename it to
  `relay.log.1` (overwriting any previous `.1`) and start a fresh `relay.log`. Keeps at
  most one rotated file. Rotation is checked on write.
- `LOG_PATH` added to `config.ts` (`join(DATA_DIR, 'relay.log')`).

### API (`server.ts`)
- `GET /api/logs?tail=N` → `{ lines: string[] }`, the last `N` lines (default 500, capped
  at e.g. 5000). Reads the active file (and spills into `.1` only if needed to satisfy N —
  optional; default reads active file only).
- `GET /api/logs/download` → streams the active log file with
  `Content-Disposition: attachment; filename="relay.log"`.

### UI (Settings tab)
- A "Run log" panel below the settings form:
  - scrollable monospace pane (`<pre>`) showing the tail,
  - **Refresh** button (and it loads on tab open),
  - **Download** button (hits `/api/logs/download`),
  - a text **filter** box that client-side-filters visible lines (substring match).

### Testing
- Logger unit tests: writes a well-formed line; rotates when the threshold is exceeded
  (inject a small threshold + a temp path); `tail(n)` returns the last n lines.
- API test: `/api/logs` returns lines; `/api/logs?tail=2` returns 2.

---

## 2. Merged "Cohorts" screen (metrics on top, editable cohort rows below)

### Goal
Fold the Metrics screen into Cohorts. The tab stays named **Cohorts**. Metrics render at
the top; cohort create/update lives below, with each cohort row carrying its own stats.

### Frontend only (no backend change)
- Remove the `#tab-metrics` section and its tab button from `index.html`.
- The **Cohorts** tab (`#tab-cohorts`) renders:
  1. **Top:** the existing metrics table (Cohort / Sent / Accepted / Pending / Expired /
     Acceptance rate / Median days), loaded from `GET /api/metrics`.
  2. **"Manage cohorts" divider.**
  3. **Below:** each cohort as a card showing a mini-stat line (`42 sent · 43% accepted`,
     joined from the metrics response by cohort name) and **click-to-edit inline**
     (template textarea + Save → `POST /api/cohorts`). A "+ New cohort" affordance reveals
     a blank name+template form.
- `loadMetrics` + `loadCohorts` merge into one `loadCohortsScreen()` that fetches both
  endpoints in parallel and joins them. Tab routing in `initTabs` drops the `metrics` case
  and points `cohorts` at the merged loader.
- Empty states preserved (no metrics yet / no cohorts yet).

### Testing
- Existing `/api/metrics` and `/api/cohorts` tests already cover the data. No new backend
  tests required; this is presentational.

---

## 3. Docs tab + `API.md` (live-synced)

### Goal
A dedicated, agent-oriented API reference as a markdown file in the repo, plus a top-level
**Docs** tab that renders it live (edits to the file reflect in the UI without restart).
Structured so more docs can be added later.

### Content
- New **`API.md`** at the repo root. Concise, agent-first:
  - base URL (`http://localhost:4400`),
  - lead with the endpoints agents use: `POST /api/profiles`, `POST /api/lists`,
    `GET /api/status`,
  - then reference the rest: cohorts, metrics, queue, settings,
  - each endpoint: method, path, request body shape, response shape, one `curl` example.

### Backend (`server.ts`)
- A small allow-list registry mapping a slug → filename, initially `{ api: 'API.md' }`,
  resolved against the repo root.
- `GET /api/docs` → `[{ slug, title }]` (title from the file's first `# ` heading).
- `GET /api/docs/:slug` → `{ slug, title, markdown }`, reading the file **from disk on each
  request** (live sync). Unknown slug → 404. Slug is validated against the registry (no
  path traversal).

### Frontend
- New **Docs** tab section (`#tab-docs`) with a left doc list (from `/api/docs`) and a
  rendered content pane.
- Markdown rendered by a **small vendored zero-dependency renderer** in `app.js`
  (or `src/web/markdown.js`): supports headings, paragraphs, unordered/ordered lists,
  fenced + inline code, bold, and links. Sufficient for our own docs; keeps the no-build,
  offline-friendly setup. Output is our own trusted content, but the renderer still
  escapes HTML in text nodes.

### Testing
- API tests: `/api/docs` lists `api`; `/api/docs/api` returns markdown containing a known
  heading; `/api/docs/nope` → 404.

---

## 4. One-line top menu

### Goal
Merge the brand row and the tabs row into a single sticky header to save vertical space.

### Frontend only
- Merge `.topbar` and `nav.tabs` into one `<header class="topbar">`:
  - **left:** brand mark + "Relay" wordmark (drop the "Connection operations" subtitle),
  - **middle:** the tab buttons in a `flex:1` container with `overflow-x:auto`,
    `flex-wrap:nowrap` (scroll horizontally on narrow windows; never wrap to a 2nd row),
  - **right:** the login-status pill (with its hidden `connectBtn`).
- Tab set: **Dashboard · Attention · Add List · Cohorts · Docs · Settings**.
- Tab-switching JS (`initTabs`) is unchanged — still `.tab[data-tab]` buttons.
- The pause / guardrail banners remain directly below the header.

### Testing
- Presentational; no new tests. Manual/visual verification.

---

## 5. Queue management — grouped, editable queue

### Goal
Let operators reorder and remove work at both the individual and cohort level, from the
Dashboard "Up next" area.

### Data model
- One new column **`profiles.priority INTEGER NOT NULL DEFAULT 0`**, added idempotently in
  `runMigrations` (PRAGMA table_info guard, matching the existing pattern).
- **Queued send-order becomes `ORDER BY priority, id`** — lower priority sent sooner; ties
  break by `id`, so default (all-0) behavior is unchanged FIFO. `priority` is the single
  source of truth for queued order.
- Two call sites change:
  1. `ProfileRepo.byStatus('queued')` ordering used by `planAndAssignToday` → order by
     `(priority, id)`. (Add a dedicated method, e.g. `queuedByPriority()`, rather than
     changing `byStatus` globally, to avoid surprising other callers.)
  2. `orderUpcoming` in `core/forecast.ts` → queued sort key `(priority, id)`.

### Semantics
- **Send next** (row ⤒): set that profile `priority = (min priority among queued) − 1`.
- **Send last** (row ⤓): `priority = (max among queued) + 1`.
- **Prioritize cohort** (header ⤒): all queued profiles in the cohort get
  `priority = (min among queued) − 1`, intra-cohort order preserved by `id`.
- **Reorder cohorts** (drag headers): recompute priorities for all queued profiles by
  walking cohorts in the new order and assigning increasing priority, preserving
  intra-cohort order (e.g. sequential integers).
- **Remove** (✕, soft-remove → status `skipped`, reversible):
  - individual → set that profile `skipped` (reuses existing dismiss semantics),
  - cohort → set all its **queued + scheduled** profiles `skipped`.
- Reorder governs the **queued pool** that feeds future slot assignment. Already-
  **scheduled** profiles keep their committed near-term slot (still removable).

### Repository additions (`repositories.ts`)
- `queuedByPriority()` → queued profiles ordered by `(priority, id)`.
- `minQueuedPriority()` / `maxQueuedPriority()`.
- `setPriority(id, priority)`.
- `prioritizeCohort(cohortId)` — bulk set queued profiles of a cohort.
- `reorderCohorts(orderedCohortIds)` — recompute queued priorities from cohort order.
- `skipProfile(id)` (or reuse `setStatus(id,'skipped')`).
- `skipCohortQueue(cohortId)` — set queued+scheduled profiles of a cohort to `skipped`.

### API (`server.ts`)
- `GET /api/queue/grouped` → `{ cohorts: [{ id, name, count, profiles: [{ id, profile_url,
  status, scheduled_for, note }] }] }`, cohorts in queued-priority order, each with its
  queued+scheduled profiles (scheduled first by time, then queued by priority).
- `POST /api/queue/profile/:id/move` `{ to: 'top' | 'bottom' }`
- `POST /api/queue/profile/:id/remove`
- `POST /api/queue/cohort/:id/move` `{ to: 'top' | 'bottom' }`
- `POST /api/queue/cohort/:id/remove`
- `POST /api/queue/cohorts/reorder` `{ order: number[] }` (cohort ids)
- All validate ids and return 404 on missing.

### UI (Dashboard "Up next")
- The flat "Up next" table becomes **grouped-by-cohort**:
  - **cohort header:** drag handle, name, queued count, ⤒ (prioritize), ✕ (remove cohort),
  - **rows beneath:** slug (link), status pill, scheduled time, ⤒ (send next), ✕ (remove).
- Cohort headers are drag-reorderable (HTML5 draggable); dropping calls
  `/api/queue/cohorts/reorder`.
- The live engine/conveyor above the queue is untouched.
- The 15 s status poll must not clobber an in-progress drag or reset scroll: suppress the
  "Up next" re-render while a drag is active (and re-render on drop / action completion).
- `queueMore` / view-more behavior preserved for large queues.

### Testing (TDD)
- Repo: `queuedByPriority` ordering; `setPriority`; send-next / send-last change ordering;
  `prioritizeCohort` moves a block ahead; `reorderCohorts` yields the requested order;
  `skipCohortQueue` marks queued+scheduled skipped.
- Scheduler: `planAndAssignToday` assigns slots in priority order.
- Forecast: `orderUpcoming` respects `(priority, id)`.
- API: each new `/api/queue/*` endpoint (happy path + 404).

---

## Cross-cutting notes
- No auth (single-user localhost app), consistent with existing endpoints.
- Migration is idempotent and back-compatible; existing DBs gain `priority` defaulting to 0
  (unchanged FIFO behavior until the operator reorders).
- Order of implementation is flexible, but a sensible sequence is:
  logger → merged Cohorts → Docs → one-line menu → queue management (largest).
