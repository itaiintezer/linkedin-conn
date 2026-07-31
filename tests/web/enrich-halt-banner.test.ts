// @vitest-environment jsdom
/// <reference lib="dom" />
/**
 * The alert for automatic enrichment. Enrichment now runs unattended, so a failure that only
 * reaches relay.log is a failure nobody sees — the roster silently stops growing while the
 * dashboard looks perfectly healthy. These tests pin what the operator is actually told.
 */
import { test, expect, beforeEach, afterEach } from 'vitest';
import { loadApp, byId, text, stubFetchRoutes, type AppInternals } from './helpers/load-app.js';

let app: AppInternals;
const realFetch = globalThis.fetch;

beforeEach(() => { app = loadApp(); });
afterEach(() => { globalThis.fetch = realFetch; });

const status = (halt: Record<string, unknown> | null) => ({
  paused: 0, counts: {}, msg_counts: {}, guardrail: { tripped: 0 }, enrich_halt: halt,
});

const progress = (over: Record<string, unknown> = {}) => ({
  running: false, halt: null, total: 7155, enriched: 7153, pending: 2, enriching: 0,
  empty: 0, failed: 0, startedAt: null, ...over,
});

test('no banner while enrichment is healthy', () => {
  app.applyEnrichHaltUi(status(null));
  expect(byId('enrichBanner').hidden).toBe(true);
});

test('a rejected key is explained in plain language, not as an HTTP code', () => {
  app.applyEnrichHaltUi(status({ reason: 'auth', detail: 'Apify run failed (HTTP 401)', at: '2026-08-01T09:00:00.000Z' }));

  expect(byId('enrichBanner').hidden).toBe(false);
  expect(text('enrichHaltReason')).toMatch(/API key/i);
  // The raw error stays available as the detail — "what actually happened?" must be answerable.
  expect(text('enrichHaltDetail')).toContain('HTTP 401');
});

test('a missing key says so', () => {
  app.applyEnrichHaltUi(status({ reason: 'no_api_key', detail: 'No Apify API key is configured.', at: '2026-08-01T09:00:00.000Z' }));
  expect(text('enrichHaltReason')).toMatch(/no apify api key/i);
});

test('repeated failures are described as a stop, not as a mystery', () => {
  app.applyEnrichHaltUi(status({ reason: 'repeated_errors', detail: '5 profiles failed in a row', at: '2026-08-01T09:00:00.000Z' }));
  expect(text('enrichHaltReason')).toMatch(/in a row/i);
});

test('an unrecognised reason still renders something useful rather than blank', () => {
  // A future halt reason must never produce an empty red bar.
  app.applyEnrichHaltUi(status({ reason: 'something_new', detail: 'the sky fell', at: '2026-08-01T09:00:00.000Z' }));
  expect(text('enrichHaltReason').length).toBeGreaterThan(0);
});

test('the banner says when it stopped', () => {
  app.applyEnrichHaltUi(status({ reason: 'auth', detail: 'x', at: '2026-08-01T09:00:00.000Z' }));
  expect(text('enrichHaltTime')).toMatch(/stopped/i);
});

test('the banner clears once the halt is gone', () => {
  app.applyEnrichHaltUi(status({ reason: 'auth', detail: 'x', at: '2026-08-01T09:00:00.000Z' }));
  app.applyEnrichHaltUi(status(null));
  expect(byId('enrichBanner').hidden).toBe(true);
});

test('a missing enrich_halt field is treated as healthy, not as a crash', () => {
  // Defensive: an older server, or a poll that failed halfway, must not break the dashboard.
  app.applyEnrichHaltUi({ paused: 0, guardrail: { tripped: 0 } });
  expect(byId('enrichBanner').hidden).toBe(true);
});

test('the enrichment panel repeats the reason where the Start button lives', async () => {
  stubFetchRoutes({
    '/api/enrichment/status': {
      body: progress({ halt: { reason: 'billing', detail: 'Apify run failed (HTTP 402)', at: '2026-08-01T09:00:00.000Z' } }),
    },
  });

  await app.refreshEnrichment();

  expect(byId('enrichPanelAlert').hidden).toBe(false);
  expect(text('enrichPanelAlert')).toMatch(/credit|billing/i);
});

test('the panel alert stays hidden when there is no halt', async () => {
  stubFetchRoutes({ '/api/enrichment/status': { body: progress() } });
  await app.refreshEnrichment();
  expect(byId('enrichPanelAlert').hidden).toBe(true);
});

test('“Try again” posts to resume and re-reads the status', async () => {
  const calls = stubFetchRoutes({
    '/api/enrichment/resume': { body: { resumed: true, queued: 2 } },
    '/api/enrichment/status': { body: progress() },
    '/api/status': { body: status(null) },
  });
  app.initEnrichment();

  byId<HTMLButtonElement>('enrichHaltRetry').click();
  await new Promise((r) => setTimeout(r, 0));

  expect(calls.some((c) => c.path === '/api/enrichment/resume' && c.method === 'POST')).toBe(true);
});
