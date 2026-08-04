/**
 * Payload-shape tolerance for the posts actor.
 *
 * `fixtures/apify-posts-sample.json` is SYNTHETIC — it mirrors the field names and nesting
 * observed in a 26,256-item corpus of real actor output at
 * `C:\Projects\prospecting\icp_cache_posts` (2026-08-04), but every name, url and id in it is
 * made up, so nothing here depends on a path that only exists on one machine or distributes
 * a real person's data. It covers: a normal post with `author.info`; a bare reshare via
 * `repostedBy` (no added commentary, content already at the top level); a reshare WITH added
 * commentary via `repost` (both with and without the resharer's own words); and
 * array-valued `engagement.reactions` throughout, since that is the real shape and never a
 * bare number.
 *
 * The `postedAt` shape used below (`{timestamp, date, postedAgoShort, postedAgoText}`, with
 * `date` already a full `Z`-suffixed ISO string) is what the corpus actually sends. The
 * space-separated and bare-date forms `parsePostedAt` also accepts are defensive-only —
 * never observed in a real payload — ported from `apify_linkedin.py::_parse_post_date`
 * because that reference handles them.
 */
import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractPost, parsePostedAt, attribute } from '../../src/core/apify-posts-extract.js';
import type { ApifyPost } from '../../src/types.js';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';

type Fixture = ApifyPost & { _label: string };
const fx = JSON.parse(
  readFileSync(join(process.cwd(), 'tests/core/fixtures/apify-posts-sample.json'), 'utf8'),
) as Fixture[];
const byLabel = (label: string): ApifyPost => {
  const found = fx.find((f) => f._label === label);
  if (!found) throw new Error(`no fixture labelled ${label}`);
  return found;
};

const URN = 'urn:li:activity:7489401096851906561';
const base: ApifyPost = {
  id: URN,
  linkedinUrl: `https://www.linkedin.com/feed/update/${URN}/`,
  content: 'Alert triage is an ownership problem.',
  // {timestamp, date, postedAgoShort, postedAgoText} is the real shape (see corpus note
  // above); `relative` here is a defensive extra, not something the actor actually sends.
  postedAt: { date: '2026-08-03T14:23:00.000Z', timestamp: 1785766980000, relative: '1d' },
  // `info` is the real headline field — see fixture note and the ApifyPost JSDoc in
  // types.ts. `position` never occurs in the corpus; kept only as a forward-compat probe.
  author: { name: 'Dana Reingold', linkedinUrl: 'https://www.linkedin.com/in/dana', info: 'VP Security' },
  engagement: { likes: 42, comments: 7, reactions: [{ type: 'LIKE', count: 42 }] },
  query: { targetUrl: 'https://www.linkedin.com/in/dana' },
};

test('parsePostedAt accepts a dict, an ISO string, a unix-ms number, and rejects junk', () => {
  // The timestamp is preferred when present: numeric and unambiguous.
  expect(parsePostedAt({ date: '2026-08-03T14:23:00.000Z', timestamp: 1785766980000 }))
    .toBe('2026-08-03T14:23:00.000Z');
  expect(parsePostedAt('2026-08-03T14:23:00Z')).toBe('2026-08-03T14:23:00.000Z');
  // Defensive-only shape (see header note): never sent by the real actor.
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

test('a zone-less T-separated timestamp is read as UTC, not local time', () => {
  // This is the regression test for a real bug: the old regex for the space-separated
  // "assume UTC" branch was `[ ]` only, so a `T`-separated zone-less string ('...T...', no
  // Z, no offset) fell through to `new Date(s)`, which reads an offset-less date-TIME as
  // LOCAL per the ECMA-262 Date Time String Format. `vitest.config.ts` pins TZ=UTC for the
  // whole suite, which makes local time equal UTC and hides the bug completely — the old,
  // broken code returns the exact same (correct-looking) answer under that pin. So this
  // test overrides process.env.TZ to a real non-UTC zone for one assertion, which is what
  // actually exercises the bug: run this against the pre-fix parser and it returns
  // '2026-08-03T11:23:00.000Z' (shifted -3h) instead of the value asserted below.
  const prevTz = process.env.TZ;
  process.env.TZ = 'Asia/Jerusalem';
  try {
    expect(parsePostedAt('2026-08-03T14:23:00')).toBe('2026-08-03T14:23:00.000Z');
    // The space-separated defensive form must behave identically.
    expect(parsePostedAt('2026-08-03 14:23:00')).toBe('2026-08-03T14:23:00.000Z');
  } finally {
    process.env.TZ = prevTz;
  }
});

test('a real UTC offset is honoured, not overridden', () => {
  // 14:23 at +03:00 is 11:23 UTC. This form carries its own zone, so it must NOT go through
  // the zone-less "assume UTC" branch — it is handled by the ordinary `new Date(s)` parse.
  expect(parsePostedAt('2026-08-03T14:23:00+03:00')).toBe('2026-08-03T11:23:00.000Z');
});

test('an impossible calendar day is rejected, not silently rolled into the next month', () => {
  // `Date` silently rolls Feb 30 -> Mar 2 rather than rejecting it, which would otherwise
  // still pass the posted_at CHECK and land two days off with nothing to say why.
  expect(parsePostedAt('2026-02-30')).toBeNull();
  expect(parsePostedAt('2026-02-30 14:23:00')).toBeNull();
  // A real calendar day one day earlier must still parse normally (the guard isn't blanket).
  expect(parsePostedAt('2026-02-28')).toBe('2026-02-28T00:00:00.000Z');
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

test('author_headline reads `info` — the real field — before the forward-compat fallbacks', () => {
  expect(extractPost({ ...base, author: { name: 'D', linkedinUrl: 'x', info: 'Real Headline' } }, 1)!
    .author_headline).toBe('Real Headline');
  // `info` absent (never happens in the corpus, but must still degrade cleanly): falls back
  // to `position`, then `headline` — neither of which the real actor ever sends.
  expect(extractPost({ ...base, author: { name: 'D', linkedinUrl: 'x', position: 'Fallback A' } }, 1)!
    .author_headline).toBe('Fallback A');
  expect(extractPost({ ...base, author: { name: 'D', linkedinUrl: 'x', headline: 'Fallback B' } }, 1)!
    .author_headline).toBe('Fallback B');
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

test('an item with no text anywhere is dropped — there is nothing to judge or engage with', () => {
  expect(extractPost({ ...base, content: '   ' }, 1)).toBeNull();
  expect(extractPost({ ...base, content: undefined }, 1)).toBeNull();
  // Still nothing to read even after checking the reshare fallback below.
  expect(extractPost({ ...base, content: undefined, repost: { content: '   ' } }, 1)).toBeNull();
});

test("a reshare-with-commentary that added no words of its own falls back to the nested original's text", () => {
  // Measured: of the 9.0% of real items with no top-level content, most are reshares whose
  // ORIGINAL is worth showing even though the resharer typed nothing — reacting to a post
  // needs no text of the resharer's own. Only when the nested post ALSO has no content is
  // the item genuinely unusable (covered by the previous test).
  const out = extractPost({ ...base, content: undefined, repost: { content: 'Nested original text.' } }, 1)!;
  expect(out.content).toBe('Nested original text.');
  expect(out.is_repost).toBe(1);
});

test('missing author and engagement degrade to null rather than throwing', () => {
  const out = extractPost({ ...base, author: null, engagement: null }, 1)!;
  expect(out.author_name).toBeNull();
  expect(out.author_headline).toBeNull();
  expect(out.reaction_count).toBeNull();
  expect(out.comment_count).toBeNull();
});

test('is_repost is set from the real repost/repostedBy signals, and defaults to 0 when unclear', () => {
  // `type` is `'post'` on every real item, including actual reshares — it is NOT the real
  // discriminator despite being one elsewhere, but is still honoured as a harmless
  // forward-compat check.
  expect(extractPost({ ...base, type: 'repost' }, 1)!.is_repost).toBe(1);
  // The two real shapes: a reshare with added commentary, and a bare reshare.
  expect(extractPost({ ...base, repost: { content: 'x' } }, 1)!.is_repost).toBe(1);
  expect(extractPost({ ...base, repostedBy: { name: 'x' } }, 1)!.is_repost).toBe(1);
  // Under-label rather than mislabel: an unrecognized shape is not called a repost.
  expect(extractPost({ ...base, type: 'something-new' }, 1)!.is_repost).toBe(0);
});

test('reaction_count reads `likes` — the total — even though `reactions` is an array, never a bare number', () => {
  // Measured on real payloads: `engagement.reactions` is always `[{type, count}, ...]`, and
  // `likes` is verified to be its sum (e.g. 51 = 41+5+5 in a sampled item). `num()` on an
  // array is null, so this is the path actually taken on every real item.
  const out = extractPost({
    ...base,
    engagement: { likes: 51, reactions: [{ type: 'LIKE', count: 41 }, { type: 'PRAISE', count: 10 }] },
  }, 1)!;
  expect(out.reaction_count).toBe(51);
});

test('the `reactions` fallback is forward-compat only: unreachable against a real payload, still safe against a hypothetical one', () => {
  // No real item omits `likes` while keeping a numeric `reactions`, but if one ever did,
  // this is the value the fallback would produce rather than silently losing the count.
  expect(extractPost({ ...base, engagement: { reactions: 9 } }, 1)!.reaction_count).toBe(9);
});

test('reaction_count and comment_count reject a negative or fractional value', () => {
  // These back an INTEGER column of counts: never negative, never fractional. Untrusted
  // input claiming otherwise is treated as absent, not coerced.
  expect(extractPost({ ...base, engagement: { likes: -3, comments: 2.5 } }, 1)!.reaction_count).toBeNull();
  expect(extractPost({ ...base, engagement: { likes: -3, comments: 2.5 } }, 1)!.comment_count).toBeNull();
});

test('a payload that cannot be JSON-stringified (a circular reference) yields null, not a throw', () => {
  const circular: Record<string, unknown> = { ...base };
  circular.self = circular;
  expect(() => extractPost(circular as ApifyPost, 1)).not.toThrow();
  expect(extractPost(circular as ApifyPost, 1)).toBeNull();
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
  const { rows, unattributed, unusable } = attribute(items, byUrl);
  expect(rows.map((r) => r.tracked_profile_id)).toEqual([11, 22]);
  expect(unattributed).toBe(1);
  expect(unusable).toBe(0);
});

test('attribute counts a content-unusable item separately from an unattributed one', () => {
  // A matched profile whose item has no resolvable text anywhere is a content-policy drop,
  // not an attribution failure — folding the two together would make a single "dropped
  // unattributable items" log line blame URL normalization for this, forever.
  const byUrl = new Map([['https://www.linkedin.com/in/dana', 11]]);
  const { rows, unattributed, unusable } = attribute([{ ...base, content: undefined }], byUrl);
  expect(rows).toEqual([]);
  expect(unattributed).toBe(0);
  expect(unusable).toBe(1);
});

test('attribute matches a targetUrl that differs only by trailing slash or case', () => {
  const byUrl = new Map([['https://www.linkedin.com/in/dana', 11]]);
  const { rows } = attribute(
    [{ ...base, query: { targetUrl: 'https://WWW.LinkedIn.com/in/Dana/' } }], byUrl,
  );
  expect(rows.map((r) => r.tracked_profile_id)).toEqual([11]);
});

// --- Real-shaped fixture coverage ------------------------------------------------------

test('a normal post fixture extracts author_headline from `info` and reaction_count from `likes`', () => {
  const out = extractPost(byLabel('normal_post'), 1)!;
  expect(out.author_headline).toBe('Director of Detection Engineering');
  expect(out.reaction_count).toBe(51);
  expect(out.is_repost).toBe(0);
});

test('a bare reshare fixture (repostedBy, no repost) keeps its top-level content and is flagged as a repost', () => {
  const out = extractPost(byLabel('bare_reshare_with_content'), 1)!;
  expect(out.content).toContain('proud to be recognized');
  expect(out.is_repost).toBe(1);
});

test("a reshare-with-commentary fixture keeps the resharer's own words when present", () => {
  const out = extractPost(byLabel('reshare_with_commentary'), 1)!;
  expect(out.content).toBe("This mirrors exactly what we're seeing in our own SOC.");
  expect(out.is_repost).toBe(1);
});

test('a reshare-with-commentary fixture with no added words falls back to the nested original', () => {
  const out = extractPost(byLabel('reshare_with_commentary_no_own_words'), 1)!;
  expect(out.content).toBe('Alert fatigue is the number one reason tier-1 analysts burn out within a year.');
  expect(out.is_repost).toBe(1);
});

test('a bare reshare fixture with no recoverable content anywhere is dropped', () => {
  expect(extractPost(byLabel('bare_reshare_no_recoverable_content'), 1)).toBeNull();
});

// --- Schema round-trip -------------------------------------------------------------

test('every row extractPost produces actually inserts against the real posts CHECK', () => {
  const repos = new Repos(openDatabase(':memory:'));
  const profile = repos.trackedProfiles.add('https://www.linkedin.com/in/dana', null, 'urls');
  const rows = fx
    .map((f) => extractPost(f, profile.id))
    .filter((r): r is NonNullable<typeof r> => r !== null);
  // Sanity: the fixture set is expected to yield 4 usable rows (one is genuinely unusable).
  expect(rows.length).toBe(4);
  const { added, rejected } = repos.posts.upsertMany(rows, new Date().toISOString());
  expect(rejected).toBe(0);
  expect(added).toBe(4);
});
