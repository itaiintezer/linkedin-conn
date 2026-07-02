# Skipped Bucket + Email-Required Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect LinkedIn's "enter their email to connect" gate and classify those profiles (plus already-connected and dismissed ones) into a generalized terminal **Skipped** bucket with a per-row reason, keeping **Needs attention** for genuinely retryable failures only.

**Architecture:** A new `SendResult 'email_required'` flows browser-driver → sender → a new `profiles.skip_reason` column. The `already_connected` status is retired via idempotent migration (rows become `skipped`/`already_connected`). The dashboard's "Already connected" card becomes "Skipped" with a reason column in its drill-down drawer.

**Tech Stack:** TypeScript (ESM, `tsx`), node:sqlite, Fastify, Playwright-core over CloakBrowser, vitest, vanilla-JS frontend.

**Spec:** `docs/superpowers/specs/2026-07-03-skipped-bucket-email-required-design.md`

**Context for the executor:**
- The production relay is RUNNING from this directory (`npm start` = `tsx src/index.ts`, port 4400, pid family above 38388). It does NOT hot-reload. Do not restart it until Task 7. `data/app.db` is the live production queue — never write test data into it.
- Work on a branch: `git checkout -b feat/skipped-bucket` before Task 1.
- Run tests with `npx vitest run <file>` (or `npm test` for all). Typecheck with `npm run typecheck`.
- Verdict log lines: the sender logs one `verdict` line per profile via `logVerdict` — keep that pattern.

---

### Task 1: Types, schema, migration, repo column allowlist

**Files:**
- Modify: `src/types.ts:4-9` (ProfileStatus, EventType, SendResult, Profile)
- Modify: `src/db/schema.sql:10-25` (profiles CREATE TABLE)
- Modify: `src/db/database.ts:47-54` (runMigrations)
- Modify: `src/db/repositories.ts:4-7` (PROFILE_COLUMNS)
- Test: `tests/db/database.test.ts`

- [ ] **Step 1: Write the failing migration tests**

Append to `tests/db/database.test.ts`:

```ts
test('runMigrations adds profiles.skip_reason and rewrites already_connected rows', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE profiles (id INTEGER PRIMARY KEY, cohort_id INTEGER, profile_url TEXT, status TEXT DEFAULT 'queued');`);
  db.exec(`INSERT INTO profiles (id, cohort_id, profile_url, status) VALUES
    (1, 1, 'https://www.linkedin.com/in/a', 'already_connected'),
    (2, 1, 'https://www.linkedin.com/in/b', 'skipped'),
    (3, 1, 'https://www.linkedin.com/in/c', 'sent');`);
  runMigrations(db);
  const cols = (db.prepare('PRAGMA table_info(profiles)').all() as { name: string }[]).map((c) => c.name);
  expect(cols).toContain('skip_reason');
  const rows = db.prepare('SELECT id, status, skip_reason FROM profiles ORDER BY id').all() as any[];
  expect(rows[0]).toMatchObject({ status: 'skipped', skip_reason: 'already_connected' });
  expect(rows[1]).toMatchObject({ status: 'skipped', skip_reason: null }); // legacy skip keeps NULL reason
  expect(rows[2]).toMatchObject({ status: 'sent', skip_reason: null });
  // Idempotent: a second run must not throw or change anything.
  runMigrations(db);
  expect((db.prepare("SELECT COUNT(*) c FROM profiles WHERE status='already_connected'").get() as any).c).toBe(0);
});

test('fresh db has profiles.skip_reason', () => {
  const db = openDatabase(':memory:');
  const cols = (db.prepare('PRAGMA table_info(profiles)').all() as { name: string }[]).map((c) => c.name);
  expect(cols).toContain('skip_reason');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/db/database.test.ts`
Expected: the two new tests FAIL (`skip_reason` missing).

- [ ] **Step 3: Implement schema + migration + types**

In `src/db/schema.sql`, inside `CREATE TABLE IF NOT EXISTS profiles (...)`, after the `last_error TEXT,` line add:

```sql
  -- Why a skipped profile was skipped: already_connected | email_required |
  -- unavailable | dismissed. NULL for rows skipped before this column existed.
  skip_reason TEXT,
```

In `src/db/database.ts`, extend the existing profiles block in `runMigrations` (after the `priority` migration):

```ts
  if (profileCols.length > 0 && !profileCols.includes('skip_reason')) {
    db.exec('ALTER TABLE profiles ADD COLUMN skip_reason TEXT');
  }
  // The already_connected status was folded into skipped + skip_reason (2026-07-03).
  // Idempotent: matches nothing once rewritten.
  if (profileCols.length > 0) {
    db.exec("UPDATE profiles SET status='skipped', skip_reason='already_connected' WHERE status='already_connected'");
  }
```

In `src/types.ts` replace lines 4-9 with:

```ts
export type ProfileStatus =
  | 'queued' | 'scheduled' | 'sending' | 'sent'
  | 'accepted' | 'expired' | 'skipped' | 'failed' | 'needs_attention';

/** Why a skipped profile was skipped (terminal — the engine never retries these). */
export type SkipReason = 'already_connected' | 'email_required' | 'unavailable' | 'dismissed';

export type EventType = 'sent' | 'accepted' | 'expired' | 'skipped' | 'failed';
```

In the `Profile` interface, after `last_error: string | null;` add:

```ts
  skip_reason: SkipReason | null;
```

In `SendResult` (types.ts:59-60) add the new member:

```ts
export type SendResult =
  | 'sent' | 'already' | 'unavailable' | 'note_quota' | 'checkpoint' | 'error'
  | 'email_required';
```

In `src/db/repositories.ts` add `'skip_reason'` to `PROFILE_COLUMNS`:

```ts
const PROFILE_COLUMNS = new Set([
  'first_name', 'custom_message', 'attempts', 'last_error', 'skip_reason',
  'scheduled_for', 'sent_at', 'accepted_at', 'resolved_at',
]);
```

- [ ] **Step 4: Run migration tests to verify they pass**

Run: `npx vitest run tests/db/database.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck — expect known downstream errors, fix ONLY the mechanical ones**

Run: `npm run typecheck`
Expected errors in `src/worker/sender.ts` (already_connected status/event) and `src/core/metrics.ts` — those are Task 2 and Task 5; leave them failing for now if they appear. If `tests/` files error on `already_connected`, they get fixed in their tasks too. Do NOT commit a broken typecheck: instead proceed to Task 2 in the same branch and commit after Task 2's tests pass, OR (preferred) commit now with only schema/db/types/tests touched if typecheck passes. If typecheck fails because of sender.ts, fold this commit into Task 2's commit.

- [ ] **Step 6: Commit (possibly combined with Task 2)**

```bash
git add src/types.ts src/db/schema.sql src/db/database.ts src/db/repositories.ts tests/db/database.test.ts
git commit -m "feat: skip_reason column; fold already_connected status into skipped"
```

---

### Task 2: Sender mapping for already / email_required / unavailable

**Files:**
- Modify: `src/worker/sender.ts:93-103` (the `already` and `unavailable` cases)
- Test: `tests/worker/sender.test.ts:34-42` (existing test) + new tests

- [ ] **Step 1: Update the existing already-connected test and add email_required tests**

In `tests/worker/sender.test.ts`, replace the test at lines 34-42 with:

```ts
test('already-connected -> skipped with reason, not counted as sent', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  const p = seedScheduled('https://www.linkedin.com/in/a', '2026-06-29T09:00:00.000Z', c.id);
  driver.scripted.set('https://www.linkedin.com/in/a', 'already');
  await runSenderOnce(repos, driver, new Date('2026-06-29T10:00:00Z'));
  const row = repos.profiles.findById(p.id)!;
  expect(row.status).toBe('skipped');
  expect(row.skip_reason).toBe('already_connected');
  expect(row.last_error).toBeNull();
  expect(repos.events.countSentSince('1970-01-01T00:00:00Z')).toBe(0);
});

test('email_required -> skipped with reason, terminal, no failure streak', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  const p = seedScheduled('https://www.linkedin.com/in/a', '2026-06-29T09:00:00.000Z', c.id);
  driver.scripted.set('https://www.linkedin.com/in/a', 'email_required');
  await runSenderOnce(repos, driver, new Date('2026-06-29T10:00:00Z'));
  const row = repos.profiles.findById(p.id)!;
  expect(row.status).toBe('skipped');
  expect(row.skip_reason).toBe('email_required');
  expect(row.last_error).toBeNull();
  // A per-profile verdict, not an automation failure: streak untouched, no guardrail.
  expect(repos.appState.get().failure_streak).toBe(0);
  expect(repos.appState.get().guardrail_tripped).toBe(0);
  expect(repos.events.countSentSince('1970-01-01T00:00:00Z')).toBe(0);
});

test('unavailable -> skipped with reason unavailable (still counts toward failure streak)', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  const p = seedScheduled('https://www.linkedin.com/in/a', '2026-06-29T09:00:00.000Z', c.id);
  driver.scripted.set('https://www.linkedin.com/in/a', 'unavailable');
  await runSenderOnce(repos, driver, new Date('2026-06-29T10:00:00Z'));
  const row = repos.profiles.findById(p.id)!;
  expect(row.status).toBe('skipped');
  expect(row.skip_reason).toBe('unavailable');
  expect(repos.appState.get().failure_streak).toBe(1);
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run tests/worker/sender.test.ts`
Expected: the three tests above FAIL (status/skip_reason mismatch); others PASS.

- [ ] **Step 3: Implement the sender mapping**

In `src/worker/sender.ts`, replace the `already` and `unavailable` cases (lines 93-103) with:

```ts
      case 'already':
        repos.profiles.setStatus(p.id, 'skipped', { last_error: null, skip_reason: 'already_connected' });
        repos.events.recordEvent(p.id, 'skipped');
        logVerdict(p, 'skipped: already connected');
        break;
      case 'email_required':
        // LinkedIn gates this member behind "enter their email to connect" — a
        // per-profile verdict that can never succeed on retry. Terminal skip; does
        // NOT touch the failure streak.
        repos.profiles.setStatus(p.id, 'skipped', { last_error: null, skip_reason: 'email_required' });
        repos.events.recordEvent(p.id, 'skipped');
        logVerdict(p, 'skipped: LinkedIn requires their email to connect');
        break;
      case 'unavailable':
        repos.profiles.setStatus(p.id, 'skipped', { last_error: null, skip_reason: 'unavailable' });
        repos.events.recordEvent(p.id, 'skipped');
        logVerdict(p, 'skipped: send composer unavailable');
        if (recordFailure(repos, 'send composer unavailable', clock())) return;
        break;
```

(Only the `unavailable` case keeps `recordFailure` — a missing composer may mean LinkedIn changed its UI, which the guardrail should notice.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/worker/sender.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: remaining errors only in `src/core/metrics.ts`/`tests/core/metrics.test.ts` if any (Task 5). If clean, better.

- [ ] **Step 6: Commit**

```bash
git add src/worker/sender.ts tests/worker/sender.test.ts
git commit -m "feat: sender maps already/email_required/unavailable to skipped + reason"
```

---

### Task 3: Metrics — replace already_connected count with skipped

**Files:**
- Modify: `src/core/metrics.ts:9-20,40,53`
- Test: `tests/core/metrics.test.ts:23-33`

- [ ] **Step 1: Update the metrics test**

In `tests/core/metrics.test.ts`, replace the test at lines 23-33 with:

```ts
test('counts skipped separately and excludes it from acceptance rate', () => {
  const rows: MetricRow[] = [
    { cohort_id: 1, cohort_name: 'A', status: 'accepted', sent_at: '2026-06-20T00:00:00Z', accepted_at: '2026-06-21T00:00:00Z' },
    { cohort_id: 1, cohort_name: 'A', status: 'skipped', sent_at: null, accepted_at: null },
    { cohort_id: 1, cohort_name: 'A', status: 'sent', sent_at: '2026-06-20T00:00:00Z', accepted_at: null },
  ];
  const [m] = computeCohortMetrics(rows);
  expect(m.skipped).toBe(1);
  // acceptance rate denominator = accepted + pending + expired = 2, not 3
  expect(m.acceptance_rate).toBeCloseTo(0.5);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/core/metrics.test.ts`
Expected: FAIL (`m.skipped` undefined).

- [ ] **Step 3: Implement**

In `src/core/metrics.ts`:
- In `CohortMetrics` replace `already_connected: number;` with `skipped: number;`
- Replace line 40 with: `const skipped = grp.filter((r) => r.status === 'skipped').length;`
- Replace line 53 (`already_connected: alreadyConnected,`) with: `skipped,`

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core/metrics.test.ts`
Expected: PASS.

- [ ] **Step 5: Full typecheck must now be clean**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/core/metrics.ts tests/core/metrics.test.ts
git commit -m "feat: metrics count skipped instead of already_connected"
```

---

### Task 4: API — skip_reason in responses; dismiss/remove stamp 'dismissed'

**Files:**
- Modify: `src/api/server.ts:157-168` (`GET /api/profiles`), `:247-252` (dismiss), `:357-362` (queue remove)
- Modify: `src/db/repositories.ts:113-115` (`skipCohortQueue`)
- Test: `tests/api/server.test.ts:307-314` (existing dismiss test) + new test

- [ ] **Step 1: Extend the dismiss test and add a skip_reason listing test**

In `tests/api/server.test.ts`, replace the dismiss test (lines 307-314) with:

```ts
test('POST /api/profiles/:id/dismiss marks it skipped with reason dismissed', async () => {
  const c = repos.cohorts.create('D1', null, true);
  const a = repos.profiles.add(c.id, 'https://www.linkedin.com/in/d1', null);
  repos.profiles.setStatus(a.id, 'needs_attention', { last_error: 'x' });
  const res = await app.inject({ method: 'POST', url: `/api/profiles/${a.id}/dismiss` });
  expect(res.statusCode).toBe(200);
  const row = repos.profiles.findById(a.id)!;
  expect(row.status).toBe('skipped');
  expect(row.skip_reason).toBe('dismissed');
});
```

Then append a new test:

```ts
test('GET /api/profiles?status=skipped returns skip_reason', async () => {
  const c = repos.cohorts.create('SK', null, true);
  const a = repos.profiles.add(c.id, 'https://www.linkedin.com/in/sk1', null);
  repos.profiles.setStatus(a.id, 'skipped', { skip_reason: 'email_required' });
  const res = await app.inject({ method: 'GET', url: '/api/profiles?status=skipped' });
  const body = JSON.parse(res.body);
  expect(body).toHaveLength(1);
  expect(body[0].skip_reason).toBe('email_required');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/api/server.test.ts`
Expected: the two touched tests FAIL; the rest PASS.

- [ ] **Step 3: Implement**

In `src/api/server.ts`:

`GET /api/profiles` (line 161-162) — add `p.skip_reason` to the SELECT:

```ts
      SELECT p.id, p.profile_url, p.status, p.skip_reason, p.scheduled_for, p.sent_at, p.accepted_at,
             p.last_error, c.name AS cohort_name
```

Dismiss endpoint (line 250):

```ts
    repos.profiles.setStatus(id, 'skipped', { last_error: null, skip_reason: 'dismissed' });
```

Queue remove endpoint (line 360):

```ts
    repos.profiles.setStatus(id, 'skipped', { last_error: null, skip_reason: 'dismissed' });
```

In `src/db/repositories.ts`, `skipCohortQueue` (archiving a cohort drops its queue — that's an operator dismissal):

```ts
  skipCohortQueue(cohortId: number): void {
    this.db.prepare("UPDATE profiles SET status='skipped', skip_reason='dismissed' WHERE cohort_id = ? AND status IN ('queued','scheduled')").run(cohortId);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/api/server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/server.ts src/db/repositories.ts tests/api/server.test.ts
git commit -m "feat: expose skip_reason; dismiss/remove/archive stamp reason dismissed"
```

---

### Task 5: Driver — detect the email-verification gate

No unit tests here (real-browser code, verified live in Task 7). Keep changes minimal and follow the existing outcome-helper pattern.

**Files:**
- Modify: `src/browser/linkedin-selectors.ts:38-67` (`find`)
- Modify: `src/browser/linkedin-driver.ts:79-124` (composer branch + post-submit)

- [ ] **Step 1: Add the selectors**

In `src/browser/linkedin-selectors.ts`, inside `find`, after `pendingBadge` add:

```ts
  // Email-verification gate: some members only accept invites from people who know
  // their email. LinkedIn shows "To verify this member knows you, please enter their
  // email to connect." with an email input in the invite dialog. Either signal
  // suffices; en-US is forced at launch so the English wording is stable.
  emailVerifyText: (s: Scope): Locator => s.getByText(/enter their email to connect/i),
  emailVerifyInput: (s: Scope): Locator => s.locator('div[role="dialog"] input[type="email"]'),
```

- [ ] **Step 2: Add the driver helper + outcome**

In `src/browser/linkedin-driver.ts`, after the `errorOutcome` method (line 159), add:

```ts
  /** True if LinkedIn's email-verification gate is showing (the invite cannot be sent). */
  private async emailRequired(page: Page): Promise<boolean> {
    if (await find.emailVerifyText(page).first().isVisible().catch(() => false)) return true;
    return find.emailVerifyInput(page).first().isVisible().catch(() => false);
  }

  /** The member requires their email to connect — terminal, never retryable. Evidence is
   *  captured BEFORE dismissing so the screenshot shows the gate itself. */
  private async emailRequiredOutcome(page: Page, firstName?: string): Promise<SendOutcome> {
    const ev = await captureEvidence(page, 'email-required', {});
    await find.dismissDialog(page).first().click().catch(() => {}); // leave no modal behind
    return {
      result: 'email_required',
      firstName,
      evidence: { pageUrl: page.url(), screenshot: ev?.screenshot ?? null },
    };
  }
```

- [ ] **Step 3: Wire the two check points into `sendConnectionRequest`**

Check point A — the composer-unusable branch (lines 79-83) becomes:

```ts
      if (!hasSendWithout && !hasAddNote) {
        const scan = await this.scanCheckpoint(page);
        if (scan.hit) return this.checkpointOutcome(page, scan, firstName);
        if (await this.emailRequired(page)) return this.emailRequiredOutcome(page, firstName);
        return { result: 'unavailable', firstName };
      }
```

Check point B — right after submit, BEFORE navigating back to the profile. Line 101 (`await sleep(rand(1500, 3000));` following the click) becomes:

```ts
      await sleep(rand(1500, 3000));
      // The email-verification gate appears here, in place of a success signal — catch it
      // now, while the dialog is still on screen (the confirm step navigates away).
      if (await this.emailRequired(page)) return this.emailRequiredOutcome(page, firstName);
```

- [ ] **Step 4: Typecheck + full test suite**

Run: `npm run typecheck && npm test`
Expected: both clean. (`FakeDriver.scripted` is typed `Map<string, SendResult>`, so `'email_required'` works with no driver.ts change.)

- [ ] **Step 5: Commit**

```bash
git add src/browser/linkedin-selectors.ts src/browser/linkedin-driver.ts
git commit -m "feat: detect LinkedIn email-verification gate as email_required"
```

---

### Task 6: UI + docs — "Skipped" card with reasons

**Files:**
- Modify: `src/web/index.html:182-185` (outcome card)
- Modify: `src/web/app.js:189,443-448,469-474` (renderEngine, DRILL_DATE, openDrawer)
- Modify: `RUNBOOK.md:47,57`

No JS unit tests exist for the frontend; verified by eye in Task 7. Keep markup/classes consistent with the existing cards.

- [ ] **Step 1: Rename the outcome card in `index.html`**

Replace lines 182-185 with:

```html
          <div class="o alr is-drill" data-drill="skipped" data-drill-title="Skipped" role="button" tabindex="0" title="View skipped profiles">
            <span class="oi"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5" stroke-linecap="round" stroke-linejoin="round"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
            <div><div class="on" id="outSkipped">0</div><div class="ol">Skipped</div></div>
          </div>
```

- [ ] **Step 2: Update `app.js`**

Line 189 (`setText('outAlready', ...)`) becomes:

```js
  setText('outSkipped', c.skipped || 0);
```

`DRILL_DATE` (lines 443-448): remove the `already_connected` entry:

```js
const DRILL_DATE = {
  sent: { field: 'sent_at', label: 'sent' },
  accepted: { field: 'accepted_at', label: 'accepted' },
  expired: { field: 'sent_at', label: 'sent' },
};
```

Below `DRILL_DATE`, add the reason labels:

```js
/* Human labels for profiles.skip_reason; NULL (legacy rows) renders as a dash. */
const SKIP_REASON_LABEL = {
  already_connected: 'already connected',
  email_required: 'requires their email',
  unavailable: 'composer unavailable',
  dismissed: 'dismissed',
};
```

In `openDrawer`, the row render (lines 469-474) becomes — skipped rows show their reason where other statuses show a date:

```js
    const d = DRILL_DATE[status] || { field: 'sent_at', label: 'sent' };
    body.replaceChildren(...rows.map((p) => el('div', { class: 'drawer-row' },
      el('a', { class: 'drawer-slug', href: p.profile_url, target: '_blank', rel: 'noopener', text: slugFromUrl(p.profile_url) }),
      el('span', { class: 'drawer-cohort', text: p.cohort_name || '—' }),
      status === 'skipped'
        ? el('span', { class: 'drawer-date', text: SKIP_REASON_LABEL[p.skip_reason] || '—' })
        : el('span', { class: 'drawer-date mono', text: p[d.field] ? `${d.label} ${fmtTime(p[d.field])}` : '—' }),
    )));
```

- [ ] **Step 3: Update RUNBOOK.md**

Line 47 (`- **Already connected** — ...`) becomes:

```markdown
- **Skipped** — terminal skips that will never be retried, with a reason each:
  already connected, requires their email to connect, composer unavailable, or
  dismissed by you.
```

Line 57 (`- **Dismiss** — give up on it (marks it skipped).`) becomes:

```markdown
- **Dismiss** — give up on it (moves it to **Skipped** with reason "dismissed").
```

- [ ] **Step 4: Full check**

Run: `npm run typecheck && npm test`
Expected: clean. (app.js/index.html aren't typechecked — the run guards against accidental damage elsewhere.)

Grep for leftovers: `grep -rn "already_connected" src/ | grep -v skip_reason` — expected matches ONLY in `src/db/database.ts` (the migration rewrite string, intentional). `outAlready` must have zero matches: `grep -rn "outAlready" src/`.

- [ ] **Step 5: Commit**

```bash
git add src/web/index.html src/web/app.js RUNBOOK.md
git commit -m "feat: Skipped outcome card with per-row skip reasons"
```

---

### Task 7: Verify end-to-end on the live relay, then merge

The production relay (port 4400) is still running OLD code. This task deploys and verifies against LinkedIn for real, per the user's decision: requeue the two email-gated profiles (ids 368 `parkforeman`, 372 `abdulsamadhussain`) and let the new detection classify them.

- [ ] **Step 1: Full suite green on the branch**

Run: `npm run typecheck && npm test`
Expected: all pass. If not, fix before touching the live relay.

- [ ] **Step 2: Merge to main**

```bash
git checkout main && git merge feat/skipped-bucket
```

- [ ] **Step 3: Restart the relay gracefully**

The relay must be shut down gracefully — force-killing the node process orphans the cloak browser, which holds the `.linkedin-profile` lock and blocks the next start. Stop the `npm start` process tree by sending Ctrl+C in its terminal if the user runs it interactively; from this session, stop the tsx child gracefully:

```powershell
# Find the tsx child (the process whose CommandLine contains 'src/index.ts')
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'src/index.ts' } | Select-Object ProcessId, CommandLine
# Graceful stop: taskkill WITHOUT /F sends WM_CLOSE-style termination; if the app has
# a SIGINT handler this lets it close the browser. Kill the npm parent last.
taskkill /PID <tsx-pid>
```

Wait ~5s, verify no orphan Chrome holds the profile (`Get-Process chrome -ErrorAction SilentlyContinue` — if cloak Chrome lingers with the relay down, kill that chrome tree per the runbook). Then restart:

```powershell
Start-Process -WorkingDirectory C:\Projects\linkedin-conn -FilePath npm -ArgumentList 'start' -WindowStyle Minimized
```

Confirm it's up and the migration ran:

```bash
curl -s http://localhost:4400/api/status
```

Expected: `counts` no longer contains `already_connected`; `skipped` is 5 (3 legacy + 2 migrated).

- [ ] **Step 4: Requeue the two email-gated profiles and make them due**

```bash
curl -s -X POST http://localhost:4400/api/profiles/368/retry
curl -s -X POST http://localhost:4400/api/profiles/372/retry
```

Then make them due immediately (direct DB write is safe: WAL mode, short transaction; this mirrors what run-now does but ONLY for these two, so no other queued profile is promoted):

```bash
node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('data/app.db');
const due = new Date(Date.now() - 5000).toISOString();
db.prepare(\"UPDATE profiles SET status='scheduled', scheduled_for=? WHERE id IN (368, 372)\").run(due);
console.log('due at', due);
"
```

The sender tick runs every 60s (within working hours; check `curl -s http://localhost:4400/api/settings` for `workday_start_hour`/`workday_end_hour` and confirm the current local hour is inside — if outside, use `curl -s -X POST http://localhost:4400/api/run-now` which forces the window BUT also promotes up to `batch_size` other queued profiles; prefer waiting for the window).

- [ ] **Step 5: Watch the verdicts**

Poll until both profiles resolve (each send takes ~30-60s of human-pacing delays):

```bash
curl -s "http://localhost:4400/api/logs?tail=50" | grep -i verdict
curl -s "http://localhost:4400/api/profiles?status=skipped"
```

Expected: both 368 and 372 end `skipped` with `skip_reason: "email_required"`, verdict lines read `skipped: LinkedIn requires their email to connect`, and a fresh `email-required` incident (screenshot showing the modal) exists in `data/incidents/`. **If instead they land `failed` again**, the detection missed — pull the newest incident HTML from `data/incidents/`, find the dialog's actual DOM/wording, adjust `emailVerifyText`/`emailVerifyInput`, and repeat from Task 5 Step 4.

- [ ] **Step 6: Verify the dashboard**

Open `http://localhost:4400`: the outcome card reads **Skipped 7** (3 legacy + 2 migrated + 2 new), clicking it lists reasons ("already connected" ×2, "requires their email" ×2, "—" ×3), and **Needs attention** shows 0.

- [ ] **Step 7: Final commit / wrap-up**

Nothing should be left uncommitted. Run `git status` to confirm, then use superpowers:finishing-a-development-branch (the branch was already merged in Step 2; delete it):

```bash
git branch -d feat/skipped-bucket
```
