// @vitest-environment jsdom
/// <reference lib="dom" />
/**
 * The Restart and Update controls (src/web/app.js).
 *
 * This is the one screen that expects the server to disappear from under it: the app exits and
 * the supervisor brings it back, so for up to a few minutes every request fails. The
 * load-bearing test here is that a refused connection in that window renders as PROGRESS. If it
 * ever renders as an error, an operator watching a perfectly healthy update sees a red banner
 * telling them their outreach tool is broken, and the natural response — reload, click again,
 * restart the laptop — is exactly the wrong one.
 */
import { test, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadApp, byId, type AppInternals } from './helpers/load-app.js';

let app: AppInternals;
const realFetch = globalThis.fetch;
const realConfirm = globalThis.confirm;

beforeEach(() => {
  app = loadApp();
  globalThis.confirm = () => true;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.confirm = realConfirm;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A fetch where /api/update/status is scripted turn by turn; everything else is benign. */
function stubStatusSequence(turns: Array<'fail' | Record<string, unknown>>) {
  let i = 0;
  const seen: string[] = [];
  globalThis.fetch = (async (path: string) => {
    const p = String(path);
    seen.push(p);
    if (p.includes('/api/update/status')) {
      const turn = turns[Math.min(i, turns.length - 1)];
      i++;
      if (turn === 'fail') throw new TypeError('Failed to fetch');
      return { ok: true, json: async () => turn };
    }
    if (p.includes('/api/update/check')) {
      return { ok: true, json: async () => ({ available: 0, changes: [] }) };
    }
    // Everything the post-comeback refresh touches. All of those callers catch, so a rejection
    // here is harmless and keeps this stub honest about what it does not model.
    throw new TypeError('not stubbed');
  }) as unknown as typeof fetch;
  return { seen };
}

const DONE = {
  state: 'done', message: 'Updated — 2 new changes installed.',
  action: 'update', requested_at: 'REQ-1', changes: ['feat: one', 'fix: two'], supervised: true,
};

test('renderAvailability stays completely silent when there is nothing to install', () => {
  // A pill that is always visible is a pill nobody reads, and a standing invitation to restart.
  app.renderAvailability({ available: 0, changes: [] });

  expect(byId('updatePill').hidden).toBe(true);
  expect(byId('maintChanges').hidden).toBe(true);
  expect(byId('updateBtn').textContent).toBe('Check for updates');
  expect(byId('maintStatusLine').textContent).toMatch(/newest version/i);
});

test('renderAvailability names the count and lists the changes', () => {
  app.renderAvailability({ available: 2, changes: ['feat: one', 'fix: two'] });

  expect(byId('updatePill').hidden).toBe(false);
  expect(byId('updatePillText').textContent).toBe('2 updates available');
  expect(byId('updateBtn').textContent).toBe('Install 2 updates');
  expect(byId('maintChanges').hidden).toBe(false);
  expect(byId('maintChanges').textContent).toContain('feat: one');
  expect(byId('maintChanges').textContent).toContain('fix: two');
});

test('one change reads as singular everywhere it appears', () => {
  app.renderAvailability({ available: 1, changes: ['feat: one'] });
  expect(byId('updatePillText').textContent).toBe('1 update available');
  expect(byId('updateBtn').textContent).toBe('Install 1 update');
});

test('being OFFLINE reassures instead of alarming', () => {
  // An operator on a train must not be told their outreach tool has a problem.
  app.renderAvailability({ available: 0, changes: [], error: 'could not resolve host' });

  expect(byId('updatePill').hidden).toBe(true);
  const line = byId('maintStatusLine').textContent ?? '';
  expect(line).toMatch(/could not reach the internet/i);
  expect(line).toMatch(/your machine is fine/i);
  expect(line).not.toMatch(/resolve host/); // no jargon leaks through
});

test('THE LOAD-BEARING ONE: a refused connection is progress, not an error', async () => {
  vi.useFakeTimers();
  // Three failed polls — the server going away — then the answer.
  stubStatusSequence(['fail', 'fail', 'fail', DONE]);

  const waiting = app.awaitComeback('update', 'REQ-1');

  await vi.advanceTimersByTimeAsync(5000);
  // Mid-flight: still the calm busy banner, nothing red, buttons held.
  expect(byId('maintBanner').className).toContain('is-busy');
  expect(byId('maintBanner').className).not.toContain('is-failed');
  expect(byId('maintTitle').textContent).toMatch(/Updating/);
  expect((byId('updateBtn') as HTMLButtonElement).disabled).toBe(true);

  await vi.advanceTimersByTimeAsync(5000);
  await waiting;

  expect(byId('maintBanner').className).toContain('is-done');
  expect(byId('maintTitle').textContent).toBe('Updated — 2 new changes installed.');
  expect((byId('updateBtn') as HTMLButtonElement).disabled).toBe(false);
});

test('a "done" belonging to an EARLIER request is not mistaken for ours', async () => {
  // A poll that lands on the restarted server would otherwise read the previous update's
  // outcome and report success for something that never ran.
  vi.useFakeTimers();
  const stale = { ...DONE, requested_at: 'REQ-0', message: 'Updated — 9 new changes installed.' };
  stubStatusSequence([stale, stale, { ...DONE, requested_at: 'REQ-1' }]);

  const waiting = app.awaitComeback('update', 'REQ-1');
  await vi.advanceTimersByTimeAsync(4000);
  expect(byId('maintBanner').className).toContain('is-busy'); // ignored the stale one

  await vi.advanceTimersByTimeAsync(4000);
  await waiting;
  expect(byId('maintTitle').textContent).toContain('2 new changes');
});

test('a busy status keeps waiting rather than declaring victory', async () => {
  vi.useFakeTimers();
  stubStatusSequence([
    { state: 'busy', message: 'Updating…', requested_at: 'REQ-1', action: 'update', supervised: true },
    { state: 'busy', message: 'Updating…', requested_at: 'REQ-1', action: 'update', supervised: true },
    DONE,
  ]);

  const waiting = app.awaitComeback('update', 'REQ-1');
  await vi.advanceTimersByTimeAsync(4000);
  expect(byId('maintBanner').className).toContain('is-busy');
  await vi.advanceTimersByTimeAsync(4000);
  await waiting;
  expect(byId('maintBanner').className).toContain('is-done');
});

test('a failed update says the old version is still running', async () => {
  vi.useFakeTimers();
  stubStatusSequence([{
    state: 'failed', action: 'update', requested_at: 'REQ-1', supervised: true, changes: [],
    message: 'The update did not finish, so The Machine is still running the version it was on.',
  }]);

  const waiting = app.awaitComeback('update', 'REQ-1');
  await vi.advanceTimersByTimeAsync(3000);
  await waiting;

  expect(byId('maintBanner').className).toContain('is-failed');
  expect(byId('maintDetail').textContent).toMatch(/still running the version it was on/i);
});

test('after a long silence it admits it lost track instead of claiming failure', async () => {
  // The update may well have worked; the honest report is that we stopped being able to see.
  vi.useFakeTimers();
  stubStatusSequence(['fail']);

  const waiting = app.awaitComeback('update', 'REQ-1');
  await vi.advanceTimersByTimeAsync(11 * 60_000);
  await waiting;

  const detail = byId('maintDetail').textContent ?? '';
  expect(byId('maintTitle').textContent).toMatch(/lost track/i);
  expect(detail).toMatch(/may still have worked/i);
});

test('a long wait explains itself rather than looking stuck', async () => {
  vi.useFakeTimers();
  stubStatusSequence(['fail']);
  const waiting = app.awaitComeback('update', 'REQ-1');

  await vi.advanceTimersByTimeAsync(95_000);
  expect(byId('maintDetail').textContent).toMatch(/still going/i);

  await vi.advanceTimersByTimeAsync(11 * 60_000);
  await waiting;
});

test('UNSUPERVISED: the buttons are disabled with a reason, not left to fail', async () => {
  globalThis.fetch = (async (path: string) => {
    if (String(path).includes('/api/update/status')) {
      return { ok: true, json: async () => ({ state: 'idle', message: '', supervised: false, changes: [] }) };
    }
    throw new TypeError('not stubbed');
  }) as unknown as typeof fetch;

  await app.refreshMaintStatus();

  expect((byId('restartBtn') as HTMLButtonElement).disabled).toBe(true);
  expect((byId('updateBtn') as HTMLButtonElement).disabled).toBe(true);
  expect(byId('maintVersionLine').textContent).toMatch(/started by hand/i);
});

test('refreshMaintStatus picks up an update already in flight elsewhere', async () => {
  // Someone clicked Update in another tab, or the page was reloaded mid-update.
  vi.useFakeTimers();
  stubStatusSequence([
    { state: 'busy', message: 'Updating…', action: 'update', requested_at: 'REQ-7', supervised: true },
    DONE,
  ]);

  await app.refreshMaintStatus();
  await vi.advanceTimersByTimeAsync(3000);

  expect(byId('maintBanner').hidden).toBe(false);
  expect(byId('maintTitle').textContent).toMatch(/Updating/);
});

test('the first Update click only LOOKS — it never restarts on a label nobody read', async () => {
  const posts: string[] = [];
  globalThis.fetch = (async (path: string, opts?: { method?: string }) => {
    const p = String(path);
    if (opts?.method === 'POST') posts.push(p);
    if (p.includes('/api/update/check')) return { ok: true, json: async () => ({ available: 3, changes: ['a', 'b', 'c'] }) };
    if (p.includes('/api/update/status')) return { ok: true, json: async () => ({ state: 'idle', supervised: true, changes: [] }) };
    throw new TypeError('not stubbed');
  }) as unknown as typeof fetch;

  app.initMaintenance();
  await vi.waitFor(() => expect(byId('updateBtn').textContent).toContain('Install 3 updates'));

  // The check ran; nothing was restarted.
  expect(posts).toEqual([]);
});

test('the second Update click posts /api/update', async () => {
  const posts: string[] = [];
  // Status answers 'done' for our request throughout, so the wait resolves on the first poll
  // rather than leaving a ten-minute loop running past the end of the test. A 'busy' status
  // here would (correctly) disable the button and the click would never land.
  globalThis.fetch = (async (path: string, opts?: { method?: string }) => {
    const p = String(path);
    if (opts?.method === 'POST') {
      posts.push(p);
      return { ok: true, json: async () => ({ ok: true, action: 'update', requested_at: 'REQ-9' }) };
    }
    if (p.includes('/api/update/check')) return { ok: true, json: async () => ({ available: 1, changes: ['feat: x'] }) };
    if (p.includes('/api/update/status')) {
      return { ok: true, json: async () => ({ state: 'done', message: 'Updated — 1 new change installed.', action: 'update', requested_at: 'REQ-9', changes: ['feat: x'], supervised: true }) };
    }
    throw new TypeError('not stubbed');
  }) as unknown as typeof fetch;

  app.initMaintenance();
  await vi.waitFor(() => expect(byId('updateBtn').textContent).toContain('Install 1 update'));
  byId('updateBtn').click();

  await vi.waitFor(() => expect(posts).toContain('/api/update'));
  await vi.waitFor(() => expect(byId('maintBanner').className).toContain('is-done'), { timeout: 5000 });
});

test('Restart asks for confirmation first, and does nothing if declined', async () => {
  const posts: string[] = [];
  globalThis.confirm = () => false;
  globalThis.fetch = (async (path: string, opts?: { method?: string }) => {
    if (opts?.method === 'POST') posts.push(String(path));
    if (String(path).includes('/api/update/check')) return { ok: true, json: async () => ({ available: 0, changes: [] }) };
    if (String(path).includes('/api/update/status')) return { ok: true, json: async () => ({ state: 'idle', supervised: true, changes: [] }) };
    throw new TypeError('not stubbed');
  }) as unknown as typeof fetch;

  app.initMaintenance();
  byId('restartBtn').click();
  await Promise.resolve();

  expect(posts).toEqual([]);
});

test('the pill\'s Update button shows and hides with the pill itself', () => {
  app.renderAvailability({ available: 2, changes: ['a', 'b'] });
  expect(byId('updatePillGo').hidden).toBe(false);

  app.renderAvailability({ available: 0, changes: [] });
  expect(byId('updatePillGo').hidden).toBe(true);
});

test('the pill\'s Update button installs from the top bar — no trip to Settings required', async () => {
  const posts: string[] = [];
  globalThis.fetch = (async (path: string, opts?: { method?: string }) => {
    const p = String(path);
    if (opts?.method === 'POST') {
      posts.push(p);
      return { ok: true, json: async () => ({ ok: true, action: 'update', requested_at: 'REQ-11' }) };
    }
    if (p.includes('/api/update/check')) return { ok: true, json: async () => ({ available: 2, changes: ['a', 'b'] }) };
    if (p.includes('/api/update/status')) {
      return { ok: true, json: async () => ({ state: 'done', message: 'Updated — 2 new changes installed.', action: 'update', requested_at: 'REQ-11', changes: [], supervised: true }) };
    }
    throw new TypeError('not stubbed');
  }) as unknown as typeof fetch;

  app.initMaintenance();
  await vi.waitFor(() => expect(byId('updatePillGo').hidden).toBe(false));
  byId('updatePillGo').click();

  await vi.waitFor(() => expect(posts).toContain('/api/update'));
  await vi.waitFor(() => expect(byId('maintBanner').className).toContain('is-done'), { timeout: 5000 });
});

test('the pill\'s Update button still asks for confirmation, and declining does nothing', async () => {
  const posts: string[] = [];
  globalThis.confirm = () => false;
  globalThis.fetch = (async (path: string, opts?: { method?: string }) => {
    if (opts?.method === 'POST') posts.push(String(path));
    if (String(path).includes('/api/update/check')) return { ok: true, json: async () => ({ available: 1, changes: ['a'] }) };
    if (String(path).includes('/api/update/status')) return { ok: true, json: async () => ({ state: 'idle', supervised: true, changes: [] }) };
    throw new TypeError('not stubbed');
  }) as unknown as typeof fetch;

  app.initMaintenance();
  await vi.waitFor(() => expect(byId('updatePillGo').hidden).toBe(false));
  byId('updatePillGo').click();
  await Promise.resolve();

  expect(posts).toEqual([]);
});

test('the pill routes to Settings, where the button actually is', async () => {
  globalThis.fetch = (async (path: string) => {
    if (String(path).includes('/api/update/check')) return { ok: true, json: async () => ({ available: 2, changes: ['a', 'b'] }) };
    if (String(path).includes('/api/update/status')) return { ok: true, json: async () => ({ state: 'idle', supervised: true, changes: [] }) };
    throw new TypeError('not stubbed');
  }) as unknown as typeof fetch;

  app.initTabs();
  app.initMaintenance();
  byId('updatePill').click();

  expect(byId('tab-settings').hidden).toBe(false);
});
