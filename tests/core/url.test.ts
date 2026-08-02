import { test, expect } from 'vitest';
import { normalizeProfileUrl, extractProfileUrls, normalizePostUrl } from '../../src/core/url.js';

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

test('feed/update form: URN is taken straight from the path', () => {
  expect(normalizePostUrl('https://www.linkedin.com/feed/update/urn:li:activity:7123456789012345678/'))
    .toEqual({
      url: 'https://www.linkedin.com/feed/update/urn:li:activity:7123456789012345678/',
      urn: 'urn:li:activity:7123456789012345678',
    });
});

test('posts/<slug>-activity-<id> form: the id is rebuilt into an activity URN', () => {
  expect(normalizePostUrl('https://www.linkedin.com/posts/jane-doe_hiring-news-activity-7123456789012345678-AbCd'))
    .toEqual({
      url: 'https://www.linkedin.com/feed/update/urn:li:activity:7123456789012345678/',
      urn: 'urn:li:activity:7123456789012345678',
    });
});

test('updateId query parameter is URL-decoded', () => {
  expect(normalizePostUrl('https://www.linkedin.com/feed/?updateId=urn%3Ali%3Aactivity%3A7123456789012345678'))
    .toEqual({
      url: 'https://www.linkedin.com/feed/update/urn:li:activity:7123456789012345678/',
      urn: 'urn:li:activity:7123456789012345678',
    });
});

test('a bare URN is accepted as-is', () => {
  expect(normalizePostUrl('urn:li:activity:7123456789012345678')?.urn)
    .toBe('urn:li:activity:7123456789012345678');
});

test('the URN type is preserved, not assumed to be activity', () => {
  expect(normalizePostUrl('https://www.linkedin.com/feed/update/urn:li:ugcPost:7123456789012345678/')?.urn)
    .toBe('urn:li:ugcPost:7123456789012345678');
  expect(normalizePostUrl('https://www.linkedin.com/feed/update/urn:li:share:7123456789012345678/')?.urn)
    .toBe('urn:li:share:7123456789012345678');
});

test('ugcPost casing is canonicalized regardless of how it was written', () => {
  expect(normalizePostUrl('https://www.linkedin.com/feed/update/urn:li:ugcpost:712345678901234567/')?.urn)
    .toBe('urn:li:ugcPost:712345678901234567');
});

test('shortlinks are rejected — resolving one needs a network round-trip', () => {
  expect(normalizePostUrl('https://lnkd.in/abc123')).toBeNull();
});

test('a profile URL is not a post URL', () => {
  expect(normalizePostUrl('https://www.linkedin.com/in/jane-doe')).toBeNull();
});

test('garbage and empty input are rejected', () => {
  expect(normalizePostUrl('')).toBeNull();
  expect(normalizePostUrl('not a url')).toBeNull();
  expect(normalizePostUrl('https://example.com/feed/update/urn:li:activity:1/')).toBeNull();
});

test('a malformed percent-escape does not throw', () => {
  expect(() => normalizePostUrl('https://www.linkedin.com/feed/?updateId=%E0%A4%A')).not.toThrow();
});
