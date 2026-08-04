import type { Page, Locator } from 'playwright-core';
import type {
  BrowserDriver, SendOutcome, SendOptions, LoginSnapshot, CheckpointScan, InboxRow,
  ConnectionCard, EventStepOutcome, BucketRunRequest, BucketRunResult,
  EngagementOutcome, Reaction,
} from '../types.js';
import { attendEvent, openEvent, runBucket } from './event-invite-driver.js';
import { CloakSession } from './cloak-session.js';
import { SEL, find, URLS, customInviteUrl, profileSlug, isNotFoundUrl } from './linkedin-selectors.js';
import {
  PSEL, reactionEntry, existingReactionFrom, commentNeedle, confirmPostedComment,
  type ThreadRow, type CommentConfirmation,
  POST_LOAD_TIMEOUT_MS, FLYOUT_TIMEOUT_MS, REACTED_TIMEOUT_MS, SUBMIT_ARM_TIMEOUT_MS,
  COMMENT_CONFIRM_TIMEOUT_MS,
} from './post-selectors.js';
import { normalizeProfileUrl } from '../core/url.js';
import {
  classifyRelationship, skipsInvite, confirmsInviteLanded, mayReceiveDirectMessage,
  type Relationship,
} from '../core/relationship.js';
import { applyFirstName, MAX_MESSAGE } from '../core/message.js';
import { firstNameFrom } from '../core/first-name.js';
import { detectCheckpoint } from '../core/checkpoint.js';
import { captureEvidence } from './evidence.js';
import { scrollToLoad, collectWhileScrolling } from './auto-scroll.js';
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

  async sendConnectionRequest(url: string, message: string | null, opts?: SendOptions): Promise<SendOutcome> {
    const page = await this.session.page();
    const slug = profileSlug(url);
    if (!slug) return { result: 'error', error: `cannot parse profile slug from ${url}` };
    try {
      // 1) Pre-visit the profile: capture the name and detect an already-pending invite
      //    (so we never re-send) or a checkpoint.
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await sleep(rand(1500, 3500));
      // Dead profile (deleted account / renamed slug) — LinkedIn redirects to /404/.
      // Without this check the flow degrades step by step into 'unavailable', which
      // counts toward the failure streak and halted the engine on 2026-07-27 when
      // three stale imports sat adjacent in the queue.
      if (isNotFoundUrl(page.url())) return this.notFoundOutcome(page);
      const firstName = opts?.firstName ?? await this.readFirstName(page);
      {
        const scan = await this.scanCheckpoint(page);
        if (scan.hit) return this.checkpointOutcome(page, scan, firstName);
      }
      // Don't re-send to someone with an invite already pending, and don't invite an existing
      // connection — LinkedIn STILL opens the custom-invite composer for connections, so
      // without this guard we'd "send", find no Pending on re-visit, and mis-record the row.
      // skipsInvite deliberately also covers 'unknown', which is what the pre-2026-08-03 code
      // treated as connected; keeping that keeps every classic-layout outcome unchanged.
      const preVisit = await this.classifyRelationship(page, url);
      if (skipsInvite(preVisit)) return { result: 'already', firstName, relationship: preVisit };

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
        // The weekly invitation limit replaces the composer with its own dialog —
        // an account-level cap, not a per-profile problem or a UI change.
        if (await page.locator(SEL.noteQuotaDialog).first().isVisible().catch(() => false)) {
          return this.weeklyLimitOutcome(page, firstName);
        }
        // Unexplained: no composer, no known gate. Snapshot the page — this verdict
        // feeds the failure streak, so a halt on it must be diagnosable after the fact.
        const ev = await captureEvidence(page, 'composer-unavailable', {});
        return {
          result: 'unavailable',
          firstName,
          evidence: { pageUrl: page.url(), screenshot: ev?.screenshot ?? null },
        };
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
        // The top card showed no Pending badge within the window. Under Sales Navigator it
        // never will — Pending is demoted into the "More" overflow — so classify properly
        // before judging, expanding the overflow if the top card is inconclusive.
        const after = await this.classifyRelationship(page, url);
        if (confirmsInviteLanded(after)) return { result: 'sent', firstName, relationship: after };
        // Deliberately NOT 'already' here, however little we can see. The pre-visit above
        // classified them invitable seconds ago and nobody becomes a 1st-degree connection in
        // between, so "no signals" means we failed to read the page — not that they were
        // connected all along. Returning 'already' recorded live pending invites as terminal
        // already_connected skips, with no send_log row and no evidence (2026-08-03).
        if (await this.invitePendingOnSentList(url)) {
          return { result: 'sent', firstName, relationship: after };
        }
        return this.unconfirmedOutcome(page, firstName, after);
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

  /**
   * The invite was submitted but LinkedIn would not confirm it — neither the profile page nor
   * the sent-invitations list showed it. Snapshotted, because this is the one verdict that
   * asks a human to go and look; the old code silently called this case "already connected"
   * and captured nothing, which is why the original incident had no evidence to inspect.
   */
  private async unconfirmedOutcome(
    page: Page, firstName: string | undefined, relationship: Relationship,
  ): Promise<SendOutcome> {
    const ev = await captureEvidence(page, 'send-unconfirmed', { relationship });
    return {
      result: 'unconfirmed',
      error: 'invite submitted but not confirmed — check the profile before retrying',
      firstName,
      relationship,
      evidence: { pageUrl: page.url(), screenshot: ev?.screenshot ?? null },
    };
  }

  /** True if LinkedIn's email-verification gate is showing (the invite cannot be sent). */
  private async emailRequired(page: Page): Promise<boolean> {
    if (await find.emailVerifyText(page).first().isVisible().catch(() => false)) return true;
    return find.emailVerifyInput(page).first().isVisible().catch(() => false);
  }

  /** LinkedIn's weekly invitation limit dialog is showing in place of the composer.
   *  Evidence is captured BEFORE dismissing so the screenshot shows the dialog. */
  private async weeklyLimitOutcome(page: Page, firstName?: string): Promise<SendOutcome> {
    const ev = await captureEvidence(page, 'weekly-limit', {});
    await find.dismissDialog(page).first().click().catch(() => {}); // leave no modal behind
    return {
      result: 'weekly_limit',
      firstName,
      evidence: { pageUrl: page.url(), screenshot: ev?.screenshot ?? null },
    };
  }

  /** The profile URL no longer exists (LinkedIn redirected to /404/) — terminal, never
   *  retryable. Evidence keeps the verdict auditable without re-visiting the URL. */
  private async notFoundOutcome(page: Page): Promise<SendOutcome> {
    const ev = await captureEvidence(page, 'profile-not-found', {});
    return {
      result: 'not_found',
      evidence: { pageUrl: page.url(), screenshot: ev?.screenshot ?? null },
    };
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
   * What the profile page says about our relationship to this person. The decisions keyed off
   * this live in core/relationship.ts, where a truth table pins them; this method only reads
   * the DOM. Degree text ("· 1st"/"· 2nd") is NOT usable — it appears on every page (sidebar
   * recommendations) and even shows both tokens for the owner (re-confirmed 2026-08-03: a
   * probe read "· 2nd" on a 1st-degree profile and "· 1st" on a pending one).
   *
   * Two passes, and the order is load-bearing:
   *
   *  1. The top card, untouched. A classic (non-Sales-Navigator) layout keeps Pending and
   *     Connect as primary controls, so it resolves here and never opens the overflow — no
   *     extra click, no extra latency on the path that already works.
   *  2. Only if that was inconclusive, expand "More" and look again. A Sales Navigator
   *     licence spends a primary slot on "Save in Sales Navigator" and demotes the
   *     relationship affordance into that overflow, where it is not merely hidden but
   *     ABSENT from the DOM until the menu opens — which is why no timeout could ever have
   *     fixed this, and why the old code (which checked Pending BEFORE the expand that
   *     hasConnectAffordance performed) lost the signal on ordering alone.
   *
   * Finding nothing yields 'unknown', never 'connected'. Callers decide what absence means:
   * the pre-visit still treats it as connected (preserving the old behaviour exactly), the
   * post-submit confirmation refuses to.
   */
  private async classifyRelationship(page: Page, url: string): Promise<Relationship> {
    const name = await this.readFullName(page);
    if (!name) return classifyRelationship({
      nameRead: false, pendingForTarget: false, connectForTarget: false, removeConnection: false,
    });

    const read = async (overflowExpanded: boolean): Promise<Relationship> => classifyRelationship({
      nameRead: true,
      pendingForTarget: await this.pendingForTarget(page, name),
      connectForTarget: await this.connectForTarget(page, url, name),
      // Only trustworthy inside the overflow we just opened (see selectors).
      removeConnection: overflowExpanded && (await this.removeConnectionVisible(page)),
    });

    const topCard = await read(false);
    if (topCard !== 'unknown') return topCard;
    if (!(await this.expandOverflow(page))) return 'unknown';
    return read(true);
  }

  /**
   * A Pending badge for THIS person. Prefers the name-scoped label, which cannot be
   * satisfied by a pending invite to someone in the right-rail recommendations, then falls
   * back to the bare badge so any layout whose label omits the name behaves as it did before.
   */
  private async pendingForTarget(page: Page, name: string): Promise<boolean> {
    if (await find.pendingBadgeForName(page, name).first().isVisible().catch(() => false)) return true;
    return find.pendingBadge(page).first().isVisible().catch(() => false);
  }

  /** A Connect/Invite control for THIS person: top card by name, or a custom-invite anchor
   *  carrying their own slug (which can never resolve to a different person). */
  private async connectForTarget(page: Page, url: string, name: string): Promise<boolean> {
    const slug = profileSlug(url);
    const main = page.locator('main');
    if (await find.connectByName(main, name).first().isVisible().catch(() => false)) return true;
    if (slug && (await find.connectByHref(page, slug).first().isVisible().catch(() => false))) return true;
    return false;
  }

  /** Expand the profile's "More" overflow. Scoped to <main> so it cannot hit the global-nav
   *  "More"; same click-and-settle timing the old hasConnectAffordance used. */
  private async expandOverflow(page: Page): Promise<boolean> {
    const more = find.moreButton(page.locator('main')).first();
    if (!(await more.isVisible().catch(() => false))) return false;
    await more.click().catch(() => {});
    await sleep(rand(600, 1200));
    return true;
  }

  /** "Remove connection" inside the expanded overflow — the positive connected signal. */
  private async removeConnectionVisible(page: Page): Promise<boolean> {
    const menu = page.locator(SEL.overflowMenu).first();
    if (!(await menu.isVisible().catch(() => false))) return false;
    return find.removeConnection(menu).first().isVisible().catch(() => false);
  }

  /**
   * Last-resort confirmation for a submitted invite the profile page would not confirm:
   * LinkedIn's own sent-invitations list. Account-level, so it is immune to whatever the
   * top card is doing. The documented weakness of this reader — only the newest page loads,
   * which is why acceptance stopped using it (false expiries) — does not apply here: an
   * invite sent seconds ago is in that newest slice by construction. Any failure (including
   * a checkpoint mid-read) answers "cannot confirm" rather than throwing, so the send falls
   * through to the operator instead of blowing up the pass.
   */
  private async invitePendingOnSentList(url: string): Promise<boolean> {
    const target = normalizeProfileUrl(url);
    if (!target) return false;
    try {
      return (await this.readPendingInvites()).includes(target);
    } catch {
      return false;
    }
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
    // The page title is a rendering artifact — it carries notification counts, bidi marks
    // and headline tails. Two names were sent with a leading U+200F before this.
    return firstNameFrom(await this.readFullName(page) ?? null) ?? undefined;
  }

  /**
   * Send a direct message to an existing 1st-degree connection.
   * Flow (live-verified 2026-07-28): profile page → 1st-degree gate (classifyRelationship
   * plus mayReceiveDirectMessage — NOT the degree badge, which renders unreliably) → navigate
   * to the profile's own /messaging/compose/ deep link → type into the classic msg-form →
   * Send → verify structurally (composer cleared + our text present in the thread).
   * Anything not clearly a 1st-degree connection is 'not_connected' — never InMail.
   */
  async sendMessage(url: string, message: string, opts?: SendOptions): Promise<SendOutcome> {
    const page = await this.session.page();
    try {
      // 1) Profile pre-visit: name capture + gates.
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await sleep(rand(1500, 3500));
      if (isNotFoundUrl(page.url())) return this.notFoundOutcome(page);
      // The full name is still read verbatim for the 1st-degree gate and the stored record;
      // only the greeting name is sanitised, and an injected roster name wins outright.
      const fullName = await this.readFullName(page);
      const firstName = opts?.firstName ?? firstNameFrom(fullName ?? null) ?? undefined;
      {
        const scan = await this.scanCheckpoint(page);
        if (scan.hit) return this.checkpointOutcome(page, scan, firstName);
      }
      // 1st-degree gate: must be an existing connection (fail-safe: skip, never InMail).
      // 'pending' is rejected here specifically: under Sales Navigator a pending invite used
      // to classify as connected, inverting this gate so a non-connection could be messaged.
      // 'unknown' still passes, as it did before, so a classic-layout connection that shows no
      // positive signal keeps working.
      const relationship = await this.classifyRelationship(page, url);
      if (!mayReceiveDirectMessage(relationship)) {
        return { result: 'not_connected', firstName, fullName, relationship };
      }
      // 2) The Message control is an anchor to the compose route; its absence on a
      //    connection's profile means messaging is unavailable for them — skip.
      const composeHref = await page.locator(SEL.msgComposeLink).first()
        .getAttribute('href').catch(() => null);
      if (!composeHref) return { result: 'not_connected', firstName, fullName };

      // 3) Compose route → classic msg-form overlay with stable selectors.
      await page.goto(new URL(composeHref, 'https://www.linkedin.com').href, { waitUntil: 'domcontentloaded' });
      await sleep(rand(3000, 5000));
      const box = page.locator(SEL.msgBox).last();
      if (!(await box.isVisible().catch(() => false))) {
        const scan = await this.scanCheckpoint(page);
        if (scan.hit) return this.checkpointOutcome(page, scan, firstName);
        const ev = await captureEvidence(page, 'msg-composer-unavailable', {});
        return {
          result: 'unavailable', firstName, fullName,
          evidence: { pageUrl: page.url(), screenshot: ev?.screenshot ?? null },
        };
      }

      // 4) Type like a human; the send button flips enabled only when text registered.
      const text = applyFirstName(message, firstName ?? null, MAX_MESSAGE);
      await box.click();
      // Type line by line, inserting breaks with Shift+Enter. keyboard.type() maps '\n'
      // to a bare ENTER keypress, and if the classic msg-form treats Enter as "send" a
      // multi-line template would send TRUNCATED at the first newline and then type the
      // remainder into a fresh composer — two bad, user-visible messages. Shift+Enter is
      // the near-universal newline gesture in chat composers; if LinkedIn ignored it the
      // worst case is a message whose line breaks are missing (cosmetic), which is
      // strictly better than a premature send plus a stray second message. \r\n and lone
      // \r are folded to \n first so Windows-authored templates split the same way.
      const lines = text.replace(/\r\n?/g, '\n').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (i > 0) await page.keyboard.press('Shift+Enter');
        if (lines[i]) await page.keyboard.type(lines[i], { delay: rand(25, 60) });
      }
      await sleep(rand(800, 1600));
      const send = page.locator(SEL.msgSendButton).last();
      if (await send.isDisabled().catch(() => true)) {
        // errorOutcome captures the evidence snapshot itself.
        return this.errorOutcome(page, 'send button never enabled after typing', firstName);
      }
      await send.click();
      await sleep(rand(3000, 5000));

      // 5) Structural confirmation: composer cleared + our text is in the thread.
      //    Both sides are whitespace-normalized: the rendered thread collapses the
      //    newlines of a multi-line template, so comparing raw sent text against
      //    normalized DOM text would report "not confirmed" for a message that DID send
      //    (a false 'error' costs a failure-streak point and invites a duplicate send).
      //    The composer is read as the LAST match, the same one we typed into.
      //
      //    NOTE: the needles are normalized HERE, in Node, and the callback declares no
      //    named inner function on purpose. Under tsx/esbuild (`npm start`), keep-names
      //    rewrites a named inner binding to `__name(fn, "fn")`, and `__name` does not
      //    exist inside the page — the callback would throw ReferenceError at runtime.
      const sent30 = text.replace(/\s+/g, ' ').trim().slice(0, 30);
      const sent40 = text.replace(/\s+/g, ' ').trim().slice(0, 40);
      const confirmed = await page.evaluate(({ boxSel, evSel, sent30: s30, sent40: s40 }) => {
        const boxes = document.querySelectorAll(boxSel);
        const box = boxes[boxes.length - 1];
        const boxText = (box?.textContent || '').replace(/\s+/g, ' ').trim();
        const cleared = !boxText.includes(s30);
        const events = Array.from(document.querySelectorAll(evSel))
          .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim());
        const inThread = events.some((e) => e.includes(s40));
        const failed = /failed to send|couldn.t send|message not sent/i.test(document.body.textContent || '');
        return { cleared, inThread, failed };
      }, { boxSel: SEL.msgBox, evSel: SEL.msgEvent, sent30, sent40 });

      if (confirmed.failed || !(confirmed.cleared && confirmed.inThread)) {
        const scan = await this.scanCheckpoint(page);
        if (scan.hit) return this.checkpointOutcome(page, scan, firstName);
        return this.errorOutcome(page, 'message send not confirmed (composer/thread state)', firstName);
      }
      const threadUrl = /\/messaging\/thread\//.test(page.url()) ? page.url() : undefined;
      return { result: 'sent', firstName, fullName, ...(threadUrl ? { threadUrl } : {}) };
    } catch (e) {
      const scan = await this.scanCheckpoint(page);
      if (scan.hit) return this.checkpointOutcome(page, scan);
      return this.errorOutcome(page, (e as Error).message);
    }
  }

  /**
   * One-page inbox scan (no scrolling: same top-slice tradeoff as the acceptance read).
   *
   * IMPORTANT, verified live 2026-07-29 (scripts/probe-thread-id.ts): conversation rows
   * carry NO anchor and NO conversation-id attribute — they are div click targets with
   * ember-generated ids only, and a thread id appears solely in the address bar once a
   * conversation is open. So `threadUrl` below is effectively always absent, and the reply
   * matcher's thread-id tier (and its veto) are INERT in production: name matching does
   * the real work. The extraction is kept because it costs nothing and starts working the
   * day LinkedIn renders hrefs again — but do not rely on it, and do not "fix" the matcher
   * by loosening names on the assumption that thread ids will catch mistakes.
   */
  /**
   * Snapshot the conversation list, scrolling to reach past the first screen.
   *
   * The scroll is not optional. LinkedIn renders ~10 conversations on load and orders them
   * by most recent activity, so every message WE send pushes older threads down. Reading only
   * the first screen therefore loses replies as soon as the day's send volume exceeds ~10:
   * on 2026-07-29 a real reply from the day's first contact went undetected because 29 later
   * sends had buried his thread, and the read reported rows=10 while 22 of 29 pending
   * contacts were never examined at all.
   *
   * Rows are accumulated per scroll round rather than collected once at the end, so this is
   * correct whether or not the list virtualizes — see collectWhileScrolling.
   */
  async readInboxSnapshot(maxRounds = 25): Promise<InboxRow[]> {
    const page = await this.session.page();
    await page.goto(URLS.messaging, { waitUntil: 'domcontentloaded' });
    await sleep(rand(3000, 5000));
    if ((await this.scanCheckpoint(page)).hit) {
      await captureEvidence(page, 'checkpoint', { during: 'inbox read' });
      throw new Error('checkpoint detected during inbox read');
    }
    const { items, rounds, exhausted } = await collectWhileScrolling<InboxRow>({
      collect: () => this.collectInboxRows(page),
      // threadUrl is the real identity when the row exposes one (it currently never does),
      // so fall back to name + snippet. Deliberately NOT name alone: two different people
      // sharing a display name must stay two rows.
      key: (r) => r.threadUrl ?? `${r.name}\u0000${r.snippet}`,
      scrollOnce: () => this.scrollInbox(page),
      onRound: (round, total) => log.debug('replies', 'inbox scroll', { round, total }),
    }, maxRounds);
    // Louder than debug on purpose: a truncated snapshot cannot find a reply that sits below
    // the cut, and the reply checker has no other way to know its input was incomplete.
    if (!exhausted) {
      log.warn('replies', 'inbox scroll hit the round cap — snapshot may be truncated', {
        rounds, rows: items.length,
      });
    }
    return items;
  }

  /**
   * One real wheel gesture over the conversation list. Same constraint as the connections
   * list (see scrollConnections): the list scrolls inside its own container, not the
   * document, and its lazy loader only responds to trusted wheel events — so
   * window.scrollTo would be a silent no-op here.
   */
  private async scrollInbox(page: Page): Promise<void> {
    const box = await page.locator(SEL.inboxList).boundingBox().catch(() => null);
    // Fallback aims at the left-hand conversation pane, which is where the list lives.
    const x = box ? box.x + box.width / 2 : 400;
    const y = box ? box.y + box.height / 2 : 400;
    await page.mouse.move(x, y);
    // HALF A VIEWPORT, never more. Each round only snapshots the rows currently rendered, so
    // a step larger than the visible window scrolls rows past without ever capturing them.
    // The original 1800px did exactly that: it traversed ~25 rows per round while capturing a
    // steady +9, and the gaps showed up as contiguous runs of missing conversations (on
    // 2026-07-29, profiles 680-687 — eight consecutive sends — vanished as one block while
    // both their older and newer neighbours were captured). Halving guarantees consecutive
    // snapshots overlap, so accumulation actually covers the list.
    const vh = page.viewportSize()?.height ?? 800;
    await page.mouse.wheel(0, Math.max(300, Math.floor(vh * 0.5)));
    await sleep(rand(900, 1500));
  }

  private async collectInboxRows(page: Page): Promise<InboxRow[]> {
    return page.evaluate(({ listSel, rowSel, nameSel, snipSel }) => {
      // Scope rows to the conversation list when it is present, so a listitem rendered
      // outside the inbox (overlays, the "other" tab's stale DOM) can't enter the snapshot.
      // Falls back to the document on purpose: the list's BEM class is more brittle than
      // the row class, and a hard scope would turn a class rename into an empty read —
      // which the reply checker treats as "page didn't render" and retries forever.
      const root: ParentNode = document.querySelector(listSel) ?? document;
      return Array.from(root.querySelectorAll(rowSel)).map((li) => {
        const name = (li.querySelector(nameSel)?.textContent || '').trim();
        const snippet = (li.querySelector(snipSel)?.textContent || '').trim();
        // Thread href IF the row ever exposes one (see the method comment: it currently
        // never does). When present it is the matcher's strongest key, since a display
        // name can render differently here than in the profile title.
        const href = li.querySelector('a[href*="/messaging/thread/"]')?.getAttribute('href') ?? null;
        const threadUrl = href ? new URL(href, 'https://www.linkedin.com').href : undefined;
        return { name, snippet, youSentLast: /^you:/i.test(snippet), ...(threadUrl ? { threadUrl } : {}) };
      }).filter((r) => r.name || r.threadUrl);
    }, {
      listSel: SEL.inboxList, rowSel: SEL.inboxRow,
      nameSel: SEL.inboxRowName, snipSel: SEL.inboxRowSnippet,
    });
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

  /**
   * Roster sync's read of the connections page: same navigation and scroll as
   * readRecentConnections, but returns the display name alongside each URL so a
   * scrape-discovered connection has a name before enrichment ever runs.
   *
   * The name comes from the anchor's own text, NOT a class selector — the connections
   * page renders hashed class names that churn. Each card contributes several anchors
   * (avatar, name), so results are deduped by URL, preferring whichever anchor had text.
   */
  async readConnectionCards(): Promise<ConnectionCard[]> {
    const page = await this.session.page();
    await page.goto(URLS.connections, { waitUntil: 'domcontentloaded' });
    await sleep(rand(2000, 4000));
    if ((await this.scanCheckpoint(page)).hit) {
      await captureEvidence(page, 'checkpoint', { during: 'roster sync' });
      throw new Error('checkpoint detected during roster sync');
    }
    await this.scrollConnections(page, 6);
    const raw = await page.locator(SEL.connectionCardLink).evaluateAll(
      (els) => els.map((e) => ({
        href: (e as HTMLAnchorElement).href,
        text: (e as HTMLElement).innerText ?? '',
      })),
    );
    const byUrl = new Map<string, ConnectionCard>();
    for (const { href, text } of raw) {
      const url = normalizeProfileUrl(href);
      if (!url) continue;
      const name = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? null;
      const existing = byUrl.get(url);
      if (!existing || (!existing.name && name)) byUrl.set(url, { url, name });
    }
    return [...byUrl.values()];
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

  // --- Event invites. Thin delegation: the operations live in event-invite-driver.ts as
  // free functions over a Page, so they stay testable while this class keeps sole
  // ownership of the single browser session.

  async openEvent(eventUrl: string): Promise<EventStepOutcome> {
    return openEvent(await this.session.page(), eventUrl);
  }

  async attendEvent(): Promise<EventStepOutcome> {
    return attendEvent(await this.session.page());
  }

  async runEventBucket(req: BucketRunRequest): Promise<BucketRunResult> {
    return runBucket(await this.session.page(), req);
  }

  // --- Post engagements ---------------------------------------------------------------
  // Selectors: browser/post-selectors.ts. All of them were captured live and then proven by
  // performing a real Like and a real comment (2026-08-02).

  /**
   * Place a reaction on a post.
   *
   * THE TRIGGER IS A TOGGLE: clicking it while `aria-pressed="true"` REMOVES the reaction.
   * So state is read FIRST and an existing reaction reports `already` without a click. This
   * is not theoretical — the company post probed on 2026-08-02 was already Liked, and a
   * blind click would have silently un-liked it.
   *
   * `like` clicks the trigger directly; every other reaction needs the flyout, which opens on
   * HOVER (no click, no long-press). The flyout entries do not reflect current state, which is
   * the second reason the `already` check reads the trigger and never an entry.
   *
   * `observedUrn` is reported on every outcome that has it: the id in a post URL can differ
   * from the post's own URN (observed live), and the sender reconciles the row from this.
   */
  async reactToPost(postUrl: string, reaction: Reaction): Promise<EngagementOutcome> {
    const page = await this.session.page();
    let observedUrn: string | undefined;
    const urn = () => (observedUrn ? { observedUrn } : {});
    try {
      await page.goto(postUrl, { waitUntil: 'domcontentloaded' });
      await sleep(rand(2500, 4500));
      if (isNotFoundUrl(page.url())) return { result: 'not_found' };
      {
        const scan = await this.scanCheckpoint(page);
        if (scan.hit) return this.engagementCheckpointOutcome(page, scan);
      }

      const post = await this.resolvePostContainer(page);
      if (await post.count()) {
        observedUrn = (await post.getAttribute('data-urn').catch(() => null)) ?? undefined;
      }

      // 1) STATE FIRST — before hovering, before clicking anything.
      const reacted = post.locator(PSEL.reactTriggerReacted).first();
      if (await reacted.count()) {
        const label = await reacted.getAttribute('aria-label').catch(() => null);
        const existing = existingReactionFrom(label);
        log.info('engage', 'post already carries a reaction — not clicking (a click would REMOVE it)',
          { postUrl, label, existing: existing ?? '(unrecognised label)' });
        return { result: 'already', ...(existing ? { existingReaction: existing } : {}), ...urn() };
      }

      // The ONLY click target: an `aria-pressed="false"` button inside the bar's react
      // wrapper. The identity toggle (which would switch the authoring identity to a company
      // page) carries no aria-pressed and is not inside that wrapper, so it cannot resolve
      // here — and nothing in this method is positional.
      const trigger = post.locator(PSEL.reactTriggerUnreacted).first();
      if (!(await trigger.count())) {
        return { ...(await this.engagementUnavailable(page, post, 'no react trigger on the post')), ...urn() };
      }

      if (reaction === 'like') {
        await trigger.scrollIntoViewIfNeeded().catch(() => {});
        await trigger.click();
      } else {
        const entry = await this.openReactionFlyout(page, post, reaction);
        if (!entry) {
          return {
            ...(await this.engagementUnavailable(page, post, `reaction flyout did not offer ${reaction}`)),
            ...urn(),
          };
        }
        await entry.click();
      }
      await sleep(rand(1500, 3000));

      // 2) LinkedIn's own state is the confirmation — never the click.
      try {
        await post.locator(PSEL.reactTriggerReacted).first()
          .waitFor({ state: 'attached', timeout: REACTED_TIMEOUT_MS });
        log.info('engage', 'reaction placed', { postUrl, reaction, observedUrn: observedUrn ?? null });
        return { result: 'done', ...urn() };
      } catch {
        const scan = await this.scanCheckpoint(page);
        if (scan.hit) return this.engagementCheckpointOutcome(page, scan);
        // Safe to report as retryable: placing the same reaction twice is idempotent, and a
        // second pass reports `already` rather than toggling it off.
        return { ...(await this.engagementErrorOutcome(page, 'reaction did not register')), ...urn() };
      }
    } catch (e) {
      const scan = await this.scanCheckpoint(page);
      if (scan.hit) return this.engagementCheckpointOutcome(page, scan);
      return { ...(await this.engagementErrorOutcome(page, (e as Error).message)), ...urn() };
    }
  }

  /**
   * The post container for the URL we just navigated to — waited for, then scoped.
   *
   * Both engagement steps read `data-urn` off this element and hand it to `reconcileUrn`,
   * which rewrites the row's identity unconditionally. A page-wide `.first()` therefore
   * makes DOM order the post's identity: a layout change that renders a related post above
   * the target would engage the wrong post AND re-key the row onto it, silently. Scoping to
   * the detail shell is what makes the choice structural instead of positional.
   *
   * The wait is on the page-wide locator, exactly as before, so nothing here costs extra
   * time: it only asks "has a post rendered yet". The shell is then preferred if it resolved
   * unambiguously. Two shells means this is not a single-post detail page (a feed, say),
   * where DOM order tells us nothing anyway — so that falls back with the page-wide locator,
   * which is today's behaviour, and logs. An absent container is left absent: the callers'
   * `count()` checks turn it into `unavailable`, which counts toward the failure streak.
   */
  private async resolvePostContainer(page: Page): Promise<Locator> {
    const wide = page.locator(PSEL.postContainer).first();
    await wide.waitFor({ state: 'attached', timeout: POST_LOAD_TIMEOUT_MS }).catch(() => {});

    const shell = page.locator(PSEL.detailShell);
    if (await shell.count() === 1) {
      const scoped = shell.locator(PSEL.postContainer).first();
      if (await scoped.count()) return scoped;
    }

    if (await wide.count()) {
      log.warn('engage', 'post container resolved outside the detail shell — its identity rests on DOM order',
        { url: page.url() });
    }
    return wide;
  }

  /**
   * Hover the react trigger and resolve one reaction's flyout entry, or null.
   *
   * The flyout mounts on hover: `reactions-menu` appears in no pre-hover page dump and is gone
   * again once the pointer leaves, so this waits for the ENTRY to become visible rather than
   * trusting the container's state classes. The entry selector requires the aria-label and
   * LinkedIn's own icon enum to agree, so a resolved entry is provably the requested reaction.
   */
  private async openReactionFlyout(page: Page, post: Locator, reaction: Reaction): Promise<Locator | null> {
    const trigger = post.locator(PSEL.reactTriggerUnreacted).first();
    await trigger.scrollIntoViewIfNeeded().catch(() => {});
    await trigger.hover();
    const sel = reactionEntry(reaction);

    const scoped = post.locator(sel).first();
    const visible = await scoped.waitFor({ state: 'visible', timeout: FLYOUT_TIMEOUT_MS })
      .then(() => true).catch(() => false);
    if (visible) return scoped;

    // Fallback for a flyout portalled out of the post subtree (not observed, but the dumps
    // only prove the entries exist while open, not where they mount). Still safe: the same
    // two-signal selector cannot resolve to a different reaction, and only one flyout can be
    // open because only one trigger was hovered. Required to be unambiguous.
    const wide = page.locator(sel);
    if (await wide.count() === 1
      && await wide.first().isVisible().catch(() => false)) {
      log.warn('engage', 'reaction flyout resolved outside the post container', { reaction });
      return wide.first();
    }
    return null;
  }

  /**
   * Post a comment.
   *
   * Verified live end-to-end with an astral-plane `👀`, which is why the editor is driven with
   * `insertText` rather than per-key typing.
   *
   * NEVER returns a bare `error` once submit has been clicked. An ambiguous comment is
   * `unverified`, which parks the row for a human; an `error` there would invite a retry that
   * publishes the comment a second time under the operator's name.
   */
  async commentOnPost(postUrl: string, text: string): Promise<EngagementOutcome> {
    const page = await this.session.page();
    let observedUrn: string | undefined;
    let submitted = false; // once true, an ambiguous outcome is `unverified`, never `error`
    const urn = () => (observedUrn ? { observedUrn } : {});
    try {
      await page.goto(postUrl, { waitUntil: 'domcontentloaded' });
      await sleep(rand(2500, 4500));
      if (isNotFoundUrl(page.url())) return { result: 'not_found' };
      {
        const scan = await this.scanCheckpoint(page);
        if (scan.hit) return this.engagementCheckpointOutcome(page, scan);
      }

      const post = await this.resolvePostContainer(page);
      if (await post.count()) {
        observedUrn = (await post.getAttribute('data-urn').catch(() => null)) ?? undefined;
      }

      // Comments restricted by the author. PROVISIONAL on both branches — no restricted post
      // was ever probed, so the structural signal is unknown. Both capture evidence so a real
      // one can be read from the incident instead of guessed at.
      if (await page.locator(PSEL.commentsDisabledText).first().count()) {
        const ev = await captureEvidence(page, 'engage-comments-disabled', { signal: 'wording', postUrl });
        log.info('engage', 'comments appear to be disabled (wording signal)', { postUrl });
        return {
          result: 'comments_disabled', ...urn(),
          evidence: { pageUrl: page.url(), screenshot: ev?.screenshot ?? null },
        };
      }

      // On a post detail page (both /feed/update/ and /posts/… shapes) the composer is inline;
      // from the feed the action bar's Comment button has to open it first.
      const editor = post.locator(PSEL.commentEditor).first();
      if (!(await editor.count())) {
        const commentBtn = post.locator(PSEL.commentButton).first();
        if (await commentBtn.count()) {
          await commentBtn.click().catch(() => {});
          await sleep(rand(1500, 3000));
        } else if (await post.locator(PSEL.actionBar).count()
          && await post.locator(PSEL.reactTrigger).count()) {
          // The bar RENDERED and offers no comment control at all. That is a positive
          // structural statement about this post, not selector rot — so it is the one
          // comments_disabled verdict we are willing to reach without a wording signal.
          //
          // TWO signals are required, and both are language-independent, because this
          // verdict is a terminal skip that deliberately never touches the failure streak:
          // if it can be reached by selector rot, rot retires every comment-bearing task as
          // "the author disabled comments" with no evidence and no halt. The action bar
          // rendering says the page loaded; `reactTrigger` RESOLVING says our structural
          // selectors still find controls inside that bar, which is what makes the missing
          // comment control a statement about the post rather than about us. (PSEL.commentButton
          // carries its own language-independence — see its note.) Anything short of both
          // falls through to `unavailable` below, which counts toward the streak and halts.
          const ev = await captureEvidence(page, 'engage-comments-disabled',
            { signal: 'no comment control in a rendered action bar whose react trigger resolves', postUrl });
          log.info('engage', 'no comment affordance on a rendered action bar — treating as disabled',
            { postUrl });
          return {
            result: 'comments_disabled', ...urn(),
            evidence: { pageUrl: page.url(), screenshot: ev?.screenshot ?? null },
          };
        }
      }
      if (!(await editor.count())) {
        // Composer absent with no explanation. Deliberately `unavailable`, not
        // comments_disabled: unavailable counts toward the failure streak, so composer
        // selector rot halts the engine loudly instead of silently retiring every comment.
        return { ...(await this.engagementUnavailable(page, post, 'comment composer never appeared')), ...urn() };
      }

      // Quill: insertText in one shot. Per-key typing mangles astral-plane characters.
      await editor.scrollIntoViewIfNeeded().catch(() => {});
      await editor.click();
      await sleep(rand(600, 1400));
      await page.keyboard.insertText(text);
      await sleep(rand(1200, 2200));

      // The submit button does not exist until the editor has text — its presence IS the
      // armed signal, so this wait doubles as "did the text register".
      const submit = post.locator(PSEL.commentSubmit).first();
      const armed = await submit.waitFor({ state: 'visible', timeout: SUBMIT_ARM_TIMEOUT_MS })
        .then(() => true).catch(() => false);
      if (!armed) {
        const scan = await this.scanCheckpoint(page);
        if (scan.hit) return this.engagementCheckpointOutcome(page, scan);
        // Unambiguous: the only publish path is that button, and it never appeared, so
        // nothing was posted. `error` (not `unverified`) is honest here.
        return {
          ...(await this.engagementErrorOutcome(page, 'comment submit control never appeared after typing')),
          ...urn(),
        };
      }

      // THE OWNERSHIP BASELINE, captured while the click has not happened yet: every comment
      // id the thread is showing right now. A row that is not in this set afterwards is one we
      // did not see before, which is the only thing that can prove a comment is ours — the
      // data-id's own post URN provably cannot (see confirmPostedComment).
      const knownIds = (await this.readThread(page)).rows.map((r) => r.dataId);

      submitted = true; // IRREVERSIBLE from here
      await submit.click();
      await sleep(rand(3000, 5000));

      // Confirmation, from two independent signals (plus a third that is logged):
      //   1. a comment row carrying our text that was NOT in the thread before we submitted;
      //   2. the composer having cleared (verified reliable: the editor read "" immediately);
      //   3. the row's `• You` badge — corroborating only, because it is English text.
      const needle = commentNeedle(text);
      const confirm = async (): Promise<CommentConfirmation> => {
        const t = await this.readThread(page);
        return confirmPostedComment(t.rows, t.editors, needle, knownIds);
      };
      const deadline = Date.now() + COMMENT_CONFIRM_TIMEOUT_MS;
      let seen = await confirm();
      while (!(seen.cleared && seen.matched) && Date.now() < deadline) {
        await sleep(1000);
        seen = await confirm();
      }
      if (seen.cleared && seen.matched) {
        log.info('engage', 'comment posted', {
          postUrl, commentId: seen.commentId, ownBadge: seen.ownBadge, knownBefore: knownIds.length,
        });
        return { result: 'done', ...urn() };
      }

      // A checkpoint detected HERE is deliberately not reported as `checkpoint`: that verdict
      // halts the pass without recording the comment, and the comment may be live. The next
      // task's reaction step scans before it clicks anything, so the guardrail still trips one
      // task later — while this row parks instead of risking a duplicate.
      const scan = await this.scanCheckpoint(page);
      const why = scan.hit
        ? `comment not confirmed and a checkpoint appeared at ${scan.url}`
        : `comment not confirmed (cleared=${seen.cleared}, newRowInThread=${seen.matched})`;
      const ev = await captureEvidence(page, 'engage-comment-unverified', { error: why, postUrl });
      log.warn('engage', 'comment could not be verified — parking it', { postUrl, why });
      return {
        result: 'unverified', error: why, ...urn(),
        evidence: { pageUrl: page.url(), matched: scan.matched, screenshot: ev?.screenshot ?? null },
      };
    } catch (e) {
      const message = (e as Error).message;
      if (submitted) {
        // The click landed; whatever broke afterwards, the comment may be published.
        const ev = await captureEvidence(page, 'engage-comment-unverified', { error: message, postUrl });
        log.warn('engage', 'comment threw after submit — parking it', { postUrl, error: message });
        return {
          result: 'unverified', error: message, ...urn(),
          evidence: { pageUrl: page.url(), screenshot: ev?.screenshot ?? null },
        };
      }
      const scan = await this.scanCheckpoint(page);
      if (scan.hit) return this.engagementCheckpointOutcome(page, scan);
      return { ...(await this.engagementErrorOutcome(page, message)), ...urn() };
    }
  }

  /**
   * One read of the thread + composer. READS ONLY — it reports what the page says and decides
   * nothing; `confirmPostedComment` renders the verdict.
   *
   * That split is not tidiness. The verdict used to be computed in here, inside the page, where
   * no test could reach it — which is how a post-URN attribution marker that matches zero rows
   * on every ugcPost-backed post survived a live run reporting success. Everything judgemental
   * now sits in a pure function with tests over the real captured DOM shapes.
   *
   * Still one evaluate, so the thread and the composer describe the SAME instant — a two-call
   * version could see the composer clear between reads and confirm against a stale thread.
   *
   * Same two constraints as the message-send confirmation: normalize BOTH sides (the rendered
   * thread collapses whitespace), and declare no named inner function — under tsx/esbuild,
   * keep-names rewrites a named inner binding to `__name(fn, "fn")`, which does not exist
   * inside the page.
   */
  private async readThread(page: Page): Promise<{ rows: ThreadRow[]; editors: string[] }> {
    return page.evaluate(({ rowSel, bodySel, metaSel, editorSel }) => ({
      rows: Array.from(document.querySelectorAll(rowSel)).map((el) => ({
        dataId: el.getAttribute('data-id') || '',
        body: (el.querySelector(bodySel)?.textContent || '').replace(/\s+/g, ' ').trim(),
        meta: (el.querySelector(metaSel)?.textContent || '').replace(/\s+/g, ' ').trim(),
      })),
      editors: Array.from(document.querySelectorAll(editorSel))
        .map((e) => (e.textContent || '').replace(/\s+/g, ' ').trim()),
    }), {
      rowSel: PSEL.commentEntity, bodySel: PSEL.commentBody, metaSel: PSEL.commentMeta,
      editorSel: PSEL.commentEditor,
    });
  }

  /** A checkpoint verdict for an engagement step. Same capture as checkpointOutcome; a
   *  separate method because the two result unions do not overlap. */
  private async engagementCheckpointOutcome(page: Page, scan: CheckpointScan): Promise<EngagementOutcome> {
    const ev = await captureEvidence(page, 'checkpoint', { matched: scan.matched, via: scan.via, during: 'engagement' });
    return {
      result: 'checkpoint',
      error: `checkpoint detected at ${scan.url}`,
      evidence: { pageUrl: scan.url, matched: scan.matched, screenshot: ev?.screenshot ?? null },
    };
  }

  /** A failed engagement step, snapshotted. Counts toward the failure streak, so it has to be
   *  diagnosable after the fact. */
  private async engagementErrorOutcome(page: Page, error: string): Promise<EngagementOutcome> {
    const ev = await captureEvidence(page, 'engage-failed', { error });
    return { result: 'error', error, evidence: { pageUrl: page.url(), screenshot: ev?.screenshot ?? null } };
  }

  /**
   * A control we expected was not on the page. `unavailable` counts toward the failure streak
   * on purpose: the reaction flyout is the most fragile element in this feature, and a
   * selector break must halt the engine loudly rather than silently no-op. The extras record
   * whether the surrounding surface rendered, which is what separates "this post is odd" from
   * "our selectors rotted".
   */
  private async engagementUnavailable(page: Page, post: Locator, error: string): Promise<EngagementOutcome> {
    const ev = await captureEvidence(page, 'engage-unavailable', {
      error,
      hasPostContainer: (await post.count()) > 0,
      hasActionBar: (await post.locator(PSEL.actionBar).count()) > 0,
      hasIdentityToggle: (await post.locator(PSEL.identityToggleNeverClick).count()) > 0,
      hasReactTrigger: (await post.locator(PSEL.reactTrigger).count()) > 0,
      hasCommentForm: (await post.locator(PSEL.commentForm).count()) > 0,
    });
    log.warn('engage', 'control unavailable', { url: page.url(), error });
    return { result: 'unavailable', error, evidence: { pageUrl: page.url(), screenshot: ev?.screenshot ?? null } };
  }

  async close(): Promise<void> { await this.session.close(); }
}
