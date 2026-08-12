// ALL LinkedIn DOM selectors live here — LinkedIn changes its markup, so this is the
// single place to update when sends start failing.
//
// Verified against the live "new" LinkedIn React UI (2026-06): the Connect control on a
// profile is an obfuscated <a href="/preload/custom-invite/?vanityName=..."> with hashed
// class names. Rather than click it, we navigate directly to that custom-invite route,
// which opens a stable dialog with aria-labelled buttons.

import type { Page, Locator } from 'playwright-core';
import type { PendingBadge } from '../core/relationship.js';

type Scope = Page | Locator;

// Non-role selectors (used via page.locator(...)). Stable enough; left as CSS.
export const SEL = {
  feedMarker: 'main',

  // Note composer textarea (unchanged — kept specific on purpose).
  noteTextarea: 'textarea[name="message"]',

  // Weekly invite-limit / quota wording (best-effort; wording varies).
  noteQuotaDialog: 'text=/weekly invitation limit|reached the weekly|out of invitations|limit of invitations/i',

  // Acceptance reader. `invitationCardLink` is DEPRECATED: the sent-invitations list is
  // huge and only its newest page loads, so scraping it to infer expiry produced false
  // expiries — acceptance no longer reads it (see core/acceptance.ts). Kept only for the
  // manual scripts/verify-readers diagnostic.
  invitationCardLink: 'a[href*="/in/"]',
  // Connections list. Scoped to <main> so it excludes the global-nav "Me" (your own
  // profile) and any sidebar links — only real connection-card profile links match.
  // Verified live (2026-07): connection cards expose /in/ anchors inside <main>, default
  // sort is "Recently added", so the top slice is where fresh acceptances appear.
  connectionCardLink: 'main a[href*="/in/"]',

  // Messaging (live-verified 2026-07-28). The profile's Message control is an anchor to
  // /messaging/compose/?profileUrn=… — navigate to its href instead of clicking hashed-
  // class UI. That route renders the CLASSIC messaging surface with stable classes.
  msgComposeLink: 'a[href*="/messaging/compose/"]',
  // The profile's "More" overflow surface, once expanded. Hashed class names churn, so the
  // role is the anchor; the artdeco class is kept as a fallback for the older surface.
  // Live-verified 2026-08-03: exactly one matches on an expanded profile top card.
  overflowMenu: '[role="menu"], [class*="artdeco-dropdown__content"]',
  msgBox: 'div.msg-form__contenteditable[contenteditable="true"]',
  // Disabled until text is typed; re-disabled after a successful send.
  msgSendButton: 'button.msg-form__send-button',
  // Thread history items — a sent message appears as the last of these.
  msgEvent: '[class*="msg-s-event"]',
  // Inbox conversation list. Snippets are prefixed "You:" when we sent last.
  inboxList: 'ul.msg-conversations-container__conversations-list',
  inboxRow: 'li.msg-conversation-listitem',
  inboxRowName: '[class*="participant-names"]',
  inboxRowSnippet: '[class*="message-snippet"]',
};

// Role-based locator builders. getByRole matches the *accessible name*, so these
// survive LinkedIn moving the label between aria-label and inner text. Forcing
// en-US at launch (see cloak-session.ts) keeps these English names valid.
export const find = {
  // Invite composer dialog (shown at the custom-invite route or after a UI click)
  sendWithoutNote: (s: Scope): Locator => s.getByRole('button', { name: 'Send without a note' }),
  addNote: (s: Scope): Locator => s.getByRole('button', { name: 'Add a note' }),
  sendInvitation: (s: Scope): Locator => s.getByRole('button', { name: 'Send invitation' }),
  dismissDialog: (s: Scope): Locator => s.getByRole('button', { name: 'Dismiss' }),

  // NOTE: there is deliberately no bare `pendingBadge(s)` locator here any more. Reading
  // "any visible [aria-label*=Pending]" page-wide is exactly how the 2026-08-07 false
  // "already connected" skips happened — the operator's own outstanding invites render
  // Pending badges on the recommendation cards of nearly every profile page (inside
  // <main>, so scoping there does not help). Read badges with `readPendingBadges` below
  // and attribute them to the target with core/relationship.ts' pendingBadgeMatchesTarget.

  // The one POSITIVE "this is an existing connection" signal. Only present in the expanded
  // "More" overflow, so callers must scope to SEL.overflowMenu after expanding — read
  // page-wide it would eventually catch a recommendation card. Live-verified: one node
  // carries aria-label="Remove connection", another is role="menuitem" with the text.
  removeConnection: (s: Scope): Locator =>
    s.locator('[aria-label*="Remove connection" i], [role="menuitem"]:has-text("Remove connection")'),

  // Email-verification gate: some members only accept invites from people who know
  // their email. LinkedIn shows "To verify this member knows you, please enter their
  // email to connect." with an email input in the invite dialog. Either signal
  // suffices; en-US is forced at launch so the English wording is stable.
  emailVerifyText: (s: Scope): Locator => s.getByText(/enter their email to connect/i),
  emailVerifyInput: (s: Scope): Locator => s.locator('div[role="dialog"] input[type="email"]'),

  // Fallback path (used only when the direct custom-invite route shows no composer).
  // The Connect control has three shapes, so we match it three ways:
  //  - top card: a button/anchor with aria-label "Invite <Name> to connect" — match by
  //    NAME, scoped to <main> so it can't grab a "people also viewed" person.
  //  - under "More" (older surface): an <a href=...custom-invite...vanityName=<slug>>
  //    with NO aria-label — match by the target's own slug in the href.
  //  - under "More" (React UI, observed 2026-08-11): a role="menuitem" custom-invite
  //    anchor whose inner div DOES carry the "Invite <Name> to connect" aria-label, in a
  //    popover portal OUTSIDE <main> — match by NAME scoped to SEL.overflowMenu. Beware
  //    the href here carries the profile's CURRENT vanity slug, which differs from the
  //    queued one after a rename (the /in/<old-slug> URL redirects).
  connectByName: (s: Scope, name: string): Locator =>
    s.locator(`[aria-label*="${name.replace(/["\\]/g, '')}"][aria-label*="to connect"]`),
  connectByHref: (s: Scope, slug: string): Locator =>
    s.locator(`a[href*="custom-invite"][href*="vanityName=${slug}"]`),
  // Profile overflow button. Scoped to <main> by the caller (an unscoped getByRole
  // matches LinkedIn's global-nav "More" and misclicks), AND required to be a real
  // dropdown trigger via aria-expanded — distinguishes it from any stray "More" text
  // toggle. Live-verified to resolve to exactly one button on the profile top card.
  moreButton: (s: Scope): Locator => s.getByRole('button', { name: /^more$/i, expanded: false }),
};

/** The raw badge selector. Keyed on the rich aria-label ("Pending, click to withdraw
 *  invitation sent to <name>") rather than getByRole: the badge is NOT exposed as a
 *  button role. en-US is forced at launch, so the English wording is safe. Exported for
 *  the preflight diagnostic only — production reads go through readPendingBadges. */
export const PENDING_BADGE_SELECTOR = '[aria-label*="Pending" i]';

/**
 * Every VISIBLE Pending badge on the page, each with the fact that decides who it belongs
 * to: the /in/<slug> of the nearest ancestor that links to a profile (a recommendation
 * card always links its own person; the target's top card links the target — live-verified
 * 2026-08-08, docs/superpowers/specs/2026-08-08-relationship-probe-findings.md). The
 * DECISION of whether a badge matches the target lives in core/relationship.ts.
 */
export async function readPendingBadges(s: Scope): Promise<PendingBadge[]> {
  const out: PendingBadge[] = [];
  for (const badge of await s.locator(PENDING_BADGE_SELECTOR).all()) {
    if (!(await badge.isVisible().catch(() => false))) continue;
    const label = (await badge.getAttribute('aria-label').catch(() => null)) ?? '';
    // Inline arrow on purpose: tsx' esbuild keepNames wraps named function expressions in
    // a __name() helper that does not exist inside the page (see scripts/probe-pending.ts).
    const cardSlug = await badge.evaluate((el: Element): string | null => {
      let cur: Element | null = el;
      while (cur && cur.tagName !== 'MAIN' && cur !== el.ownerDocument.body) {
        const a = cur.querySelector('a[href*="/in/"]');
        const href = a ? a.getAttribute('href') : null;
        const m = href ? href.match(/\/in\/([^/?#]+)/) : null;
        if (m) { try { return decodeURIComponent(m[1]!); } catch { return m[1]!; } }
        cur = cur.parentElement;
      }
      return null;
    }).catch(() => null);
    out.push({ label, cardSlug });
  }
  return out;
}

export const URLS = {
  home: 'https://www.linkedin.com/feed/',
  login: 'https://www.linkedin.com/login',
  sentInvitations: 'https://www.linkedin.com/mynetwork/invitation-manager/sent/',
  connections: 'https://www.linkedin.com/mynetwork/invite-connect/connections/',
  messaging: 'https://www.linkedin.com/messaging/',
};

/** The direct invite-composer route for a profile slug (e.g. "liron-lalezary"). */
export function customInviteUrl(slug: string): string {
  return `https://www.linkedin.com/preload/custom-invite/?vanityName=${slug}`;
}

/** Extract the vanity slug from a normalized profile URL. */
export function profileSlug(profileUrl: string): string | null {
  return profileUrl.match(/\/in\/([^/?#]+)/)?.[1] ?? null;
}

/**
 * LinkedIn redirects dead /in/<slug> URLs (deleted account or renamed vanity slug)
 * to linkedin.com/404/ — verified live 2026-07-27. Matched on the pathname so a
 * slug that merely contains "404" can't false-positive.
 */
export function isNotFoundUrl(url: string): boolean {
  try {
    return /^\/404\/?$/.test(new URL(url).pathname);
  } catch {
    return false;
  }
}
