import { test, expect } from 'vitest';
import { isNotFoundUrl, SEL, URLS } from '../../src/browser/linkedin-selectors.js';

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
