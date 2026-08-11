import { launchPersistentContext } from 'cloakbrowser';
import type { BrowserContext, Page } from 'playwright-core';
import { BROWSER_PROFILE_DIR } from '../config.js';

/**
 * The single cloakbrowser call this class makes. Injectable so the lifecycle can be tested
 * without a real Chromium — see tests/browser/cloak-session.test.ts. Derived from the real
 * function rather than hand-written, so the options object stays type-checked against the
 * engine instead of degrading to a bag of unknowns.
 */
export type ContextLauncher = typeof launchPersistentContext;

/**
 * Is this context's browser still there?
 *
 * `browser()` is non-null for a persistent context, and `isConnected()` flips the moment the
 * Chromium process goes. Written to degrade to "assume alive" if an engine exposes neither, so
 * the close event below stays the primary mechanism and this is only the backstop for a missed
 * one.
 */
function isAlive(ctx: BrowserContext): boolean {
  return ctx.browser()?.isConnected() !== false;
}

/**
 * Owns the CloakBrowser persistent-context lifecycle.
 *
 * cloakbrowser 0.4.5 exposes a top-level `launchPersistentContext(options)`
 * function (Playwright engine under the hood). The user data dir is passed as
 * the `userDataDir` field of the options object — not as a positional argument
 * like Playwright's own `chromium.launchPersistentContext(dir, opts)`. The
 * returned object is a Playwright `BrowserContext`.
 */
export class CloakSession {
  private ctx: BrowserContext | null = null;

  constructor(private readonly launch: ContextLauncher = launchPersistentContext) {}

  /**
   * Whether a LIVE context is held.
   *
   * Asking the browser instead of trusting the field is the entire point. The operator can
   * close the Chromium window at any time (it is visible on their desktop by design), and that
   * left `this.ctx` pointing at a context whose browser was gone. Every caller that guards on
   * this — `refreshLoginCache`, `checkpointScan`, the dashboard poll — was told "open", then
   * threw `Target page, context or browser has been closed` on every tick, forever: nothing but
   * process exit cleared the field. That self-healed while the app was restarted from a
   * terminal several times an hour; once it started at login and ran for weeks, a closed window
   * silently ended all LinkedIn work until someone thought to restart.
   */
  get launched(): boolean {
    return this.ctx !== null && isAlive(this.ctx);
  }

  /** Launch (or return the cached) persistent context bound to BROWSER_PROFILE_DIR. */
  async context(): Promise<BrowserContext> {
    if (this.ctx && isAlive(this.ctx)) return this.ctx;
    // Drop a dead one before relaunching. A closed context can never be revived, so holding it
    // buys nothing and costs everything.
    this.ctx = null;
    const ctx = await this.launch({
      userDataDir: BROWSER_PROFILE_DIR,
      headless: false,
      humanize: true,
      locale: 'en-US',
      viewport: { width: 1280, height: 900 },
    });
    // Self-clear, so "the operator closed the window" becomes indistinguishable from "never
    // opened" — which is the state every caller already handles, by lazily launching. Guarded on
    // identity: a late event from a context we have already replaced must not discard the new one.
    ctx.once('close', () => { if (this.ctx === ctx) this.ctx = null; });
    this.ctx = ctx;
    // Pin LinkedIn's UI language to English. `locale: 'en-US'` only sets Accept-Language,
    // which LinkedIn ignores for logged-in members — it uses the member's account language
    // (Hebrew here). Without this, the COLD first navigation of a session renders in Hebrew
    // (verified: <html lang="he" dir="rtl">), breaking every English selector (Pending
    // badge, composer buttons) so the send can't be confirmed and is mis-marked `failed`.
    // The `lang` cookie forces English from the very first request.
    await ctx.addCookies([
      { name: 'lang', value: 'v=2&lang=en-US', domain: '.linkedin.com', path: '/' },
      { name: 'lang', value: 'v=2&lang=en-US', domain: '.www.linkedin.com', path: '/' },
    ]);
    return ctx;
  }

  /** Return the first existing page, or open a new one. */
  async page(): Promise<Page> {
    const ctx = await this.context();
    const pages = ctx.pages();
    return pages.length ? pages[0]! : await ctx.newPage();
  }

  /** Close the context and clear the cache so the next call relaunches. */
  async close(): Promise<void> {
    await this.ctx?.close();
    this.ctx = null;
  }
}
