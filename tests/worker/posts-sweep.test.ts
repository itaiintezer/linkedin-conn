/**
 * One sweep pass. A FakeApifyPostsClient throughout — nothing here can spend money.
 *
 * The window-derivation tests are the important ones: postedLimit is the cost model, not a
 * filter, and widening it silently multiplies the Apify bill.
 */
import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { runPostsSweep, windowFor } from '../../src/worker/posts-sweep.js';
import type { ApifyPostsClient, FetchPostsOptions } from '../../src/core/apify-posts-client.js';
import type { ApifyPost } from '../../src/types.js';

let repos: Repos;
const NOW = new Date('2026-08-04T10:00:00.000Z');

beforeEach(() => { repos = new Repos(openDatabase(':memory:')); });

const URL_A = 'https://www.linkedin.com/in/dana';
const URL_B = 'https://www.linkedin.com/in/marcus';

/** Records every call so the batching and window choices can be asserted precisely. */
function fakeClient(
  postsFor: (url: string) => ApifyPost[] = () => [],
  fail?: (urls: string[]) => Error | null,
): ApifyPostsClient & { calls: { urls: string[]; opts: FetchPostsOptions }[] } {
  const calls: { urls: string[]; opts: FetchPostsOptions }[] = [];
  return {
    calls,
    async fetchPosts(urls, opts) {
      calls.push({ urls: [...urls], opts });
      const err = fail?.(urls) ?? null;
      if (err) throw err;
      return urls.flatMap((u) => postsFor(u));
    },
  };
}

const postFor = (url: string, urn: string, postedAt: string): ApifyPost => ({
  id: urn,
  linkedinUrl: `https://www.linkedin.com/feed/update/${urn}/`,
  content: `A post from ${url}`,
  postedAt: { timestamp: new Date(postedAt).getTime() },
  author: { name: 'Someone', linkedinUrl: url, position: 'Engineer' },
  engagement: { likes: 3, comments: 1 },
  query: { targetUrl: url },
});

test('windowFor picks the cheap 24h window only for a freshly-swept profile', () => {
  // Never swept: the wider window is what gives a newly-tracked profile content at all,
  // which is what replaced the rejected backfill mechanism.
  expect(windowFor(null, NOW)).toBe('week');
  expect(windowFor('2026-08-04T09:00:00.000Z', NOW)).toBe('24h');
  expect(windowFor('2026-08-03T11:00:00.000Z', NOW)).toBe('24h');
  // Stale: a missed sweep self-heals rather than losing those posts forever.
  expect(windowFor('2026-08-02T09:00:00.000Z', NOW)).toBe('week');
  // The boundary itself, and the two stamps that can't be read as an age. Pinned because
  // every one of them decides a bill: 'week' on a daily sweep re-pays for ~20x the posts.
  expect(windowFor(NOW.toISOString(), NOW)).toBe('24h');                  // swept this instant
  expect(windowFor('2026-08-03T10:00:00.000Z', NOW)).toBe('24h');         // exactly 24h
  expect(windowFor('2026-08-03T09:59:59.999Z', NOW)).toBe('week');        // a millisecond past
  expect(windowFor('not a date', NOW)).toBe('week');                      // unparseable
  expect(windowFor('2026-08-05T10:00:00.000Z', NOW)).toBe('week');        // stamped in the future
});

test('a sweep issues one run per window and stores what comes back', async () => {
  const a = repos.trackedProfiles.add(URL_A, null, 'urls');
  const b = repos.trackedProfiles.add(URL_B, null, 'search');
  // A is fresh, B has never been swept — so two windows, two runs.
  repos.trackedProfiles.markSwept(a.id, '2026-08-04T09:00:00.000Z');

  const client = fakeClient((url) => [
    postFor(url, `urn:li:activity:${url.endsWith('dana') ? 1 : 2}`, '2026-08-04T08:00:00.000Z'),
  ]);
  const res = await runPostsSweep(repos, { client, now: NOW, maxPosts: 3, batchSize: 200 });

  expect(res.postsAdded).toBe(2);
  expect(res.clean).toBe(true);
  const windows = client.calls.map((c) => c.opts.postedLimit).sort();
  expect(windows).toEqual(['24h', 'week']);
  expect(client.calls.every((c) => c.opts.maxPosts === 3)).toBe(true);
  // Both profiles were swept, one per window — nothing was dropped in the grouping.
  expect(res.profilesSwept).toBe(2);
  expect(repos.trackedProfiles.findById(b.id)!.last_swept_at).toBe(NOW.toISOString());
});

test('every profile in one window goes in ONE run', async () => {
  repos.trackedProfiles.add(URL_A, null, 'urls');
  repos.trackedProfiles.add(URL_B, null, 'urls');
  const client = fakeClient();
  await runPostsSweep(repos, { client, now: NOW, maxPosts: 3, batchSize: 200 });
  expect(client.calls).toHaveLength(1);
  expect(client.calls[0].urls.sort()).toEqual([URL_A, URL_B].sort());
});

test('batchSize splits a window into several runs', async () => {
  for (let i = 0; i < 5; i++) {
    repos.trackedProfiles.add(`https://www.linkedin.com/in/p${i}`, null, 'urls');
  }
  const client = fakeClient();
  await runPostsSweep(repos, { client, now: NOW, maxPosts: 3, batchSize: 2 });
  expect(client.calls.map((c) => c.urls.length)).toEqual([2, 2, 1]);
});

test('an out-of-range batch size falls back to one batch rather than sweeping nothing', async () => {
  repos.trackedProfiles.add(URL_A, null, 'urls');
  repos.trackedProfiles.add(URL_B, null, 'urls');
  const client = fakeClient();

  // NaN is what a settings value that arrived as a string reduces to. Unguarded, chunk()
  // returned ONE EMPTY batch for it: nothing fetched, nobody swept, pass still stamped clean.
  const res = await runPostsSweep(repos, { client, now: NOW, maxPosts: 3, batchSize: NaN });
  expect(client.calls.map((c) => c.urls.length)).toEqual([2]);
  expect(res.profilesSwept).toBe(2);
});

test('a clean pass stamps posts_swept_at; a failed one does not', async () => {
  repos.trackedProfiles.add(URL_A, null, 'urls');

  const boom = fakeClient(() => [], () => new Error('actor exploded'));
  const bad = await runPostsSweep(repos, { client: boom, now: NOW, maxPosts: 3, batchSize: 200 });
  expect(bad.clean).toBe(false);
  // Not stamped, so the next tick retries instead of recording this pass as done.
  expect(repos.appState.get().posts_swept_at).toBeNull();

  const ok = await runPostsSweep(repos, {
    client: fakeClient(), now: NOW, maxPosts: 3, batchSize: 200,
  });
  expect(ok.clean).toBe(true);
  expect(repos.appState.get().posts_swept_at).toBe(NOW.toISOString());
});

test('a failed run stamps only its own profiles and leaves their last_swept_at alone', async () => {
  const a = repos.trackedProfiles.add(URL_A, null, 'urls');
  const b = repos.trackedProfiles.add(URL_B, null, 'urls');
  repos.trackedProfiles.markSwept(a.id, '2026-08-04T09:00:00.000Z');   // fresh  -> 24h run
  // b has never been swept -> week run. Only the week run fails.
  const client = fakeClient(
    (url) => [postFor(url, 'urn:li:activity:1', '2026-08-04T08:00:00.000Z')],
    (urls) => (urls.includes(URL_B) ? new Error('run failed') : null),
  );

  const res = await runPostsSweep(repos, { client, now: NOW, maxPosts: 3, batchSize: 200 });
  expect(res.clean).toBe(false);

  // A succeeded and advanced. B recorded the error but did NOT advance — advancing would
  // hand it the narrow 24h window next pass and lose whatever it posted.
  expect(repos.trackedProfiles.findById(a.id)!.last_swept_at).toBe(NOW.toISOString());
  expect(repos.trackedProfiles.findById(b.id)!.last_swept_at).toBeNull();
  expect(repos.trackedProfiles.findById(b.id)!.last_sweep_error).toContain('run failed');
});

test('an auth failure latches the halt; an ordinary failure does not', async () => {
  repos.trackedProfiles.add(URL_A, null, 'urls');

  await runPostsSweep(repos, {
    client: fakeClient(() => [], () => new Error('Apify request failed (HTTP 401)')),
    now: NOW, maxPosts: 3, batchSize: 200,
  });
  expect(repos.appState.get().posts_halted).toBe(1);
  expect(repos.appState.get().posts_halt_reason).toBe('auth');

  repos.appState.clearPostsHalt();
  await runPostsSweep(repos, {
    client: fakeClient(() => [], () => new Error('socket hang up')),
    now: NOW, maxPosts: 3, batchSize: 200,
  });
  // A transient network failure is retried by the next tick, not latched off.
  expect(repos.appState.get().posts_halted).toBe(0);
});

test('the sweep prunes un-engaged posts past the retention window', async () => {
  const a = repos.trackedProfiles.add(URL_A, null, 'urls');
  repos.posts.upsertMany([{
    post_urn: 'urn:li:activity:ancient',
    post_url: 'https://www.linkedin.com/feed/update/urn:li:activity:ancient/',
    tracked_profile_id: a.id, author_name: null, author_headline: null,
    content: 'old', posted_at: '2026-01-01T00:00:00.000Z', is_repost: 0,
    reaction_count: null, comment_count: null, raw_json: null,
  }], '2026-01-01T00:00:00.000Z');

  const res = await runPostsSweep(repos, {
    client: fakeClient(), now: NOW, maxPosts: 3, batchSize: 200, retentionDays: 30,
  });
  expect(res.pruned).toBe(1);
  expect(repos.posts.countAll()).toBe(0);
});

test('unattributed and unusable are counted separately, not folded together', async () => {
  const a = repos.trackedProfiles.add(URL_A, null, 'urls');
  const client = fakeClient(() => [
    postFor(URL_A, 'urn:li:activity:1', '2026-08-04T08:00:00.000Z'),
    // Echoes a profile nobody tracks — in BOTH the primary key and the author fallback, or
    // attribute() would rightly recover it. An attribution problem, and the only one of the
    // three that should ever make someone go and read url.ts.
    postFor('https://www.linkedin.com/in/stranger', 'urn:li:activity:2', '2026-08-04T08:00:00.000Z'),
    // Attributable but wordless — a bare reshare. Routine, and must not be reported as an
    // attribution failure.
    { ...postFor(URL_A, 'urn:li:activity:3', '2026-08-04T08:00:00.000Z'), content: '' },
  ]);

  const res = await runPostsSweep(repos, { client, now: NOW, maxPosts: 3, batchSize: 200 });
  expect(res.postsAdded).toBe(1);
  expect(res.unattributed).toBe(1);
  expect(res.unusable).toBe(1);
  expect(res.postsRejected).toBe(0);
  // Neither is a failure of the pass: the profile is still swept and the pass is still clean.
  expect(res.clean).toBe(true);
  expect(repos.trackedProfiles.findById(a.id)!.last_swept_at).toBe(NOW.toISOString());
});

test('a profile whose stored URL cannot be normalized is reported, never billed for', async () => {
  const bad = repos.trackedProfiles.add('https://example.com/not-linkedin', null, 'urls');
  const client = fakeClient();
  const res = await runPostsSweep(repos, { client, now: NOW, maxPosts: 3, batchSize: 200 });

  // No run at all: whatever came back could not be attributed to it, so paying would buy
  // nothing. And the pass is not clean, so the slot is not stamped as done.
  expect(client.calls).toHaveLength(0);
  expect(res.clean).toBe(false);
  expect(repos.appState.get().posts_swept_at).toBeNull();
  expect(repos.trackedProfiles.findById(bad.id)!.last_sweep_error).toContain('normalized');
});

test('an untracked profile is never swept', async () => {
  const a = repos.trackedProfiles.add(URL_A, null, 'urls');
  repos.trackedProfiles.deactivate(a.id);
  const client = fakeClient();
  const res = await runPostsSweep(repos, { client, now: NOW, maxPosts: 3, batchSize: 200 });
  expect(client.calls).toHaveLength(0);
  expect(res.clean).toBe(true);
});
