// @vitest-environment jsdom
/// <reference lib="dom" />
/**
 * The red roster-health strip (#healthAlerts). The server decides WHAT is wrong
 * (status.alerts, computed in src/core/health.ts); these tests pin how the dashboard
 * shows it — one red banner per alert, an action button per known id, and no DOM churn
 * while the list is unchanged.
 */
import { test, expect, beforeEach, afterEach } from 'vitest';
import { loadApp, byId, stubFetchRoutes, type AppInternals } from './helpers/load-app.js';

let app: AppInternals;
const realFetch = globalThis.fetch;

beforeEach(() => { app = loadApp(); });
afterEach(() => { globalThis.fetch = realFetch; });

const status = (alerts: unknown) => ({
  paused: 0, counts: {}, msg_counts: {}, guardrail: { tripped: 0 }, enrich_halt: null, alerts,
});

const rosterAlert = {
  id: 'roster_missing',
  title: 'Connections not imported.',
  detail: 'Only 412 connections are in the roster.',
};
const enrichAlert = {
  id: 'enrich_failures',
  title: 'Connection enrichment is failing.',
  detail: '300 of 5,000 connections failed to enrich.',
};

test('a healthy status renders no banners', () => {
  app.applyHealthAlertsUi(status([]));
  expect(byId('healthAlerts').children.length).toBe(0);
});

test('a missing alerts field is treated as healthy, not as a crash', () => {
  // Defensive: an older server, or a poll that failed halfway, must not break the dashboard.
  app.applyHealthAlertsUi({ paused: 0, guardrail: { tripped: 0 } });
  expect(byId('healthAlerts').children.length).toBe(0);
});

test('each alert becomes its own red banner with the server wording', () => {
  app.applyHealthAlertsUi(status([rosterAlert, enrichAlert]));
  const banners = byId('healthAlerts').querySelectorAll('.health-banner');
  expect(banners.length).toBe(2);
  expect(banners[0].getAttribute('role')).toBe('alert');
  expect(banners[0].textContent).toContain('Connections not imported.');
  expect(banners[0].textContent).toContain('412');
  expect(banners[1].textContent).toContain('failed to enrich');
});

test('the strip clears once the conditions do', () => {
  app.applyHealthAlertsUi(status([rosterAlert]));
  app.applyHealthAlertsUi(status([]));
  expect(byId('healthAlerts').children.length).toBe(0);
});

test('an unchanged list does not rebuild the DOM under the operator', () => {
  app.applyHealthAlertsUi(status([enrichAlert]));
  const before = byId('healthAlerts').querySelector('.health-banner');
  app.applyHealthAlertsUi(status([{ ...enrichAlert }]));
  expect(byId('healthAlerts').querySelector('.health-banner')).toBe(before);
});

test('the missing-roster banner routes to the Connections tab', () => {
  app.initTabs();
  app.applyHealthAlertsUi(status([rosterAlert]));
  const btn = byId('healthAlerts').querySelector<HTMLButtonElement>('.health-banner-action');
  expect(btn?.textContent).toMatch(/connections/i);
  btn!.click();
  expect(byId('tab-connections').hidden).toBe(false);
});

test('the enrichment banner retries the failed rows in place', async () => {
  const calls = stubFetchRoutes({
    '/api/enrichment/retry-failed': { body: { requeued: 300 } },
  });
  app.applyHealthAlertsUi(status([enrichAlert]));
  const btn = byId('healthAlerts').querySelector<HTMLButtonElement>('.health-banner-action');
  expect(btn?.textContent).toMatch(/retry/i);

  btn!.click();
  await new Promise((r) => setTimeout(r, 0));

  expect(calls.some((c) => c.path === '/api/enrichment/retry-failed' && c.method === 'POST')).toBe(true);
  // The verdict lands on the button itself; the banner clears on the next poll.
  expect(btn!.textContent).toContain('300');
});

test('an unknown alert id still renders — a future check must never be invisible', () => {
  app.applyHealthAlertsUi(status([{ id: 'something_new', title: 'New problem.', detail: 'details' }]));
  const banner = byId('healthAlerts').querySelector('.health-banner');
  expect(banner?.textContent).toContain('New problem.');
  expect(banner?.querySelector('.health-banner-action')).toBeNull();
});
