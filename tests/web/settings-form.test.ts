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
import { SETTING_RULES } from '../../src/core/settings-rules.js';

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
