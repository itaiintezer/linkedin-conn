import { test, expect } from 'vitest';
import { normalizeProfileUrl, extractProfileUrls } from '../../src/core/url.js';

test('normalizes to canonical https://www.linkedin.com/in/<slug>', () => {
  expect(normalizeProfileUrl('http://linkedin.com/in/Jane-Doe-123/?trk=x'))
    .toBe('https://www.linkedin.com/in/jane-doe-123');
  expect(normalizeProfileUrl('https://www.linkedin.com/in/jane-doe-123'))
    .toBe('https://www.linkedin.com/in/jane-doe-123');
});

test('returns null for non-profile urls', () => {
  expect(normalizeProfileUrl('https://www.linkedin.com/company/acme')).toBeNull();
  expect(normalizeProfileUrl('not a url')).toBeNull();
});

test('extracts and dedupes profile urls from free text / csv', () => {
  const text = `name,url
Jane,https://linkedin.com/in/jane/
Bob,"https://www.linkedin.com/in/bob?x=1"
dup,https://linkedin.com/in/jane`;
  expect(extractProfileUrls(text)).toEqual([
    'https://www.linkedin.com/in/jane',
    'https://www.linkedin.com/in/bob',
  ]);
});
