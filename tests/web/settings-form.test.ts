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
import { SETTING_RULES, validateSettingsPatch } from '../../src/core/settings-rules.js';
import type { Settings } from '../../src/types.js';

let app: AppInternals;
const realFetch = globalThis.fetch;

beforeEach(() => {
  app = loadApp();
  // loadApp() never runs init(), so the submit listener does not exist until this is called.
  app.initSettings();
});
afterEach(() => { globalThis.fetch = realFetch; });

/**
 * A settings payload carrying a value for ALL eighteen form fields, and the real rule table.
 *
 * All eighteen, not just the keys under assertion: an empty box is a validation failure (a
 * number input reports '' for text it can't parse), so a partial payload would leave thirteen
 * fields empty and every submit test would drown in unrelated failures. The values below are
 * the schema.sql defaults, so this is also what a fresh install actually sends.
 *
 * `rules` is SETTING_RULES itself rather than a hand-copied subset, matching the server —
 * GET /api/settings spreads the same table (server.ts:1008). A hand-written copy here could
 * drift from the real ceilings and quietly assert the wrong sentence.
 */
const SETTINGS = {
  weekly_cap: 120, batch_size: 5, batches_per_day: 4,
  msg_weekly_cap: 250, msg_batch_size: 5, msg_batches_per_day: 6, reply_checks_per_day: 2,
  workday_start_hour: 8, workday_end_hour: 20, roster_sync_per_day: 2,
  events_per_day: 1, event_invite_cap: 500, event_bucket_ceiling: 10,
  event_run_budget_minutes: 20,
  engage_weekly_cap: 500, engage_batch_size: 15, engage_batches_per_day: 6,
  engage_comment_daily_cap: 10,
  rules: SETTING_RULES,
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

/*
 * The three below check the map itself rather than a code path through it.
 *
 * They exist because the behavioural tests above barely touch it: they name four fields, and
 * both walkers skip an input they can't find (`if (!input) return`). A mistyped id in any of
 * the other fourteen entries is therefore invisible — the setting silently stops loading and
 * saving, and every test still passes. These pin all 18 in both directions instead, the same
 * way the rule table is pinned against the real settings columns rather than a hand list.
 */

test('every id in SETTINGS_FIELDS resolves to an element', () => {
  const missing = app.SETTINGS_FIELDS.filter(({ id }) => !document.getElementById(id));
  expect(missing.map((f) => `${f.key} -> #${f.id}`)).toEqual([]);
});

test('every key in SETTINGS_FIELDS has a server-side rule', () => {
  const unruled = app.SETTINGS_FIELDS.filter(({ key }) => !SETTING_RULES[key]);
  expect(unruled.map((f) => f.key)).toEqual([]);
});

/* The reverse direction, so a new input added to the HTML can't sit there unwired. Scoped by
   containment and type rather than an id prefix: #setApifyKey is a password field in its own
   form, is write-only, and must never join this list. */
test('every numeric input in the settings form is in SETTINGS_FIELDS', () => {
  const mapped = new Set(app.SETTINGS_FIELDS.map((f) => f.id));
  const inputs = [...byId('settingsForm').querySelectorAll('input[type="number"]')];
  expect(inputs.map((el) => el.id).filter((id) => !mapped.has(id))).toEqual([]);
  expect(inputs).toHaveLength(app.SETTINGS_FIELDS.length);
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

/** Submit and let the async handler settle, so the caller's stub has recorded any POST. */
async function submit() {
  byId('settingsForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
}

/**
 * The writes the form has made. Counted rather than compared against `calls.length`, because
 * loadSettings() fans out to refreshConnections() without awaiting it and that chain tails
 * into GET /api/enrichment/status — a GET that lands during the submit tick and would make a
 * total-call count look like a save that never happened.
 */
const posts = (calls: { method: string }[]) => calls.filter((c) => c.method === 'POST').length;

test('an out-of-range entry blocks the save and marks the field', async () => {
  const calls = stubSettings();
  await app.loadSettings();
  byId<HTMLInputElement>('setWeeklyCap').value = '5000';
  await submit();

  expect(posts(calls)).toBe(0);                                       // nothing was posted
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
  byId<HTMLInputElement>('setStart').value = '18';
  byId<HTMLInputElement>('setEnd').value = '9';
  await submit();

  expect(posts(calls)).toBe(0);
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

/*
 * A `type=number` input reports value === '' for anything it cannot parse — "1e", a pasted
 * "1,000", plain text in Firefox. The browser's own badInput check used to block the submit;
 * `novalidate` removed it. Without a local empty check the key is simply omitted from the
 * patch, the server returns 200 for the remaining fields, and the operator reads "Settings
 * saved." over a box whose value never left the page. On a pacing cap that is somebody
 * lowering a limit for safety and being told it worked.
 *
 * jsdom sanitizes an unparseable assignment to '' exactly as a browser does, so setting
 * .value = 'abc' reproduces the real condition rather than simulating it.
 */
test('text a number input cannot parse blocks the save instead of reporting success', async () => {
  const calls = stubSettings();
  await app.loadSettings();
  const input = byId<HTMLInputElement>('setWeeklyCap');
  input.value = 'abc';
  expect(input.value).toBe('');                      // the sanitization this test depends on
  await submit();

  expect(posts(calls)).toBe(0);
  expect(byId('settingsResult').textContent).not.toBe('Settings saved.');
  expect(input.closest('.field')!.querySelector('.field-error')!.textContent)
    .toBe('Weekly cap (invites) needs a whole number.');
});

test('editing a marked field clears its error without waiting for the next save', async () => {
  stubSettings();
  await app.loadSettings();
  const input = byId<HTMLInputElement>('setWeeklyCap');
  input.value = '5000';
  await submit();
  expect(input.closest('.field')!.querySelector('.field-error')).not.toBeNull();

  input.value = '90';
  input.dispatchEvent(new Event('input', { bubbles: true }));

  expect(input.closest('.field')!.querySelector('.field-error')).toBeNull();
  expect(input.classList.contains('is-invalid')).toBe(false);
  expect(input.hasAttribute('aria-invalid')).toBe(false);
});

/* The cross-field message hangs on #setEnd but quotes #setStart's value, so an edit to the
   start hour that left it alone would strand a sentence naming an hour no longer on screen. */
test('editing the start hour clears the cross-field message parked on the end hour', async () => {
  stubSettings();
  await app.loadSettings();
  byId<HTMLInputElement>('setStart').value = '18';
  byId<HTMLInputElement>('setEnd').value = '9';
  await submit();
  expect(byId('setEnd').closest('.field')!.querySelector('.field-error')).not.toBeNull();

  const start = byId<HTMLInputElement>('setStart');
  start.value = '8';
  start.dispatchEvent(new Event('input', { bubbles: true }));

  expect(byId('setEnd').closest('.field')!.querySelector('.field-error')).toBeNull();
});

test('the load-time flag explains itself rather than just turning a field red', async () => {
  stubSettings({ reply_checks_per_day: 6 });
  await app.loadSettings();

  expect(byId('settingsResult').hidden).toBe(false);
  expect(byId('settingsResult').textContent).toBe(
    'A saved value is now outside the safe range — the limit was lowered. '
    + 'Fix the field marked in red; no settings can be saved until you do.',
  );
});

test('a clean load says nothing', async () => {
  stubSettings();
  await app.loadSettings();
  expect(byId('settingsResult').hidden).toBe(true);
});

/* The prose ranges in the labels were the last hardcoded limits in index.html once the
   min/max attributes went — and one had already drifted to 1-24 against a rule of 4. */
const hint = (id: string) =>
  byId(id).closest('.field')!.querySelector('[data-range-for]')!.textContent;

test('prose range hints match the rule table they now come from', async () => {
  stubSettings();
  await app.loadSettings();
  expect(hint('setReplyChecks')).toBe('1–4');
  expect(hint('setRosterSync')).toBe('1–24');
});

/* The assertion above would hold on the static HTML too, since it is currently in step. This
   one moves a ceiling that no HTML author touched, which only tracks if the text is stamped. */
test('a hint follows its rule when the ceiling moves', async () => {
  stubSettings({ rules: { ...SETTING_RULES, roster_sync_per_day: { label: 'Connection syncs / day', min: 2, max: 9 } } });
  await app.loadSettings();
  expect(hint('setRosterSync')).toBe('2–9');
  expect(hint('setReplyChecks')).toBe('1–4');   // untouched rule, untouched hint
});

/*
 * The client builds its three sentence frames independently of validateSettingsPatch(). The
 * labels arrive over the wire so those cannot drift, but the frames around them can, and
 * nothing else in the suite would notice a form saying "must be within" while the API says
 * "must be between". Asserting equality makes one wording an invariant across both.
 */
test.each([
  ['out of range', { weekly_cap: 5000 }, 'setWeeklyCap'],
  ['a decimal', { weekly_cap: 12.5 }, 'setWeeklyCap'],
  ['an inverted window', { workday_start_hour: 18, workday_end_hour: 9 }, 'setEnd'],
] as const)('the form and the API say the same sentence for %s', async (_name, patch, marked) => {
  stubSettings();
  await app.loadSettings();
  Object.entries(patch).forEach(([key, value]) => {
    const field = app.SETTINGS_FIELDS.find((f) => f.key === key)!;
    byId<HTMLInputElement>(field.id).value = String(value);
  });
  await submit();

  const fromServer = validateSettingsPatch(patch, SETTINGS as unknown as Settings)[0];
  expect(fromServer).toBeDefined();
  expect(byId(marked).closest('.field')!.querySelector('.field-error')!.textContent)
    .toBe(fromServer.message);
});
