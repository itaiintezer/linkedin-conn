import type { Page } from 'playwright-core';
import type { BrowserDriver, SendOutcome, LoginSnapshot, CheckpointScan } from '../types.js';
import { CloakSession } from './cloak-session.js';
import { SEL, find, URLS, customInviteUrl, profileSlug } from './linkedin-selectors.js';
import { normalizeProfileUrl } from '../core/url.js';
import { applyFirstName } from '../core/message.js';
import { detectCheckpoint } from '../core/checkpoint.js';
import { captureEvidence } from './evidence.js';
import { scrollToLoad } from './auto-scroll.js';
import { log } from '../core/log.js';

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

  async checkpointScan(): Promise<CheckpointScan> {
    if (!this.session.launched) return { hit: false, via: null, matched: null, url: '', title: '' };
    const page = await this.session.page();
    return this.scanCheckpoint(page);
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
      {
        const scan = await this.scanCheckpoint(page);
        if (scan.hit) return this.checkpointOutcome(page, scan, firstName);
      }
      if (await find.pendingBadge(page).first().isVisible().catch(() => false)) {
        return { result: 'already', firstName }; // an invite is already pending
      }
      // Already a 1st-degree connection? There's no Pending badge and no Connect control for
      // them — but LinkedIn STILL opens the custom-invite composer for connections, so without
      // this guard we'd "send", find no Pending on re-visit, and mis-record `failed`.
      if (await this.isAlreadyConnected(page, url)) return { result: 'already', firstName };

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
        const scan = await this.scanCheckpoint(page);
        if (scan.hit) return this.checkpointOutcome(page, scan, firstName);
        if (await this.emailRequired(page)) return this.emailRequiredOutcome(page, firstName);
        return { result: 'unavailable', firstName };
      }

      // The gate usually shows its "please enter their email to connect" text the moment
      // the composer opens — bail before typing a note or submitting anything.
      if (await this.emailRequired(page)) return this.emailRequiredOutcome(page, firstName);

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
      // The email-verification gate appears here, in place of a success signal — catch it
      // now, while the dialog is still on screen (the confirm step navigates away).
      if (await this.emailRequired(page)) return this.emailRequiredOutcome(page, firstName);

      // 3) Confirm the invite actually registered. The composer route only spins after
      //    submit and gives no success signal, so we trust LinkedIn's own state instead
      //    of the click: the profile must now show a Pending badge.
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      try {
        await find.pendingBadge(page).first().waitFor({ state: 'visible', timeout: 9000 });
        return { result: 'sent', firstName };
      } catch {
        const scan = await this.scanCheckpoint(page);
        if (scan.hit) return this.checkpointOutcome(page, scan, firstName);
        // No Pending badge. If there's no longer any Connect control for this person, the
        // request had nowhere to land — they're already connected, not a failure (which would
        // keep getting retried against LinkedIn).
        if (await this.isAlreadyConnected(page, url)) return { result: 'already', firstName };
        return this.errorOutcome(page, 'send not confirmed: no Pending state after submit', firstName);
      }
    } catch (e) {
      const scan = await this.scanCheckpoint(page);
      if (scan.hit) return this.checkpointOutcome(page, scan);
      return this.errorOutcome(page, (e as Error).message);
    }
  }

  /**
   * Narrow challenge detection: the page URL (challenges navigate to /checkpoint/,
   * /authwall, /uas/) plus the tab title and h1 headline. Never the page body — the
   * old whole-HTML regex halted the engine on a profile whose content merely
   * mentioned security words (2026-07-02).
   */
  private async scanCheckpoint(page: Page): Promise<CheckpointScan> {
    const url = page.url();
    const title = (await page.title().catch(() => '')) || '';
    const headings = await page.locator('h1').allInnerTexts().catch(() => [] as string[]);
    return detectCheckpoint({ url, title, headings });
  }

  /** A checkpoint verdict, with the page snapshotted so the halt is explainable. */
  private async checkpointOutcome(page: Page, scan: CheckpointScan, firstName?: string): Promise<SendOutcome> {
    const ev = await captureEvidence(page, 'checkpoint', { matched: scan.matched, via: scan.via });
    return {
      result: 'checkpoint',
      error: `checkpoint detected at ${scan.url}`,
      firstName,
      evidence: { pageUrl: scan.url, matched: scan.matched, screenshot: ev?.screenshot ?? null },
    };
  }

  /** A failed-send verdict, with the page snapshotted so the failure is explainable. */
  private async errorOutcome(page: Page, error: string, firstName?: string): Promise<SendOutcome> {
    const ev = await captureEvidence(page, 'send-failed', { error });
    return {
      result: 'error',
      error,
      firstName,
      evidence: { pageUrl: page.url(), screenshot: ev?.screenshot ?? null },
    };
  }

  /** True if LinkedIn's email-verification gate is showing (the invite cannot be sent). */
  private async emailRequired(page: Page): Promise<boolean> {
    if (await find.emailVerifyText(page).first().isVisible().catch(() => false)) return true;
    return find.emailVerifyInput(page).first().isVisible().catch(() => false);
  }

  /** The member requires their email to connect — terminal, never retryable. Evidence is
   *  captured BEFORE dismissing so the screenshot shows the gate itself. */
  private async emailRequiredOutcome(page: Page, firstName?: string): Promise<SendOutcome> {
    const ev = await captureEvidence(page, 'email-required', {});
    await find.dismissDialog(page).first().click().catch(() => {}); // leave no modal behind
    return {
      result: 'email_required',
      firstName,
      evidence: { pageUrl: page.url(), screenshot: ev?.screenshot ?? null },
    };
  }

  /**
   * True if the profile is an existing 1st-degree connection: the page actually loaded (we
   * can read the name), there's no Pending badge, and there is NO Connect control for this
   * person anywhere (top card, direct custom-invite anchor, or under "More"). Verified live:
   * a connection exposes none of those; a sendable profile exposes the custom-invite anchor
   * at the top level. Degree text ("· 1st"/"· 2nd") is NOT usable — it appears on every page
   * (sidebar recommendations) and even shows both tokens for the owner.
   */
  private async isAlreadyConnected(page: Page, url: string): Promise<boolean> {
    const name = await this.readFullName(page);
    if (!name) return false; // no profile rendered — don't infer "connected" from a blank page
    if (await find.pendingBadge(page).first().isVisible().catch(() => false)) return false;
    return !(await this.hasConnectAffordance(page, url, name));
  }

  /** Whether a Connect/Invite control for THIS person exists (top card, direct anchor, or under "More"). */
  private async hasConnectAffordance(page: Page, url: string, name: string): Promise<boolean> {
    const slug = profileSlug(url);
    const main = page.locator('main');
    if (await find.connectByName(main, name).first().isVisible().catch(() => false)) return true;
    if (slug && (await find.connectByHref(page, slug).first().isVisible().catch(() => false))) return true;
    // Connect is sometimes tucked under the "More" overflow — expand once and re-check.
    const more = find.moreButton(main).first();
    if (await more.isVisible().catch(() => false)) {
      await more.click().catch(() => {});
      await sleep(rand(600, 1200));
      if (slug && (await find.connectByHref(page, slug).first().isVisible().catch(() => false))) return true;
      if (await find.connectByName(main, name).first().isVisible().catch(() => false)) return true;
    }
    return false;
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
    if ((await this.scanCheckpoint(page)).hit) {
      await captureEvidence(page, 'checkpoint', { during: 'invitations read' });
      throw new Error('checkpoint detected during invitations read');
    }
    await this.autoScroll(page);
    return this.collectProfileLinks(page, SEL.invitationCardLink);
  }

  async readRecentConnections(): Promise<string[]> {
    const page = await this.session.page();
    await page.goto(URLS.connections, { waitUntil: 'domcontentloaded' });
    await sleep(rand(2000, 4000));
    if ((await this.scanCheckpoint(page)).hit) {
      await captureEvidence(page, 'checkpoint', { during: 'connections read' });
      throw new Error('checkpoint detected during connections read');
    }
    await this.scrollConnections(page, 6); // a few pages of "recently added" (weeks of history)
    return this.collectProfileLinks(page, SEL.connectionCardLink);
  }

  /**
   * Load more of the "recently added" connections by scrolling. CRITICAL: this list lives
   * inside a scrollable <main>, NOT the document — and its lazy loader only fires on real
   * wheel events, so programmatic window/element scrolling is a silent no-op (that was the
   * old bug: it never actually paged in more connections). We move the cursor over the list
   * and dispatch trusted wheel events, measuring the scoped card selector for growth and
   * stopping once it stalls (see auto-scroll.ts). Not virtualized: cards persist, so a
   * single collectProfileLinks afterwards captures everyone we scrolled past.
   */
  private async scrollConnections(page: Page, maxRounds: number): Promise<void> {
    const box = await page.locator('main').boundingBox().catch(() => null);
    const x = box ? box.x + box.width / 2 : 600;
    const y = box ? box.y + box.height / 2 : 400;
    await page.mouse.move(x, y);
    const { rounds, finalCount } = await scrollToLoad({
      scrollOnce: async () => { await page.mouse.wheel(0, 2200); await sleep(rand(1100, 1800)); },
      count: () => page.locator(SEL.connectionCardLink).count(),
      onRound: (round, count) => log.debug('acceptance', 'connections scroll', { round, count }),
    }, maxRounds);
    log.info('acceptance', 'connections list loaded', { rounds, cards: finalCount });
  }

  // Scroll to the bottom repeatedly until the number of profile links stops growing
  // (lazy-loaded lists), bounded by maxRounds. Used only by the deprecated
  // readPendingInvites diagnostic below.
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
