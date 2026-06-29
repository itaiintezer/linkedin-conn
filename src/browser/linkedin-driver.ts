import type { Page } from 'playwright-core';
import type { BrowserDriver, SendOutcome } from '../types.js';
import { CloakSession } from './cloak-session.js';
import { SEL, URLS, customInviteUrl, profileSlug } from './linkedin-selectors.js';
import { normalizeProfileUrl } from '../core/url.js';

const rand = (min: number, max: number) => min + Math.floor(Math.random() * (max - min));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class LinkedInDriver implements BrowserDriver {
  constructor(private session = new CloakSession()) {}

  async isLoggedIn(): Promise<boolean> {
    // Non-disruptive: never auto-launch a window just to poll, and never navigate
    // (a navigation here would interrupt a manual login in progress). We detect the
    // session purely from LinkedIn's auth cookie (`li_at`) in the persistent context.
    if (!this.session.launched) return false;
    const ctx = await this.session.context();
    const cookies = await ctx.cookies('https://www.linkedin.com');
    return cookies.some((c) => c.name === 'li_at' && !!c.value);
  }

  async openLoginWindow(): Promise<void> {
    const page = await this.session.page();
    await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' });
  }

  async sendConnectionRequest(url: string, message: string | null): Promise<SendOutcome> {
    const page = await this.session.page();
    const slug = profileSlug(url);
    if (!slug) return { result: 'error', error: `cannot parse profile slug from ${url}` };
    try {
      // New LinkedIn UI: go straight to the invite composer route for this profile.
      await page.goto(customInviteUrl(slug), { waitUntil: 'domcontentloaded' });
      await sleep(rand(2000, 4500));
      const firstName = await this.readFirstName(page);

      const sendWithout = page.locator(SEL.sendWithoutNote).first();
      const addNote = page.locator(SEL.addNoteButton).first();
      const hasSendWithout = await sendWithout.isVisible().catch(() => false);
      const hasAddNote = await addNote.isVisible().catch(() => false);

      // No invite dialog → checkpoint, already-pending, or can't-invite.
      if (!hasSendWithout && !hasAddNote) {
        const body = (await page.content().catch(() => '')) || '';
        if (/captcha|checkpoint|verify you|unusual activity|security check/i.test(body)) {
          return { result: 'checkpoint', error: 'checkpoint detected' };
        }
        if (await page.locator(SEL.pendingBadge).first().isVisible().catch(() => false)) {
          return { result: 'already', firstName };
        }
        return { result: 'unavailable', firstName };
      }

      if (message !== null) {
        if (!hasAddNote) {
          // Can't attach a note (e.g. weekly note quota). Let the caller decide whether
          // to fall back to a bare request.
          return { result: 'note_quota', firstName };
        }
        await addNote.click();
        await sleep(rand(800, 1800));
        await page.locator(SEL.noteTextarea).fill(message);
        await sleep(rand(700, 1600));
        await page.locator(SEL.sendInvitation).first().click();
        await sleep(rand(1500, 3000));
        return { result: 'sent', firstName };
      }

      // Bare request (no note).
      await sendWithout.click();
      await sleep(rand(1500, 3000));
      return { result: 'sent', firstName };
    } catch (e) {
      const body = (await page.content().catch(() => '')) || '';
      if (/captcha|checkpoint|verify|unusual activity/i.test(body)) {
        return { result: 'checkpoint', error: 'checkpoint detected' };
      }
      return { result: 'error', error: (e as Error).message };
    }
  }

  // The new profile UI has no <h1>; the profile name is reliably in the document title.
  private async readFirstName(page: Page): Promise<string | undefined> {
    const title = (await page.title().catch(() => '')) || '';
    const name = title.replace(/^\(\d+\+?\)\s*/, '').replace(/\s*[|·].*$/, '').trim();
    if (!name || /linkedin/i.test(name)) return undefined;
    return name.split(/\s+/)[0];
  }

  async readPendingInvites(): Promise<string[]> {
    const page = await this.session.page();
    await page.goto(URLS.sentInvitations, { waitUntil: 'domcontentloaded' });
    await sleep(rand(2000, 4000));
    return this.collectProfileLinks(page, SEL.invitationCardLink);
  }

  async readRecentConnections(): Promise<string[]> {
    const page = await this.session.page();
    await page.goto(URLS.connections, { waitUntil: 'domcontentloaded' });
    await sleep(rand(2000, 4000));
    return this.collectProfileLinks(page, SEL.connectionCardLink);
  }

  private async collectProfileLinks(page: Page, selector: string): Promise<string[]> {
    const hrefs = await page.locator(selector).evaluateAll(
      (els) => els.map((e) => (e as HTMLAnchorElement).href),
    );
    const out = new Set<string>();
    for (const h of hrefs) { const n = normalizeProfileUrl(h); if (n) out.add(n); }
    return [...out];
  }

  async close(): Promise<void> { await this.session.close(); }
}
