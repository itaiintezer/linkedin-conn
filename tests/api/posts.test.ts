/**
 * The Posts routes. A fake posts client is injected, so nothing here reaches Apify.
 */
import { test, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { FakeDriver } from '../../src/browser/driver.js';
import { buildServer } from '../../src/api/server.js';
import type { ApifyPostsClient } from '../../src/core/apify-posts-client.js';
import type { FastifyInstance } from 'fastify';

let repos: Repos; let app: FastifyInstance;

const fakePostsClient: ApifyPostsClient = { async fetchPosts() { return []; } };

/**
 * What the injected factory hands back. A mutable indirection rather than a fixed client so
 * the overlap test can substitute one that blocks mid-run; reset in beforeEach so no test
 * inherits another's. Every value it ever holds is a fake — nothing here can reach Apify.
 */
let postsClient: ApifyPostsClient = fakePostsClient;

/** How many times a route asked for a client. Pins the paths that must not build one at all. */
let clientBuilds = 0;

beforeEach(() => {
  repos = new Repos(openDatabase(':memory:'));
  postsClient = fakePostsClient;
  clientBuilds = 0;
  app = buildServer(repos, new FakeDriver(), undefined, undefined,
    { apifyPostsClientFactory: () => { clientBuilds++; return postsClient; } });
});
afterEach(async () => { await app.close(); });

const post = (url: string, payload: unknown) =>
  app.inject({ method: 'POST', url, payload: payload as object });

test('POST /api/tracked-profiles accepts an array and reports per-URL rejects', async () => {
  const res = await post('/api/tracked-profiles', {
    profile_urls: [
      'https://www.linkedin.com/in/dana',
      'https://www.linkedin.com/in/dana',      // duplicate inside one request
      'not a url',
    ],
  });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  expect(body.added).toBe(1);
  expect(body.rejected).toEqual([
    expect.objectContaining({ reason: 'already_tracked' }),
    expect.objectContaining({ reason: 'invalid_url' }),
  ]);
  expect(repos.trackedProfiles.countActive()).toBe(1);
});

test('POST /api/tracked-profiles also accepts a pasted text blob', async () => {
  const res = await post('/api/tracked-profiles', {
    text: 'https://www.linkedin.com/in/dana\nsome noise\nhttps://www.linkedin.com/in/marcus',
  });
  expect(res.json().added).toBe(2);
});

test('a tracked profile is linked to its connection row when one exists', async () => {
  // Inserted directly: the subject here is the route's connection lookup, not ConnectionRepo's
  // upsert signature, and coupling this test to that signature buys nothing.
  repos.db.prepare(
    `INSERT INTO connections (profile_url, full_name, source, first_seen_at, last_seen_at)
     VALUES ('https://www.linkedin.com/in/dana', 'Dana Reingold', 'urls',
             '2026-08-04T10:00:00.000Z', '2026-08-04T10:00:00.000Z')`,
  ).run();
  const conn = repos.connections.findByUrl('https://www.linkedin.com/in/dana')!;
  await post('/api/tracked-profiles', { profile_urls: ['https://www.linkedin.com/in/dana'] });
  expect(repos.trackedProfiles.findByUrl('https://www.linkedin.com/in/dana')!.connection_id)
    .toBe(conn.id);
});

test('the cap fills partially rather than refusing the whole batch', async () => {
  repos.settings.update({ tracked_profile_cap: 2 });
  const res = await post('/api/tracked-profiles', {
    profile_urls: [
      'https://www.linkedin.com/in/a',
      'https://www.linkedin.com/in/b',
      'https://www.linkedin.com/in/c',
    ],
  });
  const body = res.json();
  expect(body.added).toBe(2);
  expect(body.rejected).toEqual([expect.objectContaining({ reason: 'cap_reached' })]);
  // The message must name the cap, not just the status — the operator has to know what to do.
  expect(body.rejected[0].message).toMatch(/2/);
});

test('a reactivation consumes a cap slot like any other add', async () => {
  repos.settings.update({ tracked_profile_cap: 1 });
  await post('/api/tracked-profiles', { profile_urls: ['https://www.linkedin.com/in/a'] });
  const a = repos.trackedProfiles.findByUrl('https://www.linkedin.com/in/a')!.id;
  await app.inject({ method: 'DELETE', url: `/api/tracked-profiles/${a}` });
  // The freed slot goes to somebody else.
  await post('/api/tracked-profiles', { profile_urls: ['https://www.linkedin.com/in/b'] });
  expect(repos.trackedProfiles.countActive()).toBe(1);

  // Resurrecting `a` would put two profiles under a cap of one. Exempting a reactivation
  // because "the row already exists" is how an untrack/re-add cycle walks past the cap.
  const res = await post('/api/tracked-profiles', { profile_urls: ['https://www.linkedin.com/in/a'] });
  const body = res.json();
  expect(body.added).toBe(0);
  expect(body.rejected).toEqual([expect.objectContaining({ reason: 'cap_reached' })]);
  expect(repos.trackedProfiles.findById(a)!.active).toBe(0);
  expect(repos.trackedProfiles.countActive()).toBe(1);
});

test('GET /api/tracked-profiles returns active rows with post counts', async () => {
  await post('/api/tracked-profiles', { profile_urls: ['https://www.linkedin.com/in/dana'] });
  const res = await app.inject({ method: 'GET', url: '/api/tracked-profiles' });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.tracked).toHaveLength(1);
  expect(body.tracked[0].post_count).toBe(0);
  expect(body.cap).toBe(200);
});

test('DELETE untracks without deleting, and re-adding reactivates the same row', async () => {
  await post('/api/tracked-profiles', { profile_urls: ['https://www.linkedin.com/in/dana'] });
  const id = repos.trackedProfiles.findByUrl('https://www.linkedin.com/in/dana')!.id;

  const del = await app.inject({ method: 'DELETE', url: `/api/tracked-profiles/${id}` });
  expect(del.statusCode).toBe(200);
  expect(repos.trackedProfiles.findById(id)!.active).toBe(0);

  const again = await post('/api/tracked-profiles',
    { profile_urls: ['https://www.linkedin.com/in/dana'] });
  expect(again.json().added).toBe(1);
  expect(repos.trackedProfiles.findById(id)!.active).toBe(1);
});

test('DELETE on an unknown id is a 404, not a silent success', async () => {
  const res = await app.inject({ method: 'DELETE', url: '/api/tracked-profiles/999' });
  expect(res.statusCode).toBe(404);
});

test('an empty request is a 400', async () => {
  expect((await post('/api/tracked-profiles', { profile_urls: [] })).statusCode).toBe(400);
});

/** Insert a tracked profile and n posts, oldest first by index. */
async function seed(n: number): Promise<number> {
  await post('/api/tracked-profiles', { profile_urls: ['https://www.linkedin.com/in/dana'] });
  const tp = repos.trackedProfiles.findByUrl('https://www.linkedin.com/in/dana')!;
  repos.posts.upsertMany(
    Array.from({ length: n }, (_, i) => ({
      post_urn: `urn:li:activity:${i}`,
      post_url: `https://www.linkedin.com/feed/update/urn:li:activity:${i}/`,
      tracked_profile_id: tp.id,
      author_name: 'Dana Reingold', author_headline: 'VP Security',
      content: `Post number ${i}`,
      // Ascending dates, so index 0 is the OLDEST and index n-1 the newest.
      posted_at: new Date(Date.UTC(2026, 6, 1 + i)).toISOString(),
      is_repost: 0, reaction_count: null, comment_count: null, raw_json: null,
    })),
    // Relative to now, NOT a fixed date: the cost readout counts posts stored in the trailing
    // 30 days against a real clock, so a hard-coded first_seen_at makes that test start failing
    // a month after it was written — and the likely "fix" is deleting the assertion.
    new Date(Date.now() - 1000).toISOString(),
  );
  return tp.id;
}

test('GET /api/posts returns newest first with counts', async () => {
  await seed(3);
  const res = await app.inject({ method: 'GET', url: '/api/posts' });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.posts.map((p: { post_urn: string }) => p.post_urn))
    .toEqual(['urn:li:activity:2', 'urn:li:activity:1', 'urn:li:activity:0']);
  expect(body.counts).toEqual({ new: 3, queued: 0, engaged: 0 });
  expect(body.filter).toBe('new');          // the default
  expect(body.tracked).toBe(1);
  expect(body.author_display).toBeUndefined();
  expect(body.posts[0].author_display).toBe('Dana Reingold');
});

test('the feed pages by keyset, not offset', async () => {
  await seed(5);
  const first = (await app.inject({ method: 'GET', url: '/api/posts?limit=2' })).json();
  expect(first.posts).toHaveLength(2);
  expect(first.next_cursor).toBeTruthy();

  const second = (await app.inject({
    method: 'GET', url: `/api/posts?limit=2&before=${encodeURIComponent(first.next_cursor)}`,
  })).json();
  expect(second.posts.map((p: { post_urn: string }) => p.post_urn))
    .toEqual(['urn:li:activity:2', 'urn:li:activity:1']);
});

test('next_cursor is null on the last page', async () => {
  await seed(2);
  const res = (await app.inject({ method: 'GET', url: '/api/posts?limit=10' })).json();
  expect(res.posts).toHaveLength(2);
  expect(res.next_cursor).toBeNull();
});

test('an unknown filter is a 400 rather than silently becoming new', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/posts?filter=nonsense' });
  expect(res.statusCode).toBe(400);
});

test('the page size is clamped rather than trusted', async () => {
  await seed(101);
  const rows = async (qs: string): Promise<number> =>
    (await app.inject({ method: 'GET', url: `/api/posts?${qs}` })).json().posts.length;
  expect(await rows('limit=1e9')).toBe(100);   // the ceiling, and Infinity cannot bind in SQLite
  expect(await rows('limit=101')).toBe(100);
  expect(await rows('limit=2.7')).toBe(2);     // floored, never rounded up past the ceiling
  expect(await rows('limit=0')).toBe(25);      // the default: zero rows is nobody's intent
  expect(await rows('limit=-5')).toBe(25);
  expect(await rows('limit=abc')).toBe(25);
  expect(await rows('')).toBe(25);
});

/**
 * `before` arrives verbatim from a query parameter, so PostRepo.feed's cursor validation is
 * reachable from outside — and it reports a bad cursor by throwing. Pinned because the answer
 * depends on the global error handler mapping a status-less throw to 400: left as a 500 this
 * would read as "the server is broken" rather than "that cursor is junk".
 */
test('a malformed cursor is a 400, not a 500', async () => {
  await seed(2);
  const res = await app.inject({ method: 'GET', url: '/api/posts?before=garbage' });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toMatch(/malformed feed cursor/);
});

test('the cost readout reports posts stored in the trailing window', async () => {
  await seed(4);
  const res = (await app.inject({ method: 'GET', url: '/api/posts' })).json();
  expect(res.cost_30d.posts).toBe(4);
  expect(res.cost_30d.usd).toBeCloseTo(4 * 0.002, 6);
});

test('the halt latch travels with the feed so the screen needs one request', async () => {
  await seed(1);
  const clean = (await app.inject({ method: 'GET', url: '/api/posts' })).json();
  expect(clean.halt.halted).toBe(0);

  repos.appState.haltPosts('auth', 'Apify rejected the API key', '2026-08-04T10:00:00.000Z');
  const halted = (await app.inject({ method: 'GET', url: '/api/posts' })).json();
  expect(halted.halt.halted).toBe(1);
  expect(halted.halt.reason).toBe('auth');
  expect(halted.halt.detail).toBe('Apify rejected the API key');
});

test('engaging a post creates an engagement and links it', async () => {
  await seed(1);
  const id = repos.posts.findByUrn('urn:li:activity:0')!.id;
  const res = await post(`/api/posts/${id}/engage`,
    { reaction: 'insightful', comment: 'Useful framing.' });
  expect(res.statusCode).toBe(201);

  const body = res.json();
  expect(body.engagement.reaction).toBe('insightful');
  expect(body.engagement.comment_text).toBe('Useful framing.');
  expect(repos.posts.findById(id)!.engagement_id).toBe(body.engagement.id);
  // The post has left the New chip.
  expect(repos.posts.counts()).toEqual({ new: 0, queued: 1, engaged: 0 });
});

test('an omitted reaction defaults to like', async () => {
  await seed(1);
  const id = repos.posts.findByUrn('urn:li:activity:0')!.id;
  const res = await post(`/api/posts/${id}/engage`, {});
  expect(res.json().engagement.reaction).toBe('like');
});

test('validation is the engagement pipeline validation, not a second copy', async () => {
  await seed(1);
  const id = repos.posts.findByUrn('urn:li:activity:0')!.id;
  expect((await post(`/api/posts/${id}/engage`, { reaction: 'shrug' })).statusCode).toBe(400);
  expect((await post(`/api/posts/${id}/engage`, { comment: 'x'.repeat(1251) })).statusCode)
    .toBe(400);
  // Whitespace-only is NO comment, not an empty one — it must not claim a comment-cap slot.
  const ok = await post(`/api/posts/${id}/engage`, { comment: '   ' });
  expect(ok.json().engagement.comment_text).toBeNull();
});

test('engaging twice is a 409 naming the existing engagement', async () => {
  await seed(1);
  const id = repos.posts.findByUrn('urn:li:activity:0')!.id;
  await post(`/api/posts/${id}/engage`, { reaction: 'like' });
  const again = await post(`/api/posts/${id}/engage`, { reaction: 'love' });
  expect(again.statusCode).toBe(409);
  expect(again.json().error).toMatch(/already queued/);
});

test('a post whose engagement failed can be engaged again', async () => {
  await seed(1);
  const id = repos.posts.findByUrn('urn:li:activity:0')!.id;
  const first = (await post(`/api/posts/${id}/engage`, { reaction: 'like' })).json();
  const eid = first.engagement.id;
  repos.engagements.setStatus(eid, 'failed',
    {
      last_error: 'nope', skip_reason: 'comments_disabled',
      commented_at: '2026-08-04T11:00:00.000Z', attempts: 2,
    });
  // Back in the New chip, so it is retryable from the feed rather than invisible.
  expect(repos.posts.counts().new).toBe(1);

  const again = await post(`/api/posts/${id}/engage`, { reaction: 'like' });
  expect(again.statusCode).toBe(201);
  // Marked, because nothing was created and the row keeps its original reaction and comment.
  expect(again.json().requeued).toBe(true);
  // And the retry actually re-queues the work: answering 200 "already linked" would make the
  // click a silent no-op and leave the post stuck in New forever.
  expect(repos.posts.counts()).toEqual({ new: 0, queued: 1, engaged: 0 });

  // The exact field set, pinned. `reacted_at` staying NULL is the safety-critical half —
  // sender.ts drives the reaction only while it is null — and `attempts` must survive so a
  // re-queue cannot reset the failure budget and loop forever.
  const row = repos.engagements.findById(eid)!;
  expect(row.status).not.toBe('failed');
  expect(row.last_error).toBeNull();
  expect(row.skip_reason).toBeNull();
  expect(row.commented_at).toBeNull();
  expect(row.reacted_at).toBeNull();
  expect(row.attempts).toBe(2);
});

/**
 * The one case where `status` alone gives the wrong answer, and the reason the retryable test
 * lives in posts-repos.ts beside FILTER_SQL rather than as a second copy in the route.
 */
test('a failed engagement whose reaction already landed is not re-driven', async () => {
  await seed(1);
  const id = repos.posts.findByUrn('urn:li:activity:0')!.id;
  const eid = (await post(`/api/posts/${id}/engage`, { reaction: 'celebrate' })).json().engagement.id;
  // The reaction landed; the comment step then fell over. `failed` looks retryable, but the
  // reaction is live on LinkedIn — so the post belongs to the Engaged chip, not New.
  repos.engagements.setStatus(eid, 'failed',
    { reacted_at: '2026-08-04T11:00:00.000Z', last_error: 'comment box vanished' });
  expect(repos.posts.counts()).toEqual({ new: 0, queued: 0, engaged: 1 });

  const again = await post(`/api/posts/${id}/engage`, { reaction: 'insightful' });
  expect(again.statusCode).toBe(409);
  // Named for what it is, so the operator is pointed at retry rather than told it is queued.
  expect(again.json().error).toMatch(/already reacted/);

  // Bulk must refuse it for the same reason, through the same predicate.
  const bulk = await post('/api/posts/engage', { post_ids: [id], reaction: 'like' });
  expect(bulk.json().added).toBe(0);
  expect(bulk.json().rejected)
    .toEqual([expect.objectContaining({ post_id: id, reason: 'duplicate' })]);

  // Untouched by either attempt: re-queueing would hand the sender a second reaction to drive.
  const row = repos.engagements.findById(eid)!;
  expect(row.status).toBe('failed');
  expect(row.reacted_at).toBe('2026-08-04T11:00:00.000Z');
});

test('an engagement already queued for the same post by URL is adopted, not duplicated', async () => {
  await seed(1);
  const urn = 'urn:li:activity:0';
  // The operator pasted the URL into /api/engagements earlier, before the feed existed.
  const pasted = repos.engagements.add(
    `https://www.linkedin.com/feed/update/${urn}/`, urn, 'celebrate', null);
  const id = repos.posts.findByUrn(urn)!.id;

  const res = await post(`/api/posts/${id}/engage`, { reaction: 'like' });
  expect(res.statusCode).toBe(200);
  expect(res.json().adopted).toBe(true);
  expect(repos.posts.findById(id)!.engagement_id).toBe(pasted.id);
  // The pre-existing reaction is left alone rather than being silently rewritten.
  expect(repos.engagements.findById(pasted.id)!.reaction).toBe('celebrate');
});

test('bulk engage applies one reaction to many posts', async () => {
  const tp = await seed(3);
  expect(tp).toBeGreaterThan(0);
  const ids = ['urn:li:activity:0', 'urn:li:activity:1', 'urn:li:activity:2']
    .map((u) => repos.posts.findByUrn(u)!.id);

  const res = await post('/api/posts/engage', { post_ids: ids, reaction: 'insightful' });
  expect(res.statusCode).toBe(201);
  expect(res.json().added).toBe(3);
  expect(repos.posts.counts()).toEqual({ new: 0, queued: 3, engaged: 0 });
});

test('bulk engage IGNORES a comment field — bulk commenting is unreachable', async () => {
  await seed(2);
  const ids = ['urn:li:activity:0', 'urn:li:activity:1'].map((u) => repos.posts.findByUrn(u)!.id);
  await post('/api/posts/engage',
    { post_ids: ids, reaction: 'like', comment: 'the same sentence on both' });
  for (const id of ids) {
    const eid = repos.posts.findById(id)!.engagement_id!;
    expect(repos.engagements.findById(eid)!.comment_text).toBeNull();
  }
});

test('bulk engage separates created, adopted and re-queued rather than folding them together', async () => {
  await seed(3);
  const [fresh, pasted, failed] = ['urn:li:activity:0', 'urn:li:activity:1', 'urn:li:activity:2']
    .map((u) => repos.posts.findByUrn(u)!.id);

  // Queued by hand before the feed existed: adopted, keeping its own reaction.
  repos.engagements.add(`https://www.linkedin.com/feed/update/urn:li:activity:1/`,
    'urn:li:activity:1', 'celebrate', null);
  // An earlier attempt that failed without reacting: re-queued, also keeping its reaction.
  const failedEid = (await post(`/api/posts/${failed}/engage`, { reaction: 'support' }))
    .json().engagement.id;
  repos.engagements.setStatus(failedEid, 'failed', { last_error: 'nope' });

  const res = await post('/api/posts/engage',
    { post_ids: [fresh, pasted, failed], reaction: 'insightful' });
  const body = res.json();
  expect(body.added).toBe(3);
  // Only `fresh` actually got the reaction that was asked for; the other two are reported
  // apart so the UI can say so instead of implying three insightfuls.
  expect(body.post_ids).toEqual([fresh]);
  expect(body.adopted).toEqual([pasted]);
  expect(body.requeued).toEqual([failed]);
  expect(body.rejected).toEqual([]);
  expect(repos.engagements.findByUrn('urn:li:activity:1')!.reaction).toBe('celebrate');
  expect(repos.engagements.findById(failedEid)!.reaction).toBe('support');
  expect(repos.engagements.findById(failedEid)!.status).not.toBe('failed');
  expect(repos.posts.counts()).toEqual({ new: 0, queued: 3, engaged: 0 });
});

test('bulk engage discards junk ids instead of reading them as post 0', async () => {
  // Number(null), Number(false) and Number('') are all 0, which is an integer — so an
  // unfiltered coercion answers `no post 0` three times for input that named no post at all.
  const res = await post('/api/posts/engage', { post_ids: [null, false, '', 0, -1], reaction: 'like' });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toMatch(/no post ids/);
});

test('bulk engage reports per-post rejects and still answers 201', async () => {
  await seed(1);
  const good = repos.posts.findByUrn('urn:li:activity:0')!.id;
  const res = await post('/api/posts/engage', { post_ids: [good, 9999], reaction: 'like' });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  expect(body.added).toBe(1);
  expect(body.rejected).toEqual([expect.objectContaining({ post_id: 9999, reason: 'not_found' })]);
});

test('bulk engage with an unknown reaction is a 400 before anything is queued', async () => {
  await seed(2);
  const ids = ['urn:li:activity:0', 'urn:li:activity:1'].map((u) => repos.posts.findByUrn(u)!.id);
  const res = await post('/api/posts/engage', { post_ids: ids, reaction: 'shrug' });
  expect(res.statusCode).toBe(400);
  // Validated up front: a bad reaction is one mistake for the whole batch, and half-applying
  // it would leave the operator to undo real queued rows.
  expect(repos.posts.counts().queued).toBe(0);
});

test('POST /api/posts/sweep-now runs a sweep regardless of the slot gate', async () => {
  await post('/api/tracked-profiles', { profile_urls: ['https://www.linkedin.com/in/dana'] });
  repos.settings.update({ apify_api_key: 'apify_api_test' });
  const first = await post('/api/posts/sweep-now', {});
  expect(first.statusCode).toBe(200);
  // A second call in the same slot still runs — that is what makes it the override.
  expect((await post('/api/posts/sweep-now', {})).statusCode).toBe(200);
});

/**
 * The only spend path in this batch, so the guard is pinned rather than assumed. Without the
 * 409 the second request reaches runPostsSweep, which throws on re-entry — a 400 the operator
 * cannot interpret — and any implementation that "joined" the running sweep instead would bill
 * a second actor run for the same profiles.
 */
test('sweep-now refuses an overlapping sweep rather than starting a second billable run', async () => {
  await post('/api/tracked-profiles', { profile_urls: ['https://www.linkedin.com/in/dana'] });
  repos.settings.update({ apify_api_key: 'apify_api_test' });

  let runs = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  postsClient = { async fetchPosts() { runs++; await gate; return []; } };

  const inflight = post('/api/posts/sweep-now', {});
  // Wait until the first sweep is genuinely inside the actor call, bounded so a regression
  // that never gets there fails the assertion instead of hanging the suite.
  for (let i = 0; i < 500 && runs === 0; i++) await new Promise((r) => setTimeout(r, 2));
  expect(runs).toBe(1);

  const second = await post('/api/posts/sweep-now', {});
  expect(second.statusCode).toBe(409);
  expect(second.json().error).toMatch(/already running/);
  expect(runs).toBe(1);            // the refused call billed nothing

  release();
  expect((await inflight).statusCode).toBe(200);
});

test('sweep-now without an API key is a 400 the operator can act on', async () => {
  await post('/api/tracked-profiles', { profile_urls: ['https://www.linkedin.com/in/dana'] });
  const res = await post('/api/posts/sweep-now', {});
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toMatch(/Apify/i);
  // Refused before anything is constructed, so an unconfigured instance has no path to Apify.
  expect(clientBuilds).toBe(0);
});

/** No profiles means no run to pay for, so it is refused before a client is ever built. */
test('sweep-now with nothing tracked is a 400', async () => {
  repos.settings.update({ apify_api_key: 'apify_api_test' });
  const res = await post('/api/posts/sweep-now', {});
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toMatch(/tracked/);
  expect(clientBuilds).toBe(0);
});

/* ---------- settings validation ----------------------------------------------
   POST /api/settings allowlists key NAMES and writes values through untouched, which is
   harmless for pacing dials and is not harmless here: `posts_max_per_sweep` becomes the
   actor's `maxPosts`, where 0 means "all posts, ever" — the exact value an operator types
   to mean "off". These tests pin the outermost of the three guards. */

test('posts_max_per_sweep of 0 is refused, because 0 means "everything" to the actor', async () => {
  const before = repos.settings.get().posts_max_per_sweep;
  const res = await post('/api/settings', { posts_max_per_sweep: 0 });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toMatch(/posts_max_per_sweep/);
  expect(res.json().error).toMatch(/1 or more/);
  expect(repos.settings.get().posts_max_per_sweep).toBe(before);   // nothing was written
});

test('posts_retention_days and tracked_profile_cap also refuse 0', async () => {
  for (const key of ['posts_retention_days', 'tracked_profile_cap', 'posts_sweep_batch_size']) {
    const res = await post('/api/settings', { [key]: 0 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(new RegExp(key));
  }
});

test('a fractional posts setting is refused', async () => {
  const res = await post('/api/settings', { posts_max_per_sweep: 2.5 });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toMatch(/posts_max_per_sweep/);
  expect(res.json().error).toMatch(/whole number/);
});

/* `NaN` and `Infinity` do not survive JSON, but a client that sends `null` produces exactly
   the same failure mode the plan warns about: the actor falls back to its own default of 10.
   A non-numeric type is refused for the same reason. */
test('a non-finite or non-numeric posts setting is refused', async () => {
  for (const bad of [null, 'lots', true, {}]) {
    const res = await post('/api/settings', { posts_max_per_sweep: bad });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/posts_max_per_sweep/);
  }
});

/* Numeric strings are refused rather than coerced: the dashboard sends real numbers, and
   silently accepting '30' would make the guard's own contract ("must be a whole number")
   a lie that the next caller relies on. */
test("a numeric string is refused rather than coerced", async () => {
  const res = await post('/api/settings', { posts_retention_days: '30' });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toMatch(/posts_retention_days/);
});

test('valid posts settings are accepted and stored', async () => {
  const res = await post('/api/settings', {
    posts_sweep_per_day: 2,
    posts_max_per_sweep: 5,
    posts_retention_days: 60,
    tracked_profile_cap: 300,
    posts_sweep_batch_size: 250,
  });
  expect(res.statusCode).toBe(200);
  const s = repos.settings.get();
  expect(s.posts_sweep_per_day).toBe(2);
  expect(s.posts_max_per_sweep).toBe(5);
  expect(s.posts_retention_days).toBe(60);
  expect(s.tracked_profile_cap).toBe(300);
  expect(s.posts_sweep_batch_size).toBe(250);
});

/* The one posts setting where 0 is meaningful: it only gates the tick, so "never sweep
   automatically" costs nothing and must stay reachable. */
test('posts_sweep_per_day of 0 is accepted — it means "never sweep automatically"', async () => {
  const res = await post('/api/settings', { posts_sweep_per_day: 0 });
  expect(res.statusCode).toBe(200);
  expect(repos.settings.get().posts_sweep_per_day).toBe(0);
});

test('a negative posts_sweep_per_day is still refused', async () => {
  const res = await post('/api/settings', { posts_sweep_per_day: -1 });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toMatch(/posts_sweep_per_day/);
});

/* One bad field rejects the whole patch. A partial write would leave the operator looking at
   a "failed" toast over a form that half-saved. */
test('one invalid field rejects the whole patch', async () => {
  const res = await post('/api/settings', { posts_retention_days: 45, posts_max_per_sweep: 0 });
  expect(res.statusCode).toBe(400);
  expect(repos.settings.get().posts_retention_days).not.toBe(45);
});

/* The guard is scoped to the posts keys: every other setting keeps the established
   write-through behaviour, and this task is not the place to change that. */
test('the guard does not touch the other settings keys', async () => {
  const res = await post('/api/settings', { engage_batches_per_day: 0 });
  expect(res.statusCode).toBe(200);
  expect(repos.settings.get().engage_batches_per_day).toBe(0);
});
