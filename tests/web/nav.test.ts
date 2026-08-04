// @vitest-environment jsdom
/// <reference lib="dom" />
/**
 * Top-bar navigation (src/web/app.js).
 *
 * The dashboard lost its tab: the brand lockup is now the only way back to it, and Docs
 * moved into a collapsed section on Settings. Both are wired by hand rather than by the
 * `.tab` loop, so nothing else in the suite would notice if either came unhooked — an
 * operator would just be stranded on whatever screen they clicked into.
 */
import { test, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadApp, byId, stubFetchRoutes, type AppInternals } from './helpers/load-app.js';

let app: AppInternals;
const realFetch = globalThis.fetch;

beforeEach(() => {
  app = loadApp();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

/** Every screen the tab bar can reach, plus the dashboard it departs from. */
function visiblePanels(): string[] {
  return [...document.querySelectorAll<HTMLElement>('main > .panel')]
    .filter((p) => !p.hidden)
    .map((p) => p.id);
}

test('the tab bar no longer offers Dashboard or Docs', () => {
  const tabs = [...document.querySelectorAll<HTMLElement>('.tab')].map((t) => t.dataset.tab);
  expect(tabs).not.toContain('dashboard');
  expect(tabs).not.toContain('docs');
  // The panel still exists and is what the page opens on.
  expect(visiblePanels()).toEqual(['tab-dashboard']);
});

test('the brand lockup returns to the dashboard and unlights every tab', () => {
  app.initTabs();
  stubFetchRoutes({ '/api/cohorts': { body: [] } });

  byId('tabs').querySelector<HTMLElement>('[data-tab="cohorts"]')!.click();
  expect(visiblePanels()).toEqual(['tab-cohorts']);
  expect(document.querySelectorAll('.tab.is-active')).toHaveLength(1);

  byId('brandHome').click();
  expect(visiblePanels()).toEqual(['tab-dashboard']);
  // No tab represents the dashboard, so none may stay lit while it is showing.
  expect(document.querySelectorAll('.tab.is-active')).toHaveLength(0);
});

test('docs load when the Settings section is opened, once, and not before', async () => {
  app.initDocs();
  const calls = stubFetchRoutes({
    '/api/docs/api': { body: { slug: 'api', markdown: '# Relay API' } },
    '/api/docs': { body: [{ slug: 'api', title: 'Relay API' }] },
  });

  // markdown.js is its own script tag, so the harness never loads it (see loadApp).
  (window as unknown as { renderMarkdown: (md: string) => string }).renderMarkdown =
    (md) => `<p>${md}</p>`;

  const block = byId<HTMLDetailsElement>('docsBlock');
  expect(block.open).toBe(false);
  expect(calls).toHaveLength(0);

  block.open = true;
  block.dispatchEvent(new Event('toggle'));
  // Wait on the rendered document, not the nav: it settles last, so the fetch count below
  // is taken after the whole load rather than midway through it.
  await vi.waitFor(() => expect(byId('docsContent').innerHTML).toContain('Relay API'));
  expect(byId('docsNav').children).toHaveLength(1);

  // Collapse and reopen: the nav is already built, so re-fetching it would only reset the
  // highlight to the first document.
  const after = calls.length;
  block.open = false;
  block.dispatchEvent(new Event('toggle'));
  block.open = true;
  block.dispatchEvent(new Event('toggle'));
  await Promise.resolve();
  expect(calls).toHaveLength(after);
});
