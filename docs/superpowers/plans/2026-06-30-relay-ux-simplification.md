# Relay UX Simplification — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the false "Engine paused" banner, add a first-run setup wizard, remove the redundant note checkbox, rebuild the Add List screen (layout B), and make `cohort` optional on the add endpoints.

**Architecture:** Vanilla-JS frontend over a Fastify + node:sqlite backend. Backend changes are TDD'd with Vitest (`app.inject`, in-memory DB, `FakeDriver`). Frontend changes (wizard, Add List) have no unit-test harness in this repo, so they are built with the frontend-design skill and verified end-to-end against the running app.

**Tech Stack:** Node ≥22.5, TypeScript via tsx, Fastify 5, node:sqlite, Vitest 4. Fonts/theme already established (Fraunces / Hanken Grotesk, light emerald).

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `src/core/cohort-name.ts` | format a default cohort name from a date | **create** |
| `src/core/message.ts` | note-policy helpers | add `deriveAllowNoNote` |
| `src/db/schema.sql` | fresh-DB schema | add `onboarded` column |
| `src/db/database.ts` | open DB + run idempotent migrations | add `runMigrations`, call it |
| `src/db/repositories.ts` | settings column whitelist | add `onboarded` |
| `src/types.ts` | `Settings` interface | add `onboarded` |
| `src/api/server.ts` | HTTP endpoints | optional cohort + date default; derive `allow_no_note`; allow `onboarded` |
| `src/web/index.html` | markup | wizard modal; Add List rebuild; remove note checkboxes |
| `src/web/app.js` | frontend logic | wizard flow; cohort dropdown; drop-zone + live parse; drop flag wiring |
| `src/web/styles.css` | styles | wizard + Add List two-column (hidden-guard already added) |

---

## Task 1: `defaultCohortName` helper

**Files:**
- Create: `src/core/cohort-name.ts`
- Test: `tests/core/cohort-name.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/core/cohort-name.test.ts
import { test, expect } from 'vitest';
import { defaultCohortName } from '../../src/core/cohort-name.js';

test('formats a date as "Mon D, YYYY"', () => {
  expect(defaultCohortName(new Date(2026, 5, 30))).toBe('Jun 30, 2026');
  expect(defaultCohortName(new Date(2026, 0, 1))).toBe('Jan 1, 2026');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/cohort-name.test.ts`
Expected: FAIL — cannot find module `cohort-name.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/cohort-name.ts
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Default cohort label when none is supplied — the local date as "Mon D, YYYY". */
export function defaultCohortName(date: Date): string {
  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/cohort-name.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/cohort-name.ts tests/core/cohort-name.test.ts
git commit -m "feat: defaultCohortName helper for unnamed cohorts"
```

---

## Task 2: `deriveAllowNoNote` helper

**Files:**
- Modify: `src/core/message.ts`
- Test: `tests/core/message.test.ts`

- [ ] **Step 1: Add the failing test** (append to `tests/core/message.test.ts`)

```ts
import { deriveAllowNoNote } from '../../src/core/message.js';

test('deriveAllowNoNote: blank template allows bare requests, non-blank requires a note', () => {
  expect(deriveAllowNoNote(undefined)).toBe(true);
  expect(deriveAllowNoNote(null)).toBe(true);
  expect(deriveAllowNoNote('')).toBe(true);
  expect(deriveAllowNoNote('   ')).toBe(true);
  expect(deriveAllowNoNote('Hi {firstName}')).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/message.test.ts`
Expected: FAIL — `deriveAllowNoNote` is not exported.

- [ ] **Step 3: Implement** (append to `src/core/message.ts`)

```ts
/**
 * Derive the "send without a note" policy from the template alone: a blank template means
 * bare requests are intended (allowed); a non-blank template means the note matters, so a
 * bare fallback is NOT allowed (the sender routes to needs_attention on note-quota exhaustion).
 */
export function deriveAllowNoNote(template: string | null | undefined): boolean {
  return !template || !template.trim();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/message.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/message.ts tests/core/message.test.ts
git commit -m "feat: deriveAllowNoNote — note policy from template presence"
```

---

## Task 3: `onboarded` column + migration

**Files:**
- Modify: `src/db/schema.sql`, `src/db/database.ts`, `src/db/repositories.ts`, `src/types.ts`
- Test: `tests/db/database.test.ts`

- [ ] **Step 1: Write the failing tests** (append to `tests/db/database.test.ts`)

```ts
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../../src/db/database.js';

test('fresh db seeds onboarded = 0', () => {
  const db = openDatabase(':memory:');
  const s = db.prepare('SELECT onboarded FROM settings WHERE id = 1').get() as any;
  expect(s.onboarded).toBe(0);
});

test('runMigrations adds onboarded to a legacy settings table and back-fills configured users', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), account_type TEXT NOT NULL DEFAULT 'unknown');`);
  db.exec(`INSERT INTO settings (id, account_type) VALUES (1, 'premium');`);
  runMigrations(db);
  const cols = (db.prepare('PRAGMA table_info(settings)').all() as any[]).map((c) => c.name);
  expect(cols).toContain('onboarded');
  expect((db.prepare('SELECT onboarded FROM settings WHERE id = 1').get() as any).onboarded).toBe(1);
});

test('runMigrations leaves unknown-account users not onboarded', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), account_type TEXT NOT NULL DEFAULT 'unknown');`);
  db.exec(`INSERT INTO settings (id, account_type) VALUES (1, 'unknown');`);
  runMigrations(db);
  expect((db.prepare('SELECT onboarded FROM settings WHERE id = 1').get() as any).onboarded).toBe(0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/db/database.test.ts`
Expected: FAIL — `runMigrations` not exported / `onboarded` column missing.

- [ ] **Step 3: Add the column to `schema.sql`** (insert after the `pause_reason TEXT` line, before the closing `)`):

```sql
  pause_reason TEXT,
  onboarded INTEGER NOT NULL DEFAULT 0
```

- [ ] **Step 4: Implement `runMigrations` and call it** in `src/db/database.ts`

```ts
/** Idempotent schema migrations for databases created before a column existed. */
export function runMigrations(db: DB): void {
  const cols = (db.prepare('PRAGMA table_info(settings)').all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('onboarded')) {
    db.exec('ALTER TABLE settings ADD COLUMN onboarded INTEGER NOT NULL DEFAULT 0');
    // Don't show the wizard to users who already configured an account type.
    db.exec("UPDATE settings SET onboarded = 1 WHERE account_type != 'unknown'");
  }
}
```

In `openDatabase`, call it right after `db.exec(schema);`:

```ts
  db.exec(schema);
  runMigrations(db);
  return db;
```

- [ ] **Step 5: Whitelist + type the column**

In `src/db/repositories.ts`, add `'onboarded'` to the `SETTINGS_COLUMNS` set.
In `src/types.ts`, add to the `Settings` interface (after `pause_reason`):

```ts
  onboarded: number;
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/db/database.test.ts`
Expected: PASS (3 new tests).

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.sql src/db/database.ts src/db/repositories.ts src/types.ts tests/db/database.test.ts
git commit -m "feat: onboarded settings column with idempotent migration"
```

---

## Task 4: Optional cohort + derived note policy + onboarded patch (server)

**Files:**
- Modify: `src/api/server.ts`
- Test: `tests/api/server.test.ts`

- [ ] **Step 1: Write the failing tests** (append to `tests/api/server.test.ts`)

```ts
import { defaultCohortName } from '../../src/core/cohort-name.js';

test('POST /api/lists defaults the cohort to the date when none is given', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/lists',
    payload: { text: 'https://linkedin.com/in/no-cohort-1', message_template: 'Hi {firstName}' },
  });
  expect(res.statusCode).toBe(200);
  const name = defaultCohortName(new Date());
  expect(repos.cohorts.findByName(name)).toBeDefined();
});

test('POST /api/lists derives allow_no_note from template presence', async () => {
  await app.inject({ method: 'POST', url: '/api/lists', payload: { cohort: 'WithNote', text: 'https://linkedin.com/in/n1', message_template: 'Hi' } });
  await app.inject({ method: 'POST', url: '/api/lists', payload: { cohort: 'NoNote', text: 'https://linkedin.com/in/n2' } });
  expect(repos.cohorts.findByName('WithNote')!.allow_no_note).toBe(0);
  expect(repos.cohorts.findByName('NoNote')!.allow_no_note).toBe(1);
});

test('POST /api/profiles defaults the cohort to the date when none is given', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/profiles',
    payload: { url: 'https://linkedin.com/in/solo-1', message: 'Hey {firstName}' },
  });
  expect(res.statusCode).toBe(200);
  const name = defaultCohortName(new Date());
  expect(repos.cohorts.findByName(name)).toBeDefined();
  expect(repos.profiles.all()[0].custom_message).toBe('Hey {firstName}');
});

test('POST /api/settings accepts onboarded', async () => {
  await app.inject({ method: 'POST', url: '/api/settings', payload: { onboarded: 1 } });
  expect(repos.settings.get().onboarded).toBe(1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/api/server.test.ts`
Expected: FAIL — cohort required / `allow_no_note` not derived / `onboarded` not whitelisted.

- [ ] **Step 3: Update imports** at the top of `src/api/server.ts`:

```ts
import { defaultCohortName } from '../core/cohort-name.js';
import { deriveAllowNoNote } from '../core/message.js';
```

- [ ] **Step 4: Rewrite `POST /api/profiles`**

```ts
  app.post('/api/profiles', async (req, reply) => {
    const { url, cohort, message } = req.body as { url: string; cohort?: string; message?: string };
    const normalized = normalizeProfileUrl(url ?? '');
    if (!normalized) return reply.code(400).send({ error: 'invalid linkedin profile url' });
    const cohortName = (cohort && cohort.trim()) || defaultCohortName(new Date());
    const c = repos.cohorts.getOrCreate(cohortName, null, true);
    const p = repos.profiles.add(c.id, normalized, message ?? null);
    return { id: p.id, profile_url: p.profile_url };
  });
```

- [ ] **Step 5: Rewrite `POST /api/lists`**

```ts
  app.post('/api/lists', async (req) => {
    const { cohort, text, message_template } =
      req.body as { cohort?: string; text: string; message_template?: string };
    const cohortName = (cohort && cohort.trim()) || defaultCohortName(new Date());
    const allowNoNote = deriveAllowNoNote(message_template);
    const c = repos.cohorts.getOrCreate(cohortName, message_template ?? null, allowNoNote);
    repos.db.prepare('UPDATE cohorts SET message_template = ?, allow_no_note = ? WHERE id = ?')
      .run(message_template ?? c.message_template, allowNoNote ? 1 : 0, c.id);
    const urls = extractProfileUrls(text ?? '');
    const before = repos.profiles.countAll();
    for (const u of urls) repos.profiles.add(c.id, u, null);
    const added = repos.profiles.countAll() - before;
    return { added, found: urls.length };
  });
```

- [ ] **Step 6: Rewrite `POST /api/cohorts`** to derive the flag (drop `allow_no_note` from the body):

```ts
  app.post('/api/cohorts', async (req) => {
    const { name, message_template } = req.body as { name: string; message_template?: string };
    const allowNoNote = deriveAllowNoNote(message_template);
    const c = repos.cohorts.getOrCreate(name, message_template ?? null, allowNoNote);
    repos.db.prepare('UPDATE cohorts SET message_template = ?, allow_no_note = ? WHERE id = ?')
      .run(message_template ?? null, allowNoNote ? 1 : 0, c.id);
    return repos.cohorts.findById(c.id);
  });
```

- [ ] **Step 7: Allow `onboarded`** — add `'onboarded'` to the `ALLOWED_SETTINGS_KEYS` set near the top of `src/api/server.ts`.

- [ ] **Step 8: Run the full suite to verify nothing regressed**

Run: `npx vitest run`
Expected: PASS (new tests pass; existing `/api/lists`, `/api/run-now`, `/api/profiles` tests still pass — they don't assert on `allow_no_note`).

- [ ] **Step 9: Commit**

```bash
git add src/api/server.ts tests/api/server.test.ts
git commit -m "feat: optional cohort (date default) + derived note policy + onboarded patch"
```

---

## Task 5: First-run setup wizard (frontend)

**Sub-skill:** use the frontend-design skill for all markup/CSS in this task; keep the light emerald theme and existing tokens.

**Files:**
- Modify: `src/web/index.html` (wizard modal markup), `src/web/app.js` (flow), `src/web/styles.css` (modal styles)

**Behavior contract (must implement exactly):**
- Add a modal overlay container `#setupWizard` (with `hidden`) as the first child of `<body>` after `.atmosphere`. Inside: a 2-step panel.
  - Step 1 (`data-step="1"`): "Connect LinkedIn" heading, explanatory line, a `#wizConnectBtn` button, and a live status line `#wizLoginState`. A `#wizNext` button (disabled until logged in).
  - Step 2 (`data-step="2"`): "Your LinkedIn plan" heading, a `<select id="wizAccountType">` with options `free` / `premium` / `salesnav` (labels: Free, Premium, Sales Navigator), and a `#wizFinish` button.
- On boot, `app.js` calls `GET /api/settings`; if `onboarded` is falsy, reveal `#setupWizard` (`.hidden = false`) and start on step 1.
- Step 1 logic: `#wizConnectBtn` → `POST /api/login`; then poll `GET /api/login-status` every 2s, updating `#wizLoginState` ("Waiting for login…" → "Connected ✓"); when `loggedIn` is true, enable `#wizNext`. `#wizNext` switches to step 2 (toggle each step element's `hidden`).
- Step 2 logic: `#wizFinish` → `POST /api/settings { account_type: <select value>, onboarded: 1 }`, then hide the wizard (`#setupWizard.hidden = true`) and call `refreshLogin()` + `loadSettings()` so the dashboard reflects the new state.
- Stop the login poll interval once the wizard closes.

- [ ] **Step 1: Add the modal markup** to `index.html` per the contract above (frontend-design skill for styling/structure). Use the existing `.btn`/`.btn-green` classes; the new `select` reuses the existing select styling.

- [ ] **Step 2: Add wizard styles** to `styles.css` — a fixed full-viewport overlay (semi-opaque scrim), centered card (max-width ~440px), respecting the `[hidden]` guard (the overlay must set its own `display` only when not `[hidden]`; rely on the global guard so `#setupWizard[hidden]` stays hidden).

- [ ] **Step 3: Implement `initWizard()`** in `app.js` and call it from `init()` before `tick()`. Concrete logic:

```js
function initWizard() {
  const wiz = $('#setupWizard');
  if (!wiz) return;
  let pollId = null;
  const showStep = (n) => $$('#setupWizard [data-step]').forEach((s) => { s.hidden = s.dataset.step !== String(n); });

  const startLoginPoll = () => {
    if (pollId) return;
    pollId = setInterval(async () => {
      try {
        const { loggedIn } = await api('/api/login-status');
        $('#wizLoginState').textContent = loggedIn ? 'Connected ✓' : 'Waiting for login…';
        $('#wizNext').disabled = !loggedIn;
      } catch (_) { /* keep waiting */ }
    }, 2000);
  };
  const stopLoginPoll = () => { if (pollId) { clearInterval(pollId); pollId = null; } };

  $('#wizConnectBtn').addEventListener('click', async () => {
    $('#wizLoginState').textContent = 'Opening login window…';
    try { await api('/api/login', { method: 'POST' }); } catch (_) { /* surfaced via poll */ }
    startLoginPoll();
  });
  $('#wizNext').addEventListener('click', () => showStep(2));
  $('#wizFinish').addEventListener('click', async () => {
    const account_type = $('#wizAccountType').value;
    try { await api('/api/settings', { method: 'POST', body: { account_type, onboarded: 1 } }); } catch (_) { /* ignore */ }
    stopLoginPoll();
    wiz.hidden = true;
    refreshLogin();
  });

  api('/api/settings').then((s) => {
    if (!s.onboarded) { wiz.hidden = false; showStep(1); startLoginPoll(); }
  }).catch(() => { /* if settings unreachable, don't block the app */ });
}
```

- [ ] **Step 4: Verify (manual e2e)** — see Task 8.

- [ ] **Step 5: Commit**

```bash
git add src/web/index.html src/web/app.js src/web/styles.css
git commit -m "feat: first-run setup wizard (connect LinkedIn + account type)"
```

---

## Task 6: Add List rebuild (layout B) + remove note checkboxes (frontend)

**Sub-skill:** use the frontend-design skill for the two-column layout, drop-zone visuals, and rail styling; keep the established theme.

**Files:**
- Modify: `src/web/index.html` (Add List panel + Cohorts panel), `src/web/app.js` (Add List logic), `src/web/styles.css` (two-column + drop-zone)

**Behavior contract (must implement exactly):**

Add List panel (`#tab-add`), layout B — profiles primary (left), config rail (right):
- **Left:** label "Profiles"; a single `<textarea id="listText">` that is also a drop target; a live `#listCount` line ("N profiles detected"); a small preview is optional.
- **Right rail:**
  - `<select id="listCohortSelect">` ("Add to cohort"): first option `value=""` = "New (auto-dated)"; then one option per existing cohort (value = cohort name) loaded from `GET /api/cohorts`.
  - `<input id="listCohort">` (cohort name, **optional**) with `placeholder` set to today's date via `defaultCohortName` logic mirrored in JS (see below); no longer `required`.
  - `<textarea id="listTemplate">` with the `{firstName}` hint and `#tplCount` counter (unchanged behavior).
  - `<button class="btn btn-green" type="submit">` showing "Enqueue" / "Enqueue N".
- **Remove** the `#listAllowNoNote` checkbox and its `.field.check` wrapper, and the separate `#listFile` file-input row (drag-drop replaces it; an optional "browse" link inside the drop zone may call a hidden file input).

Cohorts panel (`#tab-cohorts`):
- **Remove** the `#cohortAllowNoNote` checkbox and its wrapper from `#cohortForm`.
- In `loadCohorts()`, **remove** the `.tag` "no-note ok / note req" span (keep the "No template (bare request)" indicator).

`app.js` Add List logic (`initAddList`), concrete:

```js
function todayCohortName() {
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const d = new Date();
  return `${M[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function countProfiles(text) {
  const re = /https?:\/\/[^\s,"'<>]*linkedin\.com\/in\/[A-Za-z0-9\-_%]+\/?/gi;
  const seen = new Set();
  for (const m of String(text).matchAll(re)) seen.add(m[0].toLowerCase().replace(/\/+$/, ''));
  return seen.size;
}

function initAddList() {
  const tpl = $('#listTemplate'), counter = $('#tplCount'), area = $('#listText');
  const updateTplCount = () => { counter.textContent = `${tpl.value.length} / 300`; };
  tpl.addEventListener('input', updateTplCount); updateTplCount();

  $('#listCohort').placeholder = todayCohortName();

  const updateCount = () => {
    const n = countProfiles(area.value);
    $('#listCount').textContent = `${n} profile${n === 1 ? '' : 's'} detected`;
    const btn = $('#listForm button[type="submit"]');
    if (btn) btn.textContent = n ? `Enqueue ${n}` : 'Enqueue';
  };
  area.addEventListener('input', updateCount); updateCount();

  // drag-drop a .csv/.txt onto the textarea
  ['dragover', 'dragenter'].forEach((ev) => area.addEventListener(ev, (e) => { e.preventDefault(); area.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => area.addEventListener(ev, () => area.classList.remove('drag')));
  area.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const existing = area.value.trim();
      area.value = existing ? existing + '\n' + reader.result : String(reader.result);
      updateCount();
    };
    reader.readAsText(file);
  });

  // cohort dropdown: pick existing -> prefill+lock name and prefill template; "New" -> unlock
  $('#listCohortSelect').addEventListener('change', async (e) => {
    const name = e.target.value;
    if (!name) { $('#listCohort').value = ''; $('#listCohort').disabled = false; return; }
    try {
      const cohorts = await api('/api/cohorts');
      const c = cohorts.find((x) => x.name === name);
      if (c) {
        $('#listCohort').value = c.name; $('#listCohort').disabled = true;
        tpl.value = c.message_template || ''; updateTplCount();
      }
    } catch (_) { /* ignore */ }
  });

  $('#listForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const result = $('#listResult');
    const payload = {
      cohort: $('#listCohort').value.trim() || undefined,
      text: area.value,
      message_template: tpl.value.trim() || undefined,
    };
    try {
      const r = await api('/api/lists', { method: 'POST', body: payload });
      toast(result, `Added ${r.added} of ${r.found} found.`);
      area.value = ''; updateCount();
    } catch (err) {
      toast(result, `Failed: ${err.message}`, true);
    }
  });
}
```

Populate the cohort dropdown when the Add tab opens. In `initTabs()`, extend the click handler: `if (name === 'add') loadCohortOptions();` and add:

```js
async function loadCohortOptions() {
  const sel = $('#listCohortSelect');
  if (!sel) return;
  try {
    const cohorts = await api('/api/cohorts');
    sel.replaceChildren(
      el('option', { value: '', text: 'New (auto-dated)' }),
      ...cohorts.map((c) => el('option', { value: c.name, text: c.name })),
    );
  } catch (_) { /* leave the default option */ }
}
```

Also remove the old `#listFile` change-handler block from `initAddList` (replaced by drag-drop).

- [ ] **Step 1:** Update `index.html` Add List panel to layout B per the contract (frontend-design skill). Preserve IDs `#listForm`, `#listText`, `#listTemplate`, `#tplCount`, `#listResult`, `#listCohort`; add `#listCohortSelect`, `#listCount`. Remove `#listAllowNoNote`, `#listFile`.
- [ ] **Step 2:** Update `index.html` Cohorts panel — remove `#cohortAllowNoNote` and its wrapper.
- [ ] **Step 3:** Add two-column + drop-zone styles to `styles.css` (`.add-layout` grid; `#listText.drag` highlighted state). Single-column under the 820px breakpoint.
- [ ] **Step 4:** Replace `initAddList` in `app.js` with the version above; add `loadCohortOptions`; wire it into `initTabs`; remove the `.tag` span in `loadCohorts`; remove `cohortAllowNoNote` from `initCohorts` submit payload.
- [ ] **Step 5: Verify (manual e2e)** — see Task 8.
- [ ] **Step 6: Commit**

```bash
git add src/web/index.html src/web/app.js src/web/styles.css
git commit -m "feat: rebuild Add List (layout B); drop redundant note checkboxes"
```

---

## Task 7: Type-check

- [ ] **Step 1:** Run `npm run typecheck`. Expected: no errors. Fix any type fallout from the `Settings.onboarded` addition or server payload type changes.
- [ ] **Step 2: Commit** any fixes:

```bash
git add -A && git commit -m "chore: typecheck fixes for onboarded/optional-cohort changes"
```

---

## Task 8: End-to-end verification (manual, before done)

Run the app against a scratch DB and confirm each item. Use a temp DB so the wizard triggers:

```bash
PORT=4410 DB_PATH=... npm run start   # or copy data/app.db aside; see note
```

Note: `DB_PATH` isn't env-configurable today — to force a fresh DB, temporarily move `data/app.db*` aside, run, then restore. Alternatively test the wizard path by setting `onboarded=0` via `POST /api/settings`.

- [ ] **Pause banner:** with `paused=0`, the "Engine paused" banner is hidden. Click Pause → banner shows with reason; Resume → hides.
- [ ] **Wizard:** on a fresh DB the modal appears; Connect LinkedIn opens the login window and the state flips to "Connected ✓"; Next → account-type step; Finish persists `account_type` + `onboarded=1` and closes. Reload → wizard does not reappear.
- [ ] **Add List:** paste URLs → "N profiles detected" + "Enqueue N"; drop a `.csv`/`.txt` → text loads; leave name blank → list lands in the dated cohort; pick an existing cohort from the dropdown → name locks and template prefills; enqueue works.
- [ ] **Note checkbox gone:** no "Allow sending without a note" anywhere; a list with a blank template creates a cohort with `allow_no_note=1`, a non-blank template → `allow_no_note=0` (verify via `GET /api/cohorts`).
- [ ] **Single-profile API:** `POST /api/profiles { url, message }` (no cohort) → profile in the dated cohort with the custom message.

- [ ] **Final:** `npx vitest run` all green; `npm run typecheck` clean.

---

## Self-Review (completed)

- **Spec coverage:** ① pause banner (done, re-verified in Task 8) · ② wizard (Task 5, column Task 3 for `onboarded`) · ③ remove checkbox + derive flag (Tasks 2, 4, 6) · ④ Add List rebuild (Task 6) · ⑤ optional cohort on both endpoints (Tasks 1, 4). All covered.
- **Type consistency:** `defaultCohortName(Date)`, `deriveAllowNoNote(string|null|undefined)`, `runMigrations(DB)`, `Settings.onboarded:number` used consistently across tasks. Client mirrors (`todayCohortName`, `countProfiles`) intentionally duplicate server logic because the browser can't import server modules.
- **Placeholder scan:** none.
