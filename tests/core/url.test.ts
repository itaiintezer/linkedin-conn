import { test, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  normalizeProfileUrl,
  extractProfileUrls,
  normalizePostUrl,
  isShortlink,
  resolveShortlink,
} from '../../src/core/url.js';

// No test in this file may make a real network request. Rather than trusting every test to
// remember to inject a fake, the global fetch is replaced with one that throws: a code path
// that reaches for it instead of the injected one cannot quietly reach the internet.
beforeAll(() => {
  vi.stubGlobal('fetch', () => { throw new Error('a test attempted a real network request'); });
});
afterAll(() => { vi.unstubAllGlobals(); });

/** A scripted stand-in for fetch. Records what was requested; refuses anything unscripted. */
function fakeFetch(script: Record<string, { status: number; location?: string }>) {
  const calls: string[] = [];
  const impl = (async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    const hit = script[url];
    if (!hit) throw new Error(`unscripted request: ${url}`);
    const headers = new Headers();
    if (hit.location !== undefined) headers.set('location', hit.location);
    return { status: hit.status, headers, body: null } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

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

test('the /posts/ path wins over a stray URN elsewhere in the URL', () => {
  expect(normalizePostUrl(
    'https://www.linkedin.com/posts/jane_x-activity-7111111111111111111-AbCd#urn:li:activity:7222222222222222222',
  )?.urn).toBe('urn:li:activity:7111111111111111111');
  expect(normalizePostUrl(
    'https://www.linkedin.com/posts/jane_x-activity-7111111111111111111-AbCd?ref=urn%3Ali%3Aactivity%3A7222222222222222222',
  )?.urn).toBe('urn:li:activity:7111111111111111111');
});

// A real share link, copied from LinkedIn. Note "-share-", not "-activity-": this is the
// ordinary form, and rejecting it would reject most of what anyone pastes.
const REAL_SHARE_URL =
  'https://www.linkedin.com/posts/lolly-andreoli-075684b2_youre-invited-to-preview-what-sai-can-do-share-7489401095899770880-VbZT/';

test('posts/<slug>-share-<id> form: a real share link resolves to a share URN', () => {
  expect(normalizePostUrl(REAL_SHARE_URL)).toEqual({
    url: 'https://www.linkedin.com/feed/update/urn:li:share:7489401095899770880/',
    urn: 'urn:li:share:7489401095899770880',
  });
});

test('the slug type drives the URN type, so -ugcPost- works too', () => {
  expect(normalizePostUrl('https://www.linkedin.com/posts/jane_x-ugcPost-7111111111111111111-AbCd')?.urn)
    .toBe('urn:li:ugcPost:7111111111111111111');
});

test('the last type infix in a slug wins — headline words can look like one', () => {
  // "share-2024" is part of the headline; the real id is the trailing component. Leftmost
  // matching would answer urn:li:share:2024.
  expect(normalizePostUrl('https://www.linkedin.com/posts/jane_share-2024-recap-activity-7123456789012345678-AbCd')?.urn)
    .toBe('urn:li:activity:7123456789012345678');
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

test('normalizePostUrl stays pure: a shortlink is null, not a network call', () => {
  expect(normalizePostUrl('https://lnkd.in/abc123')).toBeNull();
  expect(normalizePostUrl('https://lnkd.in/p/dkTR-yYF')).toBeNull();
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

test('isShortlink recognises lnkd.in however it was written', () => {
  expect(isShortlink('https://lnkd.in/p/dkTR-yYF')).toBe(true);
  expect(isShortlink('https://lnkd.in/abc123')).toBe(true);
  expect(isShortlink('https://www.lnkd.in/abc123')).toBe(true);
  // What a mobile share sheet actually produces: no scheme at all.
  expect(isShortlink('lnkd.in/p/dkTR-yYF')).toBe(true);
});

test('isShortlink is false for LinkedIn URLs and for non-strings', () => {
  expect(isShortlink(REAL_SHARE_URL)).toBe(false);
  expect(isShortlink('https://www.linkedin.com/feed/update/urn:li:activity:7123456789012345678/')).toBe(false);
  expect(isShortlink('https://example.com/lnkd.in/abc123')).toBe(false);
  expect(isShortlink(undefined)).toBe(false);
  expect(isShortlink(123)).toBe(false);
});

test('resolveShortlink follows the 301 and hands back a URL normalizePostUrl can read', async () => {
  const { impl, calls } = fakeFetch({
    'https://lnkd.in/p/dkTR-yYF': { status: 301, location: REAL_SHARE_URL },
  });
  const resolved = await resolveShortlink('https://lnkd.in/p/dkTR-yYF', { fetchImpl: impl });
  expect(resolved).toBe(REAL_SHARE_URL);
  expect(calls).toEqual(['https://lnkd.in/p/dkTR-yYF']);
  expect(normalizePostUrl(resolved)?.urn).toBe('urn:li:share:7489401095899770880');
});

test('resolveShortlink gives up once the redirect chain exceeds the bound', async () => {
  const calls: string[] = [];
  // Relative Locations, which a shortener is free to answer with, and which keep the chain
  // on lnkd.in forever.
  const impl = (async (input: unknown) => {
    calls.push(String(input));
    return {
      status: 301,
      headers: new Headers({ location: `/hop${calls.length}` }),
      body: null,
    } as unknown as Response;
  }) as unknown as typeof fetch;

  expect(await resolveShortlink('https://lnkd.in/start', { fetchImpl: impl })).toBeNull();
  expect(calls).toEqual(['https://lnkd.in/start', 'https://lnkd.in/hop1', 'https://lnkd.in/hop2']);
});

test('resolveShortlink refuses to land anywhere but LinkedIn', async () => {
  const { impl, calls } = fakeFetch({
    'https://lnkd.in/evil': { status: 301, location: 'https://example.com/phish' },
  });
  expect(await resolveShortlink('https://lnkd.in/evil', { fetchImpl: impl })).toBeNull();
  // Stopped at the first hop rather than chasing it.
  expect(calls).toEqual(['https://lnkd.in/evil']);
});

test('resolveShortlink returns null when there is nothing to follow', async () => {
  const { impl } = fakeFetch({ 'https://lnkd.in/dead': { status: 200 } });
  expect(await resolveShortlink('https://lnkd.in/dead', { fetchImpl: impl })).toBeNull();
});

test('a network failure is a null, not a throw', async () => {
  const impl = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
  await expect(resolveShortlink('https://lnkd.in/p/dkTR-yYF', { fetchImpl: impl })).resolves.toBeNull();
});

test('resolveShortlink does not call out for something that is not a shortlink', async () => {
  const { impl, calls } = fakeFetch({});
  expect(await resolveShortlink(REAL_SHARE_URL, { fetchImpl: impl })).toBeNull();
  expect(await resolveShortlink('not a url', { fetchImpl: impl })).toBeNull();
  expect(calls).toEqual([]);
});
