# On-demand Acceptance Recheck Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a refresh button next to the dashboard's "Accepted" station that reconciles acceptance on demand, running even while paused.

**Architecture:** Reuse the existing `runAcceptanceCheck`. Give it a `force` flag (bypasses only the paused gate) and a structured return value. Expose it through a new `POST /api/recheck-acceptance` endpoint guarded by the shared browser lock, and wire a small icon button in the web UI to call it and refresh the dashboard.

**Tech Stack:** TypeScript (Node ≥22, ESM), Fastify, better-sqlite3 via `Repos`, Vitest, vanilla JS/CSS frontend.

---

## File Structure

- `src/worker/acceptance-checker.ts` — **modify**: add `AcceptanceRunResult` interface, `opts.force`, and return values on every path.
- `tests/worker/acceptance-checker.test.ts` — **modify**: add tests for force/result behavior.
- `src/api/server.ts` — **modify**: import `runAcceptanceCheck`, add `POST /api/recheck-acceptance`.
- `tests/api/server.test.ts` — **modify**: add endpoint tests.
- `src/web/index.html` — **modify**: add `#recheckAccept` button in the Accepted station.
- `src/web/app.js` — **modify**: wire the button in `initDashboard()`.
- `src/web/styles.css` — **modify**: style `.recheck-btn` + `@keyframes spin`.

---

## Task 1: `runAcceptanceCheck` — force flag + structured result

**Files:**
- Modify: `src/worker/acceptance-checker.ts`
- Test: `tests/worker/acceptance-checker.test.ts`

- [ ] **Step 1: Add failing tests**

Append these tests to `tests/worker/acceptance-checker.test.ts`:

```ts
test('force runs the check even while paused and promotes accepted profiles', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  const a = seedSent('https://www.linkedin.com/in/a', c.id);
  repos.settings.update({ paused: 1 });
  driver.connections = ['https://www.linkedin.com/in/a'];
  const res = await runAcceptanceCheck(repos, driver, new Date('2026-06-29T12:00:00Z'), { force: true });
  expect(res).toEqual({ ran: true, accepted: 1, expired: 0, checkedAt: '2026-06-29T12:00:00.000Z' });
  expect(repos.profiles.findById(a.id)!.status).toBe('accepted');
});

test('without force, a paused engine returns reason "paused" and changes nothing', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  seedSent('https://www.linkedin.com/in/a', c.id);
  repos.settings.update({ paused: 1 });
  driver.connections = ['https://www.linkedin.com/in/a'];
  const res = await runAcceptanceCheck(repos, driver, new Date('2026-06-29T12:00:00Z'));
  expect(res).toEqual({ ran: false, reason: 'paused', accepted: 0, expired: 0 });
  expect(repos.profiles.byStatus('accepted')).toHaveLength(0);
});

test('reports reason "no_pending" when there is nothing to verify', async () => {
  const res = await runAcceptanceCheck(repos, driver, new Date('2026-06-29T12:00:00Z'));
  expect(res).toEqual({ ran: false, reason: 'no_pending', accepted: 0, expired: 0 });
});

test('reports reason "empty_read" on a suspiciously empty connections read', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  seedSent('https://www.linkedin.com/in/a', c.id);
  driver.connections = [];
  const res = await runAcceptanceCheck(repos, driver, new Date('2026-06-29T12:00:00Z'), { force: true });
  expect(res).toEqual({ ran: false, reason: 'empty_read', accepted: 0, expired: 0 });
});

test('reports reason "guardrail" when the guardrail is tripped, even with force', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  seedSent('https://www.linkedin.com/in/a', c.id);
  repos.appState.trip('checkpoint', 'x', '2026-06-29T00:00:00.000Z');
  driver.connections = ['https://www.linkedin.com/in/a'];
  const res = await runAcceptanceCheck(repos, driver, new Date('2026-06-29T12:00:00Z'), { force: true });
  expect(res).toEqual({ ran: false, reason: 'guardrail', accepted: 0, expired: 0 });
  expect(repos.profiles.byStatus('accepted')).toHaveLength(0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/worker/acceptance-checker.test.ts`
Expected: FAIL — the new tests error because `runAcceptanceCheck` currently returns `undefined` (e.g. `expected undefined to deeply equal { ran: true, ... }`).

- [ ] **Step 3: Rewrite `acceptance-checker.ts` with the flag and return values**

Replace the entire contents of `src/worker/acceptance-checker.ts` with:

```ts
import type { Repos } from '../db/repositories.js';
import type { BrowserDriver } from '../types.js';
import { computeAccepted, computeExpiredByAge } from '../core/acceptance.js';
import { isTripped, tripLoginLost, recordReadError, recordSuccess } from './guardrail.js';
import { log } from '../core/log.js';

/**
 * Outcome of a single acceptance pass. `ran` is true only when we actually read the
 * connections list and applied verdicts; every early return sets `ran: false` with a
 * `reason` so callers (e.g. the manual recheck endpoint) can report what happened.
 */
export interface AcceptanceRunResult {
  ran: boolean;
  reason?: 'paused' | 'guardrail' | 'no_pending' | 'logged_out' | 'login_lost' | 'read_error' | 'empty_read';
  accepted: number;
  expired: number;
  checkedAt?: string;
}

export async function runAcceptanceCheck(
  repos: Repos,
  driver: BrowserDriver,
  now: Date,
  opts: { force?: boolean } = {},
): Promise<AcceptanceRunResult> {
  // `force` (manual on-demand recheck) bypasses ONLY the paused gate — acceptance is
  // read-only against LinkedIn. Every other safety gate below is unconditional.
  if (!opts.force && repos.settings.get().paused) return { ran: false, reason: 'paused', accepted: 0, expired: 0 };
  if (isTripped(repos)) return { ran: false, reason: 'guardrail', accepted: 0, expired: 0 };

  // Nothing to verify -> stay dark (DB only, no browser).
  const sent = repos.profiles.byStatus('sent').map((p) => ({ id: p.id, profile_url: p.profile_url, sent_at: p.sent_at }));
  if (sent.length === 0) return { ran: false, reason: 'no_pending', accepted: 0, expired: 0 };

  if (repos.appState.get().login_logged_in !== 1) return { ran: false, reason: 'logged_out', accepted: 0, expired: 0 };

  // Committing to act: confirm login live (opens the browser) and refresh the cache.
  const snap = await driver.readLoginState();
  repos.appState.setLogin(snap, now.toISOString());
  if (!snap.loggedIn) { tripLoginLost(repos, now); return { ran: false, reason: 'login_lost', accepted: 0, expired: 0 }; }

  // We only READ the connections list — a new acceptance surfaces at the top of
  // "recently added", so the top slice is the right place to look. We intentionally
  // do NOT read the sent-invitations list to infer expiry: it is huge and only its
  // newest page loads, so absence there is not evidence an invite is gone
  // (see core/acceptance.ts).
  let connections: Set<string>;
  try {
    connections = new Set(await driver.readRecentConnections());
  } catch (e) {
    // Checkpoint text trips immediately; other read failures count toward the streak.
    recordReadError(repos, (e as Error).message ?? 'acceptance read failed', now);
    return { ran: false, reason: 'read_error', accepted: 0, expired: 0 };
  }

  // Fail-safe: a suspiciously empty read (page didn't render, UI changed, rate-limited)
  // must never drive state changes. Skip the run rather than mark anything.
  if (connections.size === 0) {
    log.warn('acceptance', 'connections read returned nothing — skipping (no state change)');
    return { ran: false, reason: 'empty_read', accepted: 0, expired: 0 };
  }

  const iso = now.toISOString();
  const urlById = new Map(sent.map((r) => [r.id, r.profile_url]));
  const accepted = computeAccepted(sent, connections);
  for (const id of accepted) {
    repos.profiles.setStatus(id, 'accepted', { accepted_at: iso, resolved_at: iso });
    repos.events.recordEvent(id, 'accepted');
    log.info('acceptance', 'verdict', { profile: id, url: urlById.get(id) ?? '', verdict: 'accepted' });
  }

  // Deterministic, scrape-free expiry backstop (disabled by default via expiry_days=0),
  // excluding anyone we just accepted.
  const acceptedSet = new Set(accepted);
  const stillPending = sent.filter((r) => !acceptedSet.has(r.id));
  const expired = computeExpiredByAge(stillPending, now, repos.settings.get().expiry_days);
  for (const id of expired) {
    repos.profiles.setStatus(id, 'expired', { resolved_at: iso });
    repos.events.recordEvent(id, 'expired');
    log.info('acceptance', 'verdict', { profile: id, url: urlById.get(id) ?? '', verdict: 'expired (age backstop)' });
  }

  repos.appState.setAcceptanceChecked(iso);
  recordSuccess(repos); // a clean read clears any accumulated streak
  log.info('acceptance', 'checked', { accepted: accepted.length, expired: expired.length, connections: connections.size });
  return { ran: true, accepted: accepted.length, expired: expired.length, checkedAt: iso };
}
```

- [ ] **Step 4: Run the whole acceptance-checker suite**

Run: `npm test -- tests/worker/acceptance-checker.test.ts`
Expected: PASS — new tests pass and all pre-existing tests (paused-skip, empty-read, guardrail, login-lost, checked_at stamping) still pass. The orchestrator ignores the return value, so no other file needs changing yet.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS — no type errors (the new return type is a superset; existing `void`-ignoring callers still compile).

- [ ] **Step 6: Commit**

```bash
git add src/worker/acceptance-checker.ts tests/worker/acceptance-checker.test.ts
git commit -m "feat: force flag + structured result for runAcceptanceCheck"
```

---

## Task 2: `POST /api/recheck-acceptance` endpoint

**Files:**
- Modify: `src/api/server.ts`
- Test: `tests/api/server.test.ts`

- [ ] **Step 1: Add failing endpoint tests**

Append to `tests/api/server.test.ts` (the harness already provides `app`, `repos`, and logs in via `beforeEach`):

The `beforeEach` harness builds `app` with a fresh `FakeDriver` whose `connections` default to `[]` — so a sent profile yields an `empty_read`. To test an actual promotion, build a local server with a driver whose connections we control.

```ts
test('POST /api/recheck-acceptance reports "no_pending" when nothing is sent', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/recheck-acceptance' });
  expect(res.statusCode).toBe(200);
  expect(JSON.parse(res.body)).toEqual({ ran: false, reason: 'no_pending', accepted: 0, expired: 0 });
});

test('POST /api/recheck-acceptance returns "empty_read" while paused when connections read is empty', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  const p = repos.profiles.add(c.id, 'https://www.linkedin.com/in/pending', null);
  repos.profiles.setStatus(p.id, 'sent', { sent_at: '2026-06-20T00:00:00Z' });
  repos.settings.update({ paused: 1 });
  const res = await app.inject({ method: 'POST', url: '/api/recheck-acceptance' });
  expect(res.statusCode).toBe(200);
  expect(JSON.parse(res.body)).toEqual({ ran: false, reason: 'empty_read', accepted: 0, expired: 0 });
});

test('POST /api/recheck-acceptance promotes a profile that now appears in connections, even paused', async () => {
  const driver = new FakeDriver();
  driver.connections = ['https://www.linkedin.com/in/accepted-now'];
  const localApp = buildServer(repos, driver);
  repos.appState.setLogin({ loggedIn: true, cookieExpiry: null }, '2026-06-29T00:00:00.000Z');
  const c = repos.cohorts.create('A', 'hi', true);
  const p = repos.profiles.add(c.id, 'https://www.linkedin.com/in/accepted-now', null);
  repos.profiles.setStatus(p.id, 'sent', { sent_at: '2026-06-20T00:00:00Z' });
  repos.settings.update({ paused: 1 });

  const res = await localApp.inject({ method: 'POST', url: '/api/recheck-acceptance' });
  expect(res.statusCode).toBe(200);
  const body = JSON.parse(res.body);
  expect(body.ran).toBe(true);
  expect(body.accepted).toBe(1);
  expect(repos.profiles.findById(p.id)!.status).toBe('accepted');
});
```

(`buildServer` and `FakeDriver` are already imported at the top of `tests/api/server.test.ts`.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/api/server.test.ts`
Expected: FAIL — `POST /api/recheck-acceptance` returns 404 (route not registered), so `res.statusCode` is 404, not 200.

- [ ] **Step 3: Import `runAcceptanceCheck` in the server**

In `src/api/server.ts`, add this import next to the other worker imports (below the existing `import { runSenderOnce } from '../worker/sender.js';` on line 16):

```ts
import { runAcceptanceCheck } from '../worker/acceptance-checker.js';
```

- [ ] **Step 4: Register the endpoint**

In `src/api/server.ts`, immediately after the `/api/run-now` handler block (which ends with its closing `});` around line 220), insert:

```ts
  // Manual, on-demand acceptance reconciliation. Read-only against LinkedIn, so it runs
  // even while paused (force: true) — but still respects the guardrail, login, and
  // empty-read fail-safes inside runAcceptanceCheck. Uses run (not tryRun) so it queues
  // behind any in-flight sender/acceptance batch rather than being silently dropped.
  app.post('/api/recheck-acceptance', async () => {
    defaultLog.info('api', 'recheck-acceptance');
    return browserLock.run(() => runAcceptanceCheck(repos, driver, new Date(), { force: true }));
  });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- tests/api/server.test.ts`
Expected: PASS — all three new tests pass and existing server tests are unaffected.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/api/server.ts tests/api/server.test.ts
git commit -m "feat: POST /api/recheck-acceptance endpoint"
```

---

## Task 3: Frontend — recheck button markup

**Files:**
- Modify: `src/web/index.html`

- [ ] **Step 1: Add the button to the Accepted station**

In `src/web/index.html`, replace the Accepted station block (currently lines 171-174):

```html
          <div class="station accepted is-drill" data-drill="accepted" data-drill-title="Accepted" role="button" tabindex="0" title="View accepted profiles">
            <div class="puck"><span class="n" id="stAccepted">0</span></div>
            <span class="nm">Accepted<small id="acceptedFoot">checked never</small></span>
          </div>
```

with:

```html
          <div class="station accepted is-drill" data-drill="accepted" data-drill-title="Accepted" role="button" tabindex="0" title="View accepted profiles">
            <div class="puck"><span class="n" id="stAccepted">0</span></div>
            <span class="nm">Accepted<small id="acceptedFoot">checked never</small>
              <button class="recheck-btn" id="recheckAccept" type="button" title="Recheck acceptance now" aria-label="Recheck acceptance now">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </button>
            </span>
          </div>
```

- [ ] **Step 2: Commit**

```bash
git add src/web/index.html
git commit -m "feat: recheck button markup in Accepted station"
```

---

## Task 4: Frontend — button styling

**Files:**
- Modify: `src/web/styles.css`

- [ ] **Step 1: Add `.recheck-btn` styles and the spin keyframe**

In `src/web/styles.css`, immediately after the `.station .nm small { ... }` rule (line 292), insert:

```css
.recheck-btn { display: inline-grid; place-items: center; margin-top: 6px; width: 22px; height: 22px;
  padding: 0; border-radius: 7px; border: 1px solid var(--line); background: var(--panel);
  color: var(--ink-3); cursor: pointer; transition: color .15s ease, border-color .15s ease, background .15s ease; }
.recheck-btn svg { width: 12px; height: 12px; }
.recheck-btn:hover { color: var(--brand-700); border-color: var(--brand-100); background: var(--brand-50); }
.recheck-btn:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
.recheck-btn:disabled { cursor: default; opacity: 0.7; }
.recheck-btn.busy svg { animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
```

- [ ] **Step 2: Commit**

```bash
git add src/web/styles.css
git commit -m "feat: style the acceptance recheck button"
```

---

## Task 5: Frontend — wire the button

**Files:**
- Modify: `src/web/app.js`

- [ ] **Step 1: Add the click handler in `initDashboard()`**

In `src/web/app.js`, inside `initDashboard()` (starts line 574), add the following handler immediately after the `#pauseToggle` handler block (which ends with `});` around line 590):

```js
  const recheck = $('#recheckAccept');
  if (recheck) {
    // The Accepted station is a drill target; keep button clicks/keys from opening the drawer.
    const swallow = (e) => e.stopPropagation();
    recheck.addEventListener('keydown', swallow);
    recheck.addEventListener('click', async (e) => {
      e.stopPropagation();
      recheck.disabled = true;
      recheck.classList.add('busy');
      const original = recheck.title;
      try {
        const res = await api('/api/recheck-acceptance', { method: 'POST' });
        const label = res && res.ran
          ? (res.accepted > 0 ? `Found ${res.accepted}` : 'No new acceptances')
          : ({ paused: 'Paused', guardrail: 'Blocked — check attention', no_pending: 'No pending invites',
               logged_out: 'Logged out', login_lost: 'Logged out', read_error: 'Read failed',
               empty_read: 'No new acceptances' }[res && res.reason] || 'Done');
        recheck.title = label;
        await refreshStatus();
      } catch (_) {
        recheck.title = 'Failed';
      }
      recheck.classList.remove('busy');
      setTimeout(() => { recheck.title = original; recheck.disabled = false; }, 2500);
    });
  }
```

- [ ] **Step 2: Verify the app boots and the flow works end-to-end**

Run the app and exercise the button against the real dashboard:

Run: `npm start` (then open the dashboard URL printed in the console).

Verify manually:
1. The Accepted station shows a small refresh icon next to `checked …`.
2. Clicking the icon does NOT open the Accepted drawer (the station's drill).
3. The icon spins while the request is in flight, then the tooltip briefly shows the outcome (`No pending invites` on an empty DB, or `Found N` / `No new acceptances` with pending invites), and the `checked <time>` footnote updates when a real read ran.

Stop the app when done (Ctrl-C). Note per project memory: shut down gracefully so the cloak browser profile isn't orphaned.

- [ ] **Step 3: Full test + typecheck sweep**

Run: `npm test`
Expected: PASS — whole suite green.

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/web/app.js
git commit -m "feat: wire the acceptance recheck button"
```

---

## Self-Review Notes

- **Spec coverage:** force flag + result object (Task 1), run-even-when-paused endpoint under the browser lock with `run` not `tryRun` (Task 2), small refresh icon next to the footnote with stopPropagation + spin + transient feedback (Tasks 3-5), and the specified unit/endpoint tests (Tasks 1-2). All spec sections map to a task.
- **Reasons:** the `reason` strings in `app.js` (Task 5) exactly match the `AcceptanceRunResult['reason']` union in Task 1 (`paused`, `guardrail`, `no_pending`, `logged_out`, `login_lost`, `read_error`, `empty_read`).
- **Naming:** the endpoint path `/api/recheck-acceptance`, the button id `#recheckAccept`, and the CSS class `.recheck-btn` are used consistently across Tasks 2-5.
