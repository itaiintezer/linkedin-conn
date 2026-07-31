// @vitest-environment jsdom
/// <reference lib="dom" />
/**
 * The Apify API key field (Settings → Connections).
 *
 * The bug this replaces: a saved key rendered as an EMPTY input beside small grey text
 * reading "— configured". The empty box is the louder signal, so operators concluded their
 * key had not saved and pasted it again. The field now shows a mask of the stored key and
 * only opens for editing on an explicit Replace.
 *
 * The security property is asserted here as well as server-side, because this is the layer
 * that would put a secret into the DOM.
 */
import { test, expect, beforeEach, afterEach } from 'vitest';
import { loadApp, byId, type AppInternals } from './helpers/load-app.js';

let app: AppInternals;
const realFetch = globalThis.fetch;

beforeEach(() => { app = loadApp(); });
afterEach(() => { globalThis.fetch = realFetch; });

const SAVED = { apify_key_set: true, apify_key_hint: 'apify_api_••••••••••••4f2a' };
const UNSET = { apify_key_set: false, apify_key_hint: null };

test('a stored key shows the mask, not an empty box', () => {
  app.renderApifyKey(SAVED);

  expect(byId('apifyKeySaved').hidden).toBe(false);
  expect(byId('apifyKeyEdit').hidden).toBe(true);
  expect(byId<HTMLInputElement>('apifyKeyMask').value).toBe('apify_api_••••••••••••4f2a');
  expect(byId('apifyKeyState').textContent).toBe('Configured');
  expect(byId('apifyKeyState').classList.contains('on')).toBe(true);
});

test('the mask is readonly but NOT disabled — a disabled field is unreachable', () => {
  app.renderApifyKey(SAVED);
  const mask = byId<HTMLInputElement>('apifyKeyMask');
  expect(mask.readOnly).toBe(true);
  expect(mask.disabled).toBe(false);              // screen readers skip disabled controls
  expect(mask.getAttribute('aria-label')).toMatch(/masked/i);
});

test('with no key configured the field opens straight into entry, with no Cancel', () => {
  app.renderApifyKey(UNSET);

  expect(byId('apifyKeyEdit').hidden).toBe(false);
  expect(byId('apifyKeySaved').hidden).toBe(true);
  expect(byId('cancelApifyKey').hidden).toBe(true);   // nothing to cancel back to
  expect(byId('apifyKeyState').textContent).toBe('Not set');
  expect(byId('apifyKeyState').classList.contains('on')).toBe(false);
});

test('Replace opens the entry state and focuses it; Cancel restores the mask', () => {
  app.initEnrichment();
  app.renderApifyKey(SAVED);

  byId('replaceApifyKey').click();
  expect(byId('apifyKeyEdit').hidden).toBe(false);
  expect(byId('apifyKeySaved').hidden).toBe(true);
  expect(byId('cancelApifyKey').hidden).toBe(false);
  expect(document.activeElement).toBe(byId('setApifyKey'));

  byId('cancelApifyKey').click();
  expect(byId('apifyKeySaved').hidden).toBe(false);
  expect(byId('apifyKeyEdit').hidden).toBe(true);
  expect(byId<HTMLInputElement>('apifyKeyMask').value).toBe('apify_api_••••••••••••4f2a');
});

test('Cancel discards a half-typed key rather than leaving it in the DOM', () => {
  app.initEnrichment();
  app.renderApifyKey(SAVED);
  byId('replaceApifyKey').click();
  byId<HTMLInputElement>('setApifyKey').value = 'apify_api_HALFTYPEDSECRET';

  byId('cancelApifyKey').click();

  expect(byId<HTMLInputElement>('setApifyKey').value).toBe('');
  expect(document.body.innerHTML).not.toContain('HALFTYPEDSECRET');
});

test('re-rendering after a save clears the entry field and returns to the mask', () => {
  app.renderApifyKey(UNSET);
  byId<HTMLInputElement>('setApifyKey').value = 'apify_api_JUSTPASTED';

  app.renderApifyKey({ apify_key_set: true, apify_key_hint: 'apify_api_••••••••••••ZZZZ' });

  expect(byId<HTMLInputElement>('setApifyKey').value).toBe('');
  expect(document.body.innerHTML).not.toContain('JUSTPASTED');
  expect(byId('apifyKeySaved').hidden).toBe(false);
});

test('Enter in the key field saves, so the row needs no mouse', async () => {
  const calls: { url: string; body: unknown }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    return { ok: true, json: async () => ({}) };
  }) as unknown as typeof fetch;

  app.initEnrichment();
  app.renderApifyKey(UNSET);
  byId<HTMLInputElement>('setApifyKey').value = 'apify_api_TYPEDKEY';
  byId('setApifyKey').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));

  const save = calls.find((c) => c.url === '/api/settings');
  expect(save?.body).toEqual({ apify_api_key: 'apify_api_TYPEDKEY' });
});

test('a missing hint degrades to an empty mask rather than throwing', () => {
  // An older server (or a rollback) returns apify_key_set without apify_key_hint.
  expect(() => app.renderApifyKey({ apify_key_set: true })).not.toThrow();
  expect(byId<HTMLInputElement>('apifyKeyMask').value).toBe('');
  expect(byId('apifyKeySaved').hidden).toBe(false);
});
