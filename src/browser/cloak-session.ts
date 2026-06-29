import { launchPersistentContext } from 'cloakbrowser';
import type { BrowserContext, Page } from 'playwright-core';
import { BROWSER_PROFILE_DIR } from '../config.js';

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

  /** Launch (or return the cached) persistent context bound to BROWSER_PROFILE_DIR. */
  async context(): Promise<BrowserContext> {
    if (this.ctx) return this.ctx;
    this.ctx = await launchPersistentContext({
      userDataDir: BROWSER_PROFILE_DIR,
      headless: false,
      humanize: true,
      viewport: { width: 1280, height: 900 },
    });
    return this.ctx;
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
