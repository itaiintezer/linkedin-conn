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
