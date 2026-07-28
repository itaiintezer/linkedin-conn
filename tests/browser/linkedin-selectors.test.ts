import { test, expect } from 'vitest';
import { isNotFoundUrl } from '../../src/browser/linkedin-selectors.js';

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
