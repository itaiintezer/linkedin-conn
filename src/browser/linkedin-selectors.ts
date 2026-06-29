// ALL LinkedIn DOM selectors live here — LinkedIn changes its markup, so this is the
// single place to update when sends start failing.
//
// Verified against the live "new" LinkedIn React UI (2026-06): the Connect control on a
// profile is an obfuscated <a href="/preload/custom-invite/?vanityName=..."> with hashed
// class names. Rather than click it, we navigate directly to that custom-invite route,
// which opens a stable dialog with aria-labelled buttons.

export const SEL = {
  feedMarker: 'main',

  // Invite composer dialog (shown at the custom-invite route)
  sendWithoutNote: 'button[aria-label="Send without a note"]',
  addNoteButton: 'button[aria-label="Add a note"]',
  noteTextarea: 'textarea[name="message"]',
  sendInvitation: 'button[aria-label="Send invitation"]',
  dismissDialog: 'button[aria-label="Dismiss"]',

  // Pending state (profile page)
  pendingBadge: '[aria-label*="Pending" i]',

  // Weekly invite-limit / quota wording (best-effort; wording varies)
  noteQuotaDialog: 'text=/weekly invitation limit|reached the weekly|out of invitations|limit of invitations/i',

  // Acceptance reader (list pages). NOTE: unverified against the new UI — acceptance
  // tracking may need its own selector pass.
  invitationCardLink: 'a[href*="/in/"]',
  connectionCardLink: 'a[href*="/in/"]',
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
