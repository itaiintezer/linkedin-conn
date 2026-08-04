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

beforeEach(() => {
  repos = new Repos(openDatabase(':memory:'));
  postsClient = fakePostsClient;
  app = buildServer(repos, new FakeDriver(), undefined, undefined,
    { apifyPostsClientFactory: () => postsClient });
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
    '2026-08-04T10:00:00.000Z',
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
