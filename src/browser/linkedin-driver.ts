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
      // 1) Pre-visit the profile: capture the name and detect an already-pending invite
      //    (so we never re-send) or a checkpoint.
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await sleep(rand(1500, 3500));
      const firstName = await this.readFirstName(page);
      if (await this.looksLikeCheckpoint(page)) return { result: 'checkpoint', error: 'checkpoint detected', firstName };
      if (await page.locator(SEL.pendingBadge).first().isVisible().catch(() => false)) {
        return { result: 'already', firstName };
      }

      // 2) Open the invite composer route and submit.
      await page.goto(customInviteUrl(slug), { waitUntil: 'domcontentloaded' });
      await sleep(rand(2000, 4000));
      const sendWithout = page.locator(SEL.sendWithoutNote).first();
      const addNote = page.locator(SEL.addNoteButton).first();
      const hasSendWithout = await sendWithout.isVisible().catch(() => false);
      const hasAddNote = await addNote.isVisible().catch(() => false);

      if (!hasSendWithout && !hasAddNote) {
        if (await this.looksLikeCheckpoint(page)) return { result: 'checkpoint', error: 'checkpoint detected', firstName };
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
      } else {
        await sendWithout.click();
      }
      await sleep(rand(1500, 3000));

      // 3) Confirm the invite actually registered. The composer route only spins after
      //    submit and gives no success signal, so we trust LinkedIn's own state instead
      //    of the click: the profile must now show a Pending badge.
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      try {
        await page.waitForSelector(SEL.pendingBadge, { timeout: 9000 });
        return { result: 'sent', firstName };
      } catch {
        if (await this.looksLikeCheckpoint(page)) return { result: 'checkpoint', error: 'checkpoint detected', firstName };
        return { result: 'error', error: 'send not confirmed: no Pending state after submit', firstName };
      }
    } catch (e) {
      if (await this.looksLikeCheckpoint(page)) return { result: 'checkpoint', error: 'checkpoint detected' };
      return { result: 'error', error: (e as Error).message };
    }
  }

  private async looksLikeCheckpoint(page: Page): Promise<boolean> {
    const body = (await page.content().catch(() => '')) || '';
    return /captcha|checkpoint|verify you|unusual activity|security check/i.test(body);
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
    // The list lazy-loads; load it all so we never falsely "expire" a pending invite
    // that simply hadn't scrolled into view.
    await this.autoScroll(page);
    return this.collectProfileLinks(page, SEL.invitationCardLink);
  }

  async readRecentConnections(): Promise<string[]> {
    const page = await this.session.page();
    await page.goto(URLS.connections, { waitUntil: 'domcontentloaded' });
    await sleep(rand(2000, 4000));
    await this.autoScroll(page, 6); // a few pages of "recently added" is enough
    return this.collectProfileLinks(page, SEL.connectionCardLink);
  }

  // Scroll to the bottom repeatedly until the number of profile links stops growing
  // (lazy-loaded lists), bounded by maxRounds.
  private async autoScroll(page: Page, maxRounds = 15): Promise<void> {
    let prev = -1;
    for (let i = 0; i < maxRounds; i++) {
      const count = await page.locator('a[href*="/in/"]').count();
      if (count === prev) break;
      prev = count;
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await sleep(rand(900, 1700));
    }
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
