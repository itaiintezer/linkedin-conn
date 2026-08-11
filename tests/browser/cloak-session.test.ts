/**
 * The browser-liveness contract.
 *
 * These drive CloakSession with a fake launcher rather than a real Chromium: the whole bug being
 * locked down here is about what the class BELIEVES about a context, so a fake that can die on
 * command tests it precisely, and in milliseconds.
 */
import { describe, expect, test } from 'vitest';
import type { BrowserContext, Page } from 'playwright-core';
import { CloakSession } from '../../src/browser/cloak-session.js';

/** A stand-in context that can be closed politely (event) or killed rudely (no event). */
function fakeContext() {
  const closeListeners: Array<() => void> = [];
  let connected = true;
  const ctx = {
    addCookies: async () => {},
    pages: () => [] as Page[],
    newPage: async () => ({ url: () => 'about:blank' }) as unknown as Page,
    browser: () => ({ isConnected: () => connected }),
    once: (event: string, fn: () => void) => {
      if (event === 'close') closeListeners.push(fn);
      return ctx;
    },
    close: async () => { ctx.closeWindow(); },

    // --- test controls, not part of the Playwright surface ---
    /** What the operator does: closes the window. Browser exits, context emits 'close'. */
    closeWindow: () => {
      connected = false;
      for (const fn of closeListeners.splice(0)) fn();
    },
    /** The nastier variant: the process vanishes and no event ever arrives. */
    vanish: () => { connected = false; },
  };
  return ctx;
}

/** A session wired to fresh fakes, plus the list of contexts it has launched. */
function makeSession() {
  const launched: Array<ReturnType<typeof fakeContext>> = [];
  const session = new CloakSession(async () => {
    const ctx = fakeContext();
    launched.push(ctx);
    return ctx as unknown as BrowserContext;
  });
  return { session, launched };
}

describe('CloakSession lifecycle', () => {
  test('launches once and caches the context', async () => {
    const { session, launched } = makeSession();
    expect(session.launched).toBe(false);

    const a = await session.context();
    const b = await session.context();

    expect(a).toBe(b);
    expect(launched).toHaveLength(1);
    expect(session.launched).toBe(true);
  });

  test('sets the lang cookie on every launch, not just the first', async () => {
    // The English-pinning cookie is what keeps the selectors working; a relaunched context that
    // skipped it would come back in Hebrew and fail in a far more confusing way.
    const cookieCalls: unknown[][] = [];
    const session = new CloakSession(async () => {
      const ctx = fakeContext();
      ctx.addCookies = async (...args: unknown[]) => { cookieCalls.push(args); };
      return ctx as unknown as BrowserContext;
    });

    await session.context();
    await session.close();
    await session.context();

    expect(cookieCalls).toHaveLength(2);
  });

  /**
   * THE REGRESSION. Closing the window used to leave a dead context cached, so every later
   * action ("Recheck now", a scheduled send, the login refresh) threw
   * `Target page, context or browser has been closed` until the process was restarted.
   */
  test('a window the operator closed is reopened by the next action', async () => {
    const { session, launched } = makeSession();

    await session.context();
    launched[0]!.closeWindow();

    expect(session.launched).toBe(false);

    const revived = await session.context();
    expect(launched).toHaveLength(2);
    expect(revived).toBe(launched[1] as unknown as BrowserContext);
    expect(session.launched).toBe(true);
  });

  test('a browser that vanished without emitting close is also relaunched', async () => {
    // Backstop for a missed event: `launched` consults isConnected() rather than the field alone.
    const { session, launched } = makeSession();

    await session.context();
    launched[0]!.vanish();

    expect(session.launched).toBe(false);
    await session.context();
    expect(launched).toHaveLength(2);
  });

  test('a late close event from a replaced context does not discard the live one', async () => {
    const { session, launched } = makeSession();

    await session.context();
    launched[0]!.vanish();          // dies silently
    await session.context();        // relaunch — now on launched[1]
    launched[0]!.closeWindow();     // the old context finally gets round to its event

    expect(session.launched).toBe(true);
    expect(launched).toHaveLength(2);
  });

  test('page() opens a tab when the relaunched context has none', async () => {
    const { session, launched } = makeSession();

    await session.context();
    launched[0]!.closeWindow();
    const page = await session.page();

    expect(page).toBeTruthy();
    expect(launched).toHaveLength(2);
  });

  test('close() clears the cache so the next call relaunches', async () => {
    const { session, launched } = makeSession();

    await session.context();
    await session.close();
    expect(session.launched).toBe(false);

    await session.context();
    expect(launched).toHaveLength(2);
  });
});
