/**
 * One sweep pass. A FakeApifyPostsClient throughout — nothing here can spend money.
 *
 * The window-derivation tests are the important ones: the window is the cost model, not a
 * filter, and widening it silently multiplies the Apify bill. Several tests assert the
 * PAIRING of a URL to the window its run was sent with, rather than just the set of windows
 * used — a swap between the two preserves the set and costs ~20x.
 */
import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { runPostsSweep, windowFor, isPostsSweepRunning } from '../../src/worker/posts-sweep.js';
import { ApifyRequestError } from '../../src/core/apify-posts-client.js';
import type { ApifyPostsClient, FetchPostsOptions } from '../../src/core/apify-posts-client.js';
import type { ApifyPost } from '../../src/types.js';

let repos: Repos;
const NOW = new Date('2026-08-04T10:00:00.000Z');

beforeEach(() => { repos = new Repos(openDatabase(':memory:')); });

const URL_A = 'https://www.linkedin.com/in/dana';
const URL_B = 'https://www.linkedin.com/in/marcus';

type Call = { urls: string[]; opts: FetchPostsOptions };

/** Records every call so the batching and window choices can be asserted precisely. */
function fakeClient(
  postsFor: (url: string) => ApifyPost[] = () => [],
  fail?: (urls: string[]) => Error | null,
): ApifyPostsClient & { calls: Call[] } {
  const calls: Call[] = [];
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

/** The one run that carried this URL — so a URL can be asserted against ITS OWN window. */
const callFor = (calls: Call[], url: string): Call => {
  const found = calls.filter((c) => c.urls.includes(url));
  expect(found).toHaveLength(1);
  return found[0];
};

const postFor = (url: string, urn: string, postedAt: string): ApifyPost => ({
  id: urn,
  linkedinUrl: `https://www.linkedin.com/feed/update/${urn}/`,
  content: `A post from ${url}`,
  postedAt: { timestamp: new Date(postedAt).getTime() },
  author: { name: 'Someone', linkedinUrl: url, position: 'Engineer' },
  engagement: { likes: 3, comments: 1 },
  query: { targetUrl: url },
});

test('windowFor bounds a swept profile on its own last_swept_at, exactly', () => {
  // Never swept: a bounded first look is the only option, and it is what gives a newly-tracked
  // profile content at all — this replaced the rejected backfill mechanism.
  expect(windowFor(null, NOW)).toEqual({ postedLimit: 'week' });

  // Swept before: the exact instant, so there is no gap and nothing re-fetched. Age is
  // irrelevant — the bill for any one run is capped by maxItems regardless of window width.
  expect(windowFor('2026-08-04T09:00:00.000Z', NOW)).toEqual({ postedLimitDate: '2026-08-04T09:00:00.000Z' });
  expect(windowFor('2026-08-02T09:00:00.000Z', NOW)).toEqual({ postedLimitDate: '2026-08-02T09:00:00.000Z' });

  // THE REGRESSION. Consecutive passes land 24h + δ apart, because daySlot(now, 1) keys on the
  // calendar date and the pass fires on the first tick after midnight. The old
  // `age <= 24h ? '24h' : 'week'` therefore chose 'week' essentially every time, which is the
  // design's own $1.60/mo -> $36/mo. Nothing here may depend on δ.
  expect(windowFor('2026-08-03T09:59:59.999Z', NOW)).toEqual({ postedLimitDate: '2026-08-03T09:59:59.999Z' });
  expect(windowFor('2026-08-03T10:00:00.000Z', NOW)).toEqual({ postedLimitDate: '2026-08-03T10:00:00.000Z' });

  // Neither of these can bound a run, so they take the bounded look rather than being sent as
  // a date the actor would reject or misread.
  expect(windowFor('not a date', NOW)).toEqual({ postedLimit: 'week' });
  expect(windowFor('2026-08-05T10:00:00.000Z', NOW)).toEqual({ postedLimit: 'week' });
});

test('windowFor refuses a parseable-but-wrong stamp, not just an unparseable one', () => {
  // THE DANGEROUS CASE, and the reason the gate is a shape test rather than `new Date` being
  // finite: every string here parses. The zone-less ones would be read as LOCAL by the age
  // check and in the ACTOR's zone as the run bound, so a UTC+3 operator would get a silent
  // multi-hour gap — a window that looks completely fine from here. The value is forwarded
  // verbatim to a paid actor, so anything but the exact toISOString() shape takes the
  // bounded look instead.
  for (const parseable of [
    '2026-08-04 09:00:00',        // zone-less, space-separated (SQLite datetime('now')'s shape)
    '2026-08-04T09:00:00',        // zone-less, T-separated — local per ECMA-262, not UTC
    '2026-08-04',                 // date only: silently means midnight
    'August 4, 2026 09:00',       // implementation-defined, and not UTC
    '2026-08-04T09:00:00Z',       // right idea, no milliseconds — still not the pinned shape
  ]) {
    expect(windowFor(parseable, NOW)).toEqual({ postedLimit: 'week' });
  }
  // Correctly SHAPED but an impossible date, so the shape gate alone is not enough: this
  // parses to NaN and must not be forwarded either.
  expect(windowFor('2026-13-45T00:00:00.000Z', NOW)).toEqual({ postedLimit: 'week' });
});

test('a sweep issues one run per window and pairs each profile with its OWN window', async () => {
  const a = repos.trackedProfiles.add(URL_A, null, 'urls');
  const b = repos.trackedProfiles.add(URL_B, null, 'search');
  // A was swept before, B never — so two windows, two runs.
  repos.trackedProfiles.markSwept(a.id, '2026-08-04T09:00:00.000Z');

  const client = fakeClient((url) => [
    postFor(url, `urn:li:activity:${url.endsWith('dana') ? 1 : 2}`, '2026-08-04T08:00:00.000Z'),
  ]);
  const res = await runPostsSweep(repos, { client, now: NOW, maxPosts: 3, batchSize: 200 });

  expect(res.postsAdded).toBe(2);
  expect(res.clean).toBe(true);
  expect(client.calls).toHaveLength(2);
  // The pairing, not just the set: swapping the two windows would keep the set identical.
  expect(callFor(client.calls, URL_A).opts).toEqual({
    maxPosts: 3, postedLimitDate: '2026-08-04T09:00:00.000Z',
  });
  expect(callFor(client.calls, URL_B).opts).toEqual({ maxPosts: 3, postedLimit: 'week' });
  // Both swept, nothing dropped in the grouping.
  expect(res.profilesSwept).toBe(2);
  expect(repos.trackedProfiles.findById(b.id)!.last_swept_at).toBe(NOW.toISOString());
});

test('profiles swept in the same pass share a stamp, so the next pass is ONE run', async () => {
  repos.trackedProfiles.add(URL_A, null, 'urls');
  repos.trackedProfiles.add(URL_B, null, 'urls');

  // First pass: both never-swept, so both take the bounded look, and both get the same stamp.
  const first = fakeClient();
  await runPostsSweep(repos, { client: first, now: NOW, maxPosts: 3, batchSize: 200 });
  expect(first.calls).toHaveLength(1);

  // Second pass: keying the group on a timestamp does NOT fragment batching, because
  // markSwept stamped both with the same nowIso.
  const later = new Date('2026-08-05T10:00:00.000Z');
  const second = fakeClient();
  await runPostsSweep(repos, { client: second, now: later, maxPosts: 3, batchSize: 200 });
  expect(second.calls).toHaveLength(1);
  expect(second.calls[0].urls.sort()).toEqual([URL_A, URL_B].sort());
  expect(second.calls[0].opts).toEqual({ maxPosts: 3, postedLimitDate: NOW.toISOString() });
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
  // A failed run is still an attempted run: `runs` tracks what Apify was asked to bill for.
  expect(bad.runs).toBe(1);
  expect(bad.profilesSwept).toBe(0);
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
  repos.trackedProfiles.markSwept(a.id, '2026-08-04T09:00:00.000Z');   // swept -> exact-date run
  // b has never been swept -> bounded-look run. Only that one fails.
  const client = fakeClient(
    (url) => [postFor(url, 'urn:li:activity:1', '2026-08-04T08:00:00.000Z')],
    (urls) => (urls.includes(URL_B) ? new Error('run failed') : null),
  );

  const res = await runPostsSweep(repos, { client, now: NOW, maxPosts: 3, batchSize: 200 });
  expect(res.clean).toBe(false);

  // A succeeded and advanced. B recorded the error but did NOT advance — advancing would
  // bound its next window on a sweep it never received and lose whatever it posted.
  expect(repos.trackedProfiles.findById(a.id)!.last_swept_at).toBe(NOW.toISOString());
  expect(repos.trackedProfiles.findById(b.id)!.last_swept_at).toBeNull();
  expect(repos.trackedProfiles.findById(b.id)!.last_sweep_error).toContain('run failed');
});

test('one failing chunk marks only ITS profiles, not the whole window', async () => {
  // Four profiles in one window, split into two chunks of two. Marking `members` instead of
  // `batch` would sweep p2/p3 on the strength of p0/p1's run — the swept-but-never-fetched bug.
  const ids = [0, 1, 2, 3].map((i) => repos.trackedProfiles.add(`https://www.linkedin.com/in/p${i}`, null, 'urls'));
  const client = fakeClient(
    () => [],
    (urls) => (urls.includes('https://www.linkedin.com/in/p2') ? new Error('second chunk failed') : null),
  );

  const res = await runPostsSweep(repos, { client, now: NOW, maxPosts: 3, batchSize: 2 });
  expect(client.calls).toHaveLength(2);
  expect(res.clean).toBe(false);
  expect(res.profilesSwept).toBe(2);

  expect(repos.trackedProfiles.findById(ids[0].id)!.last_swept_at).toBe(NOW.toISOString());
  expect(repos.trackedProfiles.findById(ids[1].id)!.last_swept_at).toBe(NOW.toISOString());
  expect(repos.trackedProfiles.findById(ids[2].id)!.last_swept_at).toBeNull();
  expect(repos.trackedProfiles.findById(ids[3].id)!.last_swept_at).toBeNull();
  expect(repos.trackedProfiles.findById(ids[3].id)!.last_sweep_error).toContain('second chunk failed');
});

test('an auth failure latches the halt and attempts no further run', async () => {
  const a = repos.trackedProfiles.add(URL_A, null, 'urls');
  const b = repos.trackedProfiles.add(URL_B, null, 'urls');
  // Two windows, so there IS a second run to skip.
  repos.trackedProfiles.markSwept(a.id, '2026-08-04T09:00:00.000Z');

  const client = fakeClient(
    () => [],
    () => new ApifyRequestError('Apify run start failed (HTTP 401) at /v2/acts/x/runs', 401, false),
  );
  const res = await runPostsSweep(repos, { client, now: NOW, maxPosts: 3, batchSize: 200 });

  expect(repos.appState.get().posts_halted).toBe(1);
  expect(repos.appState.get().posts_halt_reason).toBe('auth');
  // Apify's own message is passed through: a 403 is a bad key OR a spent budget, and only the
  // body says which.
  expect(repos.appState.get().posts_halt_detail).toContain('HTTP 401');
  // Bailed out rather than working through every remaining window at the same cost.
  expect(client.calls).toHaveLength(1);
  expect(res.runs).toBe(1);
  expect(b.id).toBeGreaterThan(a.id);
});

test('an auth halt still prunes, and keeps its own reason', async () => {
  const a = repos.trackedProfiles.add(URL_A, null, 'urls');
  repos.posts.upsertMany([{
    post_urn: 'urn:li:activity:ancient',
    post_url: 'https://www.linkedin.com/feed/update/urn:li:activity:ancient/',
    tracked_profile_id: a.id, author_name: null, author_headline: null,
    content: 'old', posted_at: '2026-01-01T00:00:00.000Z', is_repost: 0,
    reaction_count: null, comment_count: null, raw_json: null,
  }], '2026-01-01T00:00:00.000Z');
  // Pre-set the error so the run_failed latch's own conditions ALL hold on this pass — that is
  // the trap: falling through to reach the prune must not let run_failed overwrite 'auth'.
  repos.trackedProfiles.markSweepError(a.id, 'earlier failure');

  const res = await runPostsSweep(repos, {
    client: fakeClient(() => [], () => new ApifyRequestError('Apify run start failed (HTTP 403)', 403, false)),
    now: NOW, maxPosts: 3, batchSize: 200, retentionDays: 30,
  });

  // Ageing out is the only way a post leaves the New chip, and a latched halt stops the tick
  // from calling this worker at all — so an early return here would freeze the feed until an
  // operator fixed the key.
  expect(res.pruned).toBe(1);
  expect(repos.posts.countAll()).toBe(0);
  // The specific latch wins. Overwriting it with run_failed would throw away the Apify message
  // that distinguishes a spent budget from a bad key.
  expect(repos.appState.get().posts_halt_reason).toBe('auth');
  expect(repos.appState.get().posts_halt_detail).toContain('HTTP 403');
  // Still not a clean pass, so the slot is not stamped.
  expect(res.clean).toBe(false);
  expect(repos.appState.get().posts_swept_at).toBeNull();
});

test('an ordinary failure does not latch', async () => {
  repos.trackedProfiles.add(URL_A, null, 'urls');

  await runPostsSweep(repos, {
    client: fakeClient(() => [], () => new Error('socket hang up')),
    now: NOW, maxPosts: 3, batchSize: 200,
  });
  // A transient network failure is retried by the next tick, not latched off. (A SECOND such
  // pass does latch — see the run_failed test — so this must be a single pass to isolate.)
  expect(repos.appState.get().posts_halted).toBe(0);
});

test('a 5xx whose body merely quotes 401 does not latch auth', async () => {
  repos.trackedProfiles.add(URL_A, null, 'urls');

  // The auth check is structural, on `status`. An upstream gateway page is folded into the
  // message (up to 500 chars of it), so a 502 whose body merely QUOTES "HTTP 401" must not
  // stop automatic sweeping — that would be a silent stop caused by a transient blip, and it
  // is exactly what a regex over the message did.
  await runPostsSweep(repos, {
    client: fakeClient(() => [], () => new ApifyRequestError(
      'Apify poll failed (HTTP 502) at /v2/actor-runs/x: <html>upstream said HTTP 401</html>', 502, true,
    )),
    now: NOW, maxPosts: 3, batchSize: 200,
  });
  expect(repos.appState.get().posts_halted).toBe(0);
  expect(repos.appState.get().posts_halt_reason).toBeNull();
});

test('two consecutive fully-failed passes latch run_failed, so failed runs stop billing', async () => {
  repos.trackedProfiles.add(URL_A, null, 'urls');
  const boom = (): ApifyPostsClient & { calls: Call[] } =>
    fakeClient(() => [], () => new Error('run ended FAILED'));

  // One failed pass is ordinary — an Apify blip must self-heal without an operator.
  const first = await runPostsSweep(repos, { client: boom(), now: NOW, maxPosts: 3, batchSize: 200 });
  expect(first.clean).toBe(false);
  expect(repos.appState.get().posts_halted).toBe(0);

  // Twice over, with every run failing, means the tick would otherwise retry every 30 minutes
  // forever — and a run that starts, bills, then fails has already been charged.
  const second = await runPostsSweep(repos, { client: boom(), now: NOW, maxPosts: 3, batchSize: 200 });
  expect(second.clean).toBe(false);
  expect(repos.appState.get().posts_halted).toBe(1);
  expect(repos.appState.get().posts_halt_reason).toBe('run_failed');
});

test('a pass that partly succeeds never latches run_failed', async () => {
  const a = repos.trackedProfiles.add(URL_A, null, 'urls');
  const b = repos.trackedProfiles.add(URL_B, null, 'urls');
  repos.trackedProfiles.markSwept(a.id, '2026-08-04T09:00:00.000Z');
  // Put both profiles in the previously-errored state the latch keys on.
  repos.trackedProfiles.markSweepError(a.id, 'earlier failure');
  repos.trackedProfiles.markSweepError(b.id, 'earlier failure');

  // Only B's window fails, so this pass swept somebody — evidence Apify still works.
  const client = fakeClient(() => [], (urls) => (urls.includes(URL_B) ? new Error('run failed') : null));
  const res = await runPostsSweep(repos, { client, now: NOW, maxPosts: 3, batchSize: 200 });

  expect(res.profilesSwept).toBe(1);
  expect(res.clean).toBe(false);
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

test('a failing prune still returns the pass that already happened', async () => {
  repos.trackedProfiles.add(URL_A, null, 'urls');
  repos.posts.prune = () => { throw new Error('database is locked'); };

  // The runs are done and last_swept_at is already advanced by this point, so throwing out of
  // the call would lose the result while keeping the writes.
  const res = await runPostsSweep(repos, { client: fakeClient(), now: NOW, maxPosts: 3, batchSize: 200 });
  expect(res.pruned).toBe(0);
  // A local DB failure must not re-run the whole billable sweep on the next tick.
  expect(res.clean).toBe(true);
  expect(repos.appState.get().posts_swept_at).toBe(NOW.toISOString());
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

test('a batch where EVERY item is unattributable fails rather than reporting health', async () => {
  const a = repos.trackedProfiles.add(URL_A, null, 'urls');
  // The signature of a systematic mismatch between what we send and what the actor echoes.
  // Billed in full, stores nothing — so it must not mark the profile swept and pass clean.
  const client = fakeClient(() => [
    postFor('https://www.linkedin.com/in/stranger', 'urn:li:activity:1', '2026-08-04T08:00:00.000Z'),
    postFor('https://www.linkedin.com/in/other', 'urn:li:activity:2', '2026-08-04T08:00:00.000Z'),
  ]);

  const res = await runPostsSweep(repos, { client, now: NOW, maxPosts: 3, batchSize: 200 });
  expect(res.clean).toBe(false);
  expect(res.unattributed).toBe(2);
  expect(res.profilesSwept).toBe(0);
  expect(repos.trackedProfiles.findById(a.id)!.last_swept_at).toBeNull();
  expect(repos.trackedProfiles.findById(a.id)!.last_sweep_error).toContain('attribution is broken');
  expect(repos.appState.get().posts_swept_at).toBeNull();
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

test('two rows that normalize to one URL are not both swept off one run', async () => {
  // The UNIQUE constraint is case- and slash-sensitive; normalizeProfileUrl is neither, and
  // TrackedProfileRepo.add does not normalize. So both rows can exist.
  const first = repos.trackedProfiles.add('https://www.linkedin.com/in/Dana', null, 'urls');
  const shadow = repos.trackedProfiles.add('https://www.linkedin.com/in/dana/', null, 'urls');
  const client = fakeClient();

  const res = await runPostsSweep(repos, { client, now: NOW, maxPosts: 3, batchSize: 200 });

  // The URL is sent ONCE, not twice with maxItems doubled for the same profile.
  expect(client.calls).toHaveLength(1);
  expect(client.calls[0].urls).toEqual([URL_A]);
  // And the shadow row is visibly broken rather than permanently empty and permanently healthy.
  expect(res.clean).toBe(false);
  expect(repos.trackedProfiles.findById(first.id)!.last_swept_at).toBe(NOW.toISOString());
  expect(repos.trackedProfiles.findById(shadow.id)!.last_swept_at).toBeNull();
  expect(repos.trackedProfiles.findById(shadow.id)!.last_sweep_error).toContain('duplicate');
});

test('an overlapping sweep is refused rather than double-billing the same profiles', async () => {
  repos.trackedProfiles.add(URL_A, null, 'urls');
  // Hold the first pass open inside the actor call, where a real sweep spends its minutes.
  let release = (): void => {};
  const gate = new Promise<void>((r) => { release = r; });
  const slow: ApifyPostsClient = { async fetchPosts() { await gate; return []; } };

  const inFlight = runPostsSweep(repos, { client: slow, now: NOW, maxPosts: 3, batchSize: 200 });
  expect(isPostsSweepRunning()).toBe(true);

  // The manual sweep-now route relies on this to answer 409 instead of starting a second run.
  const second = fakeClient();
  await expect(runPostsSweep(repos, { client: second, now: NOW, maxPosts: 3, batchSize: 200 }))
    .rejects.toThrow(/already running/);
  expect(second.calls).toHaveLength(0);
  // And the refused call must not have cleared the flag out from under the pass that owns it.
  expect(isPostsSweepRunning()).toBe(true);

  release();
  await inFlight;
  expect(isPostsSweepRunning()).toBe(false);
});

test('an untracked profile is never swept', async () => {
  const a = repos.trackedProfiles.add(URL_A, null, 'urls');
  repos.trackedProfiles.deactivate(a.id);
  const client = fakeClient();
  const res = await runPostsSweep(repos, { client, now: NOW, maxPosts: 3, batchSize: 200 });
  expect(client.calls).toHaveLength(0);
  expect(res.clean).toBe(true);
});
