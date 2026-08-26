// @vitest-environment jsdom
/// <reference lib="dom" />
/**
 * "Send these first" on the Add to queue form.
 *
 * The tests that matter here are about not prioritizing by accident, because doing so
 * displaces sends the operator already lined up: that the flag is off unless ticked, that
 * it is absent from an ordinary request body rather than sent as false, that it does not
 * persist into the next batch, and that the confirmation quotes the real slot the API
 * assigned instead of implying one.
 */
import { test, expect, beforeEach, afterEach } from 'vitest';
import { loadApp, byId, text, stubFetchRoutes, type AppInternals } from './helpers/load-app.js';

let app: AppInternals;
const realFetch = globalThis.fetch;

beforeEach(() => { app = loadApp(); app.initAddList(); });
afterEach(() => { globalThis.fetch = realFetch; });

const flush = () => new Promise((r) => setTimeout(r, 0));

const URLS = 'https://www.linkedin.com/in/a\nhttps://www.linkedin.com/in/b';

function typeUrls(v = URLS) {
  const area = byId<HTMLTextAreaElement>('listText');
  area.value = v;
  area.dispatchEvent(new Event('input', { bubbles: true }));
}

function tickFirst(on = true) {
  const box = byId<HTMLInputElement>('listPrioritize');
  box.checked = on;
  box.dispatchEvent(new Event('change', { bubbles: true }));
}

async function submit(listBody: unknown) {
  const calls = stubFetchRoutes({
    '/api/lists': { body: listBody },
    '/api/cohorts': { body: [] },
  });
  byId('listForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await flush();
  return calls;
}

test('the switch is off on load, with its consequence note hidden', () => {
  expect(byId<HTMLInputElement>('listPrioritize').checked).toBe(false);
  expect(byId('listPrioNote').hidden).toBe(true);
});

test('an ordinary enqueue omits prioritize entirely rather than sending false', async () => {
  typeUrls();
  const calls = await submit({ added: 2, found: 2 });
  const body = calls.find((c) => c.path.startsWith('/api/lists'))!.body as Record<string, unknown>;
  expect('prioritize' in body).toBe(false);
});

test('ticking it reveals the consequence note and re-labels the submit button', () => {
  typeUrls();
  expect(text('listCount')).toBe('2 profiles detected');
  const btn = byId('listForm').querySelector<HTMLButtonElement>('button[type="submit"]')!;
  expect(btn.textContent).toBe('Enqueue 2');

  tickFirst();
  expect(byId('listPrioNote').hidden).toBe(false);
  expect(btn.textContent).toBe('Enqueue 2 first in line');

  tickFirst(false);
  expect(byId('listPrioNote').hidden).toBe(true);
  expect(btn.textContent).toBe('Enqueue 2');
});

test('ticking it sends prioritize:true and reports the real slot it took', async () => {
  typeUrls();
  tickFirst();
  const at = new Date();
  at.setHours(at.getHours() + 2, 40, 0, 0);
  const calls = await submit({
    added: 2, found: 2, prioritized: 2, first_scheduled_for: at.toISOString(),
  });
  const body = calls.find((c) => c.path.startsWith('/api/lists'))!.body as Record<string, unknown>;
  expect(body.prioritize).toBe(true);

  const msg = text('listResult');
  expect(msg).toContain('Added 2 of 2 found.');
  expect(msg).toContain('Sending them first');
  expect(msg).toContain('today');
});

test('the switch resets after a successful enqueue — prioritizing is never sticky', async () => {
  typeUrls();
  tickFirst();
  await submit({ added: 2, found: 2, prioritized: 2, first_scheduled_for: null });
  expect(byId<HTMLInputElement>('listPrioritize').checked).toBe(false);
  expect(byId('listPrioNote').hidden).toBe(true);
  const btn = byId('listForm').querySelector<HTMLButtonElement>('button[type="submit"]')!;
  expect(btn.textContent).toBe('Enqueue');
});

test('a successful enqueue is never reported as a failure where scrollIntoView is missing', async () => {
  // jsdom does not implement scrollIntoView, which is the whole point of this test: the
  // handler used to call it BEFORE clearing the form, so the throw landed in the catch and
  // a successful add announced "Failed: result.scrollIntoView is not a function" with the
  // pasted URLs still sitting in the box. Real browsers hid it; this environment does not.
  expect(byId('listResult').scrollIntoView).toBeUndefined();
  typeUrls();
  await submit({ added: 2, found: 2 });
  expect(text('listResult')).toBe('Added 2 of 2 found.');
  expect(byId('listResult').className).not.toContain('error');
  expect(byId<HTMLTextAreaElement>('listText').value).toBe('');
});

/* ---------- prioritizedSuffix: the sentence, in isolation ---------- */

test('prioritizedSuffix says nothing at all when prioritize was not asked for', () => {
  expect(app.prioritizedSuffix({ added: 2, found: 2 }, false)).toBe('');
});

test('prioritizedSuffix promises no clock time when today had no seat left', () => {
  const s = app.prioritizedSuffix({ found: 2, prioritized: 2, first_scheduled_for: null }, true);
  expect(s).toContain('first in line for the next sending day');
  // The one thing it must never do is invent a time for a row with no slot behind it.
  expect(s).not.toMatch(/\d\d:\d\d/);
});

test('prioritizedSuffix reports rows left alone because they were already sent', () => {
  const s = app.prioritizedSuffix({ found: 5, prioritized: 3, first_scheduled_for: null }, true);
  expect(s).toContain('(2 already sent, left as-is)');
});

test('prioritizedSuffix explains a no-op instead of claiming a move', () => {
  const s = app.prioritizedSuffix({ found: 2, prioritized: 0 }, true);
  expect(s).toContain('Nothing was moved to the front');
});

test('prioritizedSuffix reads singular for one profile', () => {
  const s = app.prioritizedSuffix({ found: 1, prioritized: 1, first_scheduled_for: null }, true);
  expect(s).toContain('Sending it first');
});
