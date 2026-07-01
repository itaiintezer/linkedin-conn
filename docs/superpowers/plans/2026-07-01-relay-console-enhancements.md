# Relay Console Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add five operability features to the Relay console — a full debug run-log viewable in Settings, a merged Cohorts+Metrics screen, a live-synced Docs tab backed by `API.md`, a one-line top menu, and grouped delete/reorder queue management.

**Architecture:** Backend is Fastify + `node:sqlite` (repositories pattern) serving a vanilla-JS SPA from `src/web/`. New logic lives in small focused `src/core/` modules (`logger.ts`, `docs.ts`) tested with vitest; queue ordering adds one `priority` column and a handful of repo methods that the scheduler and forecast already-existing call sites consume. Frontend changes are plain edits to `index.html` / `app.js` / `styles.css` verified by running the app.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Fastify 5, `node:sqlite`, vitest 4, tsx. No frontend build step; no DOM test harness (frontend tasks are verified manually via `npm start`).

**Conventions for every task:**
- Run a single test file with `npx vitest run <path>`; run everything with `npm test`; typecheck with `npm run typecheck`.
- Import specifiers use `.js` even for `.ts` files (ESM/NodeNext).
- Commit after each task with the message shown.

---

## Group A — Full run log

### Task A1: Logger core module (format + write + rotate + tail)

**Files:**
- Create: `src/core/logger.ts`
- Test: `tests/core/logger.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/core/logger.test.ts
import { test, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatLine, createLogger } from '../../src/core/logger.js';

test('formatLine renders ISO, level, component, message and quoted data', () => {
  const line = formatLine('2026-07-01T00:00:00.000Z', 'info', 'sender', 'sent', { profile: 123, cohort: 'Security VPs' });
  expect(line).toBe('2026-07-01T00:00:00.000Z INFO sender sent profile=123 cohort="Security VPs"');
});

test('formatLine collapses newlines in values', () => {
  const line = formatLine('2026-07-01T00:00:00.000Z', 'error', 'sender', 'boom', { err: 'a\nb' });
  expect(line).toBe('2026-07-01T00:00:00.000Z ERROR sender boom err="a b"');
});

test('logger writes lines and tail returns the last n', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relaylog-'));
  const path = join(dir, 'relay.log');
  const log = createLogger(path, { maxBytes: 1_000_000, echo: false });
  log.info('t', 'one');
  log.info('t', 'two');
  log.debug('t', 'three');
  const tail = log.tail(2);
  expect(tail).toHaveLength(2);
  expect(tail[0]).toContain('two');
  expect(tail[1]).toContain('three');
});

test('logger rotates to .1 when the file exceeds maxBytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relaylog-'));
  const path = join(dir, 'relay.log');
  const log = createLogger(path, { maxBytes: 80, echo: false });
  log.info('t', 'first message padded out to exceed the tiny threshold aaaaaaaaaa');
  log.info('t', 'second');
  expect(existsSync(path + '.1')).toBe(true);
  expect(readFileSync(path, 'utf8')).toContain('second');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/logger.test.ts`
Expected: FAIL — `createLogger`/`formatLine` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/logger.ts
import { appendFileSync, statSync, renameSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  readonly path: string;
  debug(component: string, message: string, data?: Record<string, unknown>): void;
  info(component: string, message: string, data?: Record<string, unknown>): void;
  warn(component: string, message: string, data?: Record<string, unknown>): void;
  error(component: string, message: string, data?: Record<string, unknown>): void;
  tail(n: number): string[];
}

function fmtVal(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  const clean = String(s).replace(/[\r\n]+/g, ' ');
  return /[\s"]/.test(clean) ? `"${clean.replace(/"/g, "'")}"` : clean;
}

export function formatLine(
  ts: string, level: LogLevel, component: string, message: string, data?: Record<string, unknown>,
): string {
  const parts = [ts, level.toUpperCase(), component, message.replace(/[\r\n]+/g, ' ')];
  if (data) for (const [k, v] of Object.entries(data)) parts.push(`${k}=${fmtVal(v)}`);
  return parts.join(' ');
}

export interface LoggerOptions { maxBytes?: number; echo?: boolean; }

export function createLogger(path: string, opts: LoggerOptions = {}): Logger {
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const echo = opts.echo ?? true;
  mkdirSync(dirname(path), { recursive: true });

  const write = (level: LogLevel, component: string, message: string, data?: Record<string, unknown>): void => {
    const line = formatLine(new Date().toISOString(), level, component, message, data);
    try {
      if (existsSync(path) && statSync(path).size >= maxBytes) renameSync(path, path + '.1');
      appendFileSync(path, line + '\n');
    } catch { /* logging must never throw into the app */ }
    if (echo) (level === 'error' ? console.error : console.log)(line);
  };

  return {
    path,
    debug: (c, m, d) => write('debug', c, m, d),
    info: (c, m, d) => write('info', c, m, d),
    warn: (c, m, d) => write('warn', c, m, d),
    error: (c, m, d) => write('error', c, m, d),
    tail(n: number): string[] {
      if (!existsSync(path)) return [];
      const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.length > 0);
      return lines.slice(-n);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/logger.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/logger.ts tests/core/logger.test.ts
git commit -m "feat(log): add logger core (format, write, rotate, tail)"
```

---

### Task A2: Wire `LOG_PATH` + default singleton

**Files:**
- Modify: `src/config.ts`
- Create: `src/core/log.ts`

- [ ] **Step 1: Add LOG_PATH to config**

Add to `src/config.ts` after the `DB_PATH` line:

```ts
export const LOG_PATH = join(DATA_DIR, 'relay.log');
```

- [ ] **Step 2: Create the shared singleton**

```ts
// src/core/log.ts
import { createLogger } from './logger.js';
import { LOG_PATH } from '../config.js';

/** Process-wide logger. Import this everywhere except tests (which build their own). */
export const log = createLogger(LOG_PATH);
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/config.ts src/core/log.ts
git commit -m "feat(log): shared logger singleton at data/relay.log"
```

---

### Task A3: Log endpoints (`/api/logs`, `/api/logs/download`)

**Files:**
- Modify: `src/api/server.ts`
- Test: `tests/api/server.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/api/server.test.ts`. First extend the top imports and add a helper logger:

```ts
import { createLogger } from '../../src/core/logger.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
```

Then add these tests:

```ts
test('GET /api/logs returns the last N lines', async () => {
  const path = pathJoin(mkdtempSync(pathJoin(tmpdir(), 'srvlog-')), 'relay.log');
  const logger = createLogger(path, { echo: false });
  logger.info('test', 'alpha');
  logger.info('test', 'bravo');
  const a = buildServer(repos, new FakeDriver(), new Mutex(), logger);
  const res = await a.inject({ method: 'GET', url: '/api/logs?tail=1' });
  expect(res.statusCode).toBe(200);
  const body = JSON.parse(res.body);
  expect(body.lines).toHaveLength(1);
  expect(body.lines[0]).toContain('bravo');
});

test('GET /api/logs/download streams the log as an attachment', async () => {
  const path = pathJoin(mkdtempSync(pathJoin(tmpdir(), 'srvlog-')), 'relay.log');
  const logger = createLogger(path, { echo: false });
  logger.info('test', 'downloadable');
  const a = buildServer(repos, new FakeDriver(), new Mutex(), logger);
  const res = await a.inject({ method: 'GET', url: '/api/logs/download' });
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-disposition']).toContain('relay.log');
  expect(res.body).toContain('downloadable');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/api/server.test.ts -t "api/logs"`
Expected: FAIL — `buildServer` takes 3 args / route 404.

- [ ] **Step 3: Implement**

In `src/api/server.ts`, add imports near the top:

```ts
import { readFileSync, existsSync } from 'node:fs';
import type { Logger } from '../core/logger.js';
import { log as defaultLog } from '../core/log.js';
```

Change the signature:

```ts
export function buildServer(
  repos: Repos, driver: BrowserDriver, browserLock: Mutex = new Mutex(), logger: Logger = defaultLog,
): FastifyInstance {
```

Add these routes just before `return app;`:

```ts
  app.get('/api/logs', async (req) => {
    const tailRaw = Number((req.query as { tail?: string }).tail);
    const tail = Number.isFinite(tailRaw) && tailRaw > 0 ? Math.min(Math.floor(tailRaw), 5000) : 500;
    return { lines: logger.tail(tail) };
  });

  app.get('/api/logs/download', async (_req, reply) => {
    const body = existsSync(logger.path) ? readFileSync(logger.path, 'utf8') : '';
    reply.header('Content-Type', 'text/plain; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="relay.log"');
    return body;
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/api/server.test.ts`
Expected: PASS (all, including the two new ones).

- [ ] **Step 5: Commit**

```bash
git add src/api/server.ts tests/api/server.test.ts
git commit -m "feat(log): GET /api/logs and /api/logs/download"
```

---

### Task A4: Wire logging calls through the app

**Files:**
- Modify: `src/index.ts`, `src/worker/scheduler-service.ts`, `src/worker/sender.ts`, `src/worker/guardrail.ts`, `src/worker/acceptance-checker.ts`, `src/api/server.ts`

No new tests (wiring); existing suites must stay green. Add `import { log } from '../core/log.js';` (adjust depth) to each file below and insert the calls.

- [ ] **Step 1: index.ts** — startup/shutdown. Add `import { log } from './core/log.js';` and replace the two console lines:

```ts
  .then(() => {
    log.info('app', 'started', { port: PORT });
    console.log(`LinkedIn Connector running at http://localhost:${PORT}`);
  })
```

and in `shutdown`, as the first line: `log.info('app', 'shutting down');`

- [ ] **Step 2: scheduler-service.ts** — after the assignments loop (end of `planAndAssignToday`), before it returns:

```ts
  log.debug('scheduler', 'assigned slots', { count: assignments.length, slots: times.length, budget });
```

Add `import { log } from '../core/log.js';` at the top.

- [ ] **Step 3: sender.ts** — add `import { log } from '../core/log.js';`. Inside the `for (const p of due)` loop, right after `repos.profiles.setStatus(p.id, 'sending', ...)`:

```ts
    log.debug('sender', 'attempting', { profile: p.id, url: p.profile_url });
```

and after the `switch` resolves, log the outcome by adding this line at the very end of the loop body (before `if (remaining <= 0) break;`):

```ts
    log.info('sender', 'outcome', { profile: p.id, result: outcome.result, error: outcome.error ?? '' });
```

- [ ] **Step 4: guardrail.ts** — add `import { log } from '../core/log.js';`. Add a log line inside each trip helper:

In `tripCheckpoint`: `log.warn('guardrail', 'tripped checkpoint');` before the `repos.appState.trip(...)` call.
In `tripLoginLost`: `log.warn('guardrail', 'tripped login_lost');` before the trip call.
In `recordFailure`, inside the `if (streak >= threshold)` block: `log.warn('guardrail', 'tripped repeated_failures', { detail, streak });` before the trip call.

- [ ] **Step 5: acceptance-checker.ts** — add `import { log } from '../core/log.js';`. After the transitions are applied (`repos.appState.setAcceptanceChecked(iso);`):

```ts
  log.info('acceptance', 'checked', { accepted: accepted.length, expired: expired.length });
```

- [ ] **Step 6: server.ts mutations** — add `log` calls in the handlers:
  - `/api/pause`: `log.info('api', 'pause');`
  - `/api/resume`: `log.info('api', 'resume');`
  - `/api/run-now`: after computing `candidates`: `log.info('api', 'run-now', { promoted: candidates.length });`
  - `/api/retry`: after `targets`: `log.info('api', 'retry', { count: targets.length });`
  - `/api/login`: `log.info('api', 'open login window');`
  - `/api/guardrail/acknowledge`: `log.info('api', 'guardrail acknowledge', { resumed: snap.loggedIn && !checkpoint });` (place after `checkpoint` is computed).

  Use the module `defaultLog` alias already imported (`import { log as defaultLog }`), i.e. call `defaultLog.info(...)`.

- [ ] **Step 7: Run the whole suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add src/index.ts src/worker/scheduler-service.ts src/worker/sender.ts src/worker/guardrail.ts src/worker/acceptance-checker.ts src/api/server.ts
git commit -m "feat(log): emit debug/info events across scheduler, sender, guardrail, acceptance, api"
```

---

### Task A5: Settings "Run log" viewer (frontend)

**Files:**
- Modify: `src/web/index.html`, `src/web/app.js`, `src/web/styles.css`

No automated test (no DOM harness). Verified by running the app.

- [ ] **Step 1: Add the panel markup**

In `index.html`, inside `<section class="panel" id="tab-settings">`, after the closing `</form>` of `#settingsForm` and after `<div class="toast" id="settingsResult" hidden></div>`, add:

```html
      <div class="panel-head sub">
        <div class="panel-title"><h3>Run log</h3><p class="panel-sub">Full debug log for audit &amp; troubleshooting</p></div>
        <div class="panel-actions">
          <input id="logFilter" class="log-filter" type="text" placeholder="filter…" autocomplete="off" />
          <button class="btn" id="logRefresh" type="button">Refresh</button>
          <a class="btn btn-ghost" id="logDownload" href="/api/logs/download" download>Download</a>
        </div>
      </div>
      <pre class="log-view" id="logView" aria-label="Run log">loading…</pre>
```

- [ ] **Step 2: Add the loader + filter in app.js**

Add these functions (near the settings section):

```js
let logLines = [];
async function loadLogs() {
  const view = $('#logView');
  try {
    const { lines } = await api('/api/logs?tail=1000');
    logLines = lines;
    renderLogView();
  } catch (_) { if (view) view.textContent = 'failed to load log'; }
}
function renderLogView() {
  const view = $('#logView');
  if (!view) return;
  const q = ($('#logFilter').value || '').toLowerCase();
  const shown = q ? logLines.filter((l) => l.toLowerCase().includes(q)) : logLines;
  view.textContent = shown.length ? shown.join('\n') : '(no matching lines)';
  view.scrollTop = view.scrollHeight;
}
function initLogViewer() {
  const refresh = $('#logRefresh'), filter = $('#logFilter');
  if (refresh) refresh.addEventListener('click', loadLogs);
  if (filter) filter.addEventListener('input', renderLogView);
}
```

In `loadSettings()`, add `loadLogs();` as the last line of the `try` block so the log loads with the tab. In `init()`, add `initLogViewer();` alongside the other `init*()` calls.

- [ ] **Step 3: Add styles**

Append to `styles.css`:

```css
.log-filter { border:1px solid var(--line); border-radius:8px; padding:7px 10px; font-size:13px; background:var(--panel); }
.log-view {
  margin-top:12px; max-height:420px; overflow:auto; padding:14px 16px;
  background:#0f1512; color:#c7d2cc; border-radius:var(--radius-sm);
  font-family:var(--mono); font-size:12px; line-height:1.6; white-space:pre-wrap; word-break:break-word;
}
```

- [ ] **Step 4: Verify manually**

Run: `npm start`, open http://localhost:4400, go to Settings. Expected: the Run log panel shows recent lines; typing in the filter narrows them; Refresh reloads; Download saves `relay.log`.

- [ ] **Step 5: Commit**

```bash
git add src/web/index.html src/web/app.js src/web/styles.css
git commit -m "feat(log): Run log viewer in Settings (tail, filter, download)"
```

---

## Group B — Merged Cohorts screen

### Task B1: Remove the Metrics tab; move the metrics table into Cohorts

**Files:**
- Modify: `src/web/index.html`

- [ ] **Step 1: Delete the Metrics tab button**

In the `<nav class="tabs">`, remove this line:

```html
    <button class="tab" data-tab="metrics">Metrics</button>
```

- [ ] **Step 2: Delete the standalone Metrics section**

Remove the entire `<!-- METRICS -->` `<section class="panel" id="tab-metrics" hidden> … </section>` block.

- [ ] **Step 3: Rebuild the Cohorts section body**

Replace the current contents of `<section class="panel" id="tab-cohorts">` (keep the section tag and its `panel-head`) so the body becomes:

```html
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr><th>Cohort</th><th class="num">Sent</th><th class="num">Accepted</th><th class="num">Pending</th><th class="num">Expired</th><th>Acceptance rate</th><th class="num">Median days</th></tr>
          </thead>
          <tbody id="metricsBody"></tbody>
        </table>
        <div class="empty" id="metricsEmpty" hidden>No metrics yet — send some requests first.</div>
      </div>

      <div class="section-divider"><span>Manage cohorts</span></div>

      <div id="cohortList" class="cohort-list"></div>
      <div class="empty" id="cohortEmpty" hidden>No cohorts yet.</div>
      <button class="btn btn-ghost" id="cohortNewBtn" type="button">+ New cohort</button>

      <form id="cohortForm" class="form-grid card-form" hidden>
        <h3 id="cohortFormTitle">New cohort</h3>
        <div class="field">
          <label for="cohortName">Name</label>
          <input id="cohortName" type="text" required placeholder="cohort name" autocomplete="off" />
        </div>
        <div class="field">
          <label for="cohortTemplate">Message template <span class="hint">blank = bare request, no note</span></label>
          <textarea id="cohortTemplate" maxlength="300" rows="4" placeholder="Hi {firstName}, …"></textarea>
        </div>
        <div class="field span-all"><button class="btn btn-green" type="submit">Save cohort</button></div>
      </form>
```

- [ ] **Step 4: Commit**

```bash
git add src/web/index.html
git commit -m "feat(cohorts): merge Metrics into the Cohorts tab markup"
```

---

### Task B2: Merged Cohorts render logic (stats on rows, inline edit)

**Files:**
- Modify: `src/web/app.js`, `src/web/styles.css`

- [ ] **Step 1: Replace tab routing for metrics/cohorts**

In `initTabs`, remove the `if (name === 'metrics') loadMetrics();` line and change the cohorts line to `if (name === 'cohorts') loadCohortsScreen();`.

- [ ] **Step 2: Replace `loadCohorts` + `loadMetrics` with a merged loader**

Replace the existing `loadMetrics` and `loadCohorts` functions with:

```js
async function loadCohortsScreen() {
  const [cohorts, metrics] = await Promise.all([
    api('/api/cohorts').catch(() => []),
    api('/api/metrics').catch(() => []),
  ]);
  renderMetricsTable(metrics);
  renderCohortList(cohorts, metrics);
}

function renderMetricsTable(rows) {
  const body = $('#metricsBody'), empty = $('#metricsEmpty');
  if (!rows.length) { body.replaceChildren(); empty.hidden = false; return; }
  empty.hidden = true;
  body.replaceChildren(...rows.map((m) => {
    const pct = Math.round((m.acceptance_rate || 0) * 100);
    const rateCell = el('div', { class: 'rate-cell' },
      el('div', { class: 'rate-bar' }, el('i', { style: `width:${pct}%` })),
      el('span', { class: 'rate-val', text: `${pct}%` }),
    );
    const median = (m.median_time_to_accept_days == null) ? '—' : String(m.median_time_to_accept_days);
    return el('tr', {},
      el('td', { class: 'mono' }, m.cohort_name || '—'),
      el('td', { class: 'num mono' }, String(m.sent)),
      el('td', { class: 'num mono' }, String(m.accepted)),
      el('td', { class: 'num mono' }, String(m.pending)),
      el('td', { class: 'num mono' }, String(m.expired)),
      el('td', {}, rateCell),
      el('td', { class: 'num mono' }, median),
    );
  }));
}

function renderCohortList(cohorts, metrics) {
  const list = $('#cohortList'), empty = $('#cohortEmpty');
  const byName = Object.fromEntries(metrics.map((m) => [m.cohort_name, m]));
  if (!cohorts.length) { list.replaceChildren(); empty.hidden = false; return; }
  empty.hidden = true;
  list.replaceChildren(...cohorts.map((c) => {
    const m = byName[c.name];
    const stat = m
      ? `${m.sent} sent · ${Math.round((m.acceptance_rate || 0) * 100)}% accepted`
      : 'no sends yet';
    const tplText = (c.message_template && c.message_template.trim())
      ? el('div', { class: 'tpl', text: c.message_template })
      : el('div', { class: 'tpl none', text: 'No template (bare request)' });
    return el('div', { class: 'cohort-card', onclick: () => openCohortEditor(c) },
      el('div', { class: 'name' }, el('span', { text: c.name })),
      el('div', { class: 'cohort-stat', text: stat }),
      tplText,
    );
  }));
}

function openCohortEditor(c) {
  const form = $('#cohortForm');
  form.hidden = false;
  $('#cohortFormTitle').textContent = c ? `Edit “${c.name}”` : 'New cohort';
  $('#cohortName').value = c ? (c.name || '') : '';
  $('#cohortName').disabled = !!c; // name is the key; edit templates, not names
  $('#cohortTemplate').value = c ? (c.message_template || '') : '';
  $('#cohortName').focus();
  form.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
```

- [ ] **Step 3: Update `initCohorts`**

Replace `initCohorts` with:

```js
function initCohorts() {
  const newBtn = $('#cohortNewBtn');
  if (newBtn) newBtn.addEventListener('click', () => openCohortEditor(null));
  $('#cohortForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      name: $('#cohortName').value.trim(),
      message_template: $('#cohortTemplate').value.trim() || undefined,
    };
    if (!payload.name) return;
    try {
      await api('/api/cohorts', { method: 'POST', body: payload });
      $('#cohortForm').reset();
      $('#cohortForm').hidden = true;
      $('#cohortName').disabled = false;
      loadCohortsScreen();
    } catch (_) { /* ignore */ }
  });
}
```

Remove the now-unused `fillCohortForm` function.

- [ ] **Step 4: Add styles**

Append to `styles.css`:

```css
.section-divider { display:flex; align-items:center; gap:12px; margin:26px 0 16px; color:var(--ink-3); font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.6px; }
.section-divider::before, .section-divider::after { content:""; height:1px; background:var(--line); flex:1; }
.cohort-stat { font-size:12px; color:var(--ink-3); margin:2px 0 6px; font-family:var(--mono); }
```

- [ ] **Step 5: Verify manually**

Run: `npm start`; open the Cohorts tab. Expected: metrics table on top; below the "Manage cohorts" divider, each cohort card shows a stat line; clicking a card opens the editor prefilled (name locked); "+ New cohort" opens a blank editor; saving refreshes both sections. Confirm the Metrics tab is gone.

- [ ] **Step 6: Commit**

```bash
git add src/web/app.js src/web/styles.css
git commit -m "feat(cohorts): metrics on top + per-cohort stats and inline editor"
```

---

## Group C — Docs tab + API.md

### Task C1: Author `API.md`

**Files:**
- Create: `API.md`

- [ ] **Step 1: Write the doc**

Create `API.md` at the repo root:

```markdown
# Relay API

Local HTTP API for the Relay LinkedIn outreach console. Base URL: `http://localhost:4400`.
All request/response bodies are JSON. No authentication (localhost, single user).

## For agents: the two you need

### POST /api/profiles
Enqueue one profile. Creates the cohort if it does not exist.

Request: `{ "url": "https://www.linkedin.com/in/jane-doe/", "cohort": "Security VPs", "message": "Hi {firstName}, …" }`
- `url` (required) — a LinkedIn profile URL; normalized server-side.
- `cohort` (optional) — cohort name; defaults to today's date.
- `message` (optional) — per-profile note; `{firstName}` is substituted at send time.

Response: `{ "id": 42, "profile_url": "https://www.linkedin.com/in/jane-doe" }`

```
curl -s http://localhost:4400/api/profiles \
  -H 'content-type: application/json' \
  -d '{"url":"https://www.linkedin.com/in/jane-doe/","cohort":"Security VPs"}'
```

### GET /api/status
Queue snapshot + weekly usage + forecast.

Response (abridged): `{ "paused": 0, "weekly_sent": 12, "weekly_cap": 100, "counts": { "queued": 30, "scheduled": 5, "sent": 12, "accepted": 4 }, "loggedIn": true, "forecast": { "queue_remaining": 35, "eta": { "sendingDays": 7, "finishDate": "…" }, "next_batch": { "estimated": true, "at": "…", "count": 5 } } }`

## Bulk & cohorts

### POST /api/lists
Bulk-enqueue from pasted text. Request: `{ "cohort": "Security VPs", "text": "url1\nurl2", "message_template": "Hi {firstName}" }`. Response: `{ "added": 2, "found": 2 }`.

### GET /api/cohorts
List cohorts: `[{ "id", "name", "message_template", "allow_no_note", "created_at" }]`.

### POST /api/cohorts
Create or update by name. Request: `{ "name": "Security VPs", "message_template": "Hi {firstName}" }`.

### GET /api/metrics
Per-cohort acceptance metrics: `[{ "cohort_name", "sent", "accepted", "pending", "expired", "acceptance_rate", "median_time_to_accept_days" }]`.

## Queue

### GET /api/queue?limit=N
Flat upcoming work: `{ "upcoming": [{ "id", "profile_url", "status", "scheduled_for", "cohort_name", "note" }], "total_remaining": N }`.

### GET /api/queue/grouped
Queue grouped by cohort in send-priority order: `{ "cohorts": [{ "id", "name", "count", "profiles": [{ "id", "profile_url", "status", "scheduled_for", "note" }] }] }`.

### Reordering & removal
- `POST /api/queue/profile/:id/move` — body `{ "to": "top" | "bottom" }`.
- `POST /api/queue/profile/:id/remove` — soft-remove (marks skipped).
- `POST /api/queue/cohort/:id/move` — body `{ "to": "top" | "bottom" }`.
- `POST /api/queue/cohort/:id/remove` — soft-remove all queued/scheduled in the cohort.
- `POST /api/queue/cohorts/reorder` — body `{ "order": [cohortId, …] }`.

## Ops

- `POST /api/pause`, `POST /api/resume` — halt/continue sending.
- `POST /api/run-now` — send one batch immediately.
- `GET /api/settings`, `POST /api/settings` — pacing/limits (allow-listed keys only).
- `GET /api/logs?tail=N`, `GET /api/logs/download` — run log.
```

- [ ] **Step 2: Commit**

```bash
git add API.md
git commit -m "docs: add agent-facing API.md"
```

---

### Task C2: Docs module (`listDocs` / `readDoc`)

**Files:**
- Create: `src/core/docs.ts`
- Test: `tests/core/docs.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/core/docs.test.ts
import { test, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listDocs, readDoc } from '../../src/core/docs.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'docs-'));
  writeFileSync(join(dir, 'API.md'), '# Relay API\n\nHello.');
  return dir;
}

test('listDocs returns known docs that exist, with titles from the first heading', () => {
  const docs = listDocs(fixture());
  expect(docs).toContainEqual({ slug: 'api', title: 'Relay API' });
});

test('readDoc returns markdown for a known slug', () => {
  const doc = readDoc('api', fixture());
  expect(doc).not.toBeNull();
  expect(doc.markdown).toContain('Hello.');
  expect(doc.title).toBe('Relay API');
});

test('readDoc returns null for an unknown slug', () => {
  expect(readDoc('nope', fixture())).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/docs.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/core/docs.ts
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../config.js';

const REGISTRY: Record<string, string> = { api: 'API.md' };

function firstHeading(markdown: string): string | null {
  const m = markdown.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

export interface DocMeta { slug: string; title: string; }
export interface Doc extends DocMeta { markdown: string; }

export function listDocs(root: string = ROOT): DocMeta[] {
  return Object.entries(REGISTRY)
    .filter(([, file]) => existsSync(join(root, file)))
    .map(([slug, file]) => ({ slug, title: firstHeading(readFileSync(join(root, file), 'utf8')) ?? slug }));
}

export function readDoc(slug: string, root: string = ROOT): Doc | null {
  const file = REGISTRY[slug];
  if (!file) return null;
  const path = join(root, file);
  if (!existsSync(path)) return null;
  const markdown = readFileSync(path, 'utf8');
  return { slug, title: firstHeading(markdown) ?? slug, markdown };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/docs.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/docs.ts tests/core/docs.test.ts
git commit -m "feat(docs): docs registry module (listDocs/readDoc, live from disk)"
```

---

### Task C3: Docs endpoints

**Files:**
- Modify: `src/api/server.ts`
- Test: `tests/api/server.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/api/server.test.ts`:

```ts
test('GET /api/docs lists the api doc', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/docs' });
  expect(res.statusCode).toBe(200);
  const body = JSON.parse(res.body);
  expect(body.some((d: { slug: string }) => d.slug === 'api')).toBe(true);
});

test('GET /api/docs/api returns markdown', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/docs/api' });
  expect(res.statusCode).toBe(200);
  expect(JSON.parse(res.body).markdown).toContain('# Relay API');
});

test('GET /api/docs/unknown 404s', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/docs/unknown' });
  expect(res.statusCode).toBe(404);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/api/server.test.ts -t "api/docs"`
Expected: FAIL — routes 404 / return HTML.

- [ ] **Step 3: Implement**

In `src/api/server.ts` add `import { listDocs, readDoc } from '../core/docs.js';` and add before `return app;`:

```ts
  app.get('/api/docs', async () => listDocs());
  app.get('/api/docs/:slug', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const doc = readDoc(slug);
    if (!doc) return reply.code(404).send({ error: 'doc not found' });
    return doc;
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/api/server.test.ts`
Expected: PASS. (Relies on `API.md` from Task C1 being present at repo root.)

- [ ] **Step 5: Commit**

```bash
git add src/api/server.ts tests/api/server.test.ts
git commit -m "feat(docs): GET /api/docs and /api/docs/:slug"
```

---

### Task C4: Markdown renderer (frontend, zero-dep)

**Files:**
- Create: `src/web/markdown.js`
- Modify: `src/web/index.html` (load the script)

No automated test (browser module). Verified in the next task.

- [ ] **Step 1: Implement a minimal renderer**

```js
// src/web/markdown.js — tiny, trusted-input markdown -> HTML (our own docs only)
'use strict';
(function () {
  function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function inline(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
      .replace(/\*\*([^*]+)\*\*/g, (_, c) => `<strong>${c}</strong>`)
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, h) => `<a href="${h}" target="_blank" rel="noopener">${t}</a>`);
  }
  function render(md) {
    const lines = String(md).replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let i = 0, inList = null;
    const closeList = () => { if (inList) { out.push(`</${inList}>`); inList = null; } };
    while (i < lines.length) {
      const line = lines[i];
      const fence = line.match(/^```/);
      if (fence) {
        closeList();
        const buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) { buf.push(esc(lines[i])); i++; }
        i++; // skip closing fence
        out.push(`<pre class="md-pre"><code>${buf.join('\n')}</code></pre>`);
        continue;
      }
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) { closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
      const ul = line.match(/^[-*]\s+(.*)$/);
      const ol = line.match(/^\d+\.\s+(.*)$/);
      if (ul || ol) {
        const want = ul ? 'ul' : 'ol';
        if (inList && inList !== want) closeList();
        if (!inList) { inList = want; out.push(`<${want}>`); }
        out.push(`<li>${inline((ul || ol)[1])}</li>`);
        i++; continue;
      }
      if (line.trim() === '') { closeList(); i++; continue; }
      closeList();
      out.push(`<p>${inline(line)}</p>`);
      i++;
    }
    closeList();
    return out.join('\n');
  }
  window.renderMarkdown = render;
})();
```

- [ ] **Step 2: Load it in index.html**

Before `<script src="/app.js"></script>`, add:

```html
  <script src="/markdown.js"></script>
```

- [ ] **Step 3: Commit**

```bash
git add src/web/markdown.js src/web/index.html
git commit -m "feat(docs): tiny zero-dep markdown renderer for the Docs tab"
```

---

### Task C5: Docs tab UI

**Files:**
- Modify: `src/web/index.html`, `src/web/app.js`, `src/web/styles.css`

- [ ] **Step 1: Add the Docs tab button**

In `<nav class="tabs">`, add between `Cohorts` and `Settings`:

```html
    <button class="tab" data-tab="docs">Docs</button>
```

- [ ] **Step 2: Add the Docs section**

Add a new panel in `<main>` (e.g. after the Cohorts section):

```html
    <!-- DOCS -->
    <section class="panel" id="tab-docs" hidden>
      <div class="panel-head">
        <div class="panel-title"><h2>Docs</h2><p class="panel-sub">Reference for operators and AI agents</p></div>
      </div>
      <div class="docs-layout">
        <nav class="docs-nav" id="docsNav"></nav>
        <article class="docs-content markdown" id="docsContent">Select a document.</article>
      </div>
    </section>
```

- [ ] **Step 3: Wire it in app.js**

Add routing in `initTabs`: `if (name === 'docs') loadDocs();`

Add:

```js
let docsLoaded = false;
async function loadDocs() {
  const nav = $('#docsNav');
  try {
    const docs = await api('/api/docs');
    nav.replaceChildren(...docs.map((d, idx) =>
      el('button', {
        class: 'docs-nav-item' + (idx === 0 ? ' is-active' : ''),
        type: 'button', 'data-slug': d.slug,
        onclick: (e) => selectDoc(d.slug, e.currentTarget),
      }, d.title)));
    if (!docsLoaded && docs.length) { await selectDoc(docs[0].slug, nav.firstChild); docsLoaded = true; }
  } catch (_) { $('#docsContent').textContent = 'Failed to load docs.'; }
}
async function selectDoc(slug, btn) {
  $$('.docs-nav-item').forEach((b) => b.classList.toggle('is-active', b === btn));
  try {
    const doc = await api(`/api/docs/${slug}`);
    $('#docsContent').innerHTML = window.renderMarkdown(doc.markdown);
  } catch (_) { $('#docsContent').textContent = 'Failed to load document.'; }
}
```

- [ ] **Step 4: Add styles**

Append to `styles.css`:

```css
.docs-layout { display:grid; grid-template-columns:200px 1fr; gap:22px; align-items:start; }
.docs-nav { display:flex; flex-direction:column; gap:4px; position:sticky; top:90px; }
.docs-nav-item { text-align:left; border:none; background:none; padding:8px 12px; border-radius:8px; font:inherit; font-size:13.5px; font-weight:600; color:var(--ink-3); cursor:pointer; }
.docs-nav-item.is-active { color:var(--brand-ink); background:var(--brand-50); }
.markdown { background:var(--panel); border:1px solid var(--line); border-radius:var(--radius); padding:26px 30px; box-shadow:var(--shadow-sm); line-height:1.65; }
.markdown h1 { font-family:var(--display); font-size:26px; margin:0 0 12px; }
.markdown h2 { font-family:var(--display); font-size:19px; margin:26px 0 8px; }
.markdown h3 { font-size:15px; margin:20px 0 6px; }
.markdown code { font-family:var(--mono); font-size:12.5px; background:var(--panel-2); border:1px solid var(--line); border-radius:5px; padding:1px 5px; }
.markdown pre.md-pre { background:#0f1512; color:#c7d2cc; padding:14px 16px; border-radius:var(--radius-sm); overflow:auto; }
.markdown pre.md-pre code { background:none; border:none; color:inherit; padding:0; }
.markdown a { color:var(--brand-700); }
```

- [ ] **Step 5: Verify manually**

Run: `npm start`; open the Docs tab. Expected: left nav lists "Relay API"; content pane renders the markdown (headings, lists, code blocks, links). Edit `API.md`, click the doc again → the change appears without restart.

- [ ] **Step 6: Commit**

```bash
git add src/web/index.html src/web/app.js src/web/styles.css
git commit -m "feat(docs): Docs tab rendering live API.md"
```

---

## Group D — One-line top menu

### Task D1: Merge brand row and tabs row into one header

**Files:**
- Modify: `src/web/index.html`, `src/web/styles.css`

No automated test. Verified by running the app.

- [ ] **Step 1: Restructure the header markup**

Replace the existing `<header class="topbar"> … </header>` and the separate `<nav class="tabs" id="tabs"> … </nav>` with a single header (note: the tab set includes Docs, and Metrics is gone):

```html
  <header class="topbar">
    <div class="brand">
      <span class="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8">
          <path d="M3 12h4l2 6 4-14 2 8h6" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </span>
      <div class="brand-text"><h1>Relay</h1></div>
    </div>

    <nav class="tabs" id="tabs">
      <button class="tab is-active" data-tab="dashboard">Dashboard</button>
      <button class="tab" data-tab="attention">Attention</button>
      <button class="tab" data-tab="add">Add List</button>
      <button class="tab" data-tab="cohorts">Cohorts</button>
      <button class="tab" data-tab="docs">Docs</button>
      <button class="tab" data-tab="settings">Settings</button>
    </nav>

    <div class="login-status" id="loginStatus" aria-live="polite">
      <span class="led" id="loginLed"></span>
      <span class="login-label" id="loginLabel">checking link…</span>
      <button class="btn btn-ghost" id="connectBtn" hidden>Connect LinkedIn</button>
    </div>
  </header>
```

(Ensure the earlier Task B1/C5 tab edits are reflected here; this block is the final authoritative tab set.)

- [ ] **Step 2: Update styles for the single-row bar**

In `styles.css`, replace the `.topbar` rule and the `.brand-text p` handling, and update `.tabs`:

```css
.topbar {
  display: flex; align-items: center; gap: 20px;
  padding: 12px 28px;
  background: rgba(251, 250, 246, 0.82);
  backdrop-filter: saturate(1.4) blur(10px);
  border-bottom: 1px solid var(--line);
  position: sticky; top: 0; z-index: 50;
}
.brand { display: flex; align-items: center; gap: 11px; flex: none; }
.brand-text p { display: none; }  /* subtitle removed in the one-line bar */
.tabs {
  display: flex; align-items: center; gap: 4px;
  flex: 1 1 auto; min-width: 0; overflow-x: auto; flex-wrap: nowrap;
  scrollbar-width: thin;
}
.login-status { flex: none; }
```

Reduce the brand mark size to match the tighter bar — update `.brand-mark { width: 34px; height: 34px; }` and `.brand-text h1 { font-size: 22px; }`.

If a standalone `.tabs` top-margin/padding rule exists elsewhere (from the old two-row layout), remove it so the nav sits inline.

- [ ] **Step 3: Verify manually**

Run: `npm start`. Expected: a single sticky bar — brand left, six tabs filling the middle, login pill right. Narrow the window: tabs scroll horizontally, never wrapping to a second row. Banners still appear directly below.

- [ ] **Step 4: Commit**

```bash
git add src/web/index.html src/web/styles.css
git commit -m "feat(ui): one-line top menu (brand + tabs + login in a single bar)"
```

---

## Group E — Queue management (grouped delete/reorder)

### Task E1: Add `priority` column + migration + Profile type

**Files:**
- Modify: `src/db/schema.sql`, `src/db/database.ts`, `src/types.ts`
- Test: `tests/db/database.test.ts`

- [ ] **Step 1: Write the failing migration test**

Add to `tests/db/database.test.ts`:

```ts
import { test as mtest, expect as mexpect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../../src/db/database.js';

mtest('runMigrations adds profiles.priority to a pre-existing profiles table', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE profiles (id INTEGER PRIMARY KEY, cohort_id INTEGER, profile_url TEXT, status TEXT DEFAULT 'queued');`);
  runMigrations(db);
  const cols = (db.prepare('PRAGMA table_info(profiles)').all() as { name: string }[]).map((c) => c.name);
  mexpect(cols).toContain('priority');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/db/database.test.ts -t "priority"`
Expected: FAIL — `priority` not present.

- [ ] **Step 3: Implement**

In `src/db/schema.sql`, add to the `profiles` table definition (after `resolved_at TEXT,`):

```sql
  priority INTEGER NOT NULL DEFAULT 0,
```

In `src/db/database.ts`, inside `runMigrations`, add (guarding on table presence like the existing app_state block):

```ts
  const profileCols = (db.prepare('PRAGMA table_info(profiles)').all() as { name: string }[]).map((c) => c.name);
  if (profileCols.length > 0 && !profileCols.includes('priority')) {
    db.exec('ALTER TABLE profiles ADD COLUMN priority INTEGER NOT NULL DEFAULT 0');
  }
```

In `src/types.ts`, add to the `Profile` interface (after `resolved_at`):

```ts
  priority: number;
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/db/database.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.sql src/db/database.ts src/types.ts tests/db/database.test.ts
git commit -m "feat(queue): add profiles.priority column + migration"
```

---

### Task E2: Repository priority + queue-mutation methods

**Files:**
- Modify: `src/db/repositories.ts`
- Test: `tests/db/repositories.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/db/repositories.test.ts`:

```ts
test('queuedByPriority orders by (priority, id)', () => {
  const c = repos.cohorts.create('P', null, true);
  const a = repos.profiles.add(c.id, 'https://www.linkedin.com/in/a', null);
  const b = repos.profiles.add(c.id, 'https://www.linkedin.com/in/b', null);
  repos.profiles.setPriority(b.id, -1);
  const ordered = repos.profiles.queuedByPriority().map((p) => p.id);
  expect(ordered).toEqual([b.id, a.id]);
});

test('moveProfile top/bottom repositions within the queued pool', () => {
  const c = repos.cohorts.create('M', null, true);
  const a = repos.profiles.add(c.id, 'https://www.linkedin.com/in/a', null);
  const b = repos.profiles.add(c.id, 'https://www.linkedin.com/in/b', null);
  const d = repos.profiles.add(c.id, 'https://www.linkedin.com/in/d', null);
  repos.profiles.moveProfile(d.id, 'top');
  repos.profiles.moveProfile(a.id, 'bottom');
  expect(repos.profiles.queuedByPriority().map((p) => p.id)).toEqual([d.id, b.id, a.id]);
});

test('prioritizeCohort moves a cohort block ahead of others', () => {
  const c1 = repos.cohorts.create('C1', null, true);
  const c2 = repos.cohorts.create('C2', null, true);
  const a = repos.profiles.add(c1.id, 'https://www.linkedin.com/in/a', null);
  const b = repos.profiles.add(c2.id, 'https://www.linkedin.com/in/b', null);
  const e = repos.profiles.add(c2.id, 'https://www.linkedin.com/in/e', null);
  repos.profiles.prioritizeCohort(c2.id, 'top');
  const ordered = repos.profiles.queuedByPriority().map((p) => p.id);
  expect(ordered.slice(0, 2).sort()).toEqual([b.id, e.id].sort());
  expect(ordered[2]).toBe(a.id);
});

test('reorderCohorts recomputes queued priorities from the given order', () => {
  const c1 = repos.cohorts.create('C1', null, true);
  const c2 = repos.cohorts.create('C2', null, true);
  const a = repos.profiles.add(c1.id, 'https://www.linkedin.com/in/a', null);
  const b = repos.profiles.add(c2.id, 'https://www.linkedin.com/in/b', null);
  repos.profiles.reorderCohorts([c2.id, c1.id]);
  expect(repos.profiles.queuedByPriority().map((p) => p.id)).toEqual([b.id, a.id]);
});

test('skipCohortQueue marks queued and scheduled profiles skipped', () => {
  const c = repos.cohorts.create('S', null, true);
  const a = repos.profiles.add(c.id, 'https://www.linkedin.com/in/a', null);
  const b = repos.profiles.add(c.id, 'https://www.linkedin.com/in/b', null);
  repos.profiles.setScheduled(b.id, '2099-01-01T00:00:00.000Z');
  repos.profiles.skipCohortQueue(c.id);
  expect(repos.profiles.findById(a.id)!.status).toBe('skipped');
  expect(repos.profiles.findById(b.id)!.status).toBe('skipped');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/db/repositories.test.ts`
Expected: FAIL — methods undefined.

- [ ] **Step 3: Implement**

Add these methods to `ProfileRepo` in `src/db/repositories.ts`:

```ts
  queuedByPriority(): Profile[] {
    return this.db.prepare("SELECT * FROM profiles WHERE status='queued' ORDER BY priority, id").all() as unknown as Profile[];
  }
  setPriority(id: number, priority: number): void {
    this.db.prepare('UPDATE profiles SET priority = ? WHERE id = ?').run(priority, id);
  }
  private queuedBound(kind: 'MIN' | 'MAX'): number {
    const row = this.db.prepare(`SELECT ${kind}(priority) v FROM profiles WHERE status='queued'`).get() as unknown as { v: number | null };
    return row.v ?? 0;
  }
  moveProfile(id: number, to: 'top' | 'bottom'): void {
    const priority = to === 'top' ? this.queuedBound('MIN') - 1 : this.queuedBound('MAX') + 1;
    this.setPriority(id, priority);
  }
  prioritizeCohort(cohortId: number, to: 'top' | 'bottom'): void {
    const priority = to === 'top' ? this.queuedBound('MIN') - 1 : this.queuedBound('MAX') + 1;
    this.db.prepare("UPDATE profiles SET priority = ? WHERE cohort_id = ? AND status = 'queued'").run(priority, cohortId);
  }
  reorderCohorts(orderedCohortIds: number[]): void {
    let p = 0;
    const upd = this.db.prepare('UPDATE profiles SET priority = ? WHERE id = ?');
    for (const cid of orderedCohortIds) {
      const rows = this.db.prepare("SELECT id FROM profiles WHERE status='queued' AND cohort_id = ? ORDER BY id").all(cid) as unknown as { id: number }[];
      for (const r of rows) upd.run(p++, r.id);
    }
  }
  skipCohortQueue(cohortId: number): void {
    this.db.prepare("UPDATE profiles SET status='skipped' WHERE cohort_id = ? AND status IN ('queued','scheduled')").run(cohortId);
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/db/repositories.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/repositories.ts tests/db/repositories.test.ts
git commit -m "feat(queue): repo priority ordering + move/reorder/skip methods"
```

---

### Task E3: Scheduler + forecast consume priority order

**Files:**
- Modify: `src/worker/scheduler-service.ts`, `src/core/forecast.ts`
- Test: `tests/core/forecast.test.ts`, `tests/worker/scheduler-service.test.ts`

- [ ] **Step 1: Write the failing forecast test**

Add to `tests/core/forecast.test.ts` (the file already imports `orderUpcoming` — reuse it):

```ts
test('orderUpcoming sorts queued by (priority, id)', () => {
  const rows = [
    { id: 3, status: 'queued', scheduled_for: null, priority: -1 },
    { id: 1, status: 'queued', scheduled_for: null, priority: 0 },
    { id: 2, status: 'queued', scheduled_for: null, priority: 0 },
  ];
  expect(orderUpcoming(rows).map((r) => r.id)).toEqual([3, 1, 2]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/core/forecast.test.ts -t "priority"`
Expected: FAIL — queued currently sorts by id only (order would be [1,2,3]).

- [ ] **Step 3: Implement forecast change**

In `src/core/forecast.ts`, update the `orderUpcoming` generic constraint and the queued sort:

```ts
export function orderUpcoming<T extends { id: number; status: string; scheduled_for: string | null; priority?: number }>(
  rows: T[],
): T[] {
  const scheduled = rows
    .filter((r) => r.status === 'scheduled')
    .sort((a, b) => (a.scheduled_for ?? '').localeCompare(b.scheduled_for ?? ''));
  const queued = rows
    .filter((r) => r.status === 'queued')
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0) || a.id - b.id);
  return [...scheduled, ...queued];
}
```

- [ ] **Step 4: Implement scheduler change**

In `src/worker/scheduler-service.ts`, change the queued fetch (line ~47) from:

```ts
  const queued = repos.profiles.byStatus('queued').slice(0, budget);
```

to:

```ts
  const queued = repos.profiles.queuedByPriority().slice(0, budget);
```

- [ ] **Step 5: Add a scheduler ordering test**

Add to `tests/worker/scheduler-service.test.ts` (it already imports `planAndAssignToday` and sets up `repos` in `beforeEach`):

```ts
test('planAndAssignToday schedules higher-priority queued profiles first', () => {
  const c = repos.cohorts.create('Prio', null, true);
  const a = repos.profiles.add(c.id, 'https://www.linkedin.com/in/a', null);
  const b = repos.profiles.add(c.id, 'https://www.linkedin.com/in/b', null);
  repos.profiles.setPriority(b.id, -5); // b should be scheduled before a
  repos.settings.update({ weekly_cap: 1, batch_size: 1, batches_per_day: 1 });
  // 2026-07-01 is a Wednesday, mid-window (09:00) so exactly one slot exists.
  planAndAssignToday(repos, new Date('2026-07-01T09:00:00'), () => 0.5);
  expect(repos.profiles.findById(b.id)!.status).toBe('scheduled');
  expect(repos.profiles.findById(a.id)!.status).toBe('queued');
});
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run tests/core/forecast.test.ts tests/worker/scheduler-service.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/core/forecast.ts src/worker/scheduler-service.ts tests/core/forecast.test.ts tests/worker/scheduler-service.test.ts
git commit -m "feat(queue): scheduler + forecast honor profile priority"
```

---

### Task E4: Queue-management API endpoints

**Files:**
- Modify: `src/api/server.ts`
- Test: `tests/api/server.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/api/server.test.ts`:

```ts
test('GET /api/queue/grouped groups queued+scheduled by cohort', async () => {
  const c1 = repos.cohorts.create('G1', null, true);
  const c2 = repos.cohorts.create('G2', null, true);
  repos.profiles.add(c1.id, 'https://www.linkedin.com/in/g1a', null);
  repos.profiles.add(c2.id, 'https://www.linkedin.com/in/g2a', null);
  const res = await app.inject({ method: 'GET', url: '/api/queue/grouped' });
  expect(res.statusCode).toBe(200);
  const body = JSON.parse(res.body);
  const names = body.cohorts.map((c: { name: string }) => c.name).sort();
  expect(names).toEqual(['G1', 'G2']);
  expect(body.cohorts[0].profiles.length).toBeGreaterThan(0);
});

test('POST /api/queue/profile/:id/move top reprioritizes', async () => {
  const c = repos.cohorts.create('Mv', null, true);
  repos.profiles.add(c.id, 'https://www.linkedin.com/in/first', null);
  const b = repos.profiles.add(c.id, 'https://www.linkedin.com/in/second', null);
  const res = await app.inject({ method: 'POST', url: `/api/queue/profile/${b.id}/move`, payload: { to: 'top' } });
  expect(res.statusCode).toBe(200);
  expect(repos.profiles.queuedByPriority()[0].id).toBe(b.id);
});

test('POST /api/queue/profile/:id/remove soft-removes (skipped)', async () => {
  const c = repos.cohorts.create('Rm', null, true);
  const a = repos.profiles.add(c.id, 'https://www.linkedin.com/in/rm', null);
  const res = await app.inject({ method: 'POST', url: `/api/queue/profile/${a.id}/remove` });
  expect(res.statusCode).toBe(200);
  expect(repos.profiles.findById(a.id)!.status).toBe('skipped');
});

test('POST /api/queue/cohort/:id/remove skips the whole cohort queue', async () => {
  const c = repos.cohorts.create('CR', null, true);
  const a = repos.profiles.add(c.id, 'https://www.linkedin.com/in/cr1', null);
  const b = repos.profiles.add(c.id, 'https://www.linkedin.com/in/cr2', null);
  const res = await app.inject({ method: 'POST', url: `/api/queue/cohort/${c.id}/remove` });
  expect(res.statusCode).toBe(200);
  expect(repos.profiles.findById(a.id)!.status).toBe('skipped');
  expect(repos.profiles.findById(b.id)!.status).toBe('skipped');
});

test('POST /api/queue/cohorts/reorder applies the given order', async () => {
  const c1 = repos.cohorts.create('O1', null, true);
  const c2 = repos.cohorts.create('O2', null, true);
  const a = repos.profiles.add(c1.id, 'https://www.linkedin.com/in/o1', null);
  const b = repos.profiles.add(c2.id, 'https://www.linkedin.com/in/o2', null);
  const res = await app.inject({ method: 'POST', url: '/api/queue/cohorts/reorder', payload: { order: [c2.id, c1.id] } });
  expect(res.statusCode).toBe(200);
  expect(repos.profiles.queuedByPriority().map((p) => p.id)).toEqual([b.id, a.id]);
});

test('POST /api/queue/profile/:id/move 404s for unknown id', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/queue/profile/99999/move', payload: { to: 'top' } });
  expect(res.statusCode).toBe(404);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/api/server.test.ts -t "queue/"`
Expected: FAIL — routes not defined.

- [ ] **Step 3: Implement the endpoints**

In `src/api/server.ts`, add before `return app;`:

```ts
  app.get('/api/queue/grouped', async () => {
    const rows = repos.db.prepare(`
      SELECT p.id, p.profile_url, p.status, p.scheduled_for, p.priority, p.cohort_id,
             c.name AS cohort_name,
             COALESCE(NULLIF(p.custom_message, ''), NULLIF(c.message_template, '')) AS note
      FROM profiles p JOIN cohorts c ON c.id = p.cohort_id
      WHERE p.status IN ('queued','scheduled')
    `).all() as unknown as {
      id: number; profile_url: string; status: string; scheduled_for: string | null;
      priority: number; cohort_id: number; cohort_name: string; note: string | null;
    }[];

    const groups = new Map<number, { id: number; name: string; count: number; minPriority: number; profiles: typeof rows }>();
    for (const r of rows) {
      let g = groups.get(r.cohort_id);
      if (!g) { g = { id: r.cohort_id, name: r.cohort_name, count: 0, minPriority: Infinity, profiles: [] }; groups.set(r.cohort_id, g); }
      g.count++;
      if (r.status === 'queued') g.minPriority = Math.min(g.minPriority, r.priority);
      g.profiles.push(r);
    }
    const cohorts = [...groups.values()]
      .sort((a, b) => a.minPriority - b.minPriority || a.id - b.id)
      .map((g) => ({
        id: g.id, name: g.name, count: g.count,
        profiles: orderUpcoming(g.profiles).map((p) => ({
          id: p.id, profile_url: p.profile_url, status: p.status, scheduled_for: p.scheduled_for, note: p.note,
        })),
      }));
    return { cohorts };
  });

  app.post('/api/queue/profile/:id/move', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const { to } = (req.body ?? {}) as { to?: 'top' | 'bottom' };
    if (!repos.profiles.findById(id)) return reply.code(404).send({ error: 'profile not found' });
    repos.profiles.moveProfile(id, to === 'bottom' ? 'bottom' : 'top');
    return { ok: true };
  });

  app.post('/api/queue/profile/:id/remove', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!repos.profiles.findById(id)) return reply.code(404).send({ error: 'profile not found' });
    repos.profiles.setStatus(id, 'skipped', { last_error: null });
    return { ok: true };
  });

  app.post('/api/queue/cohort/:id/move', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const { to } = (req.body ?? {}) as { to?: 'top' | 'bottom' };
    if (!repos.cohorts.findById(id)) return reply.code(404).send({ error: 'cohort not found' });
    repos.profiles.prioritizeCohort(id, to === 'bottom' ? 'bottom' : 'top');
    return { ok: true };
  });

  app.post('/api/queue/cohort/:id/remove', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!repos.cohorts.findById(id)) return reply.code(404).send({ error: 'cohort not found' });
    repos.profiles.skipCohortQueue(id);
    return { ok: true };
  });

  app.post('/api/queue/cohorts/reorder', async (req) => {
    const { order } = (req.body ?? {}) as { order?: number[] };
    repos.profiles.reorderCohorts(Array.isArray(order) ? order.map(Number) : []);
    return { ok: true };
  });
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/api/server.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/api/server.ts tests/api/server.test.ts
git commit -m "feat(queue): /api/queue/grouped + move/remove/reorder endpoints"
```

---

### Task E5: Grouped, editable "Up next" (frontend)

**Files:**
- Modify: `src/web/app.js`, `src/web/styles.css`

No automated test (no DOM harness). Verified by running the app.

- [ ] **Step 1: Replace the queue renderer**

In `src/web/app.js`, replace `refreshQueue` with a grouped renderer + a drag-suppression flag. Add near the top of the dashboard section:

```js
let queueDragging = false;
```

Then:

```js
async function refreshQueue() {
  if (queueDragging) return; // don't clobber an in-progress drag / action
  const body = $('#queueBody'), empty = $('#queueEmpty'), count = $('#queueCount'), more = $('#queueMore');
  // Hide the old flat <table> but keep its wrapper (which also holds #queueEmpty) visible,
  // then render the grouped view as a sibling inside the same wrapper.
  const tbl = body ? body.closest('table') : null;
  try {
    const { cohorts } = await api('/api/queue/grouped');
    const total = cohorts.reduce((n, c) => n + c.count, 0);
    count.textContent = `${total} up for processing`;
    if (more) more.hidden = true; // grouped view shows all cohorts
    if (tbl) tbl.hidden = true;
    let container = $('#queueGroups');
    if (!container && tbl) {
      container = el('div', { id: 'queueGroups', class: 'queue-groups' });
      tbl.parentNode.insertBefore(container, tbl.nextSibling);
    }
    if (!cohorts.length) { if (container) container.replaceChildren(); empty.hidden = false; return; }
    empty.hidden = true;
    if (container) container.replaceChildren(...cohorts.map(renderCohortGroup));
  } catch (_) { /* transient */ }
}

function renderCohortGroup(c) {
  const header = el('div', {
    class: 'qg-head', draggable: 'true', 'data-cohort': String(c.id),
    ondragstart: (e) => { queueDragging = true; e.dataTransfer.setData('text/plain', String(c.id)); e.dataTransfer.effectAllowed = 'move'; },
    ondragend: () => { queueDragging = false; },
    ondragover: (e) => { e.preventDefault(); e.currentTarget.classList.add('drop-hint'); },
    ondragleave: (e) => e.currentTarget.classList.remove('drop-hint'),
    ondrop: (e) => { e.preventDefault(); e.currentTarget.classList.remove('drop-hint'); onCohortDrop(Number(e.dataTransfer.getData('text/plain')), c.id); },
  },
    el('span', { class: 'qg-drag', 'aria-hidden': 'true' }, '⋮⋮'),
    el('span', { class: 'qg-name' }, c.name || '—'),
    el('span', { class: 'qg-count' }, `${c.count} in queue`),
    el('span', { class: 'qg-actions' },
      el('button', { class: 'qg-ico', title: 'Prioritize cohort', onclick: () => queueAction(`/api/queue/cohort/${c.id}/move`, { to: 'top' }) }, '⤒'),
      el('button', { class: 'qg-ico rm', title: 'Remove cohort from queue', onclick: () => queueAction(`/api/queue/cohort/${c.id}/remove`) }, '✕'),
    ),
  );
  const rows = c.profiles.map((p) => el('div', { class: 'qg-row' },
    el('a', { class: 'qg-slug', href: p.profile_url, target: '_blank', rel: 'noopener', text: slugFromUrl(p.profile_url) }),
    el('span', { class: `pill ${p.status}`, text: p.status.replace('_', ' ') }),
    el('span', { class: 'qg-time mono', text: fmtTime(p.scheduled_for) }),
    el('span', { class: 'qg-actions' },
      el('button', { class: 'qg-ico', title: 'Send next', onclick: () => queueAction(`/api/queue/profile/${p.id}/move`, { to: 'top' }) }, '⤒'),
      el('button', { class: 'qg-ico rm', title: 'Remove', onclick: () => queueAction(`/api/queue/profile/${p.id}/remove`) }, '✕'),
    ),
  ));
  return el('div', { class: 'qg' }, header, el('div', { class: 'qg-body' }, ...rows));
}

async function onCohortDrop(draggedId, targetId) {
  if (!draggedId || draggedId === targetId) { queueDragging = false; return; }
  const order = $$('#queueGroups .qg-head').map((h) => Number(h.dataset.cohort));
  const from = order.indexOf(draggedId), to = order.indexOf(targetId);
  if (from === -1 || to === -1) { queueDragging = false; return; }
  order.splice(to, 0, order.splice(from, 1)[0]);
  queueDragging = false;
  await queueAction('/api/queue/cohorts/reorder', { order });
}

async function queueAction(path, body) {
  try {
    await api(path, { method: 'POST', body: body ?? {} });
    await refreshQueue();
    await refreshStatus();
  } catch (_) { /* ignore */ }
}
```

- [ ] **Step 2: Add styles**

Append to `styles.css`:

```css
.queue-groups { display:flex; flex-direction:column; gap:12px; }
.qg { border:1px solid var(--line); border-radius:var(--radius-sm); overflow:hidden; background:var(--panel); }
.qg-head { display:flex; align-items:center; gap:10px; padding:9px 12px; background:var(--panel-2); border-bottom:1px solid var(--line); cursor:grab; }
.qg-head.drop-hint { outline:2px dashed var(--brand); outline-offset:-2px; }
.qg-drag { color:var(--ink-faint); }
.qg-name { font-weight:600; font-size:13.5px; }
.qg-count { color:var(--ink-3); font-size:11.5px; }
.qg-actions { margin-left:auto; display:flex; gap:4px; }
.qg-ico { width:26px; height:26px; display:grid; place-items:center; border:1px solid var(--line); background:var(--panel); border-radius:6px; color:var(--ink-2); cursor:pointer; font-size:13px; }
.qg-ico:hover { background:var(--brand-50); color:var(--brand-ink); }
.qg-ico.rm { color:var(--red); } .qg-ico.rm:hover { background:var(--red-bg); }
.qg-row { display:flex; align-items:center; gap:10px; padding:8px 12px; border-bottom:1px solid var(--line-soft); }
.qg-row:last-child { border-bottom:none; }
.qg-slug { flex:1; font-family:var(--mono); font-size:12.5px; }
.qg-time { color:var(--ink-3); font-size:11.5px; }
```

- [ ] **Step 3: Verify manually**

Run: `npm start`; add a couple of lists in different cohorts; open the Dashboard. Expected: "Up next" shows cohort groups with headers; ⤒ on a row moves it to the front of the queue; ✕ removes a row (it disappears; status becomes skipped); cohort ⤒/✕ act on the whole cohort; dragging a cohort header onto another reorders them; the 15s auto-refresh does not interrupt a drag. Confirm the live engine/conveyor above is unchanged.

- [ ] **Step 4: Commit**

```bash
git add src/web/app.js src/web/styles.css
git commit -m "feat(queue): grouped editable Up-next (row/cohort bump, remove, drag-reorder)"
```

---

## Final verification

- [ ] **Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: all tests pass; no type errors.

- [ ] **Manual smoke of all five features**

Run: `npm start`, open http://localhost:4400:
1. One-line header with six tabs (no Metrics tab).
2. Cohorts tab: metrics on top, per-cohort stats + inline editor below.
3. Docs tab: renders `API.md`; editing the file updates the view on reselect.
4. Settings: Run log panel tails, filters, downloads.
5. Dashboard: grouped queue with row/cohort bump, remove, and drag-reorder.

- [ ] **Update README API section (optional consistency)**

If desired, point the README's "API (localhost)" section at the new Docs tab / `API.md` so the two don't drift. Commit separately.
```
