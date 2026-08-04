# Settings Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No settings value can reach the database outside a sane range, and the operator finds
out in the form rather than by watching a queue that never drains.

**Architecture:** One rule table in `src/core/settings-rules.ts` holding `{ label, min, max }`
per numeric setting, plus a pure `validateSettingsPatch()`. `POST /api/settings` runs the
validator over the whole patch before writing anything. `GET /api/settings` returns the table,
and the dashboard form stamps `min`/`max`/`step` onto its inputs from it and re-checks the same
ranges before posting. The table is the only place a limit is written down — `index.html` stops
hardcoding them.

**Tech Stack:** TypeScript (server, run directly via `tsx`), vanilla JS (`src/web/app.js`, a
classic script with no module system), vitest + jsdom.

**Design spec:** `docs/superpowers/specs/2026-08-04-settings-validation-design.md`

**Two simplifications against that spec, both for a smaller diff:**
1. Out-of-range values found at load time show the same message as any other range failure
   (*"Reply checks / day must be between 1 and 4."*) rather than a bespoke "is now capped at…"
   sentence. The offending value is visible in the box beside the message, so the second
   wording added a code path without adding information.
2. The form does not render the server's `fields[]`. It validates the same rules locally, so a
   server rejection is unreachable from the dashboard; it toasts the server's `error` sentence
   if one ever arrives. `fields[]` stays in the response for API consumers. This avoids
   changing the shared `api()` helper, which currently discards response bodies.

---

### Task 1: The rule table

**Files:**
- Create: `src/core/settings-rules.ts`
- Test: `tests/core/settings-rules.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/core/settings-rules.test.ts`:

```ts
/**
 * The settings rule table.
 *
 * The load-bearing test here is the defaults one: a ceiling accidentally set below a value
 * schema.sql ships would make every fresh install start in a state the API rejects, and
 * nothing else in the suite would notice.
 */
import { test, expect } from 'vitest';
import { SETTING_RULES } from '../../src/core/settings-rules.js';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';

/** Every key the Settings form posts. Kept literal so a dropped rule fails loudly here. */
const FORM_KEYS = [
  'weekly_cap', 'batch_size', 'batches_per_day',
  'msg_weekly_cap', 'msg_batch_size', 'msg_batches_per_day', 'reply_checks_per_day',
  'events_per_day', 'event_invite_cap', 'event_bucket_ceiling', 'event_run_budget_minutes',
  'engage_weekly_cap', 'engage_batch_size', 'engage_batches_per_day', 'engage_comment_daily_cap',
  'workday_start_hour', 'workday_end_hour', 'roster_sync_per_day',
];

test('every field the Settings form posts has a rule', () => {
  for (const key of FORM_KEYS) {
    expect(SETTING_RULES[key], `no rule for ${key}`).toBeDefined();
  }
});

test('the API-only numeric keys are ruled too', () => {
  for (const key of ['min_delay_ms', 'max_delay_ms', 'enrich_ttl_days', 'enrich_concurrency', 'event_shard_threshold']) {
    expect(SETTING_RULES[key], `no rule for ${key}`).toBeDefined();
  }
});

test('every rule is a sane integer range with a label', () => {
  for (const [key, rule] of Object.entries(SETTING_RULES)) {
    expect(Number.isInteger(rule.min), `${key} min`).toBe(true);
    expect(Number.isInteger(rule.max), `${key} max`).toBe(true);
    expect(rule.min, `${key} min <= max`).toBeLessThanOrEqual(rule.max);
    expect(rule.label.length, `${key} label`).toBeGreaterThan(0);
  }
});

test('every schema.sql default falls inside its own rule', () => {
  const repos = new Repos(openDatabase(':memory:'));
  const defaults = repos.settings.get() as unknown as Record<string, number>;
  for (const [key, rule] of Object.entries(SETTING_RULES)) {
    const value = defaults[key];
    expect(typeof value, `${key} missing from the settings row`).toBe('number');
    expect(value, `${key} default ${value} is outside ${rule.min}..${rule.max}`)
      .toBeGreaterThanOrEqual(rule.min);
    expect(value).toBeLessThanOrEqual(rule.max);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/settings-rules.test.ts`
Expected: FAIL — `Cannot find module '../../src/core/settings-rules.js'`

- [ ] **Step 3: Write the rule table**

Create `src/core/settings-rules.ts`:

```ts
/**
 * Range rules for every numeric setting, and the validator both writers run.
 *
 * One table, two consumers. The server imports it directly; the browser receives it on
 * GET /api/settings and stamps min/max/step onto the form inputs. That is why index.html
 * carries no min/max of its own any more — a limit written in two places drifts, and the
 * copy in the HTML is the one nobody remembers to update.
 *
 * Most ceilings here are pacing decisions rather than arithmetic ones: they are bounded by
 * what LinkedIn tolerates, not by what the code can represent, so each carries its reasoning.
 * `label` is operator-facing and goes verbatim into the 400 body, which is what the
 * non-technical reader in RUNBOOK.md ends up seeing.
 *
 * Declaration order is significant: it fixes which failure a multi-failure patch reports as
 * its headline `error`, so the same patch always produces the same sentence.
 */
import type { Settings } from '../types.js';

export interface SettingRule {
  /** Operator-facing name. Appears verbatim in error text — not a column name. */
  label: string;
  min: number;
  max: number;
}

export const SETTING_RULES: Record<string, SettingRule> = {
  // --- Connection requests ---
  // LinkedIn's invite limit sits near 100/week. Past ~150 the outcome is a restriction on
  // the account, not a faster campaign.
  weekly_cap: { label: 'Weekly cap (invites)', min: 0, max: 150 },
  // Sends are spaced min_delay_ms..max_delay_ms apart (20-90s), so 25 in a batch is already
  // ~35 minutes of unbroken automation inside one browser session.
  batch_size: { label: 'Batch size (invites)', min: 1, max: 25 },
  batches_per_day: { label: 'Batches / day (invites)', min: 0, max: 12 },

  // --- Messages ---
  // A DM to a 1st-degree connection is cheaper than an invite; 100/day sustained is the top.
  msg_weekly_cap: { label: 'Weekly cap (messages)', min: 0, max: 700 },
  msg_batch_size: { label: 'Batch size (messages)', min: 1, max: 10 },
  msg_batches_per_day: { label: 'Batches / day (messages)', min: 0, max: 12 },
  reply_checks_per_day: { label: 'Reply checks / day', min: 1, max: 4 },

  // --- Event invites ---
  events_per_day: { label: 'Events / day', min: 0, max: 2 },
  // The LinkedIn invite picker hard-caps at 1000 rows (see schema.sql), so a larger cap
  // describes invitees that can never be reached.
  event_invite_cap: { label: 'Invites / event', min: 1, max: 1000 },
  event_bucket_ceiling: { label: 'Locations / run', min: 1, max: 50 },
  event_run_budget_minutes: { label: 'Run budget (minutes)', min: 1, max: 120 },

  // --- Post engagements ---
  // A reaction is the cheapest action the engine takes; ~140/day is the plausible top.
  engage_weekly_cap: { label: 'Weekly cap (reactions)', min: 0, max: 1000 },
  // No composer and no page dwell, so a bigger batch than an invite's is fine.
  engage_batch_size: { label: 'Batch size (reactions)', min: 1, max: 50 },
  engage_batches_per_day: { label: 'Batches / day (reactions)', min: 0, max: 12 },
  // Public and attributable, so deliberately an order of magnitude below reactions.
  engage_comment_daily_cap: { label: 'Comments / day', min: 0, max: 50 },

  // --- Both engines ---
  workday_start_hour: { label: 'Workday start hour', min: 0, max: 23 },
  workday_end_hour: { label: 'Workday end hour', min: 0, max: 23 },
  roster_sync_per_day: { label: 'Connection syncs / day', min: 1, max: 24 },

  // --- API-only. No form input; ruled because POST /api/settings accepts them and a
  //     negative send delay would remove the pacing that protects the account. ---
  min_delay_ms: { label: 'Minimum send delay (ms)', min: 5000, max: 600000 },
  max_delay_ms: { label: 'Maximum send delay (ms)', min: 5000, max: 600000 },
  enrich_ttl_days: { label: 'Enrichment TTL (days)', min: 1, max: 3650 },
  // No LinkedIn risk — bounded only by the operator's Apify plan.
  enrich_concurrency: { label: 'Enrichment concurrency', min: 1, max: 32 },
  // Above the picker's 1000-row cap the threshold could never trigger.
  event_shard_threshold: { label: 'Event shard threshold', min: 1, max: 1000 },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/settings-rules.test.ts`
Expected: PASS, 4 tests.

If the defaults test fails, the rule is wrong, not the default — `schema.sql` ships what
production already runs. Widen the rule.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/core/settings-rules.ts tests/core/settings-rules.test.ts
git commit -m "feat: add the settings rule table"
```

---

### Task 2: The validator

**Files:**
- Modify: `src/core/settings-rules.ts` (append)
- Modify: `tests/core/settings-rules.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/core/settings-rules.test.ts`:

```ts
import { validateSettingsPatch } from '../../src/core/settings-rules.js';
import type { Settings } from '../../src/types.js';

/** The stored row a patch is validated against. Defaults, so cross-field rules start valid. */
function stored(over: Partial<Settings> = {}): Settings {
  const repos = new Repos(openDatabase(':memory:'));
  return { ...repos.settings.get(), ...over };
}

test('a valid patch produces no failures', () => {
  expect(validateSettingsPatch({ weekly_cap: 120, batch_size: 5 }, stored())).toEqual([]);
});

test('an out-of-range value fails with the operator-facing label', () => {
  const [f] = validateSettingsPatch({ weekly_cap: 5000 }, stored());
  expect(f.key).toBe('weekly_cap');
  expect(f.message).toBe('Weekly cap (invites) must be between 0 and 150.');
});

test('a non-integer fails even when it is inside the range', () => {
  const [f] = validateSettingsPatch({ batches_per_day: 3.5 }, stored());
  expect(f.message).toBe('Batches / day (invites) must be a whole number.');
});

test('a non-number fails rather than coercing', () => {
  expect(validateSettingsPatch({ weekly_cap: '10' }, stored())).toHaveLength(1);
});

test('unruled keys are ignored, not rejected', () => {
  expect(validateSettingsPatch({ paused: 1, pause_reason: 'x', apify_api_key: 'k' }, stored())).toEqual([]);
});

test('every failing key is reported, not just the first', () => {
  const out = validateSettingsPatch({ weekly_cap: 5000, batch_size: 0 }, stored());
  expect(out.map((f) => f.key)).toEqual(['weekly_cap', 'batch_size']);
});

test('failures come back in table order regardless of patch key order', () => {
  const out = validateSettingsPatch({ batch_size: 0, weekly_cap: 5000 }, stored());
  expect(out.map((f) => f.key)).toEqual(['weekly_cap', 'batch_size']);
});

test('an inverted workday window is rejected', () => {
  const [f] = validateSettingsPatch({ workday_start_hour: 18, workday_end_hour: 9 }, stored());
  expect(f.key).toBe('workday_end_hour');
  expect(f.message).toBe('Workday end hour must be after the start hour (currently 18).');
});

test('an equal workday window is rejected — it sends nothing', () => {
  expect(validateSettingsPatch({ workday_start_hour: 9, workday_end_hour: 9 }, stored())).toHaveLength(1);
});

// The half-patch case: the form posts both hours, but an agent following API.md may send one.
test('a one-sided workday patch is checked against the stored other side', () => {
  expect(validateSettingsPatch({ workday_end_hour: 6 }, stored({ workday_start_hour: 8 }))).toHaveLength(1);
  expect(validateSettingsPatch({ workday_start_hour: 22 }, stored({ workday_end_hour: 20 }))).toHaveLength(1);
});

/* An install can already hold an inverted window — nothing stopped it before this feature.
   Rejecting an unrelated patch because of it would strand that operator: they could not
   even pause the engine through settings. */
test('an already-inverted stored window does not fail an unrelated patch', () => {
  const bad = stored({ workday_start_hour: 18, workday_end_hour: 9 });
  expect(validateSettingsPatch({ weekly_cap: 50 }, bad)).toEqual([]);
});

test('a range failure on an hour suppresses the cross-field message', () => {
  const out = validateSettingsPatch({ workday_end_hour: 99 }, stored());
  expect(out).toHaveLength(1);                       // not also "must be after the start hour"
  expect(out[0].message).toBe('Workday end hour must be between 0 and 23.');
});

test('max_delay_ms below min_delay_ms is rejected, equal is allowed', () => {
  expect(validateSettingsPatch({ min_delay_ms: 90000, max_delay_ms: 20000 }, stored())).toHaveLength(1);
  expect(validateSettingsPatch({ min_delay_ms: 30000, max_delay_ms: 30000 }, stored())).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/settings-rules.test.ts`
Expected: FAIL — `validateSettingsPatch is not a function`

- [ ] **Step 3: Write the validator**

Append to `src/core/settings-rules.ts`:

```ts
export interface SettingFailure { key: string; message: string; }

/**
 * The value a patch will leave in place for `key`: the patched one when present, otherwise
 * what is stored. Cross-field rules read this so a patch touching only one side of a pair is
 * still checked against the other.
 */
function effective(patch: Record<string, unknown>, current: Settings, key: keyof Settings): number {
  return key in patch ? (patch[key] as number) : (current[key] as number);
}

/**
 * Every rule violation in a patch, in table order. Empty means the patch is safe to apply.
 *
 * Two deliberate restraints:
 *  - A cross-field rule runs ONLY when the patch touches one of its keys. An install can
 *    already hold an inverted workday window — nothing rejected one before this existed — and
 *    failing every unrelated patch on account of it would leave that operator unable to change
 *    anything at all, including pausing.
 *  - A cross-field rule is skipped when either of its keys already failed its own range.
 *    "must be after the start hour" stacked on "must be between 0 and 23" is noise.
 */
export function validateSettingsPatch(
  patch: Record<string, unknown>,
  current: Settings,
): SettingFailure[] {
  const failures: SettingFailure[] = [];

  for (const [key, rule] of Object.entries(SETTING_RULES)) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      failures.push({ key, message: `${rule.label} must be a whole number.` });
    } else if (value < rule.min || value > rule.max) {
      failures.push({ key, message: `${rule.label} must be between ${rule.min} and ${rule.max}.` });
    }
  }

  const failed = new Set(failures.map((f) => f.key));
  const checkable = (a: string, b: string) => (a in patch || b in patch) && !failed.has(a) && !failed.has(b);

  if (checkable('workday_start_hour', 'workday_end_hour')) {
    const start = effective(patch, current, 'workday_start_hour');
    const end = effective(patch, current, 'workday_end_hour');
    // Equal is rejected alongside inverted: a zero-length window schedules nothing, silently.
    if (end <= start) {
      failures.push({
        key: 'workday_end_hour',
        message: `Workday end hour must be after the start hour (currently ${start}).`,
      });
    }
  }

  if (checkable('min_delay_ms', 'max_delay_ms')) {
    const lo = effective(patch, current, 'min_delay_ms');
    const hi = effective(patch, current, 'max_delay_ms');
    // Equal is fine here — a fixed delay is deterministic, not broken. Only inverted fails.
    if (hi < lo) {
      failures.push({
        key: 'max_delay_ms',
        message: `Maximum send delay must be at least the minimum (${lo} ms).`,
      });
    }
  }

  return failures;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/settings-rules.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/core/settings-rules.ts tests/core/settings-rules.test.ts
git commit -m "feat: validate a settings patch against the rule table"
```

---

### Task 3: Enforce on the API

**Files:**
- Modify: `src/api/server.ts` (imports; `GET`/`POST /api/settings` at lines 1004-1013)
- Test: `tests/api/settings-validation.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/api/settings-validation.test.ts`:

```ts
/**
 * POST /api/settings range enforcement.
 *
 * The property that matters most is atomicity: a patch carrying one bad value must leave the
 * whole row untouched. Applying the legal half would put the engine in a state the operator
 * never asked for and cannot see.
 */
import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { FakeDriver } from '../../src/browser/driver.js';
import { buildServer } from '../../src/api/server.js';

let app: ReturnType<typeof buildServer>;
let repos: Repos;

beforeEach(() => {
  repos = new Repos(openDatabase(':memory:'));
  app = buildServer(repos, new FakeDriver());
});

const post = (payload: unknown) => app.inject({ method: 'POST', url: '/api/settings', payload });

test('an out-of-range value is a 400 naming the field in operator language', async () => {
  const res = await post({ weekly_cap: 5000 });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toBe('Weekly cap (invites) must be between 0 and 150.');
});

test('a rejected patch writes nothing at all', async () => {
  const before = repos.settings.get().batch_size;
  const res = await post({ batch_size: 7, weekly_cap: 5000 });   // one legal, one not
  expect(res.statusCode).toBe(400);
  expect(repos.settings.get().batch_size).toBe(before);          // the legal half did NOT land
});

test('a non-integer is rejected', async () => {
  expect((await post({ batches_per_day: 3.5 })).statusCode).toBe(400);
});

test('an inverted workday window is rejected', async () => {
  const res = await post({ workday_start_hour: 18, workday_end_hour: 9 });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toContain('must be after the start hour');
});

test('every failure comes back in fields[], with the first also as error', async () => {
  const body = (await post({ weekly_cap: 5000, batch_size: 0 })).json();
  expect(body.fields.map((f: { key: string }) => f.key)).toEqual(['weekly_cap', 'batch_size']);
  expect(body.error).toBe(body.fields[0].message);
});

test('an API-only key is ruled too', async () => {
  expect((await post({ min_delay_ms: -5 })).statusCode).toBe(400);
  expect((await post({ min_delay_ms: 30000 })).statusCode).toBe(200);
});

test('unruled keys still pass through untouched', async () => {
  expect((await post({ onboarded: 1, pause_reason: 'x' })).statusCode).toBe(200);
  expect(repos.settings.get().onboarded).toBe(1);
});

test('a valid patch still saves and echoes the settings back', async () => {
  const res = await post({ weekly_cap: 120 });
  expect(res.statusCode).toBe(200);
  expect(res.json().weekly_cap).toBe(120);
  expect(repos.settings.get().weekly_cap).toBe(120);
});

test('GET /api/settings serves the rule table for the form to stamp', async () => {
  const body = (await app.inject({ method: 'GET', url: '/api/settings' })).json();
  expect(body.rules.weekly_cap).toEqual({ label: 'Weekly cap (invites)', min: 0, max: 150 });
  expect(body.apify_key_set).toBe(false);        // the secret handling is unchanged
  expect(body.apify_api_key).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/api/settings-validation.test.ts`
Expected: FAIL — the 400 tests get `200`, and `body.rules` is `undefined`.

- [ ] **Step 3: Wire the validator into the routes**

In `src/api/server.ts`, add to the import block (after the `engagementCaps` import on line 39):

```ts
import { SETTING_RULES, validateSettingsPatch } from '../core/settings-rules.js';
```

Replace lines 1004-1013 entirely:

```ts
  // `rules` rides along so the form can stamp min/max/step onto its inputs — index.html
  // hardcodes no limits, which is what keeps the two from drifting.
  app.get('/api/settings', async () => ({ ...publicSettings(repos.settings.get()), rules: SETTING_RULES }));
  app.post('/api/settings', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const k of Object.keys(body)) {
      if (ALLOWED_SETTINGS_KEYS.has(k)) patch[k] = body[k];
    }
    // Validated as a whole BEFORE the write. Applying the legal half of a bad patch would
    // leave the engine paced by numbers nobody chose, with nothing on screen to say so.
    // `error` is the one sentence agents relay to the operator (see CLAUDE.md); `fields`
    // is the machine-readable rest, which matters for the API-only keys that have no form.
    const failures = validateSettingsPatch(patch, repos.settings.get());
    if (failures.length) {
      return reply.code(400).send({ error: failures[0].message, fields: failures });
    }
    repos.settings.update(patch as any);
    return publicSettings(repos.settings.get());
  });
```

- [ ] **Step 4: Run the new test and the whole API suite**

Run: `npx vitest run tests/api/settings-validation.test.ts`
Expected: PASS, 9 tests.

Run: `npx vitest run tests/api tests/worker`
Expected: PASS. Every pre-existing settings payload in the suite is inside the new ranges
(`weekly_cap` 42/33/100, `msg_weekly_cap` 200/0/150, `event_invite_cap` 250/42,
`roster_sync_per_day` 4, `engage_*` 200/4/2/3), so nothing here should need changing. If
something does fail, check the payload against the table before widening a rule.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/api/server.ts tests/api/settings-validation.test.ts
git commit -m "feat: reject out-of-range settings at the API"
```

---

### Task 4: One field map on the client

Pure refactor, no behaviour change. The id↔key mapping is currently written out twice; adding
validation would make it three copies.

**Files:**
- Modify: `src/web/app.js` (`loadSettings` at 1768-1793; `initSettings` at 2539-2572)
- Modify: `tests/web/helpers/load-app.ts`
- Test: `tests/web/settings-form.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/web/settings-form.test.ts`:

```ts
// @vitest-environment jsdom
/// <reference lib="dom" />
/**
 * The Settings form controller (src/web/app.js).
 *
 * Load and submit walk one SETTINGS_FIELDS map, so these tests pin the round trip: what the
 * server sends reaches the right inputs, and what the inputs hold reaches the right keys.
 */
import { test, expect, beforeEach, afterEach } from 'vitest';
import { loadApp, byId, stubFetchRoutes, type AppInternals } from './helpers/load-app.js';

let app: AppInternals;
const realFetch = globalThis.fetch;

beforeEach(() => {
  app = loadApp();
  // loadApp() never runs init(), so the submit listener does not exist until this is called.
  app.initSettings();
});
afterEach(() => { globalThis.fetch = realFetch; });

/** A settings payload with the handful of keys these tests assert on. */
const SETTINGS = {
  weekly_cap: 120, batch_size: 5, reply_checks_per_day: 2,
  workday_start_hour: 8, workday_end_hour: 20,
  rules: {
    weekly_cap: { label: 'Weekly cap (invites)', min: 0, max: 150 },
    reply_checks_per_day: { label: 'Reply checks / day', min: 1, max: 4 },
    workday_start_hour: { label: 'Workday start hour', min: 0, max: 23 },
    workday_end_hour: { label: 'Workday end hour', min: 0, max: 23 },
  },
};

/**
 * Route every endpoint loadSettings() reaches, not just /api/settings — it fans out to
 * renderApifyKey, refreshConnections (which tails into refreshEnrichment, outside its own
 * catch) and loadLogs. stubFetchRoutes matches by longest prefix and throws on anything
 * unrouted, so a missing entry surfaces as a confusing async failure rather than a skip.
 */
function stubSettings(over: Record<string, unknown> = {}) {
  return stubFetchRoutes({
    '/api/settings': { body: { ...SETTINGS, ...over } },
    '/api/connections': { body: { total: 0, by_enrich_status: {}, last_synced_at: null } },
    '/api/enrichment': { body: {} },
    '/api/logs': { body: { lines: [] } },
  });
}

test('loaded values land in their inputs', async () => {
  stubSettings();
  await app.loadSettings();
  expect(byId<HTMLInputElement>('setWeeklyCap').value).toBe('120');
  expect(byId<HTMLInputElement>('setEnd').value).toBe('20');
});

test('the served rules become min/max/step on the inputs', async () => {
  stubSettings();
  await app.loadSettings();
  const cap = byId<HTMLInputElement>('setWeeklyCap');
  expect(cap.min).toBe('0');
  expect(cap.max).toBe('150');
  expect(cap.step).toBe('1');
});

/* An older server, or any test stubbing this endpoint, sends no `rules`. The form must still
   render its values rather than throwing partway through. */
test('a response with no rules still populates the form', async () => {
  stubSettings({ rules: undefined });
  await app.loadSettings();
  expect(byId<HTMLInputElement>('setWeeklyCap').value).toBe('120');
});

test('submitting posts every field, keyed by setting name', async () => {
  const calls = stubSettings();
  await app.loadSettings();
  byId<HTMLInputElement>('setWeeklyCap').value = '90';
  byId('settingsForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
  const post = calls.find((c) => c.path === '/api/settings' && c.method === 'POST')!;
  expect((post.body as Record<string, number>).weekly_cap).toBe(90);
  expect((post.body as Record<string, number>).workday_end_hour).toBe(20);
});
```

- [ ] **Step 2: Expose the internals to the harness**

In `tests/web/helpers/load-app.ts`, add to the `AppInternals` interface (after
`renderApifyKey` on line 36):

```ts
  loadSettings: () => Promise<void>;
  initSettings: () => void;
```

and add `loadSettings, initSettings, ` to the `return {…}` string inside the `new Function`
call on line 76.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/web/settings-form.test.ts`
Expected: FAIL — the min/max test gets `''`, since nothing stamps them yet.

- [ ] **Step 4: Add the field map and rewrite both walkers**

In `src/web/app.js`, replace `loadSettings` (lines 1768-1793) with:

```js
/**
 * The Settings form's numeric fields, in one place.
 *
 * Load, validation and submit all walk this list. The id<->key mapping used to be spelled
 * out separately in loadSettings() and in the submit handler, which meant a new setting had
 * to be added in two places and a typo in either was silent.
 */
const SETTINGS_FIELDS = [
  { key: 'weekly_cap', id: 'setWeeklyCap' },
  { key: 'batch_size', id: 'setBatchSize' },
  { key: 'batches_per_day', id: 'setBatchesPerDay' },
  { key: 'msg_weekly_cap', id: 'setMsgWeeklyCap' },
  { key: 'msg_batch_size', id: 'setMsgBatchSize' },
  { key: 'msg_batches_per_day', id: 'setMsgBatchesPerDay' },
  { key: 'reply_checks_per_day', id: 'setReplyChecks' },
  { key: 'workday_start_hour', id: 'setStart' },
  { key: 'workday_end_hour', id: 'setEnd' },
  { key: 'roster_sync_per_day', id: 'setRosterSync' },
  { key: 'events_per_day', id: 'setEventsPerDay' },
  { key: 'event_invite_cap', id: 'setEventInviteCap' },
  { key: 'event_bucket_ceiling', id: 'setEventBucketCeiling' },
  { key: 'event_run_budget_minutes', id: 'setEventBudget' },
  { key: 'engage_weekly_cap', id: 'setEngageWeeklyCap' },
  { key: 'engage_batch_size', id: 'setEngageBatchSize' },
  { key: 'engage_batches_per_day', id: 'setEngageBatchesPerDay' },
  { key: 'engage_comment_daily_cap', id: 'setEngageCommentCap' },
];

/** Ranges from the last GET /api/settings, keyed by setting name. Empty until one lands. */
let settingRules = {};

/**
 * Stamp the server's ranges onto the inputs, so index.html holds no limits of its own.
 *
 * Tolerates a response carrying no `rules` — an older server, or a test stubbing the
 * endpoint. The inputs keep type=number, the local check finds no rule and skips, and POST
 * still rejects anything out of range. Degraded, never broken.
 */
function applySettingRules(rules) {
  settingRules = rules || {};
  SETTINGS_FIELDS.forEach(({ key, id }) => {
    const rule = settingRules[key];
    const input = $(`#${id}`);
    if (!rule || !input) return;
    input.min = String(rule.min);
    input.max = String(rule.max);
    input.step = '1';
  });
}

async function loadSettings() {
  try {
    const s = await api('/api/settings');
    applySettingRules(s.rules);
    SETTINGS_FIELDS.forEach(({ key, id }) => {
      const input = $(`#${id}`);
      if (input) input.value = s[key] ?? '';
    });
    renderApifyKey(s);
    refreshConnections();
    loadLogs();
  } catch (_) { /* ignore */ }
}
```

Then in `initSettings` (line 2539), replace the `num` helper and the `patch` literal
(lines 2543-2564) with:

```js
    const patch = {};
    SETTINGS_FIELDS.forEach(({ key, id }) => {
      const v = $(`#${id}`).value;
      if (v !== '') patch[key] = Number(v);
    });
```

Leave the `try`/`catch` that follows untouched.

- [ ] **Step 5: Run the test and the whole web suite**

Run: `npx vitest run tests/web`
Expected: PASS. `tests/web/enrichment-panel.test.ts` stubs `/api/settings` without `rules`,
which the tolerance in `applySettingRules` covers.

- [ ] **Step 6: Commit**

```bash
git add src/web/app.js tests/web/settings-form.test.ts tests/web/helpers/load-app.ts
git commit -m "refactor: drive the settings form from one field map"
```

---

### Task 5: Validate in the form

**Files:**
- Modify: `src/web/app.js` (`initSettings`, and `loadSettings` from Task 4)
- Modify: `src/web/index.html` (form tag at 733; inputs at 742-790)
- Modify: `src/web/styles.css` (after the `.hint` rule at line 735)
- Modify: `tests/web/settings-form.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/web/settings-form.test.ts`:

```ts
/** Submit and let the async handler settle. Returns the fetches it made. */
async function submit() {
  byId('settingsForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
}

test('an out-of-range entry blocks the save and marks the field', async () => {
  const calls = stubSettings();
  await app.loadSettings();
  const before = calls.length;
  byId<HTMLInputElement>('setWeeklyCap').value = '5000';
  await submit();

  expect(calls.length).toBe(before);                                  // nothing was posted
  const err = byId('setWeeklyCap').closest('.field')!.querySelector('.field-error')!;
  expect(err.textContent).toBe('Weekly cap (invites) must be between 0 and 150.');
  expect(byId('setWeeklyCap').getAttribute('aria-invalid')).toBe('true');
});

test('a fixed value clears the error and lets the save through', async () => {
  const calls = stubSettings();
  await app.loadSettings();
  byId<HTMLInputElement>('setWeeklyCap').value = '5000';
  await submit();
  byId<HTMLInputElement>('setWeeklyCap').value = '90';
  await submit();

  expect(byId('setWeeklyCap').closest('.field')!.querySelector('.field-error')).toBeNull();
  expect(calls.some((c) => c.method === 'POST')).toBe(true);
});

test('an inverted workday window is caught in the form', async () => {
  const calls = stubSettings();
  await app.loadSettings();
  const before = calls.length;
  byId<HTMLInputElement>('setStart').value = '18';
  byId<HTMLInputElement>('setEnd').value = '9';
  await submit();

  expect(calls.length).toBe(before);
  const err = byId('setEnd').closest('.field')!.querySelector('.field-error')!;
  expect(err.textContent).toBe('Workday end hour must be after the start hour (currently 18).');
});

/* The two tightened ceilings (reply checks 24->4, events/day 10->2) mean a live database can
   hold a value the rules now reject. Flagging it only on submit would reject a field the
   operator never touched, with no clue which one. */
test('a stored value the rules now reject is flagged the moment Settings opens', async () => {
  stubSettings({ reply_checks_per_day: 6 });
  await app.loadSettings();

  const err = byId('setReplyChecks').closest('.field')!.querySelector('.field-error')!;
  expect(err.textContent).toBe('Reply checks / day must be between 1 and 4.');
});

test('a whole-number rule rejects a decimal', async () => {
  stubSettings();
  await app.loadSettings();
  byId<HTMLInputElement>('setWeeklyCap').value = '12.5';
  await submit();
  const err = byId('setWeeklyCap').closest('.field')!.querySelector('.field-error')!;
  expect(err.textContent).toBe('Weekly cap (invites) must be a whole number.');
});

test('several failures are counted in the toast, not listed', async () => {
  stubSettings();
  await app.loadSettings();
  byId<HTMLInputElement>('setWeeklyCap').value = '5000';
  byId<HTMLInputElement>('setReplyChecks').value = '99';
  await submit();
  expect(byId('settingsResult').textContent).toBe('Fix 2 settings before saving.');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/web/settings-form.test.ts`
Expected: FAIL — no `.field-error` element exists; the blocked-save tests see a POST go out.

- [ ] **Step 3: Add error rendering and the check**

In `src/web/app.js`, insert after `applySettingRules` (from Task 4):

```js
/**
 * Show or clear one field's error message.
 *
 * The <p> is created on demand rather than shipped empty in index.html — eighteen unused
 * error slots would be eighteen more things to keep in step with SETTINGS_FIELDS.
 */
function setFieldError(input, message) {
  const field = input.closest('.field');
  if (!field) return;
  let note = field.querySelector('.field-error');
  if (!message) {
    if (note) note.remove();
    input.classList.remove('is-invalid');
    input.removeAttribute('aria-invalid');
    input.removeAttribute('aria-describedby');
    return;
  }
  if (!note) {
    note = document.createElement('p');
    note.className = 'field-error';
    note.id = `${input.id}-err`;
    field.appendChild(note);
  }
  note.textContent = message;
  input.classList.add('is-invalid');
  input.setAttribute('aria-invalid', 'true');
  input.setAttribute('aria-describedby', note.id);
}

/**
 * Check every settings input against the served rules, marking each offending field.
 * Returns the failures; empty means the form is safe to post.
 *
 * Runs on load as well as on submit. Two ceilings tightened when this shipped (reply checks
 * 24->4, events/day 10->2), so a database written by an older build can hold a value the
 * rules now reject. The load-time pass names it the moment Settings opens, rather than
 * letting the operator edit something unrelated and get a rejection about a field they
 * never touched.
 *
 * The rules come from the server, so this can only ever agree with what POST will accept —
 * but POST re-checks regardless. This is the message, not the guarantee.
 */
function validateSettings() {
  const failures = [];
  const values = {};
  SETTINGS_FIELDS.forEach(({ key, id }) => {
    const input = $(`#${id}`);
    if (!input) return;
    setFieldError(input, null);
    if (input.value === '') return;
    const n = Number(input.value);
    values[key] = n;
    const rule = settingRules[key];
    if (!rule) return;
    let message = null;
    if (!Number.isInteger(n)) message = `${rule.label} must be a whole number.`;
    else if (n < rule.min || n > rule.max) message = `${rule.label} must be between ${rule.min} and ${rule.max}.`;
    if (message) { setFieldError(input, message); failures.push({ id, message }); }
  });

  // The one cross-field rule with two form fields. Skipped when either hour already failed
  // its own range — "must be after the start hour" stacked on "must be between 0 and 23" is
  // noise, and the server applies the same restraint.
  const alreadyBad = failures.some((f) => f.id === 'setStart' || f.id === 'setEnd');
  if (!alreadyBad && values.workday_start_hour !== undefined && values.workday_end_hour !== undefined
      && values.workday_end_hour <= values.workday_start_hour) {
    const message = `Workday end hour must be after the start hour (currently ${values.workday_start_hour}).`;
    setFieldError($('#setEnd'), message);
    failures.push({ id: 'setEnd', message });
  }
  return failures;
}
```

Add the load-time pass to `loadSettings`, immediately after the value-setting `forEach`:

```js
    validateSettings();   // flag anything the stored row already violates
```

In `initSettings`, insert at the top of the handler, right after `const result = …`:

```js
    // Local check first: no request goes out for a value the server would only reject.
    const failures = validateSettings();
    if (failures.length) {
      const first = $(`#${failures[0].id}`);
      if (first) first.focus();
      toast(result, failures.length === 1 ? failures[0].message : `Fix ${failures.length} settings before saving.`, true);
      return;
    }
```

- [ ] **Step 4: Strip the hardcoded limits from index.html**

The rules are now stamped at load, so the attributes in the HTML are a second copy that can
only drift. On line 733, add `novalidate` to the form (our messages replace the native
bubbles, which surface one field at a time and would compete):

```html
      <form id="settingsForm" class="form-grid settings-grid card-surface" novalidate>
```

Then in lines 742-790, remove every `min="…"` and `max="…"` from the eighteen numeric
`input` elements, leaving `type="number"`. For example line 757 becomes:

```html
        <div class="field"><label for="setReplyChecks">Reply checks / day <span class="hint">1–24</span></label><input id="setReplyChecks" type="number" /></div>
```

Two `hint` spans quote a range in prose and are now wrong. Update them:
- line 757: `<span class="hint">1–24</span>` → `<span class="hint">1–4</span>`
- line 790: `<span class="hint">1–24</span>` → leave as is (`roster_sync_per_day` is still 1–24)

- [ ] **Step 5: Style the error state**

In `src/web/styles.css`, after the `.hint code` rule (line 736):

```css
/* Inline validation on the Settings form. That form is `novalidate`, so these are the only
   messages the operator gets — the native bubbles show one field at a time and would fight
   with a form that marks every bad value at once. */
.field-error { margin: 0; font-size: 12.5px; font-weight: 500; color: var(--red); }
input.is-invalid { border-color: var(--red); background: var(--red-bg); }
input.is-invalid:focus { border-color: var(--red); box-shadow: 0 0 0 4px rgba(214, 58, 58, 0.18); }
```

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: PASS across all files.

Run: `npm run typecheck`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add src/web/app.js src/web/index.html src/web/styles.css tests/web/settings-form.test.ts
git commit -m "feat: validate settings values in the form before posting"
```

---

### Task 6: Document the contract

**Files:**
- Modify: `API.md` (the settings section near line 738, and the endpoint list near line 826)

- [ ] **Step 1: Add the ranges and the 400 shape**

In `API.md`, at the end of the `### Settings` section that ends around line 744 (just before
`## Queue`), add:

```markdown
#### Ranges

Every numeric setting is checked on write. A value outside its range, or one that is not a
whole number, is a `400` and **nothing in the patch is applied** — not even the keys that
were fine.

| Key | Range | | Key | Range |
|---|---|---|---|---|
| `weekly_cap` | 0–150 | | `engage_weekly_cap` | 0–1000 |
| `batch_size` | 1–25 | | `engage_batch_size` | 1–50 |
| `batches_per_day` | 0–12 | | `engage_batches_per_day` | 0–12 |
| `msg_weekly_cap` | 0–700 | | `engage_comment_daily_cap` | 0–50 |
| `msg_batch_size` | 1–10 | | `workday_start_hour` | 0–23 |
| `msg_batches_per_day` | 0–12 | | `workday_end_hour` | 0–23 |
| `reply_checks_per_day` | 1–4 | | `roster_sync_per_day` | 1–24 |
| `events_per_day` | 0–2 | | `min_delay_ms` | 5000–600000 |
| `event_invite_cap` | 1–1000 | | `max_delay_ms` | 5000–600000 |
| `event_bucket_ceiling` | 1–50 | | `enrich_ttl_days` | 1–3650 |
| `event_run_budget_minutes` | 1–120 | | `enrich_concurrency` | 1–32 |
| `event_shard_threshold` | 1–1000 | | | |

Two cross-field rules apply on top, each checked against the stored value when the patch only
carries one side:

- `workday_end_hour` must be **strictly after** `workday_start_hour`. Equal hours is an empty
  send window, so it is rejected too.
- `max_delay_ms` must be at least `min_delay_ms`. Equal is allowed — that is a fixed delay.

A rejection carries a plain sentence in `error` and every failure in `fields`:

```json
{
  "error": "Weekly cap (invites) must be between 0 and 150.",
  "fields": [{ "key": "weekly_cap", "message": "Weekly cap (invites) must be between 0 and 150." }]
}
```

`error` repeats the first failure and is the sentence to relay to an operator. Keys with no
range (`paused`, `pause_reason`, `onboarded`, `weekdays_only`, `note_quota_exhausted`,
`expiry_days`, `apify_api_key`) are unaffected.

`GET /api/settings` returns the same ranges under `rules`, as
`{ "<key>": { "label", "min", "max" } }` — the dashboard form reads it to configure its inputs.
```

- [ ] **Step 2: Update the endpoint summary line**

Replace line 826:

```markdown
- `GET /api/settings`, `POST /api/settings` — pacing/limits (allow-listed keys only, range-checked; a `400` applies nothing).
```

- [ ] **Step 3: Check it renders in the Docs tab**

The dashboard renders API.md through `src/web/markdown.js`, which supports pipe tables and
fenced code. Start the server, open **Docs → API**, and confirm the new table and JSON block
render rather than appearing as raw pipes.

```bash
npm start
```

- [ ] **Step 4: Commit**

```bash
git add API.md
git commit -m "docs: document the settings ranges and the 400 shape"
```

---

## Verification

- [ ] `npm test` — full suite green
- [ ] `npm run typecheck` — clean
- [ ] Manual: open Settings, set **Weekly cap (invites)** to `5000`, hit Save. Expect a red
      border and *"Weekly cap (invites) must be between 0 and 150."* both under the field and
      in the toast (a lone failure repeats its own message rather than counting), and **no**
      network request in devtools.
- [ ] Manual: set start hour `18`, end hour `9`, Save. Expect the error on the end-hour field.
- [ ] Manual: fix both, Save. Expect *"Settings saved."* and the values to survive a reload.
- [ ] Manual: `curl -X POST localhost:4400/api/settings -H 'content-type: application/json' -d '{"weekly_cap":5000}'`
      returns `400` with the sentence, and `GET /api/settings` shows `weekly_cap` unchanged.
