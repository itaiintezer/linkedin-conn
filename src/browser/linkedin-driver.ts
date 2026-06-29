import type { Page } from 'playwright-core';
import type { BrowserDriver, SendOutcome } from '../types.js';
import { CloakSession } from './cloak-session.js';
import { SEL, URLS } from './linkedin-selectors.js';
import { normalizeProfileUrl } from '../core/url.js';

const rand = (min: number, max: number) => min + Math.floor(Math.random() * (max - min));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class LinkedInDriver implements BrowserDriver {
  constructor(private session = new CloakSession()) {}

  async isLoggedIn(): Promise<boolean> {
    const page = await this.session.page();
    await page.goto(URLS.home, { waitUntil: 'domcontentloaded' });
    try {
      await page.waitForSelector(SEL.feedMarker, { timeout: 8000 });
      return true;
    } catch {
      return false;
    }
  }

  async openLoginWindow(): Promise<void> {
    const page = await this.session.page();
    await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' });
  }

  async sendConnectionRequest(url: string, message: string | null): Promise<SendOutcome> {
    const page = await this.session.page();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await sleep(rand(1500, 4000));
      const firstName = await this.readFirstName(page);

      if (await page.locator(SEL.pendingBadge).first().isVisible().catch(() => false)) {
        return { result: 'already', firstName };
      }

      const clicked = await this.clickConnect(page);
      if (!clicked) return { result: 'unavailable', firstName };

      if (message !== null) {
        const addNote = page.locator(SEL.addNoteButton).first();
        if (await addNote.isVisible().catch(() => false)) {
          await addNote.click();
          await sleep(rand(800, 2000));
          if (await page.locator(SEL.noteQuotaDialog).first().isVisible().catch(() => false)) {
            return { result: 'note_quota', firstName };
          }
          await page.locator(SEL.noteTextarea).fill(message);
          await sleep(rand(800, 2000));
          await page.locator(SEL.sendButton).first().click();
          return { result: 'sent', firstName };
        }
      }
      const without = page.locator(SEL.sendWithoutNote).first();
      if (await without.isVisible().catch(() => false)) await without.click();
      else await page.locator(SEL.sendButton).first().click();
      return { result: 'sent', firstName };
    } catch (e) {
      const body = (await page.content().catch(() => '')) || '';
      if (/captcha|checkpoint|verify|unusual activity/i.test(body)) {
        return { result: 'checkpoint', error: 'checkpoint detected' };
      }
      return { result: 'error', error: (e as Error).message };
    }
  }

  private async readFirstName(page: Page): Promise<string | undefined> {
    const h1 = await page.locator('h1').first().textContent().catch(() => null);
    if (!h1) return undefined;
    return h1.trim().split(/\s+/)[0];
  }

  private async clickConnect(page: Page): Promise<boolean> {
    const direct = page.locator(SEL.connectButton).first();
    if (await direct.isVisible().catch(() => false)) { await direct.click(); return true; }
    const more = page.locator(SEL.moreButton).first();
    if (await more.isVisible().catch(() => false)) {
      await more.click();
      await sleep(rand(500, 1200));
      const item = page.locator(SEL.moreConnectItem).first();
      if (await item.isVisible().catch(() => false)) { await item.click(); return true; }
    }
    return false;
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
