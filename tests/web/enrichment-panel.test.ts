// @vitest-environment jsdom
/// <reference lib="dom" />
/**
 * Enrichment panel controller. This surface spends real money, so the cases that matter are
 * the ones where the operator must not be misled: the cost has to be visible BEFORE the
 * click, a missing key must explain itself, and the poll must stop when the run does.
 */
import { test, expect, beforeEach, afterEach } from 'vitest';
import { loadApp, byId, stubFetchRoutes, type AppInternals } from './helpers/load-app.js';

let app: AppInternals;
const realFetch = globalThis.fetch;

beforeEach(() => { app = loadApp(); });
afterEach(() => { globalThis.fetch = realFetch; });

const flush = () => new Promise((r) => setTimeout(r, 0));

const progress = (over: Record<string, unknown> = {}) => ({
  running: false, total: 7147, enriched: 0, pending: 7147, enriching: 0, empty: 0, failed: 0,
  startedAt: null, ...over,
});

test('shows the queue size and dollar cost on the button before anything is spent', async () => {
  stubFetchRoutes({ '/api/enrichment/status': { body: progress() } });
  await app.refreshEnrichment();

  const btn = byId<HTMLButtonElement>('enrichStart');
  expect(btn.textContent).toContain('7,147');
  expect(btn.textContent).toContain('$28.59');   // 7147 * $0.004
  expect(btn.disabled).toBe(false);
});

test('the panel stays hidden while the roster is empty', async () => {
  stubFetchRoutes({ '/api/enrichment/status': { body: progress({ total: 0, pending: 0 }) } });
  await app.refreshEnrichment();
  expect(byId('connEnrich').hidden).toBe(true);
});

test('reports progress including parked rows, which will never complete', async () => {
  stubFetchRoutes({
    '/api/enrichment/status': { body: progress({ enriched: 6140, pending: 940, failed: 38, empty: 29 }) },
  });
  await app.refreshEnrichment();

  const legend = byId('enrichLegend').textContent!;
  expect(legend).toContain('6,140 of 7,147 enriched');
  expect(legend).toContain('38 failed');
  expect(legend).toContain('29 unreachable');
  expect(byId<HTMLElement>('enrichRetry').hidden).toBe(false);
});

test('while running, Start is disabled and Pause is offered', async () => {
  stubFetchRoutes({ '/api/enrichment/status': { body: progress({ running: true, enriched: 12, pending: 7135 }) } });
  await app.refreshEnrichment();

  expect(byId<HTMLButtonElement>('enrichStart').disabled).toBe(true);
  expect(byId<HTMLButtonElement>('enrichStart').textContent).toContain('Running');
  expect(byId('enrichPause').hidden).toBe(false);
  // Retry must NOT be offered mid-run: re-arming rows under a live worker is confusing.
  expect(byId('enrichRetry').hidden).toBe(true);
});

test('a fully enriched roster offers nothing to start', async () => {
  stubFetchRoutes({ '/api/enrichment/status': { body: progress({ enriched: 7147, pending: 0 }) } });
  await app.refreshEnrichment();

  const btn = byId<HTMLButtonElement>('enrichStart');
  expect(btn.disabled).toBe(true);
  expect(btn.textContent).toContain('Everything enriched');
});

test('a missing API key surfaces the actionable server message, not a bare failure', async () => {
  stubFetchRoutes({
    '/api/enrichment/start': { error: 'No Apify API key configured — add one under Settings → Connections', status: 400 },
    '/api/enrichment/status': { body: progress() },
  });
  app.initEnrichment();

  byId('enrichStart').dispatchEvent(new Event('click', { bubbles: true }));
  await flush();

  const toast = byId('connImportResult');
  expect(toast.textContent).toMatch(/apify api key/i);
  expect(toast.className).toContain('error');
});

test('starting reports the spend that was just committed', async () => {
  const calls = stubFetchRoutes({
    '/api/enrichment/start': { body: { started: true, queued: 7147, estimated_cost_usd: 28.59 } },
    '/api/enrichment/status': { body: progress({ running: true }) },
  });
  app.initEnrichment();

  byId('enrichStart').dispatchEvent(new Event('click', { bubbles: true }));
  await flush();

  expect(calls.some((c) => c.path === '/api/enrichment/start' && c.method === 'POST')).toBe(true);
  expect(byId('connImportResult').textContent).toContain('$28.59');
});

test('saving the key clears the input so a credential is not left in the DOM', async () => {
  const calls = stubFetchRoutes({
    '/api/settings': { body: { apify_key_set: true, roster_sync_per_day: 2 } },
    '/api/connections/stats': { body: { total: 0, by_enrich_status: { pending: 0, enriching: 0, enriched: 0, empty: 0, failed: 0 }, last_synced_at: null } },
    '/api/enrichment/status': { body: progress({ total: 0, pending: 0 }) },
    '/api/logs': { body: { lines: [] } },
  });
  app.initEnrichment();

  (byId('setApifyKey') as HTMLInputElement).value = 'apify_api_secret123';
  byId('saveApifyKey').dispatchEvent(new Event('click', { bubbles: true }));
  await flush();

  const post = calls.find((c) => c.path === '/api/settings' && c.method === 'POST')!;
  expect((post.body as { apify_api_key: string }).apify_api_key).toBe('apify_api_secret123');
  expect((byId('setApifyKey') as HTMLInputElement).value).toBe('');
});

test('an empty key is rejected client-side rather than saving a blank credential', async () => {
  const calls = stubFetchRoutes({ '/api/settings': { body: {} }, '/api/enrichment/status': { body: progress() } });
  app.initEnrichment();

  (byId('setApifyKey') as HTMLInputElement).value = '   ';
  byId('saveApifyKey').dispatchEvent(new Event('click', { bubbles: true }));
  await flush();

  expect(calls.some((c) => c.method === 'POST')).toBe(false);
  expect(byId('connImportResult').className).toContain('error');
});
