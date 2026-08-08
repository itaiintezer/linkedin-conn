import { test, expect } from 'vitest';
import { isNotFoundUrl, readPendingBadges, SEL, URLS } from '../../src/browser/linkedin-selectors.js';
import { pendingBadgeMatchesTarget } from '../../src/core/relationship.js';
import { FakeProfilePage } from '../helpers/fake-profile-page.js';

// The regression fixture for the 2026-08-07 false skips: the page carries ONE pending
// badge and it belongs to a neighbour card, not the target. The reader must surface it
// with its card attribution (never hide it), and the matcher must then reject it.
test('readPendingBadges attributes a neighbour badge to its card, and the matcher rejects it', async () => {
  const page = new FakeProfilePage({
    url: 'https://www.linkedin.com/in/target-person-123/',
    title: 'Target Person | LinkedIn',
    elements: [
      {
        tag: 'button',
        attrs: { 'aria-label': 'Pending, click to withdraw invitation sent to Neighbour Guy' },
        cardSlug: 'neighbour-guy-9z',
      },
      // An invisible badge (collapsed overflow duplicate) must not be reported.
      {
        tag: 'a',
        attrs: { 'aria-label': 'Pending, click to withdraw invitation sent to Hidden Person' },
        visible: false,
        cardSlug: 'hidden-person',
      },
    ],
  });
  const badges = await readPendingBadges(page as never);
  expect(badges).toEqual([{
    label: 'Pending, click to withdraw invitation sent to Neighbour Guy',
    cardSlug: 'neighbour-guy-9z',
  }]);
  expect(pendingBadgeMatchesTarget(badges[0]!, 'Target Person', 'target-person-123')).toBe(false);
});

test('readPendingBadges reports the target badge with its own card slug', async () => {
  const page = new FakeProfilePage({
    url: 'https://www.linkedin.com/in/helge-poel-32ba4791/',
    title: 'Helge Poel | LinkedIn',
    elements: [{
      tag: 'a',
      attrs: { 'aria-label': 'Pending, click to withdraw invitation sent to Helge Poel' },
      cardSlug: 'helge-poel-32ba4791',
    }],
  });
  const badges = await readPendingBadges(page as never);
  expect(badges).toHaveLength(1);
  expect(pendingBadgeMatchesTarget(badges[0]!, 'Helge Poel', 'helge-poel-32ba4791')).toBe(true);
});

// LinkedIn redirects dead /in/<slug> URLs (deleted account or renamed vanity
// slug) to linkedin.com/404/ — verified live 2026-07-27 against three such
// profiles. The driver keys "profile no longer exists" off that redirect.
test('isNotFoundUrl matches the LinkedIn 404 redirect target', () => {
  expect(isNotFoundUrl('https://www.linkedin.com/404/')).toBe(true);
  expect(isNotFoundUrl('https://www.linkedin.com/404')).toBe(true);
  expect(isNotFoundUrl('https://www.linkedin.com/404/?trk=404_page')).toBe(true);
});

test('isNotFoundUrl does not match live profile or app pages', () => {
  expect(isNotFoundUrl('https://www.linkedin.com/in/some-person')).toBe(false);
  expect(isNotFoundUrl('https://www.linkedin.com/feed/')).toBe(false);
  // a profile slug that merely contains 404
  expect(isNotFoundUrl('https://www.linkedin.com/in/agent-404')).toBe(false);
  expect(isNotFoundUrl('https://www.linkedin.com/preload/custom-invite/?vanityName=x404')).toBe(false);
  expect(isNotFoundUrl('not a url')).toBe(false);
});

// Live-verified 2026-07-28 (scripts/probe-compose.ts, scripts/inspect-message-send.ts).
// Pinned here so a careless "cleanup" of the messaging selectors fails loudly instead of
// silently breaking sends against the classic msg-form surface.
test('messaging selectors and compose-href helper', () => {
  expect(SEL.msgComposeLink).toBe('a[href*="/messaging/compose/"]');
  expect(SEL.msgBox).toBe('div.msg-form__contenteditable[contenteditable="true"]');
  expect(SEL.msgSendButton).toBe('button.msg-form__send-button');
  expect(SEL.msgEvent).toBe('[class*="msg-s-event"]');
  expect(SEL.inboxList).toBe('ul.msg-conversations-container__conversations-list');
  expect(SEL.inboxRow).toBe('li.msg-conversation-listitem');
  expect(SEL.inboxRowName).toBe('[class*="participant-names"]');
  expect(SEL.inboxRowSnippet).toBe('[class*="message-snippet"]');
  expect(URLS.messaging).toBe('https://www.linkedin.com/messaging/');
});
