import type { Page } from 'playwright-core';
import type { BrowserDriver, SendOutcome, LoginSnapshot } from '../types.js';
import { CloakSession } from './cloak-session.js';
import { SEL, find, URLS, customInviteUrl, profileSlug } from './linkedin-selectors.js';
import { normalizeProfileUrl } from '../core/url.js';
import { applyFirstName } from '../core/message.js';

const rand = (min: number, max: number) => min + Math.floor(Math.random() * (max - min));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class LinkedInDriver implements BrowserDriver {
  constructor(private session = new CloakSession()) {}

  browserOpen(): boolean {
    return this.session.launched;
  }

  async readLoginState(): Promise<LoginSnapshot> {
    // Opens the context if needed — callers that must stay non-disruptive
    // (the dashboard poll, the orchestrator refresher) guard with browserOpen() first.
    const ctx = await this.session.context();
    const cookies = await ctx.cookies('https://www.linkedin.com');
    const li = cookies.find((c) => c.name === 'li_at' && !!c.value);
    const expirySec = li?.expires;
    const cookieExpiry = typeof expirySec === 'number' && expirySec > 0
      ? new Date(expirySec * 1000).toISOString()
      : null;
    return { loggedIn: !!li, cookieExpiry };
  }

  async checkpointPresent(): Promise<boolean> {
    if (!this.session.launched) return false;
    const page = await this.session.page();
    return this.looksLikeCheckpoint(page);
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
      if (await find.pendingBadge(page).first().isVisible().catch(() => false)) {
        return { result: 'already', firstName };
      }

      // 2) Open the invite composer: direct custom-invite route first, then
      //    fall back to clicking the Connect control on the profile UI.
      await page.goto(customInviteUrl(slug), { waitUntil: 'domcontentloaded' });
      await sleep(rand(2000, 4000));
      if (!(await this.composerVisible(page))) {
        await this.openComposerViaProfile(page, url);
        await sleep(rand(1500, 3000));
      }
      const sendWithout = find.sendWithoutNote(page).first();
      const addNote = find.addNote(page).first();
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
        // Substitute {firstName} with the name captured during the pre-visit (step 1).
        const note = applyFirstName(message, firstName ?? null);
        await page.locator(SEL.noteTextarea).fill(note);
        await sleep(rand(700, 1600));
        await find.sendInvitation(page).first().click();
      } else {
        await sendWithout.click();
      }
      await sleep(rand(1500, 3000));

      // 3) Confirm the invite actually registered. The composer route only spins after
      //    submit and gives no success signal, so we trust LinkedIn's own state instead
      //    of the click: the profile must now show a Pending badge.
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      try {
        await find.pendingBadge(page).first().waitFor({ state: 'visible', timeout: 9000 });
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

  /** True if the invite composer (note or no-note path) is currently open. */
  private async composerVisible(page: Page): Promise<boolean> {
    if (await find.sendWithoutNote(page).first().isVisible().catch(() => false)) return true;
    return find.addNote(page).first().isVisible().catch(() => false);
  }

  /**
   * Fallback when the direct custom-invite route yields no composer: open the
   * profile and click the target's Connect control. The control has two shapes:
   *  - top card: matched by the target's name (scoped to <main> to skip the
   *    "people also viewed" sidebar, whose Connect links are also inside <main>);
   *  - under the "More" overflow: a custom-invite anchor carrying the target's
   *    own slug, so it can never resolve to a different person.
   * Verified live against both layouts (top-card and Connect-under-More).
   */
  private async openComposerViaProfile(page: Page, url: string): Promise<void> {
    const slug = profileSlug(url);
    if (!slug) return;
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await sleep(rand(1500, 3000));

    const name = await this.readFullName(page);
    const main = page.locator('main');
    const byName = name ? find.connectByName(main, name).first() : null;
    const byHref = find.connectByHref(page, slug).first();

    const clickIfVisible = async (loc: typeof byHref | null): Promise<boolean> => {
      if (!loc) return false;
      if (!(await loc.isVisible().catch(() => false))) return false;
      await loc.click().catch(() => {});
      await sleep(rand(1500, 3000));
      return this.composerVisible(page);
    };

    // a) Connect in the top card, then b) a direct custom-invite anchor for this target.
    if (await clickIfVisible(byName)) return;
    if (await clickIfVisible(byHref)) return;

    // c) Connect tucked under the "More" overflow (scoped to <main> to avoid the
    //    global-nav "More").
    const more = find.moreButton(main).first();
    if (await more.isVisible().catch(() => false)) {
      await more.click().catch(() => {});
      await sleep(rand(800, 1600));
      if (await clickIfVisible(byHref)) return;
      await clickIfVisible(byName);
    }
  }

  // The new profile UI has no <h1>; the profile name is reliably in the document title.
  private async readFullName(page: Page): Promise<string | undefined> {
    const title = (await page.title().catch(() => '')) || '';
    const name = title.replace(/^\(\d+\+?\)\s*/, '').replace(/\s*[|·].*$/, '').trim();
    if (!name || /linkedin/i.test(name)) return undefined;
    return name;
  }

  private async readFirstName(page: Page): Promise<string | undefined> {
    return (await this.readFullName(page))?.split(/\s+/)[0];
  }

  /**
   * DEPRECATED / diagnostic-only. The sent-invitations list is very large and only its
   * newest page renders (scroll does not lazy-load more), so this returns just the top
   * slice — NOT all outstanding invites. Acceptance tracking no longer calls this (it
   * would false-expire everything below the top slice); expiry is now age-based
   * (see core/acceptance.ts). Kept for scripts/verify-readers.
   */
  async readPendingInvites(): Promise<string[]> {
    const page = await this.session.page();
    await page.goto(URLS.sentInvitations, { waitUntil: 'domcontentloaded' });
    await sleep(rand(2000, 4000));
    if (await this.looksLikeCheckpoint(page)) throw new Error('checkpoint detected during invitations read');
    await this.autoScroll(page);
    return this.collectProfileLinks(page, SEL.invitationCardLink);
  }

  async readRecentConnections(): Promise<string[]> {
    const page = await this.session.page();
    await page.goto(URLS.connections, { waitUntil: 'domcontentloaded' });
    await sleep(rand(2000, 4000));
    if (await this.looksLikeCheckpoint(page)) throw new Error('checkpoint detected during connections read');
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
