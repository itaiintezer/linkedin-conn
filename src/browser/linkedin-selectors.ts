export const SEL = {
  feedMarker: 'div.feed-identity-module, main.scaffold-layout__main',
  loginField: 'input#username',
  connectButton: 'button[aria-label^="Invite"][aria-label*="connect"]',
  moreButton: 'button[aria-label="More actions"]',
  moreConnectItem: 'div[aria-label^="Invite"][role="button"], div.artdeco-dropdown__item:has-text("Connect")',
  addNoteButton: 'button[aria-label="Add a note"]',
  noteTextarea: 'textarea[name="message"]',
  sendButton: 'button[aria-label="Send invitation"], button[aria-label="Send now"]',
  sendWithoutNote: 'button[aria-label="Send without a note"]',
  pendingBadge: 'button[aria-label^="Pending"], span.artdeco-button__text:has-text("Pending")',
  invitationCardLink: 'a[data-test-app-aware-link][href*="/in/"]',
  connectionCardLink: 'a[href*="/in/"]',
  noteQuotaDialog: 'text=/free to send a personalized invitation|out of personalized invitations/i',
};

export const URLS = {
  home: 'https://www.linkedin.com/feed/',
  sentInvitations: 'https://www.linkedin.com/mynetwork/invitation-manager/sent/',
  connections: 'https://www.linkedin.com/mynetwork/invite-connect/connections/',
};
