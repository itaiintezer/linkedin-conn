// ALL LinkedIn DOM selectors live here — LinkedIn changes its markup, so this is the
// single place to update when sends start failing.
//
// Verified against the live "new" LinkedIn React UI (2026-06): the Connect control on a
// profile is an obfuscated <a href="/preload/custom-invite/?vanityName=..."> with hashed
// class names. Rather than click it, we navigate directly to that custom-invite route,
// which opens a stable dialog with aria-labelled buttons.

import type { Page, Locator } from 'playwright-core';

type Scope = Page | Locator;

// Non-role selectors (used via page.locator(...)). Stable enough; left as CSS.
export const SEL = {
  feedMarker: 'main',

  // Note composer textarea (unchanged — kept specific on purpose).
  noteTextarea: 'textarea[name="message"]',

  // Weekly invite-limit / quota wording (best-effort; wording varies).
  noteQuotaDialog: 'text=/weekly invitation limit|reached the weekly|out of invitations|limit of invitations/i',

  // Acceptance reader (list pages). NOTE: unverified against the new UI — acceptance
  // tracking may need its own selector pass.
  invitationCardLink: 'a[href*="/in/"]',
  connectionCardLink: 'a[href*="/in/"]',
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

  // Pending state on the profile page (post-send confirmation / pre-send guard).
  // Keyed on the rich aria-label ("Pending, click to withdraw invitation sent to
  // <name>") rather than getByRole: this badge is NOT exposed as a button role, so
  // getByRole('button') misses it. en-US is forced at launch, so matching the
  // English "Pending" wording is safe.
  pendingBadge: (s: Scope): Locator => s.locator('[aria-label*="Pending" i]'),

  // Fallback path (used only when the direct custom-invite route shows no composer).
  // The Connect control has two shapes, so we match it two ways:
  //  - top card: a button/anchor with aria-label "Invite <Name> to connect" — match by
  //    NAME, scoped to <main> so it can't grab a "people also viewed" person.
  //  - under "More": an <a href=...custom-invite...vanityName=<slug>> with NO aria-label
  //    — match by the target's own slug in the href.
  connectByName: (s: Scope, name: string): Locator =>
    s.locator(`[aria-label*="${name.replace(/["\\]/g, '')}"][aria-label*="to connect"]`),
  connectByHref: (s: Scope, slug: string): Locator =>
    s.locator(`a[href*="custom-invite"][href*="vanityName=${slug}"]`),
  // Profile overflow button. MUST be scoped to <main> by the caller — an unscoped
  // getByRole matches LinkedIn's global-nav "More" and misclicks.
  moreButton: (s: Scope): Locator => s.getByRole('button', { name: /^more$/i }),
};

export const URLS = {
  home: 'https://www.linkedin.com/feed/',
  login: 'https://www.linkedin.com/login',
  sentInvitations: 'https://www.linkedin.com/mynetwork/invitation-manager/sent/',
  connections: 'https://www.linkedin.com/mynetwork/invite-connect/connections/',
};

/** The direct invite-composer route for a profile slug (e.g. "liron-lalezary"). */
export function customInviteUrl(slug: string): string {
  return `https://www.linkedin.com/preload/custom-invite/?vanityName=${slug}`;
}

/** Extract the vanity slug from a normalized profile URL. */
export function profileSlug(profileUrl: string): string | null {
  return profileUrl.match(/\/in\/([^/?#]+)/)?.[1] ?? null;
}
