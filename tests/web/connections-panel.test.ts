// @vitest-environment jsdom
/// <reference lib="dom" />
/**
 * Connections panel controller tests (src/web/app.js).
 *
 * The panel is the only surface where an operator can see whether their roster actually
 * imported, so the cases that matter are the ones where something went wrong: a rejected
 * import must SAY so rather than leaving the stats looking untouched, and a sync that
 * declined to run must report its reason instead of silently claiming success.
 */
import { test, expect, beforeEach, afterEach } from 'vitest';
import { loadApp, byId, stubFetchRoutes, type AppInternals } from './helpers/load-app.js';

let app: AppInternals;
const realFetch = globalThis.fetch;

beforeEach(() => { app = loadApp(); });
afterEach(() => { globalThis.fetch = realFetch; });

const STATS = {
  total: 8214,
  by_enrich_status: { pending: 2036, enriching: 0, enriched: 6140, empty: 0, failed: 38 },
  last_synced_at: '2026-07-31T09:00:00.000Z',
};

/** Let the controller's promise chain settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

test('renders roster stats from /api/connections/stats', async () => {
  stubFetchRoutes({ '/api/connections/stats': { body: STATS } });
  await app.refreshConnections();

  expect(byId('connTotal').textContent).toBe('8,214');
  expect(byId('connEnriched').textContent).toBe('6,140');
  expect(byId('connPending').textContent).toBe('2,036');
  expect(byId('connSynced').textContent).not.toBe('—');
});

test('an empty roster reads as a dash, not a misleading zero-state', async () => {
  stubFetchRoutes({
    '/api/connections/stats': {
      body: { total: 0, by_enrich_status: { pending: 0, enriching: 0, enriched: 0, empty: 0, failed: 0 }, last_synced_at: null },
    },
  });
  await app.refreshConnections();

  expect(byId('connTotal').textContent).toBe('0');
  expect(byId('connSynced').textContent).toBe('never');
});

test('submitting the import form posts the pasted text and reports the outcome', async () => {
  const calls = stubFetchRoutes({
    '/api/connections/import': { body: { format: 'csv', parsed: 2, inserted: 2, updated: 0, skipped: 0 } },
    '/api/connections/stats': { body: STATS },
  });
  app.initConnections();

  (byId('connImportText') as HTMLTextAreaElement).value = 'First Name,URL\nAda,https://www.linkedin.com/in/ada';
  byId('connImportForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await flush();

  const post = calls.find((c) => c.path === '/api/connections/import')!;
  expect(post.method).toBe('POST');
  expect((post.body as { text: string }).text).toContain('linkedin.com/in/ada');
  expect(byId('connImportResult').textContent).toMatch(/2 added/i);
  expect(byId('connImportResult').hidden).toBe(false);
});

test('an import error is surfaced as an error toast, not swallowed', async () => {
  stubFetchRoutes({
    '/api/connections/import': { error: 'No LinkedIn profile URLs found in the input', status: 400 },
    '/api/connections/stats': { body: STATS },
  });
  app.initConnections();

  (byId('connImportText') as HTMLTextAreaElement).value = 'nonsense';
  byId('connImportForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await flush();

  const result = byId('connImportResult');
  expect(result.textContent).toMatch(/no linkedin profile urls/i);
  expect(result.className).toContain('error');
});

test('a skipped-rows import says how many were dropped', async () => {
  stubFetchRoutes({
    '/api/connections/import': { body: { format: 'csv', parsed: 8, inserted: 8, updated: 0, skipped: 3 } },
    '/api/connections/stats': { body: STATS },
  });
  app.initConnections();

  (byId('connImportText') as HTMLTextAreaElement).value = 'x';
  byId('connImportForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await flush();

  expect(byId('connImportResult').textContent).toMatch(/3 skipped/i);
});

test('sync-now reports the reason when a pass declines to run', async () => {
  stubFetchRoutes({
    '/api/roster/sync-now': { body: { ran: false, reason: 'empty_read', seen: 0, discovered: 0 } },
    '/api/connections/stats': { body: STATS },
  });
  app.initConnections();

  byId('connSyncNow').dispatchEvent(new Event('click', { bubbles: true }));
  await flush();

  expect(byId('connImportResult').textContent).toMatch(/empty_read/);
});

test('sync-now reports what a successful pass found', async () => {
  stubFetchRoutes({
    '/api/roster/sync-now': { body: { ran: true, seen: 40, discovered: 3 } },
    '/api/connections/stats': { body: STATS },
  });
  app.initConnections();

  byId('connSyncNow').dispatchEvent(new Event('click', { bubbles: true }));
  await flush();

  expect(byId('connImportResult').textContent).toMatch(/40 read/);
  expect(byId('connImportResult').textContent).toMatch(/3 new/);
});

test('the wizard import shares the same path and reports into its own toast', async () => {
  const calls = stubFetchRoutes({
    '/api/connections/import': { body: { format: 'urls', parsed: 1, inserted: 1, updated: 0, skipped: 0 } },
    '/api/connections/stats': { body: STATS },
  });
  app.initConnections();

  (byId('wizImportText') as HTMLTextAreaElement).value = 'https://www.linkedin.com/in/ada';
  byId('wizImportBtn').dispatchEvent(new Event('click', { bubbles: true }));
  await flush();

  expect(calls.some((c) => c.path === '/api/connections/import')).toBe(true);
  expect(byId('wizImportResult').textContent).toMatch(/1 added/i);
  expect(byId('connImportResult').hidden).toBe(true); // the settings toast stays untouched
});
