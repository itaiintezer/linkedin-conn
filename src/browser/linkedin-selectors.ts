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

  // Fallback path: the obfuscated Connect control on a profile is an anchor to the
  // custom-invite route. Clicking it opens the composer in-page.
  connectAnchor: 'a[href*="custom-invite"]',
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

  // Fallback path: Connect hidden behind the "More" overflow menu
  moreActions: (s: Scope): Locator => s.getByRole('button', { name: /more actions/i }),
  connectMenuItem: (s: Scope): Locator => s.getByRole('menuitem', { name: /^connect$/i }),
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
