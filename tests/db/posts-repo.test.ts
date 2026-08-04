/**
 * Schema-level coverage for the Posts feed: the new tables and columns exist, the
 * settings defaults match the spec, and the `posted_at` CHECK rejects the shape the
 * retention prune cannot safely compare as TEXT. Task 2 adds TrackedProfileRepo and,
 * with it, coverage for its reactivating `add` (including the connection_id backfill
 * rule — fills a NULL, never overwrites a set one), soft-delete via `deactivate`,
 * the per-profile sweep stamps (`markSwept` / `markSweepError`), and `withCounts`'s
 * LEFT JOIN + COUNT. Task 3 adds PostRepo: URN dedupe via `upsertMany` (including
 * disambiguating a genuine duplicate from a row the schema's CHECK/NOT NULL
 * constraints rejected), the feed hiding an untracked profile's posts without
 * deleting them, the retention prune (un-engaged old posts drop, engaged ones
 * survive, `first_seen_at` stands in for a NULL `posted_at`, and a `days` value that
 * would wipe everything or throw is refused), `engagement_id` surviving a URN
 * reconcile, keyset pagination end-to-end (including a tie spanning a page boundary
 * and an interleaved NULL `posted_at`), and that the three feed filters partition
 * every engagement state — across all seven `EngagementStatus` values crossed with
 * reacted/not-reacted — into exactly one chip, with `counts()` and `feed()` in
 * agreement.
 */
import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import type { EngagementStatus, PostFilter } from '../../src/types.js';

let repos: Repos;
beforeEach(() => { repos = new Repos(openDatabase(':memory:')); });

test('the new tables and columns exist', () => {
  const tables = (repos.db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('tracked_profiles','posts')",
  ).all() as { name: string }[]).map((r) => r.name).sort();
  expect(tables).toEqual(['posts', 'tracked_profiles']);

  const settings = (repos.db.prepare('PRAGMA table_info(settings)').all() as { name: string }[])
    .map((c) => c.name);
  expect(settings).toContain('posts_sweep_per_day');
  expect(settings).toContain('posts_max_per_sweep');
  expect(settings).toContain('posts_sweep_batch_size');
  expect(settings).toContain('posts_retention_days');
  expect(settings).toContain('tracked_profile_cap');

  const app = (repos.db.prepare('PRAGMA table_info(app_state)').all() as { name: string }[])
    .map((c) => c.name);
  expect(app).toContain('posts_swept_at');
  expect(app).toContain('posts_halted');
});

test('settings defaults match the spec', () => {
  const s = repos.settings.get() as unknown as Record<string, number>;
  expect(s.posts_sweep_per_day).toBe(1);
  expect(s.posts_max_per_sweep).toBe(3);
  expect(s.posts_sweep_batch_size).toBe(200);
  expect(s.posts_retention_days).toBe(30);
  expect(s.tracked_profile_cap).toBe(200);
});

test('posted_at rejects a non-ISO shape, because the prune compares it as TEXT', () => {
  repos.db.prepare(
    "INSERT INTO tracked_profiles (profile_url, source) VALUES ('https://www.linkedin.com/in/a', 'urls')",
  ).run();
  // Space-separated, no timezone — the exact shape datetime('now') produces, and the
  // exact shape the send_log scar (see schema.sql) was written to reject.
  const bad = () => repos.db.prepare(
    `INSERT INTO posts (post_urn, post_url, tracked_profile_id, posted_at, first_seen_at)
     VALUES ('urn:li:activity:1', 'https://x', 1, '2026-08-04 10:00:00', '2026-08-04T10:00:00.000Z')`,
  ).run();
  // Anchor on the CHECK's own text so this fails loudly if a FK or NOT NULL violation
  // ever reached it first instead — SQLite's message reproduces the failing constraint
  // expression verbatim, which for this column starts with 'posted_at IS NULL'.
  expect(bad).toThrow(/CHECK constraint failed: posted_at IS NULL/);

  // Sibling proof: the identical INSERT with only the timestamp shape corrected succeeds,
  // which pins the timestamp shape as the sole variable between the two outcomes.
  const good = () => repos.db.prepare(
    `INSERT INTO posts (post_urn, post_url, tracked_profile_id, posted_at, first_seen_at)
     VALUES ('urn:li:activity:2', 'https://x', 1, '2026-08-04T10:00:00.000Z', '2026-08-04T10:00:00.000Z')`,
  ).run();
  expect(good).not.toThrow();
});

const URL_A = 'https://www.linkedin.com/in/ada-lovelace';
const URL_B = 'https://www.linkedin.com/in/grace-hopper';

test('add is idempotent and reactivates a previously untracked profile', () => {
  const first = repos.trackedProfiles.add(URL_A, null, 'urls');
  const again = repos.trackedProfiles.add(URL_A, null, 'urls');
  expect(again.id).toBe(first.id);

  repos.trackedProfiles.deactivate(first.id);
  expect(repos.trackedProfiles.findByUrl(URL_A)!.active).toBe(0);

  // Re-adding the same URL reactivates rather than duplicating, so re-tracking someone
  // you removed neither creates a second row nor re-bills their first sweep.
  const back = repos.trackedProfiles.add(URL_A, null, 'urls');
  expect(back.id).toBe(first.id);
  expect(back.active).toBe(1);
});

test('activeProfiles and countActive exclude soft-deleted rows', () => {
  const a = repos.trackedProfiles.add(URL_A, null, 'urls');
  repos.trackedProfiles.add(URL_B, null, 'search');
  expect(repos.trackedProfiles.countActive()).toBe(2);

  repos.trackedProfiles.deactivate(a.id);
  expect(repos.trackedProfiles.countActive()).toBe(1);
  expect(repos.trackedProfiles.activeProfiles().map((p) => p.profile_url)).toEqual([URL_B]);
});

test('markSwept clears a previous error; markSweepError leaves last_swept_at alone', () => {
  const a = repos.trackedProfiles.add(URL_A, null, 'urls');

  repos.trackedProfiles.markSweepError(a.id, 'run failed');
  expect(repos.trackedProfiles.findById(a.id)!.last_sweep_error).toBe('run failed');
  // A failed sweep must not advance last_swept_at, or the next pass would treat this
  // profile as fresh and use the narrow 24h window it never actually got.
  expect(repos.trackedProfiles.findById(a.id)!.last_swept_at).toBeNull();

  repos.trackedProfiles.markSwept(a.id, '2026-08-04T10:00:00.000Z');
  const row = repos.trackedProfiles.findById(a.id)!;
  expect(row.last_swept_at).toBe('2026-08-04T10:00:00.000Z');
  expect(row.last_sweep_error).toBeNull();
});

test('add fills a NULL connection_id but never overwrites one already set', () => {
  // connection_id is a real FK (connections(id)), and foreign_keys is ON — direct-SQL
  // inserts here, same style as the posted_at CHECK test above, since a bare made-up
  // integer would be rejected before the backfill logic is ever exercised.
  repos.db.prepare(`
    INSERT INTO connections (profile_url, full_name, source, first_seen_at, last_seen_at)
    VALUES (?, 'Ada Lovelace', 'urls', '2026-08-04T10:00:00.000Z', '2026-08-04T10:00:00.000Z')
  `).run(URL_A);
  const connA = repos.connections.findByUrl(URL_A)!.id;

  repos.db.prepare(`
    INSERT INTO connections (profile_url, full_name, source, first_seen_at, last_seen_at)
    VALUES (?, 'Grace Hopper', 'urls', '2026-08-04T10:00:00.000Z', '2026-08-04T10:00:00.000Z')
  `).run(URL_B);
  const connB = repos.connections.findByUrl(URL_B)!.id;
  expect(connA).not.toBe(connB);

  // Fresh add with no connection known yet: stored as NULL.
  const fresh = repos.trackedProfiles.add(URL_A, null, 'urls');
  expect(fresh.connection_id).toBeNull();

  // A later add that knows the connection backfills the NULL.
  const backfilled = repos.trackedProfiles.add(URL_A, connA, 'urls');
  expect(backfilled.connection_id).toBe(connA);

  // A further add carrying a DIFFERENT real connection id must not clobber the one
  // already stored — inverting this check would silently re-link the profile to the
  // wrong person and corrupt the feed's author display.
  const notOverwritten = repos.trackedProfiles.add(URL_A, connB, 'urls');
  expect(notOverwritten.connection_id).toBe(connA);

  // And the FK itself is genuinely enforced here (not silently ignored on :memory:):
  // a connection_id that doesn't exist in connections must be rejected outright.
  expect(() => repos.trackedProfiles.add(URL_B, connB + 999, 'urls'))
    .toThrow(/FOREIGN KEY constraint failed/);
});

test('withCounts: zero posts reports 0, N posts reports N, soft-deleted rows are excluded', () => {
  const a = repos.trackedProfiles.add(URL_A, null, 'urls');       // no posts yet
  const b = repos.trackedProfiles.add(URL_B, null, 'search');     // two posts
  const c = repos.trackedProfiles.add('https://www.linkedin.com/in/margaret-hamilton', null, 'urls');

  const insertPost = repos.db.prepare(`
    INSERT INTO posts (post_urn, post_url, tracked_profile_id, posted_at, first_seen_at)
    VALUES (?, ?, ?, '2026-08-04T10:00:00.000Z', '2026-08-04T10:00:00.000Z')
  `);
  insertPost.run('urn:li:activity:10', 'https://x/10', b.id);
  insertPost.run('urn:li:activity:11', 'https://x/11', b.id);

  repos.trackedProfiles.deactivate(c.id);

  const rows = repos.trackedProfiles.withCounts();
  const byUrl = new Map(rows.map((r) => [r.profile_url, r.post_count]));

  // Proves COUNT(p.id) against the LEFT JOIN — COUNT(*) would wrongly report 1 for a
  // profile whose join produced one unmatched (NULL) row instead of zero real posts.
  expect(byUrl.get(a.profile_url)).toBe(0);
  expect(byUrl.get(b.profile_url)).toBe(2);
  expect(byUrl.has(c.profile_url)).toBe(false);
});

const postInput = (urn: string, profileId: number, postedAt: string | null) => ({
  post_urn: urn,
  post_url: `https://www.linkedin.com/feed/update/${urn}/`,
  tracked_profile_id: profileId,
  author_name: 'Ada Lovelace',
  author_headline: 'Analytical Engine',
  content: 'A note on the engine.',
  posted_at: postedAt,
  is_repost: 0,
  reaction_count: 12,
  comment_count: 3,
  raw_json: '{}',
});

test('upsert dedupes on post_urn and reports how many were new', () => {
  const a = repos.trackedProfiles.add(URL_A, null, 'urls');
  const now = '2026-08-04T10:00:00.000Z';

  const first = repos.posts.upsertMany([
    postInput('urn:li:activity:1', a.id, '2026-08-03T09:00:00.000Z'),
    postInput('urn:li:activity:2', a.id, '2026-08-02T09:00:00.000Z'),
  ], now);
  expect(first).toEqual({ added: 2, rejected: 0 });

  // Re-sweeping the same posts is a no-op. This is what removes the need for a cursor.
  const second = repos.posts.upsertMany([
    postInput('urn:li:activity:1', a.id, '2026-08-03T09:00:00.000Z'),
    postInput('urn:li:activity:3', a.id, '2026-08-01T09:00:00.000Z'),
  ], now);
  expect(second).toEqual({ added: 1, rejected: 0 });
  expect(repos.posts.countAll()).toBe(3);
});

test('upsertMany distinguishes a genuine duplicate from a row the schema rejected, and is atomic', () => {
  const a = repos.trackedProfiles.add(URL_A, null, 'urls');
  // Valid, but no milliseconds — an entirely ordinary serialization the CHECK still
  // refuses, since it pins toISOString()'s exact fixed-width shape.
  const malformed = { ...postInput('urn:li:activity:bad', a.id, null), posted_at: '2026-07-20T09:00:00Z' };

  const result = repos.posts.upsertMany([
    postInput('urn:li:activity:ok', a.id, '2026-08-03T09:00:00.000Z'),
    malformed,
  ], '2026-08-04T10:00:00.000Z');
  // The good row is stored; the malformed one is counted as `rejected`, not silently
  // folded into "0 new" the way a duplicate would be — that distinction is the whole
  // point, since an operator seeing "0 new posts" for a batch that was actually dropped
  // would never know to look, and the next sweep would re-fetch and re-drop it forever.
  expect(result).toEqual({ added: 1, rejected: 1 });
  expect(repos.posts.countAll()).toBe(1);
  expect(repos.posts.findByUrn('urn:li:activity:bad')).toBeUndefined();

  // Re-running the identical batch: the good row is now a genuine duplicate (rejected
  // stays 0 for it), the malformed row is rejected again (it still never made it in).
  const again = repos.posts.upsertMany([
    postInput('urn:li:activity:ok', a.id, '2026-08-03T09:00:00.000Z'),
    malformed,
  ], '2026-08-04T10:00:00.000Z');
  expect(again).toEqual({ added: 0, rejected: 1 });

  // Atomicity: a batch where one row trips a FOREIGN KEY violation (unlike a CHECK
  // failure, this throws rather than being swallowed by OR IGNORE) must not leave the
  // rows before it committed.
  const withBadFk = [
    postInput('urn:li:activity:before-fk', a.id, '2026-08-03T09:00:00.000Z'),
    { ...postInput('urn:li:activity:bad-fk', a.id + 999, '2026-08-03T09:00:00.000Z') },
  ];
  expect(() => repos.posts.upsertMany(withBadFk, '2026-08-04T10:00:00.000Z'))
    .toThrow(/FOREIGN KEY constraint failed/);
  expect(repos.posts.findByUrn('urn:li:activity:before-fk')).toBeUndefined();
});

test('the feed hides posts of an untracked profile without deleting them', () => {
  const a = repos.trackedProfiles.add(URL_A, null, 'urls');
  repos.posts.upsertMany([postInput('urn:li:activity:9', a.id, '2026-08-03T09:00:00.000Z')],
    '2026-08-04T10:00:00.000Z');
  expect(repos.posts.feed('new', 20, null)).toHaveLength(1);

  repos.trackedProfiles.deactivate(a.id);
  expect(repos.posts.feed('new', 20, null)).toHaveLength(0);
  expect(repos.posts.countAll()).toBe(1);   // still on disk
});

test('the prune drops un-engaged old posts, keeps engaged ones, and uses first_seen_at when posted_at is NULL', () => {
  const a = repos.trackedProfiles.add(URL_A, null, 'urls');
  const now = new Date('2026-08-04T10:00:00.000Z');
  repos.posts.upsertMany([
    postInput('urn:li:activity:old', a.id, '2026-06-01T09:00:00.000Z'),      // old, un-engaged
    postInput('urn:li:activity:keep', a.id, '2026-06-01T09:00:00.000Z'),     // old, engaged
    postInput('urn:li:activity:fresh', a.id, '2026-08-03T09:00:00.000Z'),    // recent
    postInput('urn:li:activity:nodate', a.id, null),                          // no posted_at
  ], '2026-06-01T09:00:00.000Z');   // first_seen_at is old for all four

  const eng = repos.engagements.add(
    'https://www.linkedin.com/feed/update/urn:li:activity:keep/',
    'urn:li:activity:keep', 'like', null,
  );
  repos.posts.setEngagement(repos.posts.findByUrn('urn:li:activity:keep')!.id, eng.id);

  const pruned = repos.posts.prune(30, now);
  expect(pruned).toBe(2);   // 'old' and 'nodate' — the latter via first_seen_at
  const left = repos.db.prepare('SELECT post_urn FROM posts ORDER BY post_urn')
    .all() as { post_urn: string }[];
  expect(left.map((r) => r.post_urn)).toEqual(['urn:li:activity:fresh', 'urn:li:activity:keep']);
});

test('feed() rejects a malformed cursor rather than silently returning a wrong page', () => {
  const a = repos.trackedProfiles.add(URL_A, null, 'urls');
  repos.posts.upsertMany([postInput('urn:li:activity:1', a.id, '2026-08-03T09:00:00.000Z')],
    '2026-08-04T10:00:00.000Z');

  // No pipe at all — lastIndexOf('|') used to return -1 here, silently taking the first
  // page as if no cursor had been passed.
  expect(() => repos.posts.feed('new', 20, 'garbage')).toThrow(/malformed feed cursor/);
  // Empty string — same shape, same failure mode.
  expect(() => repos.posts.feed('new', 20, '')).toThrow(/malformed feed cursor/);
  // Empty key ("|5") — sep === 0 must also be rejected, not just sep === -1.
  expect(() => repos.posts.feed('new', 20, '|5')).toThrow(/malformed feed cursor/);
  // Non-integer id half.
  expect(() => repos.posts.feed('new', 20, '2026-08-03T09:00:00.000Z|abc')).toThrow(/malformed feed cursor/);
  // Trailing pipe, empty id half. This is the one that used to slip through:
  // Number('') === 0 and Number.isInteger(0) is true, so `id` became 0 and `p.id < 0`
  // silently excluded every row at that key — the only malformed shape that DROPS rows
  // rather than repeating a page. Must throw, not return an (empty) result set.
  expect(() => repos.posts.feed('new', 20, '2026-08-03T09:00:00.000Z|')).toThrow(/malformed feed cursor/);
  // Digits-only also closes off values Number.isInteger would have accepted: negative,
  // scientific notation, and leading/trailing whitespace.
  expect(() => repos.posts.feed('new', 20, '2026-08-03T09:00:00.000Z|-1')).toThrow(/malformed feed cursor/);
  expect(() => repos.posts.feed('new', 20, '2026-08-03T09:00:00.000Z|1e3')).toThrow(/malformed feed cursor/);
  expect(() => repos.posts.feed('new', 20, '2026-08-03T09:00:00.000Z| 2')).toThrow(/malformed feed cursor/);
  // A garbage key that isn't the schema's ISO shape must also throw — unvalidated, any
  // string sorting above real data satisfies SORT_KEY < ? for every row and silently
  // re-serves page one. Parameterization means this was never an injection risk, just a
  // wrong page with no signal.
  expect(() => repos.posts.feed('new', 20, "x' OR 1=1 --|1")).toThrow(/malformed feed cursor/);
});

test('keyset pagination visits every post exactly once, in order, across ties and a NULL posted_at', () => {
  const a = repos.trackedProfiles.add(URL_A, null, 'urls');

  // A tie group of 4 (ids 1-4) deliberately bigger than the page size, so it splits
  // across a page boundary and the id-tiebreak has to carry the reader through it.
  for (let i = 1; i <= 4; i++) {
    repos.posts.upsertMany([postInput(`urn:p:${i}`, a.id, '2026-07-30T09:00:00.000Z')],
      '2026-08-04T10:00:00.000Z');
  }
  // A second, smaller tie group (ids 5-6).
  repos.posts.upsertMany([
    postInput('urn:p:5', a.id, '2026-07-25T09:00:00.000Z'),
    postInput('urn:p:6', a.id, '2026-07-25T09:00:00.000Z'),
  ], '2026-08-04T10:00:00.000Z');
  // A NULL posted_at (id 7), sorting by its first_seen_at instead — interleaved between
  // the two remaining tie groups below.
  repos.posts.upsertMany([postInput('urn:p:7', a.id, null)], '2026-07-22T09:00:00.000Z');
  // A third tie group (ids 8-9), then a lone oldest post (id 10).
  repos.posts.upsertMany([
    postInput('urn:p:8', a.id, '2026-07-20T09:00:00.000Z'),
    postInput('urn:p:9', a.id, '2026-07-20T09:00:00.000Z'),
  ], '2026-08-04T10:00:00.000Z');
  repos.posts.upsertMany([postInput('urn:p:10', a.id, '2026-07-15T09:00:00.000Z')],
    '2026-08-04T10:00:00.000Z');

  // The order ORDER BY COALESCE(posted_at, first_seen_at) DESC, id DESC produces: within
  // a tie, the highest id (most recently inserted) sorts first.
  const expectedOrder = [
    'urn:p:4', 'urn:p:3', 'urn:p:2', 'urn:p:1',   // tie group, newest-inserted-first
    'urn:p:6', 'urn:p:5',                          // second tie group
    'urn:p:7',                                     // NULL posted_at, via first_seen_at
    'urn:p:9', 'urn:p:8',                          // third tie group
    'urn:p:10',
  ];

  // Page through with the API's exact cursor construction, at a page size that forces
  // several boundaries mid-tie-group.
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 20; guard++) {
    const page = repos.posts.feed('new', 3, cursor);
    if (page.length === 0) break;
    for (const row of page) seen.push(row.post_urn);
    const last = page[page.length - 1]!;
    cursor = `${last.posted_at ?? last.first_seen_at}|${last.id}`;
  }

  expect(seen).toEqual(expectedOrder);
  expect(new Set(seen).size).toBe(10); // no duplicates
});

test('the three feed filters partition every engagement state into exactly one chip', () => {
  const a = repos.trackedProfiles.add(URL_A, null, 'urls');
  const statuses: EngagementStatus[] =
    ['queued', 'scheduled', 'sending', 'needs_attention', 'sent', 'failed', 'skipped'];

  const expectedFilter: Record<string, PostFilter> = {};
  let n = 0;
  for (const status of statuses) {
    for (const reacted of [false, true]) {
      n += 1;
      const urn = `urn:state:${n}`;
      repos.posts.upsertMany([postInput(urn, a.id, '2026-08-03T09:00:00.000Z')],
        '2026-08-04T10:00:00.000Z');
      const post = repos.posts.findByUrn(urn)!;
      const eng = repos.engagements.add(`https://x/${n}`, urn, 'like', null);
      repos.engagements.setStatus(eng.id, status, reacted ? { reacted_at: '2026-08-04T10:00:00.000Z' } : {});
      repos.posts.setEngagement(post.id, eng.id);

      // reacted always wins regardless of status; otherwise failed/skipped return to
      // `new` so they're retryable, and everything else (including needs_attention) is
      // still in flight.
      expectedFilter[urn] = reacted ? 'engaged'
        : (status === 'failed' || status === 'skipped') ? 'new' : 'queued';
    }
  }
  // A post with no engagement at all belongs in `new` too.
  repos.posts.upsertMany([postInput('urn:state:none', a.id, '2026-08-03T09:00:00.000Z')],
    '2026-08-04T10:00:00.000Z');
  expectedFilter['urn:state:none'] = 'new';

  const total = repos.posts.countAll();
  expect(total).toBe(statuses.length * 2 + 1);

  const filters: PostFilter[] = ['new', 'queued', 'engaged'];
  const counts = repos.posts.counts();
  let summed = 0;
  for (const f of filters) {
    const urnsInFilter = repos.posts.feed(f, 99, null).map((p) => p.post_urn);
    // counts() and feed() must agree exactly — this is what proves the SQL behind the
    // chip badge and the SQL behind the list are the same partition, not two that
    // happen to coincide today.
    expect(counts[f]).toBe(urnsInFilter.length);
    summed += counts[f];
    // Every URN that landed in this filter must be the one the partition predicts, and
    // nothing else — proves no post is double-counted across chips.
    for (const urn of urnsInFilter) expect(expectedFilter[urn]).toBe(f);
  }
  // The three counts sum to the total: every post on an active profile is in exactly
  // one chip, never none and never two.
  expect(summed).toBe(total);
});

test('engagement_id survives the engagement URN being reconciled', () => {
  const a = repos.trackedProfiles.add(URL_A, null, 'urls');
  const urn = 'urn:li:activity:7489401095899770880';
  repos.posts.upsertMany([postInput(urn, a.id, '2026-08-03T09:00:00.000Z')],
    '2026-08-04T10:00:00.000Z');
  const post = repos.posts.findByUrn(urn)!;
  const eng = repos.engagements.add(`https://www.linkedin.com/feed/update/${urn}/`, urn, 'like', null);
  repos.posts.setEngagement(post.id, eng.id);

  // The driver rewrites the engagement's URN to the canonical one it read off the live post.
  // A join on post_urn would lose the link here; a direct id does not.
  expect(repos.engagements.reconcileUrn(eng.id, 'urn:li:activity:7489401096851906561'))
    .toBe('reconciled');
  expect(repos.posts.feed('queued', 20, null).map((p) => p.id)).toEqual([post.id]);
});
