# Browser Lifecycle, Persisted Login & Guardrails — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the browser open only when work is actually due (never auto-close), drive the dashboard login indicator from a DB cache so it's correct before the browser opens, and add a guardrail that halts everything with a loud dashboard alert when LinkedIn looks uncooperative.

**Architecture:** A new single-row `app_state` table holds the cached login flag, a persisted consecutive-failure counter, and a distinct guardrail "tripped" state (separate from the user's manual `paused`). Workers compute due work from the DB before touching the browser, gate on the cached login flag, then confirm login live (which lazily opens the browser). A small pure `guardrail` module decides when to trip. The browser driver gains a cookie-snapshot read and a no-side-effect "is it open" check; the orchestrator refreshes the login cache every 10s only while the browser is already open.

**Tech Stack:** TypeScript (ESM, NodeNext), `node:sqlite` (DatabaseSync), Fastify, Playwright-core via cloakbrowser, Vitest. Tests run with `npm test` (`vitest run`). Type checking with `npm run typecheck`.

Spec: `docs/superpowers/specs/2026-06-30-browser-lifecycle-persisted-login-guardrails-design.md`

---

## File Structure

**Create:**
- `tests/worker/guardrail.test.ts` — unit tests for the pure guardrail module
- `src/worker/guardrail.ts` — trip decisions + failure-streak logic (operates on `Repos`)
- `tests/db/app-state.test.ts` — `AppStateRepo` round-trip tests

**Modify:**
- `src/db/schema.sql` — add `app_state` table (+ seed row); add `failure_threshold` column to `settings`
- `src/db/database.ts` — `runMigrations`: add `failure_threshold` to legacy settings tables
- `src/types.ts` — add `LoginSnapshot`, `GuardrailReason`, `AppState`; extend `BrowserDriver`; add `failure_threshold` to `Settings`
- `src/db/repositories.ts` — add `AppStateRepo`, wire into `Repos`; allow `failure_threshold` in settings updates
- `src/browser/driver.ts` — extend `FakeDriver` with the new driver methods
- `src/browser/linkedin-driver.ts` — implement `browserOpen`, `readLoginState`, `checkpointPresent`; checkpoint detection in read methods
- `src/worker/sender.ts` — reordered gating + guardrail routing
- `src/worker/acceptance-checker.ts` — reordered gating + guardrail routing
- `src/worker/orchestrator.ts` — login-cache refresher + tripped gating
- `src/api/server.ts` — login-status from cache; extend `/api/status`; add `/api/guardrail/acknowledge`
- `src/web/index.html` — guardrail alert banner markup
- `src/web/app.js` — render guardrail banner, login "as of", re-check button
- `src/web/styles.css` — guardrail banner styles
- `tests/worker/sender.test.ts` — seed login cache; update checkpoint test; add guardrail tests
- `tests/worker/acceptance-checker.test.ts` — seed login cache; add guardrail tests
- `tests/api/server.test.ts` — seed login cache for run-now; add login-status + acknowledge tests
- `tests/e2e/full-pipeline.test.ts` — seed login cache so sends proceed

---

## Task 1: `app_state` table, `failure_threshold` setting, and migration

**Files:**
- Modify: `src/db/schema.sql`
- Modify: `src/db/database.ts:22-29`
- Modify: `src/types.ts:33-49`
- Test: `tests/db/database.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/db/database.test.ts`:

```typescript
test('fresh db creates app_state with a seeded single row', () => {
  const db = openDatabase(':memory:');
  const row = db.prepare('SELECT * FROM app_state WHERE id = 1').get() as any;
  expect(row).toBeDefined();
  expect(row.login_logged_in).toBe(0);
  expect(row.guardrail_tripped).toBe(0);
  expect(row.failure_streak).toBe(0);
  expect(row.login_cookie_expiry).toBeNull();
});

test('fresh db seeds settings.failure_threshold = 3', () => {
  const db = openDatabase(':memory:');
  const s = db.prepare('SELECT failure_threshold FROM settings WHERE id = 1').get() as any;
  expect(s.failure_threshold).toBe(3);
});

test('runMigrations adds failure_threshold to a legacy settings table', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), account_type TEXT NOT NULL DEFAULT 'unknown');`);
  db.exec(`INSERT INTO settings (id) VALUES (1);`);
  runMigrations(db);
  const cols = (db.prepare('PRAGMA table_info(settings)').all() as any[]).map((c) => c.name);
  expect(cols).toContain('failure_threshold');
  expect((db.prepare('SELECT failure_threshold FROM settings WHERE id = 1').get() as any).failure_threshold).toBe(3);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/db/database.test.ts`
Expected: FAIL — `no such table: app_state` / `no such column: failure_threshold`.

- [ ] **Step 3: Add the table and column to `src/db/schema.sql`**

Add `failure_threshold` to the `settings` table — change the `onboarded` line (currently the last column, line 58) to include it:

```sql
  onboarded INTEGER NOT NULL DEFAULT 0,
  failure_threshold INTEGER NOT NULL DEFAULT 3
);
```

Then, immediately after the `INSERT OR IGNORE INTO settings (id) VALUES (1);` line (currently line 61), append:

```sql

CREATE TABLE IF NOT EXISTS app_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  login_logged_in INTEGER NOT NULL DEFAULT 0,
  login_cookie_expiry TEXT,
  login_confirmed_at TEXT,
  guardrail_tripped INTEGER NOT NULL DEFAULT 0,
  guardrail_reason TEXT,
  guardrail_detail TEXT,
  guardrail_tripped_at TEXT,
  failure_streak INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO app_state (id) VALUES (1);
```

(`schema.sql` is exec'd on every `openDatabase`, so `CREATE TABLE IF NOT EXISTS app_state` also back-fills existing databases — no migration needed for the new table. Only the new `settings` column needs a migration.)

- [ ] **Step 4: Add the column migration in `src/db/database.ts`**

Replace the body of `runMigrations` (lines 22-29) with:

```typescript
export function runMigrations(db: DB): void {
  const cols = (db.prepare('PRAGMA table_info(settings)').all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('onboarded')) {
    db.exec('ALTER TABLE settings ADD COLUMN onboarded INTEGER NOT NULL DEFAULT 0');
    // Don't show the wizard to users who already configured an account type.
    db.exec("UPDATE settings SET onboarded = 1 WHERE account_type != 'unknown'");
  }
  if (!cols.includes('failure_threshold')) {
    db.exec('ALTER TABLE settings ADD COLUMN failure_threshold INTEGER NOT NULL DEFAULT 3');
  }
}
```

- [ ] **Step 5: Add types in `src/types.ts`**

Add `failure_threshold: number;` to the `Settings` interface (after `onboarded: number;`, line 48):

```typescript
  onboarded: number;
  failure_threshold: number;
}
```

Then append these new types at the end of the file:

```typescript
export type GuardrailReason = 'checkpoint' | 'login_lost' | 'repeated_failures';

export interface AppState {
  id: 1;
  login_logged_in: number;        // 0 | 1
  login_cookie_expiry: string | null;  // ISO
  login_confirmed_at: string | null;   // ISO
  guardrail_tripped: number;      // 0 | 1
  guardrail_reason: GuardrailReason | null;
  guardrail_detail: string | null;
  guardrail_tripped_at: string | null; // ISO
  failure_streak: number;
}

/** A point-in-time read of LinkedIn auth from the browser's li_at cookie. */
export interface LoginSnapshot {
  loggedIn: boolean;
  cookieExpiry: string | null;    // ISO, or null for a session cookie / unknown
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- tests/db/database.test.ts`
Expected: PASS (all tests including the 3 new ones).

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.sql src/db/database.ts src/types.ts tests/db/database.test.ts
git commit -m "feat(db): add app_state table, failure_threshold setting, and migration"
```

---

## Task 2: `AppStateRepo`

**Files:**
- Modify: `src/db/repositories.ts`
- Test: `tests/db/app-state.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/db/app-state.test.ts`:

```typescript
import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';

let repos: Repos;
beforeEach(() => { repos = new Repos(openDatabase(':memory:')); });

test('defaults: logged out, not tripped, zero streak', () => {
  const s = repos.appState.get();
  expect(s.login_logged_in).toBe(0);
  expect(s.guardrail_tripped).toBe(0);
  expect(s.failure_streak).toBe(0);
});

test('setLogin writes flag, expiry and confirmed-at', () => {
  repos.appState.setLogin({ loggedIn: true, cookieExpiry: '2027-01-01T00:00:00.000Z' }, '2026-06-30T10:00:00.000Z');
  const s = repos.appState.get();
  expect(s.login_logged_in).toBe(1);
  expect(s.login_cookie_expiry).toBe('2027-01-01T00:00:00.000Z');
  expect(s.login_confirmed_at).toBe('2026-06-30T10:00:00.000Z');
});

test('trip then clearGuardrail round-trips', () => {
  repos.appState.trip('checkpoint', 'captcha', '2026-06-30T10:00:00.000Z');
  let s = repos.appState.get();
  expect(s.guardrail_tripped).toBe(1);
  expect(s.guardrail_reason).toBe('checkpoint');
  expect(s.guardrail_detail).toBe('captcha');
  expect(s.guardrail_tripped_at).toBe('2026-06-30T10:00:00.000Z');
  repos.appState.clearGuardrail();
  s = repos.appState.get();
  expect(s.guardrail_tripped).toBe(0);
  expect(s.guardrail_reason).toBeNull();
  expect(s.guardrail_detail).toBeNull();
  expect(s.guardrail_tripped_at).toBeNull();
});

test('incFailureStreak returns the new value; reset zeroes it', () => {
  expect(repos.appState.incFailureStreak()).toBe(1);
  expect(repos.appState.incFailureStreak()).toBe(2);
  expect(repos.appState.get().failure_streak).toBe(2);
  repos.appState.resetFailureStreak();
  expect(repos.appState.get().failure_streak).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/db/app-state.test.ts`
Expected: FAIL — `repos.appState is undefined`.

- [ ] **Step 3: Implement `AppStateRepo` and wire it into `Repos`**

In `src/db/repositories.ts`, update the type import on line 2 to include `AppState` and `GuardrailReason`:

```typescript
import type { Cohort, Profile, Settings, ProfileStatus, EventType, AppState, GuardrailReason } from '../types.js';
```

Add `failure_threshold` to the `SETTINGS_COLUMNS` set (so settings updates can write it) — change the set's last line:

```typescript
  'onboarded', 'failure_threshold',
]);
```

Add the new repo class (place it after `SettingsRepo`, before `class Repos`):

```typescript
export class AppStateRepo {
  constructor(private db: DB) {}

  get(): AppState {
    return this.db.prepare('SELECT * FROM app_state WHERE id = 1').get() as unknown as AppState;
  }

  setLogin(snap: { loggedIn: boolean; cookieExpiry: string | null }, confirmedAtIso: string): void {
    this.db.prepare(
      'UPDATE app_state SET login_logged_in = ?, login_cookie_expiry = ?, login_confirmed_at = ? WHERE id = 1',
    ).run(snap.loggedIn ? 1 : 0, snap.cookieExpiry, confirmedAtIso);
  }

  trip(reason: GuardrailReason, detail: string, atIso: string): void {
    this.db.prepare(
      'UPDATE app_state SET guardrail_tripped = 1, guardrail_reason = ?, guardrail_detail = ?, guardrail_tripped_at = ? WHERE id = 1',
    ).run(reason, detail, atIso);
  }

  clearGuardrail(): void {
    this.db.prepare(
      'UPDATE app_state SET guardrail_tripped = 0, guardrail_reason = NULL, guardrail_detail = NULL, guardrail_tripped_at = NULL WHERE id = 1',
    ).run();
  }

  /** Increment the consecutive-failure counter and return the new value. */
  incFailureStreak(): number {
    this.db.prepare('UPDATE app_state SET failure_streak = failure_streak + 1 WHERE id = 1').run();
    return this.get().failure_streak;
  }

  resetFailureStreak(): void {
    this.db.prepare('UPDATE app_state SET failure_streak = 0 WHERE id = 1').run();
  }
}
```

Wire it into the `Repos` class:

```typescript
export class Repos {
  cohorts: CohortRepo;
  profiles: ProfileRepo;
  events: EventRepo;
  settings: SettingsRepo;
  appState: AppStateRepo;
  constructor(public db: DB) {
    this.cohorts = new CohortRepo(db);
    this.profiles = new ProfileRepo(db);
    this.events = new EventRepo(db);
    this.settings = new SettingsRepo(db);
    this.appState = new AppStateRepo(db);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/db/app-state.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/repositories.ts tests/db/app-state.test.ts
git commit -m "feat(db): AppStateRepo for login cache, guardrail state and failure streak"
```

---

## Task 3: `guardrail` module

**Files:**
- Create: `src/worker/guardrail.ts`
- Test: `tests/worker/guardrail.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/worker/guardrail.test.ts`:

```typescript
import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import {
  isTripped, tripCheckpoint, tripLoginLost, recordFailure, recordSuccess, recordReadError,
} from '../../src/worker/guardrail.js';

let repos: Repos;
const NOW = new Date('2026-06-30T10:00:00.000Z');
beforeEach(() => { repos = new Repos(openDatabase(':memory:')); });

test('isTripped reflects app_state', () => {
  expect(isTripped(repos)).toBe(false);
  tripCheckpoint(repos, NOW);
  expect(isTripped(repos)).toBe(true);
  expect(repos.appState.get().guardrail_reason).toBe('checkpoint');
});

test('tripLoginLost sets login_lost reason', () => {
  tripLoginLost(repos, NOW);
  expect(repos.appState.get().guardrail_reason).toBe('login_lost');
  expect(isTripped(repos)).toBe(true);
});

test('recordFailure trips only at the threshold (default 3)', () => {
  expect(recordFailure(repos, 'err1', NOW)).toBe(false);
  expect(recordFailure(repos, 'err2', NOW)).toBe(false);
  expect(recordFailure(repos, 'err3', NOW)).toBe(true);
  expect(repos.appState.get().guardrail_reason).toBe('repeated_failures');
  expect(repos.appState.get().guardrail_detail).toBe('err3');
});

test('recordSuccess resets the streak so failures must re-accumulate', () => {
  recordFailure(repos, 'err1', NOW);
  recordFailure(repos, 'err2', NOW);
  recordSuccess(repos);
  expect(repos.appState.get().failure_streak).toBe(0);
  expect(recordFailure(repos, 'err1', NOW)).toBe(false); // streak is 1 again, not 3
});

test('threshold honors settings.failure_threshold', () => {
  repos.settings.update({ failure_threshold: 1 });
  expect(recordFailure(repos, 'boom', NOW)).toBe(true);
});

test('recordReadError with checkpoint text trips immediately as checkpoint', () => {
  recordReadError(repos, 'captcha challenge page', NOW);
  expect(repos.appState.get().guardrail_reason).toBe('checkpoint');
});

test('recordReadError with a plain error counts toward the streak', () => {
  recordReadError(repos, 'navigation timeout', NOW);
  expect(isTripped(repos)).toBe(false);
  expect(repos.appState.get().failure_streak).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/worker/guardrail.test.ts`
Expected: FAIL — cannot find module `../../src/worker/guardrail.js`.

- [ ] **Step 3: Implement `src/worker/guardrail.ts`**

```typescript
import type { Repos } from '../db/repositories.js';

const CHECKPOINT_RE = /captcha|checkpoint|verify you|unusual activity|security check/i;

export function isTripped(repos: Repos): boolean {
  return repos.appState.get().guardrail_tripped === 1;
}

export function tripCheckpoint(repos: Repos, now: Date): void {
  repos.appState.trip('checkpoint', 'Captcha/checkpoint detected', now.toISOString());
}

export function tripLoginLost(repos: Repos, now: Date): void {
  repos.appState.trip('login_lost', 'LinkedIn session lost (li_at cookie missing)', now.toISOString());
}

/**
 * Count one failed send/read toward the consecutive-failure streak and trip
 * 'repeated_failures' once it reaches settings.failure_threshold.
 * Returns true if the guardrail is now tripped.
 */
export function recordFailure(repos: Repos, detail: string, now: Date): boolean {
  const streak = repos.appState.incFailureStreak();
  const threshold = repos.settings.get().failure_threshold;
  if (streak >= threshold) {
    repos.appState.trip('repeated_failures', detail, now.toISOString());
    return true;
  }
  return false;
}

/** A clean send resets the failure streak. */
export function recordSuccess(repos: Repos): void {
  repos.appState.resetFailureStreak();
}

/**
 * A read-path failure: checkpoint/captcha text trips immediately; any other
 * error counts toward the streak (so a one-off blip doesn't halt everything).
 */
export function recordReadError(repos: Repos, message: string, now: Date): void {
  if (CHECKPOINT_RE.test(message)) {
    tripCheckpoint(repos, now);
    return;
  }
  recordFailure(repos, message, now);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/worker/guardrail.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/worker/guardrail.ts tests/worker/guardrail.test.ts
git commit -m "feat(worker): guardrail module for trip decisions and failure streak"
```

---

## Task 4: Extend the `BrowserDriver` interface (additive) + driver implementations

This is additive — `isLoggedIn()` stays on the interface until Task 10 so existing callers keep compiling and the suite stays green.

**Files:**
- Modify: `src/types.ts` (BrowserDriver interface)
- Modify: `src/browser/driver.ts` (FakeDriver)
- Modify: `src/browser/linkedin-driver.ts` (LinkedInDriver)

- [ ] **Step 1: Extend the interface in `src/types.ts`**

Update the `BrowserDriver` interface (currently lines 60-68) to add the three new methods, keeping `isLoggedIn`:

```typescript
export interface BrowserDriver {
  isLoggedIn(): Promise<boolean>;
  /** No side effects: whether the browser context is currently open. */
  browserOpen(): boolean;
  /** Read the li_at cookie. Opens the context if needed (callers that must not
   *  open the browser guard with browserOpen() first). */
  readLoginState(): Promise<LoginSnapshot>;
  openLoginWindow(): Promise<void>;
  // message === null => send a bare request (no note)
  sendConnectionRequest(url: string, message: string | null): Promise<SendOutcome>;
  readPendingInvites(): Promise<string[]>;     // normalized profile URLs
  readRecentConnections(): Promise<string[]>;  // normalized profile URLs
  /** Whether the currently-loaded page looks like a checkpoint/captcha. */
  checkpointPresent(): Promise<boolean>;
  close(): Promise<void>;
}
```

`LoginSnapshot` is already imported implicitly (same file). No new import needed.

- [ ] **Step 2: Extend `FakeDriver` in `src/browser/driver.ts`**

Replace the whole `FakeDriver` class body with (adds `open`, `cookieExpiry`, `checkpoint` fields and the three methods):

```typescript
import type { BrowserDriver, SendOutcome, SendResult, LoginSnapshot } from '../types.js';
import { applyFirstName } from '../core/message.js';
export type { BrowserDriver };

/** In-memory driver for testing workers without a real browser. */
export class FakeDriver implements BrowserDriver {
  loggedIn = true;
  open = false;
  cookieExpiry: string | null = null;
  checkpoint = false;
  pending: string[] = [];
  connections: string[] = [];
  scripted = new Map<string, SendResult>();
  /** Name this fake "reads" from profiles; {firstName} is substituted with it. */
  firstName = 'Test';
  /** Records the note as actually sent (after {firstName} substitution). */
  sentLog: { url: string; message: string | null }[] = [];

  async isLoggedIn() { return this.loggedIn; }
  browserOpen() { return this.open; }
  async readLoginState(): Promise<LoginSnapshot> {
    this.open = true;
    return { loggedIn: this.loggedIn, cookieExpiry: this.cookieExpiry };
  }
  async openLoginWindow() { this.open = true; this.loggedIn = true; }
  async sendConnectionRequest(url: string, message: string | null): Promise<SendOutcome> {
    this.open = true;
    // Faithfully mirror the real driver: substitute {firstName} with the name it reads.
    const note = message === null ? null : applyFirstName(message, this.firstName);
    this.sentLog.push({ url, message: note });
    const result = this.scripted.get(url) ?? 'sent';
    return { result, firstName: this.firstName };
  }
  async readPendingInvites() { return this.pending; }
  async readRecentConnections() { return this.connections; }
  async checkpointPresent() { return this.checkpoint; }
  async close() { this.open = false; }
}
```

- [ ] **Step 3: Implement the methods in `src/browser/linkedin-driver.ts`**

Update the import on line 2 to add `LoginSnapshot`:

```typescript
import type { BrowserDriver, SendOutcome, LoginSnapshot } from '../types.js';
```

Keep the existing `isLoggedIn()` (lines 14-22) as-is. Immediately after it, add the three new methods:

```typescript
  browserOpen(): boolean {
    return this.session.launched;
  }

  async readLoginState(): Promise<LoginSnapshot> {
    // Opens the context if needed — callers that must stay non-disruptive
    // (the dashboard poll, the orchestrator refresher) guard with browserOpen() first.
    const ctx = await this.session.context();
    const cookies = await ctx.cookies('https://www.linkedin.com');
    const li = cookies.find((c) => c.name === 'li_at' && !!c.value);
    const expirySec = li?.expires;
    const cookieExpiry = typeof expirySec === 'number' && expirySec > 0
      ? new Date(expirySec * 1000).toISOString()
      : null;
    return { loggedIn: !!li, cookieExpiry };
  }

  async checkpointPresent(): Promise<boolean> {
    if (!this.session.launched) return false;
    const page = await this.session.page();
    return this.looksLikeCheckpoint(page);
  }
```

Then make the two read methods surface a checkpoint so the worker can trip on it. In `readPendingInvites` (currently lines 105-113), add a checkpoint guard after the `autoScroll`:

```typescript
  async readPendingInvites(): Promise<string[]> {
    const page = await this.session.page();
    await page.goto(URLS.sentInvitations, { waitUntil: 'domcontentloaded' });
    await sleep(rand(2000, 4000));
    if (await this.looksLikeCheckpoint(page)) throw new Error('checkpoint detected during invitations read');
    // The list lazy-loads; load it all so we never falsely "expire" a pending invite
    // that simply hadn't scrolled into view.
    await this.autoScroll(page);
    return this.collectProfileLinks(page, SEL.invitationCardLink);
  }
```

And in `readRecentConnections` (currently lines 115-121):

```typescript
  async readRecentConnections(): Promise<string[]> {
    const page = await this.session.page();
    await page.goto(URLS.connections, { waitUntil: 'domcontentloaded' });
    await sleep(rand(2000, 4000));
    if (await this.looksLikeCheckpoint(page)) throw new Error('checkpoint detected during connections read');
    await this.autoScroll(page, 6); // a few pages of "recently added" is enough
    return this.collectProfileLinks(page, SEL.connectionCardLink);
  }
```

- [ ] **Step 4: Run typecheck and the full suite to verify nothing broke**

Run: `npm run typecheck`
Expected: PASS (no type errors).

Run: `npm test`
Expected: PASS — all existing tests still green (the interface change is additive; FakeDriver implements the new methods).

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/browser/driver.ts src/browser/linkedin-driver.ts
git commit -m "feat(browser): add browserOpen/readLoginState/checkpointPresent to the driver"
```

---

## Task 5: Sender — reordered gating + guardrail routing

**Files:**
- Modify: `src/worker/sender.ts`
- Test: `tests/worker/sender.test.ts`

- [ ] **Step 1: Update existing tests + add new guardrail tests**

In `tests/worker/sender.test.ts`, seed the login cache so the new cached-login gate lets sends proceed. Update `beforeEach` (line 8) to:

```typescript
beforeEach(() => {
  repos = new Repos(openDatabase(':memory:'));
  driver = new FakeDriver();
  repos.appState.setLogin({ loggedIn: true, cookieExpiry: null }, '2026-06-29T00:00:00.000Z');
});
```

Replace the existing checkpoint test (lines 39-46) — checkpoint now trips the guardrail instead of setting `paused`:

```typescript
test('checkpoint -> trips guardrail and flags needs_attention', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  seedScheduled('https://www.linkedin.com/in/a', '2026-06-29T09:00:00.000Z', c.id);
  driver.scripted.set('https://www.linkedin.com/in/a', 'checkpoint');
  await runSenderOnce(repos, driver, new Date('2026-06-29T10:00:00Z'));
  expect(repos.appState.get().guardrail_tripped).toBe(1);
  expect(repos.appState.get().guardrail_reason).toBe('checkpoint');
  expect(repos.profiles.byStatus('needs_attention')).toHaveLength(1);
  expect(repos.settings.get().paused).toBe(0); // manual pause untouched
});
```

Replace the "not logged in" test (lines 71-78) to drive it through the cache:

```typescript
test('not logged in (cache): skips without sending and without tripping', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  seedScheduled('https://www.linkedin.com/in/a', '2026-06-29T09:00:00.000Z', c.id);
  repos.appState.setLogin({ loggedIn: false, cookieExpiry: null }, '2026-06-29T00:00:00.000Z');
  await runSenderOnce(repos, driver, new Date('2026-06-29T10:00:00Z'));
  expect(driver.sentLog).toHaveLength(0);
  expect(repos.appState.get().guardrail_tripped).toBe(0);
  expect(repos.settings.get().paused).toBe(0);
});
```

Add these new tests at the end of the file:

```typescript
test('does nothing and never opens the browser when no profile is due', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  // scheduled in the future -> not due yet
  seedScheduled('https://www.linkedin.com/in/a', '2026-06-29T23:00:00.000Z', c.id);
  await runSenderOnce(repos, driver, new Date('2026-06-29T10:00:00Z'));
  expect(driver.sentLog).toHaveLength(0);
  expect(driver.open).toBe(false); // lazy: browser never opened
});

test('skips and trips login_lost when the live check fails despite a stale cache', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  seedScheduled('https://www.linkedin.com/in/a', '2026-06-29T09:00:00.000Z', c.id);
  driver.loggedIn = false; // cache says logged-in (from beforeEach), live read disagrees
  await runSenderOnce(repos, driver, new Date('2026-06-29T10:00:00Z'));
  expect(driver.sentLog).toHaveLength(0);
  expect(repos.appState.get().guardrail_tripped).toBe(1);
  expect(repos.appState.get().guardrail_reason).toBe('login_lost');
  expect(repos.appState.get().login_logged_in).toBe(0); // cache corrected
});

test('does nothing when guardrail is already tripped', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  seedScheduled('https://www.linkedin.com/in/a', '2026-06-29T09:00:00.000Z', c.id);
  repos.appState.trip('checkpoint', 'x', '2026-06-29T00:00:00.000Z');
  await runSenderOnce(repos, driver, new Date('2026-06-29T10:00:00Z'));
  expect(driver.sentLog).toHaveLength(0);
});

test('three consecutive errors trip repeated_failures and stop the batch', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  for (const slug of ['a', 'b', 'c', 'd']) {
    seedScheduled(`https://www.linkedin.com/in/${slug}`, '2026-06-29T09:00:00.000Z', c.id);
    driver.scripted.set(`https://www.linkedin.com/in/${slug}`, 'error');
  }
  await runSenderOnce(repos, driver, new Date('2026-06-29T10:00:00Z'));
  expect(repos.appState.get().guardrail_tripped).toBe(1);
  expect(repos.appState.get().guardrail_reason).toBe('repeated_failures');
  // tripped on the 3rd error -> 4th profile never attempted
  expect(driver.sentLog).toHaveLength(3);
});

test('a success between failures resets the streak (no trip)', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  seedScheduled('https://www.linkedin.com/in/a', '2026-06-29T09:00:00.000Z', c.id);
  seedScheduled('https://www.linkedin.com/in/b', '2026-06-29T09:00:00.000Z', c.id);
  seedScheduled('https://www.linkedin.com/in/c', '2026-06-29T09:00:00.000Z', c.id);
  driver.scripted.set('https://www.linkedin.com/in/a', 'error');
  driver.scripted.set('https://www.linkedin.com/in/b', 'sent');
  driver.scripted.set('https://www.linkedin.com/in/c', 'error');
  await runSenderOnce(repos, driver, new Date('2026-06-29T10:00:00Z'));
  expect(repos.appState.get().guardrail_tripped).toBe(0);
  expect(repos.appState.get().failure_streak).toBe(1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/worker/sender.test.ts`
Expected: FAIL — happy path opens nothing/sends nothing (cache gate not implemented yet to confirm), new guardrail tests fail (`guardrail_tripped` still 0 on checkpoint, etc.).

- [ ] **Step 3: Rewrite `src/worker/sender.ts`**

Replace the entire file with:

```typescript
import type { Repos } from '../db/repositories.js';
import type { BrowserDriver } from '../types.js';
import { selectNoteSource } from '../core/message.js';
import { windowStartIso, remainingCapacity } from '../core/rate-limit.js';
import { pickDue } from '../core/schedule.js';
import { isTripped, tripCheckpoint, tripLoginLost, recordFailure, recordSuccess } from './guardrail.js';

export async function runSenderOnce(repos: Repos, driver: BrowserDriver, now: Date): Promise<void> {
  const settings = repos.settings.get();
  if (settings.paused) return;
  if (isTripped(repos)) return;

  // Capacity + due work are computed from the DB only — so idle ticks never open the browser.
  const sentInWindow = repos.events.countSentSince(windowStartIso(now));
  let remaining = remainingCapacity(settings.weekly_cap, sentInWindow);
  if (remaining <= 0) return;

  const scheduled = repos.profiles.byStatus('scheduled');
  const due = pickDue(scheduled, now, Math.min(remaining, settings.batch_size));
  if (due.length === 0) return; // nothing due -> stay dark

  // Cached-login gate (no browser): login only ever happens through our own browser, so
  // the cache is authoritative. Not logged in is transient — skip, the dashboard surfaces it.
  if (repos.appState.get().login_logged_in !== 1) return;

  // Committing to act: confirm live (this lazily opens the browser and keeps it open) and
  // refresh the cache. A live miss after a logged-in cache means the session was lost.
  const snap = await driver.readLoginState();
  repos.appState.setLogin(snap, now.toISOString());
  if (!snap.loggedIn) { tripLoginLost(repos, now); return; }

  for (const p of due) {
    const cohort = repos.cohorts.findById(p.cohort_id)!;
    repos.profiles.setStatus(p.id, 'sending', { attempts: p.attempts + 1 });

    // Pass the raw note template (with {firstName} intact); the driver substitutes the
    // real name it reads from the profile at send time.
    const note = selectNoteSource(p.custom_message, cohort.message_template);
    let outcome = await driver.sendConnectionRequest(p.profile_url, note);

    if (outcome.firstName) repos.profiles.setStatus(p.id, 'sending', { first_name: outcome.firstName });

    if (outcome.result === 'note_quota') {
      repos.settings.update({ note_quota_exhausted: 1 });
      if (cohort.allow_no_note) {
        outcome = await driver.sendConnectionRequest(p.profile_url, null);
      } else {
        repos.profiles.setStatus(p.id, 'needs_attention', { last_error: 'note quota exhausted; no-note disabled' });
        continue;
      }
    }

    switch (outcome.result) {
      case 'sent':
        repos.profiles.setStatus(p.id, 'sent', { sent_at: now.toISOString() });
        repos.events.recordSend(p.id, 'sent');
        recordSuccess(repos); // reset the failure streak
        remaining--;
        break;
      case 'already':
        repos.profiles.setStatus(p.id, 'skipped', { last_error: outcome.result });
        repos.events.recordEvent(p.id, 'skipped');
        break;
      case 'unavailable':
        repos.profiles.setStatus(p.id, 'skipped', { last_error: outcome.result });
        repos.events.recordEvent(p.id, 'skipped');
        if (recordFailure(repos, 'send composer unavailable', now)) return;
        break;
      case 'checkpoint':
        repos.profiles.setStatus(p.id, 'needs_attention', { last_error: 'checkpoint' });
        tripCheckpoint(repos, now);
        return;
      case 'error':
      default:
        repos.profiles.setStatus(p.id, 'failed', { last_error: outcome.error ?? 'unknown' });
        repos.events.recordEvent(p.id, 'failed');
        if (recordFailure(repos, outcome.error ?? 'unknown', now)) return;
        break;
    }
    if (remaining <= 0) break;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/worker/sender.test.ts`
Expected: PASS (all tests, original + new).

- [ ] **Step 5: Commit**

```bash
git add src/worker/sender.ts tests/worker/sender.test.ts
git commit -m "feat(worker): sender lazy-opens on due work, gates on cached login, routes guardrail"
```

---

## Task 6: Acceptance checker — reordered gating + guardrail routing

**Files:**
- Modify: `src/worker/acceptance-checker.ts`
- Test: `tests/worker/acceptance-checker.test.ts`

- [ ] **Step 1: Update existing tests + add guardrail tests**

In `tests/worker/acceptance-checker.test.ts`, seed the login cache in `beforeEach` (line 8):

```typescript
beforeEach(() => {
  repos = new Repos(openDatabase(':memory:'));
  driver = new FakeDriver();
  repos.appState.setLogin({ loggedIn: true, cookieExpiry: null }, '2026-06-29T00:00:00.000Z');
});
```

Add these tests at the end of the file:

```typescript
test('does not open the browser when there are no sent profiles', async () => {
  await runAcceptanceCheck(repos, driver, new Date('2026-06-29T12:00:00Z'));
  expect(driver.open).toBe(false);
});

test('skips when guardrail tripped', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  seedSent('https://www.linkedin.com/in/a', c.id);
  repos.appState.trip('checkpoint', 'x', '2026-06-29T00:00:00.000Z');
  driver.connections = ['https://www.linkedin.com/in/a'];
  await runAcceptanceCheck(repos, driver, new Date('2026-06-29T12:00:00Z'));
  expect(repos.profiles.byStatus('accepted')).toHaveLength(0);
});

test('a checkpoint thrown during a read trips the guardrail', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  seedSent('https://www.linkedin.com/in/a', c.id);
  driver.readPendingInvites = async () => { throw new Error('checkpoint detected during invitations read'); };
  await runAcceptanceCheck(repos, driver, new Date('2026-06-29T12:00:00Z'));
  expect(repos.appState.get().guardrail_tripped).toBe(1);
  expect(repos.appState.get().guardrail_reason).toBe('checkpoint');
});

test('login lost on the live check trips login_lost and reads nothing', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  seedSent('https://www.linkedin.com/in/a', c.id);
  driver.loggedIn = false;
  driver.connections = ['https://www.linkedin.com/in/a'];
  await runAcceptanceCheck(repos, driver, new Date('2026-06-29T12:00:00Z'));
  expect(repos.appState.get().guardrail_reason).toBe('login_lost');
  expect(repos.profiles.byStatus('accepted')).toHaveLength(0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/worker/acceptance-checker.test.ts`
Expected: FAIL — new guardrail tests fail (no trip yet); `does not open the browser` may already pass.

- [ ] **Step 3: Rewrite `src/worker/acceptance-checker.ts`**

```typescript
import type { Repos } from '../db/repositories.js';
import type { BrowserDriver } from '../types.js';
import { computeAcceptanceTransitions } from '../core/acceptance.js';
import { isTripped, tripLoginLost, recordReadError, recordSuccess } from './guardrail.js';

export async function runAcceptanceCheck(repos: Repos, driver: BrowserDriver, now: Date): Promise<void> {
  if (repos.settings.get().paused) return;
  if (isTripped(repos)) return;

  // Nothing to verify -> stay dark (DB only, no browser).
  const sent = repos.profiles.byStatus('sent').map((p) => ({ id: p.id, profile_url: p.profile_url }));
  if (sent.length === 0) return;

  if (repos.appState.get().login_logged_in !== 1) return;

  // Committing to act: confirm login live (opens the browser) and refresh the cache.
  const snap = await driver.readLoginState();
  repos.appState.setLogin(snap, now.toISOString());
  if (!snap.loggedIn) { tripLoginLost(repos, now); return; }

  let pending: Set<string>;
  let connections: Set<string>;
  try {
    pending = new Set(await driver.readPendingInvites());
    connections = new Set(await driver.readRecentConnections());
  } catch (e) {
    // Checkpoint text trips immediately; other read failures count toward the streak.
    recordReadError(repos, (e as Error).message ?? 'acceptance read failed', now);
    return;
  }

  const { accepted, expired } = computeAcceptanceTransitions(sent, pending, connections);
  const iso = now.toISOString();
  for (const id of accepted) {
    repos.profiles.setStatus(id, 'accepted', { accepted_at: iso, resolved_at: iso });
    repos.events.recordEvent(id, 'accepted');
  }
  for (const id of expired) {
    repos.profiles.setStatus(id, 'expired', { resolved_at: iso });
    repos.events.recordEvent(id, 'expired');
  }
  recordSuccess(repos); // a clean read clears any accumulated streak
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/worker/acceptance-checker.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/worker/acceptance-checker.ts tests/worker/acceptance-checker.test.ts
git commit -m "feat(worker): acceptance checker lazy-opens, gates on cached login, trips on read failure"
```

---

## Task 7: Orchestrator — login-cache refresher + tripped gating

**Files:**
- Modify: `src/worker/orchestrator.ts`
- Test: `tests/worker/orchestrator.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/worker/orchestrator.test.ts` (tests the extracted refresher function, not the timers):

```typescript
import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { FakeDriver } from '../../src/browser/driver.js';
import { refreshLoginCache } from '../../src/worker/orchestrator.js';

let repos: Repos; let driver: FakeDriver;
const NOW = new Date('2026-06-30T10:00:00.000Z');
beforeEach(() => { repos = new Repos(openDatabase(':memory:')); driver = new FakeDriver(); });

test('does nothing when the browser is not open (never opens it)', async () => {
  driver.open = false;
  await refreshLoginCache(repos, driver, NOW);
  expect(driver.open).toBe(false);
  expect(repos.appState.get().login_confirmed_at).toBeNull();
});

test('refreshes the cache from the live cookie while the browser is open', async () => {
  driver.open = true;
  driver.loggedIn = true;
  driver.cookieExpiry = '2027-01-01T00:00:00.000Z';
  await refreshLoginCache(repos, driver, NOW);
  const s = repos.appState.get();
  expect(s.login_logged_in).toBe(1);
  expect(s.login_cookie_expiry).toBe('2027-01-01T00:00:00.000Z');
  expect(s.login_confirmed_at).toBe(NOW.toISOString());
});

test('records a logged-out cache when the cookie is gone', async () => {
  driver.open = true;
  driver.loggedIn = false;
  await refreshLoginCache(repos, driver, NOW);
  expect(repos.appState.get().login_logged_in).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/worker/orchestrator.test.ts`
Expected: FAIL — `refreshLoginCache` is not exported.

- [ ] **Step 3: Rewrite `src/worker/orchestrator.ts`**

```typescript
import type { Repos } from '../db/repositories.js';
import type { BrowserDriver } from '../types.js';
import { planAndAssignToday } from './scheduler-service.js';
import { runSenderOnce } from './sender.js';
import { runAcceptanceCheck } from './acceptance-checker.js';

/**
 * Refresh the cached login flag from the live li_at cookie — but ONLY when the
 * browser is already open, so this never opens a window just to poll. A no-op
 * while the browser is closed (the cache holds last-known state).
 */
export async function refreshLoginCache(repos: Repos, driver: BrowserDriver, now: Date): Promise<void> {
  if (!driver.browserOpen()) return;
  const snap = await driver.readLoginState();
  repos.appState.setLogin(snap, now.toISOString());
}

export class Orchestrator {
  private timers: ReturnType<typeof setInterval>[] = [];
  private lastAcceptanceDay = '';

  constructor(private repos: Repos, private driver: BrowserDriver) {}

  start(): void {
    planAndAssignToday(this.repos, new Date());
    this.timers.push(setInterval(() => planAndAssignToday(this.repos, new Date()), 60 * 60 * 1000));
    this.timers.push(setInterval(() => { void runSenderOnce(this.repos, this.driver, new Date()); }, 60 * 1000));

    // Keep the dashboard login indicator fresh without ever opening the browser.
    this.timers.push(setInterval(() => { void refreshLoginCache(this.repos, this.driver, new Date()); }, 10 * 1000));

    this.timers.push(setInterval(() => {
      const day = new Date().toDateString();
      const s = this.repos.settings.get();
      const tripped = this.repos.appState.get().guardrail_tripped === 1;
      if (day !== this.lastAcceptanceDay && !s.paused && !tripped) {
        this.lastAcceptanceDay = day;
        void runAcceptanceCheck(this.repos, this.driver, new Date());
      }
    }, 30 * 60 * 1000));
  }

  stop(): void { this.timers.forEach(clearInterval); this.timers = []; }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/worker/orchestrator.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/worker/orchestrator.ts tests/worker/orchestrator.test.ts
git commit -m "feat(worker): orchestrator refreshes login cache while open, gates acceptance on guardrail"
```

---

## Task 8: API — login-status from cache, extended `/api/status`, acknowledge endpoint

**Files:**
- Modify: `src/api/server.ts`
- Test: `tests/api/server.test.ts`

- [ ] **Step 1: Update existing tests + add new tests**

In `tests/api/server.test.ts`, the `run-now` test needs the login cache seeded (the sender now gates on it). Update `beforeEach` (lines 10-13):

```typescript
beforeEach(() => {
  repos = new Repos(openDatabase(':memory:'));
  app = buildServer(repos, new FakeDriver());
  repos.appState.setLogin({ loggedIn: true, cookieExpiry: null }, '2026-06-29T00:00:00.000Z');
});
```

Add these tests at the end of the file:

```typescript
test('GET /api/login-status reads the cache without touching the browser', async () => {
  repos.appState.setLogin({ loggedIn: true, cookieExpiry: null }, '2026-06-30T08:00:00.000Z');
  const res = await app.inject({ method: 'GET', url: '/api/login-status' });
  const body = JSON.parse(res.body);
  expect(body.loggedIn).toBe(true);
  expect(body.asOf).toBe('2026-06-30T08:00:00.000Z');
});

test('GET /api/status includes guardrail state', async () => {
  repos.appState.trip('checkpoint', 'captcha', '2026-06-30T09:00:00.000Z');
  const res = await app.inject({ method: 'GET', url: '/api/status' });
  const body = JSON.parse(res.body);
  expect(body.guardrail).toMatchObject({
    tripped: 1, reason: 'checkpoint', detail: 'captcha', trippedAt: '2026-06-30T09:00:00.000Z',
  });
});

test('POST /api/guardrail/acknowledge clears the guardrail when healthy', async () => {
  const driver = new FakeDriver();
  driver.loggedIn = true; driver.checkpoint = false;
  const a = buildServer(repos, driver);
  repos.appState.trip('checkpoint', 'captcha', '2026-06-30T09:00:00.000Z');
  const res = await a.inject({ method: 'POST', url: '/api/guardrail/acknowledge' });
  expect(JSON.parse(res.body).resumed).toBe(true);
  expect(repos.appState.get().guardrail_tripped).toBe(0);
  expect(repos.appState.get().failure_streak).toBe(0);
});

test('POST /api/guardrail/acknowledge stays tripped when still unhealthy', async () => {
  const driver = new FakeDriver();
  driver.loggedIn = false; // still logged out
  const a = buildServer(repos, driver);
  repos.appState.trip('login_lost', 'gone', '2026-06-30T09:00:00.000Z');
  const res = await a.inject({ method: 'POST', url: '/api/guardrail/acknowledge' });
  const body = JSON.parse(res.body);
  expect(body.resumed).toBe(false);
  expect(body.reason).toBe('login_lost');
  expect(repos.appState.get().guardrail_tripped).toBe(1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/api/server.test.ts`
Expected: FAIL — `/api/login-status` has no `asOf`, `/api/status` has no `guardrail`, `/api/guardrail/acknowledge` 404s.

- [ ] **Step 3: Update `src/api/server.ts`**

Extend the existing `GET /api/status` handler (lines 59-70) to include the login `asOf` and guardrail block:

```typescript
  app.get('/api/status', async () => {
    const counts: Record<string, number> = {};
    for (const p of repos.profiles.all()) counts[p.status] = (counts[p.status] ?? 0) + 1;
    const s = repos.settings.get();
    const a = repos.appState.get();
    return {
      paused: s.paused,
      pause_reason: s.pause_reason,
      weekly_sent: repos.events.countSentSince(windowStartIso(new Date())),
      weekly_cap: s.weekly_cap,
      counts,
      loggedIn: a.login_logged_in === 1,
      login_as_of: a.login_confirmed_at,
      guardrail: {
        tripped: a.guardrail_tripped,
        reason: a.guardrail_reason,
        detail: a.guardrail_detail,
        trippedAt: a.guardrail_tripped_at,
      },
    };
  });
```

Replace the `GET /api/login-status` handler (line 136) so it reads the cache instead of the live browser:

```typescript
  app.get('/api/login-status', async () => {
    const a = repos.appState.get();
    return { loggedIn: a.login_logged_in === 1, asOf: a.login_confirmed_at };
  });
```

Then, immediately after the `/api/login-status` handler, add the acknowledge endpoint:

```typescript
  // Re-verify the live session before clearing a tripped guardrail; only resume if the
  // session is back AND the current page isn't a checkpoint.
  app.post('/api/guardrail/acknowledge', async () => {
    const now = new Date();
    const snap = await driver.readLoginState();
    repos.appState.setLogin(snap, now.toISOString());
    const checkpoint = await driver.checkpointPresent();
    if (snap.loggedIn && !checkpoint) {
      repos.appState.clearGuardrail();
      repos.appState.resetFailureStreak();
      return { ok: true, resumed: true };
    }
    const reason = !snap.loggedIn ? 'login_lost' : 'checkpoint';
    const detail = !snap.loggedIn ? 'Still not logged in' : 'Checkpoint still present';
    repos.appState.trip(reason, detail, now.toISOString());
    return { ok: true, resumed: false, reason };
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/api/server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/server.ts tests/api/server.test.ts
git commit -m "feat(api): login-status from cache, guardrail in status, acknowledge endpoint"
```

---

## Task 9: Web UI — guardrail banner, login "as of", re-check button

No automated tests (vanilla DOM, no harness in this repo — consistent with existing `web/`). Verified manually in Task 10.

**Files:**
- Modify: `src/web/index.html:77-80`
- Modify: `src/web/app.js`
- Modify: `src/web/styles.css`

- [ ] **Step 1: Add the guardrail banner markup**

In `src/web/index.html`, immediately after the existing pause banner (after line 80, the closing `</div>` of `#pauseBanner`), add:

```html
  <div class="guardrail-banner" id="guardrailBanner" hidden role="alert">
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    <div class="guardrail-body">
      <strong>Automation halted.</strong>
      <span id="guardrailReason"></span>
      <span class="guardrail-time" id="guardrailTime"></span>
    </div>
    <button class="btn" id="guardrailRecheck" type="button">I've fixed it — re-check &amp; resume</button>
  </div>
```

- [ ] **Step 2: Add the guardrail styles**

Append to `src/web/styles.css`:

```css
/* ---------- guardrail alert ---------- */
.guardrail-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 12px 16px;
  padding: 14px 16px;
  border-radius: 10px;
  background: #fdeaea;
  border: 1px solid #e23b3b;
  color: #7a1414;
  box-shadow: 0 2px 10px rgba(226, 59, 59, 0.18);
}
.guardrail-banner svg { flex: 0 0 auto; color: #e23b3b; }
.guardrail-banner .guardrail-body { display: flex; flex-direction: column; gap: 2px; flex: 1 1 auto; }
.guardrail-banner .guardrail-time { font-size: 12px; opacity: 0.75; }
.guardrail-banner #guardrailRecheck { flex: 0 0 auto; }
```

- [ ] **Step 3: Render the banner + login "as of" in `src/web/app.js`**

Update `refreshLogin` (lines 79-91) to show the "as of" time when not freshly confirmed:

```javascript
async function refreshLogin() {
  const led = $('#loginLed'), label = $('#loginLabel'), btn = $('#connectBtn');
  try {
    const { loggedIn, asOf } = await api('/api/login-status');
    led.className = 'led ' + (loggedIn ? 'on' : 'off');
    label.textContent = loggedIn ? 'linked' : 'not logged in';
    label.title = asOf ? `as of ${fmtTime(asOf)}` : '';
    btn.hidden = loggedIn;
  } catch (_) {
    led.className = 'led off';
    label.textContent = 'link error';
    label.title = '';
    btn.hidden = false;
  }
}
```

Add a guardrail renderer. Insert this function just before `async function refreshStatus()` (line 149):

```javascript
const GUARDRAIL_TEXT = {
  checkpoint: 'LinkedIn showed a captcha or security check. Solve it in the browser window, then re-check.',
  login_lost: 'Your LinkedIn session was lost. Log back in via the browser window, then re-check.',
  repeated_failures: 'Several actions failed in a row (LinkedIn may have changed its UI or is blocking us). Check the browser window, then re-check.',
};

function applyGuardrailUi(status) {
  const banner = $('#guardrailBanner');
  const g = (status && status.guardrail) || {};
  const tripped = !!g.tripped;
  banner.hidden = !tripped;
  if (tripped) {
    $('#guardrailReason').textContent = GUARDRAIL_TEXT[g.reason] || g.detail || 'Automation was halted.';
    $('#guardrailTime').textContent = g.trippedAt ? `Halted ${fmtTime(g.trippedAt)}` : '';
  }
}
```

Call it from `refreshStatus` (lines 149-155):

```javascript
async function refreshStatus() {
  try {
    const status = await api('/api/status');
    renderCards(status);
    applyPauseUi(status);
    applyGuardrailUi(status);
  } catch (_) { /* transient; next tick retries */ }
}
```

Wire the re-check button. Add this block at the end of `initDashboard` (before its closing brace, line 212):

```javascript
  $('#guardrailRecheck').addEventListener('click', async () => {
    const btn = $('#guardrailRecheck');
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Re-checking…';
    try {
      const res = await api('/api/guardrail/acknowledge', { method: 'POST' });
      btn.textContent = res && res.resumed ? 'Resumed' : 'Still blocked';
      await refreshStatus();
    } catch (_) {
      btn.textContent = 'Failed';
    }
    setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 2500);
  });
```

- [ ] **Step 4: Commit**

```bash
git add src/web/index.html src/web/app.js src/web/styles.css
git commit -m "feat(web): guardrail alert banner, re-check button, login as-of tooltip"
```

---

## Task 10: Remove the now-unused `isLoggedIn()` + full verification

After Tasks 5-8, nothing in `src/` calls `driver.isLoggedIn()` anymore (workers use `readLoginState`, the API uses the cache). Remove it to keep the interface honest.

**Files:**
- Modify: `src/types.ts` (BrowserDriver)
- Modify: `src/browser/driver.ts` (FakeDriver)
- Modify: `src/browser/linkedin-driver.ts` (LinkedInDriver)

- [ ] **Step 1: Confirm there are no remaining callers**

Run: `grep -rn "isLoggedIn" src tests`
Expected: matches only in the three files about to be edited (interface declaration + the two implementations). If any worker/api/test still references it, stop and migrate that caller first.

- [ ] **Step 2: Remove the method**

In `src/types.ts`, delete the `isLoggedIn(): Promise<boolean>;` line from the `BrowserDriver` interface.

In `src/browser/driver.ts`, delete the `async isLoggedIn() { return this.loggedIn; }` line from `FakeDriver`. (Keep the `loggedIn` field — `readLoginState` still uses it.)

In `src/browser/linkedin-driver.ts`, delete the entire `isLoggedIn()` method (the block currently at lines 14-22, including its comment).

- [ ] **Step 3: Typecheck and run the full suite**

Run: `npm run typecheck`
Expected: PASS — no references to a removed method.

Run: `npm test`
Expected: PASS — every test green.

- [ ] **Step 4: Commit**

```bash
git add src/types.ts src/browser/driver.ts src/browser/linkedin-driver.ts
git commit -m "refactor(browser): drop unused isLoggedIn now that callers use readLoginState/cache"
```

- [ ] **Step 5: Manual end-to-end verification**

Start the app: `npm start`. Verify each:

1. **Restart-just-works:** With a previously logged-in profile in `.linkedin-profile` and `app_state.login_logged_in = 1`, start the app. The dashboard LED shows "linked (as of …)" immediately, before any browser window appears.
2. **Lazy open:** With nothing due, confirm no browser window opens on idle ticks. Click **Run batch now** (or wait for a due batch) and confirm the window opens then and stays open.
3. **Guardrail (checkpoint):** Temporarily force a checkpoint (e.g. script a profile that lands on a verification page, or set `driver` to return `checkpoint`) and confirm the red banner appears, sending and acceptance both stop, and the browser stays open.
4. **Recovery:** Resolve the condition (log in / clear the page), click **I've fixed it — re-check & resume**. Confirm the banner clears and the engine resumes; if still unhealthy, the banner stays with an updated message.

---

## Self-Review

**Spec coverage:**
- Lazy open / never close → Tasks 5, 6 (due-from-DB before any browser call; `readLoginState` opens lazily; no close path added). ✓
- Persisted login cache + dashboard from cache → Tasks 1, 2, 7 (refresher), 8 (`login-status`). ✓
- Guardrail triggers: checkpoint (Tasks 5, 6), login lost (Tasks 5, 6), DOM/repeated (Task 3 `recordFailure`, Tasks 5, 6). ✓
- Halt everything into a distinct tripped state → Tasks 5, 6 short-circuit; Task 7 gates the acceptance tick. ✓
- Acknowledge + re-verify → Task 8. ✓
- UI red banner + re-check + login as-of → Task 9. ✓
- Persisted failure counter + threshold setting → Tasks 1, 2, 3. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code. ✓

**Type/name consistency:** `LoginSnapshot { loggedIn, cookieExpiry }`, `AppState` columns, and `AppStateRepo` methods (`get`, `setLogin`, `trip`, `clearGuardrail`, `incFailureStreak`, `resetFailureStreak`) are used identically across Tasks 2-9. `GuardrailReason` values `checkpoint | login_lost | repeated_failures` match between `types.ts`, `guardrail.ts`, the acknowledge endpoint, and the UI `GUARDRAIL_TEXT` map. Driver methods `browserOpen`, `readLoginState`, `checkpointPresent` are declared (Task 4) before use (Tasks 5-8). ✓
