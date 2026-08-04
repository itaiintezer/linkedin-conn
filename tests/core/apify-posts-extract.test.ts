/**
 * Payload-shape tolerance for the posts actor.
 *
 * Every test here is a shape observed in, or plausible from, the reference implementation at
 * C:\Projects\prospecting\apify_linkedin.py — whose _parse_post_date exists precisely because
 * postedAt arrives as a dict, a bare string, or a unix number depending on the payload.
 */
import { test, expect } from 'vitest';
import { extractPost, parsePostedAt, attribute } from '../../src/core/apify-posts-extract.js';
import type { ApifyPost } from '../../src/types.js';

const URN = 'urn:li:activity:7489401096851906561';
const base: ApifyPost = {
  id: URN,
  linkedinUrl: `https://www.linkedin.com/feed/update/${URN}/`,
  content: 'Alert triage is an ownership problem.',
  postedAt: { date: '2026-08-03 14:23:00', timestamp: 1785766980000, relative: '1d' },
  author: { name: 'Dana Reingold', linkedinUrl: 'https://www.linkedin.com/in/dana', position: 'VP Security' },
  engagement: { likes: 42, comments: 7 },
  query: { targetUrl: 'https://www.linkedin.com/in/dana' },
};

test('parsePostedAt accepts a dict, an ISO string, a unix-ms number, and rejects junk', () => {
  // The timestamp is preferred when present: numeric and unambiguous.
  expect(parsePostedAt({ date: '2026-08-03 14:23:00', timestamp: 1785766980000 }))
    .toBe('2026-08-03T14:23:00.000Z');
  expect(parsePostedAt('2026-08-03T14:23:00Z')).toBe('2026-08-03T14:23:00.000Z');
  expect(parsePostedAt('2026-08-03 14:23:00')).toBe('2026-08-03T14:23:00.000Z');
  expect(parsePostedAt('2026-08-03')).toBe('2026-08-03T00:00:00.000Z');
  expect(parsePostedAt(1785766980000)).toBe('2026-08-03T14:23:00.000Z');
  // Seconds rather than ms, scaled up the way the reference implementation does.
  expect(parsePostedAt(1785766980)).toBe('2026-08-03T14:23:00.000Z');
  expect(parsePostedAt('2 days ago')).toBeNull();
  expect(parsePostedAt(null)).toBeNull();
  expect(parsePostedAt({ relative: '1d' })).toBeNull();
});

test('every parsed date is the fixed-width shape the posted_at CHECK demands', () => {
  const iso = parsePostedAt('2026-08-03T14:23:00Z')!;
  expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('extractPost maps a full item', () => {
  const out = extractPost(base, 5)!;
  expect(out.post_urn).toBe(URN);
  expect(out.post_url).toBe(`https://www.linkedin.com/feed/update/${URN}/`);
  expect(out.tracked_profile_id).toBe(5);
  expect(out.author_name).toBe('Dana Reingold');
  expect(out.author_headline).toBe('VP Security');
  expect(out.content).toBe('Alert triage is an ownership problem.');
  expect(out.posted_at).toBe('2026-08-03T14:23:00.000Z');
  expect(out.is_repost).toBe(0);
  expect(out.reaction_count).toBe(42);
  expect(out.comment_count).toBe(7);
});

test('the URN comes from linkedinUrl, falling back to a bare or numeric id', () => {
  expect(extractPost({ ...base, id: undefined }, 1)!.post_urn).toBe(URN);
  // No URL at all: a bare URN in `id` still identifies the post.
  expect(extractPost({ ...base, linkedinUrl: undefined }, 1)!.post_urn).toBe(URN);
  // A digits-only id is promoted to an activity URN rather than discarded.
  expect(extractPost({ ...base, linkedinUrl: undefined, id: '7489401096851906561' }, 1)!.post_urn)
    .toBe(URN);
});

test('an item with no resolvable identity is dropped, not guessed at', () => {
  expect(extractPost({ ...base, id: undefined, linkedinUrl: undefined }, 1)).toBeNull();
  expect(extractPost({ ...base, id: 'not-a-urn', linkedinUrl: 'https://example.com/x' }, 1)).toBeNull();
});

test('an item with no text is dropped — there is nothing to judge or engage with', () => {
  expect(extractPost({ ...base, content: '   ' }, 1)).toBeNull();
  expect(extractPost({ ...base, content: undefined }, 1)).toBeNull();
});

test('missing author and engagement degrade to null rather than throwing', () => {
  const out = extractPost({ ...base, author: null, engagement: null }, 1)!;
  expect(out.author_name).toBeNull();
  expect(out.author_headline).toBeNull();
  expect(out.reaction_count).toBeNull();
  expect(out.comment_count).toBeNull();
});

test('is_repost is set from type or a nested reshared post, and defaults to 0 when unclear', () => {
  expect(extractPost({ ...base, type: 'repost' }, 1)!.is_repost).toBe(1);
  expect(extractPost({ ...base, resharedPost: { id: 'x' } }, 1)!.is_repost).toBe(1);
  // Under-label rather than mislabel: an unrecognized shape is not called a repost.
  expect(extractPost({ ...base, type: 'something-new' }, 1)!.is_repost).toBe(0);
});

test('reactions falls back to `reactions` when `likes` is absent', () => {
  expect(extractPost({ ...base, engagement: { reactions: 9 } }, 1)!.reaction_count).toBe(9);
});

test('attribute splits a batched run by query.targetUrl, then author.linkedinUrl', () => {
  const byUrl = new Map([
    ['https://www.linkedin.com/in/dana', 11],
    ['https://www.linkedin.com/in/marcus', 22],
  ]);
  const items: ApifyPost[] = [
    base,
    { ...base, id: 'urn:li:activity:2', linkedinUrl: undefined,
      query: null, author: { name: 'M', linkedinUrl: 'https://www.linkedin.com/in/marcus' } },
    // Matches neither: dropped rather than assigned to whichever profile came first.
    { ...base, id: 'urn:li:activity:3', query: { targetUrl: 'https://www.linkedin.com/in/nobody' },
      author: { name: 'X', linkedinUrl: 'https://www.linkedin.com/in/nobody' } },
  ];
  const { rows, unattributed } = attribute(items, byUrl);
  expect(rows.map((r) => r.tracked_profile_id)).toEqual([11, 22]);
  expect(unattributed).toBe(1);
});

test('attribute matches a targetUrl that differs only by trailing slash or case', () => {
  const byUrl = new Map([['https://www.linkedin.com/in/dana', 11]]);
  const { rows } = attribute(
    [{ ...base, query: { targetUrl: 'https://WWW.LinkedIn.com/in/Dana/' } }], byUrl,
  );
  expect(rows.map((r) => r.tracked_profile_id)).toEqual([11]);
});
