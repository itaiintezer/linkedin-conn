import { test, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { FakeDriver } from '../../src/browser/driver.js';
import { buildServer } from '../../src/api/server.js';

/**
 * NO TEST IN THIS FILE MAY MAKE A REAL NETWORK REQUEST.
 *
 * The enqueue path expands lnkd.in shortlinks, which is a genuine outbound fetch, so this
 * follows the precedent set by tests/core/url.test.ts rather than trusting every test to
 * remember to inject a fake: the global is replaced with a spy that throws. A route that
 * reaches for the global instead of the injected fetch cannot quietly reach the internet, and
 * `guard` records the attempt so a test can PROVE the stub bit rather than assuming it.
 */
const guard = vi.fn(() => { throw new Error('a test attempted a real network request'); });
beforeAll(() => { vi.stubGlobal('fetch', guard); });
afterAll(() => { vi.unstubAllGlobals(); });

/**
 * One anchor, every other instant derived from it.
 *
 * Built from LOCAL components on purpose. Planning is local-clock (working hours, weekday
 * rule), so a UTC literal would put the test inside or outside the workday depending on the
 * machine's zone — and mixing a local literal with a UTC one elsewhere in the same test makes
 * assertions pass for the wrong reason. 2026-08-05 is a Wednesday, and 10:00 sits inside the
 * default 08:00-20:00 window in every zone because both are read as local.
 */
const ANCHOR = new Date(2026, 7, 5, 10, 0, 0, 0);
/** ISO strings the DB stores. Derived, never written twice in two forms. */
const iso = (msAgo = 0) => new Date(ANCHOR.getTime() - msAgo).toISOString();

let app: ReturnType<typeof buildServer>;
let repos: Repos;

/** A real share link, copied from LinkedIn. Note "-share-", not "-activity-". */
const SHARE_URL =
  'https://www.linkedin.com/posts/lolly-andreoli-075684b2_youre-invited-to-preview-what-sai-can-do-share-7489401095899770880-VbZT/';
const SHARE_URN = 'urn:li:share:7489401095899770880';
/** The same post, reached the other way. Deduping on the URL would dedupe nothing. */
const FEED_URL = `https://www.linkedin.com/feed/update/${SHARE_URN}/`;
const POST_URL = 'https://www.linkedin.com/feed/update/urn:li:activity:7123456789012345678/';
const POST_URN = 'urn:li:activity:7123456789012345678';

/** A scripted stand-in for fetch. Refuses anything unscripted. */
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

/** Rebuild the server with a specific fetch stand-in (shortlink tests only). */
function serverWith(fetchImpl?: typeof fetch) {
  return buildServer(repos, new FakeDriver(), undefined, undefined, { fetchImpl });
}

beforeEach(() => {
  // Only Date is faked: resolveShortlink arms an AbortSignal.timeout, and faking timers
  // wholesale would leave that signal frozen instead of simply unused.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(ANCHOR);
  guard.mockClear();
  repos = new Repos(openDatabase(':memory:'));
  app = buildServer(repos, new FakeDriver(), undefined, undefined, {
    // Default harness: a fetch that refuses everything. Nothing in the ordinary tests below
    // is a shortlink, so nothing should ever call it.
    fetchImpl: (async () => { throw new Error('unexpected fetch'); }) as unknown as typeof fetch,
  });
  repos.appState.setLogin({ loggedIn: true, cookieExpiry: null }, iso());
});
afterEach(() => { vi.useRealTimers(); });

const post = (url: string, payload: Record<string, unknown> = {}, on = app) =>
  on.inject({ method: 'POST', url, payload });
const get = (url: string, on = app) => on.inject({ method: 'GET', url });

/* ---------- creating one ---------- */

test('creates a reaction-only engagement and defaults the reaction to like', async () => {
  const r = await post('/api/engagements', { post_url: POST_URL });
  expect(r.statusCode).toBe(201);
  const body = r.json();
  expect(body.post_urn).toBe(POST_URN);
  expect(body.post_url).toBe(POST_URL);
  expect(body.reaction).toBe('like');
  expect(body.comment_text).toBeNull();
  expect(repos.engagements.all()).toHaveLength(1);
});

test('creates a reaction + comment engagement', async () => {
  const r = await post('/api/engagements', {
    post_url: SHARE_URL, reaction: 'insightful', comment: 'Congrats!',
  });
  expect(r.statusCode).toBe(201);
  expect(r.json().reaction).toBe('insightful');
  expect(r.json().comment_text).toBe('Congrats!');
  expect(r.json().post_urn).toBe(SHARE_URN);
});

test('the share form and the feed/update form are the same post', async () => {
  const first = await post('/api/engagements', { post_url: SHARE_URL });
  expect(first.statusCode).toBe(201);
  const again = await post('/api/engagements', { post_url: FEED_URL });
  expect(again.statusCode).toBe(409);
  expect(repos.engagements.all()).toHaveLength(1);
});

test('a second engagement on the same post 409s, naming the row that already holds it', async () => {
  const first = (await post('/api/engagements', { post_url: POST_URL })).json();
  const again = await post('/api/engagements', { post_url: POST_URL, reaction: 'love' });
  expect(again.statusCode).toBe(409);
  expect(again.json().error).toContain(String(first.id));
  // The existing row is untouched — no reaction rewritten behind the caller's back.
  expect(repos.engagements.findById(first.id)!.reaction).toBe('like');
});

test('an unknown reaction is a 400 that names it', async () => {
  const r = await post('/api/engagements', { post_url: POST_URL, reaction: 'thumbsup' });
  expect(r.statusCode).toBe(400);
  expect(r.json().error).toBe('unknown reaction: thumbsup');
  expect(repos.engagements.all()).toHaveLength(0);
});

test('a profile URL is not a post', async () => {
  const r = await post('/api/engagements', { post_url: 'https://www.linkedin.com/in/keren' });
  expect(r.statusCode).toBe(400);
  expect(repos.engagements.all()).toHaveLength(0);
});

test('a missing or non-string post_url is a 400, not a crash', async () => {
  expect((await post('/api/engagements', {})).statusCode).toBe(400);
  expect((await post('/api/engagements', { post_url: 42 })).statusCode).toBe(400);
});

test('an over-long comment is refused and says what the limit is', async () => {
  const r = await post('/api/engagements', { post_url: POST_URL, comment: 'x'.repeat(1251) });
  expect(r.statusCode).toBe(400);
  expect(r.json().error).toContain('1250');
  expect(repos.engagements.all()).toHaveLength(0);
  // Exactly at the limit is fine.
  expect((await post('/api/engagements', { post_url: POST_URL, comment: 'x'.repeat(1250) })).statusCode)
    .toBe(201);
});

test('an all-whitespace comment is NO comment, stored as NULL rather than an empty string', async () => {
  const r = await post('/api/engagements', { post_url: POST_URL, comment: '   \n\t ' });
  expect(r.statusCode).toBe(201);
  const row = repos.engagements.findById(r.json().id)!;
  expect(row.comment_text).toBeNull();
});

/* ---------- shortlinks ---------- */

test('a shortlink that resolves is enqueued under the expanded URL', async () => {
  // Scheme-less, which is what a mobile share sheet actually hands over.
  const { impl, calls } = fakeFetch({ 'https://lnkd.in/p/dkTR-yYF': { status: 301, location: SHARE_URL } });
  const r = await post('/api/engagements', { post_url: 'lnkd.in/p/dkTR-yYF' }, serverWith(impl));
  expect(r.statusCode).toBe(201);
  expect(r.json().post_urn).toBe(SHARE_URN);
  expect(r.json().post_url).toBe(FEED_URL);
  expect(calls).toEqual(['https://lnkd.in/p/dkTR-yYF']);
  expect(guard).not.toHaveBeenCalled();
});

test('a shortlink that cannot be expanded tells the caller to paste the full post URL', async () => {
  const { impl } = fakeFetch({ 'https://lnkd.in/dead': { status: 200 } });
  const r = await post('/api/engagements', { post_url: 'https://lnkd.in/dead' }, serverWith(impl));
  expect(r.statusCode).toBe(400);
  expect(r.json().error).toMatch(/full post URL/i);
  expect(repos.engagements.all()).toHaveLength(0);
});

test('a shortlink that lands somewhere other than a post is a plain invalid URL', async () => {
  const { impl } = fakeFetch({
    'https://lnkd.in/prof': { status: 301, location: 'https://www.linkedin.com/in/keren' },
  });
  const r = await post('/api/engagements', { post_url: 'https://lnkd.in/prof' }, serverWith(impl));
  expect(r.statusCode).toBe(400);
  expect(r.json().error).not.toMatch(/full post URL/i);
});

test('the network guard actually bites: with no fetch injected, nothing reaches the internet', async () => {
  // buildServer with no fetchImpl falls through to globalThis.fetch, which this file has
  // replaced with a throwing spy. Proof the guard is load-bearing rather than decorative:
  // the spy WAS called, and the request still degraded to a named reject instead of hanging.
  const r = await post('/api/engagements', { post_url: 'https://lnkd.in/unstubbed' }, serverWith());
  expect(guard).toHaveBeenCalled();
  expect(r.statusCode).toBe(400);
  expect(r.json().error).toMatch(/full post URL/i);
});

test('an ordinary post URL costs no network call at all', async () => {
  const { impl, calls } = fakeFetch({});
  const r = await post('/api/engagements', { post_url: POST_URL }, serverWith(impl));
  expect(r.statusCode).toBe(201);
  expect(calls).toEqual([]);
});

/* ---------- bulk ---------- */

test('bulk creation reports what it added and rejects the rest by name and reason', async () => {
  const { impl } = fakeFetch({ 'https://lnkd.in/p/ok': { status: 301, location: SHARE_URL } });
  const r = await post('/api/engagements', {
    items: [
      { post_url: POST_URL },
      { post_url: 'lnkd.in/p/ok', comment: 'nice' },
      { post_url: 'https://www.linkedin.com/in/keren' },
      { post_url: POST_URL, reaction: 'love' },            // duplicate of the first item
      { post_url: 'https://www.linkedin.com/feed/update/urn:li:activity:711/', reaction: 'thumbsup' },
      { post_url: 'https://www.linkedin.com/feed/update/urn:li:activity:712/', comment: 'y'.repeat(1300) },
    ],
  }, serverWith(impl));
  expect(r.statusCode).toBe(201);
  const body = r.json();
  expect(body.added).toBe(2);
  expect(body.rejected.map((x: { reason: string }) => x.reason))
    .toEqual(['invalid_url', 'duplicate', 'unknown_reaction', 'comment_too_long']);
  // Each reject names the input it is about and carries its own readable message.
  expect(body.rejected[0].post_url).toBe('https://www.linkedin.com/in/keren');
  expect(body.rejected[1].message).toContain(String(body.engagements[0].id));
  expect(body.rejected.every((x: { message: string }) => x.message.length > 0)).toBe(true);
  expect(repos.engagements.all()).toHaveLength(2);
});

test('two items naming the same post in one request produce one row, not two', async () => {
  const r = await post('/api/engagements', {
    items: [{ post_url: SHARE_URL }, { post_url: FEED_URL }],
  });
  expect(r.json().added).toBe(1);
  expect(r.json().rejected[0].reason).toBe('duplicate');
  expect(repos.engagements.all()).toHaveLength(1);
});

test('bulk shortlink expansion is bounded rather than a serial round-trip per item', async () => {
  // Ten shortlinks, one after another at up to 5s each, would hold the handler for most of a
  // minute. Assert the concurrency window instead of trusting it.
  let inFlight = 0; let peak = 0;
  const impl = (async (input: unknown) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await Promise.resolve();                       // yield, so overlap is observable
    inFlight--;
    return {
      status: 301,
      headers: new Headers({ location: `https://www.linkedin.com/feed/update/urn:li:activity:8${String(input).slice(-2)}/` }),
      body: null,
    } as unknown as Response;
  }) as unknown as typeof fetch;

  const items = Array.from({ length: 10 }, (_, i) => ({ post_url: `https://lnkd.in/x${10 + i}` }));
  const r = await post('/api/engagements', { items }, serverWith(impl));
  expect(r.json().added).toBe(10);
  expect(peak).toBeGreaterThan(1);                 // it really is concurrent...
  expect(peak).toBeLessThanOrEqual(4);             // ...and really is capped
});

test('once the expansion budget is spent the rest are named rejects, not more waiting', async () => {
  // Each call pushes the (faked) clock 6s forward, so the 15s budget runs out after three.
  // Whatever is left must degrade to a reject instead of adding more round-trips.
  const impl = (async (input: unknown) => {
    vi.setSystemTime(new Date(Date.now() + 6_000));
    return {
      status: 301,
      headers: new Headers({ location: `https://www.linkedin.com/feed/update/urn:li:activity:9${String(input).slice(-2)}/` }),
      body: null,
    } as unknown as Response;
  }) as unknown as typeof fetch;

  const items = Array.from({ length: 12 }, (_, i) => ({ post_url: `https://lnkd.in/y${10 + i}` }));
  const body = (await post('/api/engagements', { items }, serverWith(impl))).json();
  expect(body.added).toBeGreaterThan(0);
  expect(body.added).toBeLessThan(12);
  expect(body.rejected.length).toBe(12 - body.added);
  expect(body.rejected.every((x: { reason: string }) => x.reason === 'shortlink_unresolvable'))
    .toBe(true);
  expect(body.rejected[0].message).toMatch(/full post URL/i);
});

test('an empty items array is a 400', async () => {
  expect((await post('/api/engagements', { items: [] })).statusCode).toBe(400);
});

/* ---------- planning ---------- */

test('creation schedules the work immediately instead of leaving it unplanned', async () => {
  const r = await post('/api/engagements', { post_url: POST_URL });
  // ANCHOR is a Wednesday 10:00 local, inside the default 08:00-20:00 window, so the planner
  // accepts. The row must not be left `queued` waiting on the hourly tick.
  expect(r.json().status).toBe('scheduled');
  const row = repos.engagements.findById(r.json().id)!;
  expect(row.status).toBe('scheduled');
  expect(row.scheduled_for).not.toBeNull();
  expect(new Date(row.scheduled_for!).getTime()).toBeGreaterThan(ANCHOR.getTime());
});

test('creation while paused leaves the row queued — no way to slip past the gate', async () => {
  repos.settings.update({ paused: 1, pause_reason: 'Manual pause' });
  const r = await post('/api/engagements', { post_url: POST_URL });
  expect(r.json().status).toBe('queued');
});

/* ---------- reading ---------- */

test('GET /api/engagements filters by status and 404s for an unknown id', async () => {
  const a = (await post('/api/engagements', { post_url: POST_URL })).json();
  const b = (await post('/api/engagements', { post_url: SHARE_URL })).json();
  repos.engagements.setStatus(b.id, 'failed', { last_error: 'boom' });

  const all = (await get('/api/engagements')).json();
  expect(all).toHaveLength(2);

  const failed = (await get('/api/engagements?status=failed')).json();
  expect(failed.map((e: { id: number }) => e.id)).toEqual([b.id]);

  expect((await get(`/api/engagements/${a.id}`)).json().post_urn).toBe(POST_URN);
  expect((await get('/api/engagements/99999')).statusCode).toBe(404);
  // A status the engine doesn't know is a 400, not a silently-empty "filtered" list.
  expect((await get('/api/engagements?status=nonsense')).statusCode).toBe(400);
  // Inherited Object members are not statuses. `'toString' in obj` is TRUE, so a membership
  // test written with `in` would wave these through and then return an empty list — a filter
  // reporting "no rows have this status" about a status that does not exist.
  for (const bad of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
    expect((await get(`/api/engagements?status=${bad}`)).statusCode, bad).toBe(400);
  }
});

test('?limit= returns the NEWEST rows and cannot be coerced into something nonsensical', async () => {
  const ids: number[] = [];
  for (const n of ['711', '712', '713']) {
    ids.push((await post('/api/engagements', {
      post_url: `https://www.linkedin.com/feed/update/urn:li:activity:${n}/`,
    })).json().id);
  }
  const two = (await get('/api/engagements?limit=2')).json();
  expect(two.map((e: { id: number }) => e.id)).toEqual([ids[2], ids[1]]);

  for (const bad of ['abc', '-5', '0', '1e9999', '', 'NaN']) {
    const r = await get(`/api/engagements?limit=${bad}`);
    expect(r.statusCode, `limit=${bad}`).toBe(200);
    expect(r.json().length, `limit=${bad}`).toBe(3);
  }
});

/* ---------- retry / dismiss ---------- */

test('retry re-queues a needs_attention row and clears its error', async () => {
  const e = (await post('/api/engagements', { post_url: POST_URL })).json();
  repos.engagements.setStatus(e.id, 'needs_attention', {
    last_error: 'interrupted mid-comment', scheduled_for: null,
  });
  const r = await post(`/api/engagements/${e.id}/retry`);
  expect(r.statusCode).toBe(200);
  const row = repos.engagements.findById(e.id)!;
  expect(row.status).toBe('queued');
  expect(row.last_error).toBeNull();
  expect(row.skip_reason).toBeNull();
  expect(row.scheduled_for).toBeNull();
});

test('retry works for failed and skipped too, and 404s for an unknown id', async () => {
  for (const [n, status] of [['721', 'failed'], ['722', 'skipped']] as const) {
    const e = (await post('/api/engagements', {
      post_url: `https://www.linkedin.com/feed/update/urn:li:activity:${n}/`,
    })).json();
    repos.engagements.setStatus(e.id, status, { last_error: 'x', skip_reason: 'unavailable' });
    expect((await post(`/api/engagements/${e.id}/retry`)).statusCode, status).toBe(200);
    expect(repos.engagements.findById(e.id)!.status).toBe('queued');
  }
  expect((await post('/api/engagements/99999/retry')).statusCode).toBe(404);
});

test('retry refuses a status that would re-engage a post', async () => {
  const e = (await post('/api/engagements', { post_url: POST_URL })).json();
  for (const status of ['sent', 'sending', 'queued', 'scheduled'] as const) {
    repos.engagements.setStatus(e.id, status);
    const r = await post(`/api/engagements/${e.id}/retry`);
    expect(r.statusCode, status).toBe(409);
    expect(r.json().error).toContain(status);
    expect(repos.engagements.findById(e.id)!.status).toBe(status);
  }
});

test('dismiss terminates a queued row with skip_reason dismissed', async () => {
  const e = (await post('/api/engagements', { post_url: POST_URL })).json();
  expect(repos.engagements.findById(e.id)!.status).toBe('scheduled');
  const r = await post(`/api/engagements/${e.id}/dismiss`);
  expect(r.statusCode).toBe(200);
  const row = repos.engagements.findById(e.id)!;
  expect(row.status).toBe('skipped');
  expect(row.skip_reason).toBe('dismissed');
  expect(row.scheduled_for).toBeNull();     // must not linger in "next scheduled"
  expect((await post('/api/engagements/99999/dismiss')).statusCode).toBe(404);
});

/* ---------- settings ---------- */

test('the four engagement settings are readable and writable', async () => {
  const s = (await get('/api/settings')).json();
  expect(s.engage_weekly_cap).toBe(500);
  expect(s.engage_batch_size).toBe(15);
  expect(s.engage_batches_per_day).toBe(6);
  expect(s.engage_comment_daily_cap).toBe(10);

  const updated = (await post('/api/settings', {
    engage_weekly_cap: 200, engage_batch_size: 4,
    engage_batches_per_day: 2, engage_comment_daily_cap: 3,
  })).json();
  expect(updated.engage_weekly_cap).toBe(200);
  expect(updated.engage_batch_size).toBe(4);
  expect(updated.engage_batches_per_day).toBe(2);
  expect(updated.engage_comment_daily_cap).toBe(3);
});

/* ---------- what the dashboard reads ---------- */

test('/api/status carries an engagements block, and it is quiet when unused', async () => {
  const fresh = (await get('/api/status')).json().engagements;
  expect(fresh.counts).toEqual({});
  expect(fresh.weekly_used).toBe(0);
  expect(fresh.weekly_cap).toBe(500);
  expect(fresh.weekly_remaining).toBe(500);
  expect(fresh.comments_today).toBe(0);
  expect(fresh.comment_daily_cap).toBe(10);
  // NOT an estimate. An unplanned queue must be able to render as "not scheduled".
  expect(fresh.next_scheduled).toBeNull();
});

test('/api/status reports real usage and the earliest genuine scheduled instant', async () => {
  const a = (await post('/api/engagements', { post_url: POST_URL })).json();
  const b = (await post('/api/engagements', { post_url: SHARE_URL, comment: 'hi' })).json();

  // Both derived from the one anchor: an hour ago (inside today AND inside the week).
  repos.engagements.setStatus(a.id, 'sent', { reacted_at: iso(60 * 60 * 1000) });
  repos.engagements.setStatus(b.id, 'sent', {
    reacted_at: iso(60 * 60 * 1000), commented_at: iso(60 * 60 * 1000),
  });
  const used = (await get('/api/status')).json().engagements;
  expect(used.counts.sent).toBe(2);
  expect(used.weekly_used).toBe(2);
  expect(used.weekly_remaining).toBe(498);
  expect(used.comments_today).toBe(1);
  expect(used.next_scheduled).toBeNull();   // both are done; nothing is scheduled

  const c = (await post('/api/engagements', {
    post_url: 'https://www.linkedin.com/feed/update/urn:li:activity:733/',
  })).json();
  const later = (await get('/api/status')).json().engagements;
  expect(later.next_scheduled).toBe(repos.engagements.findById(c.id)!.scheduled_for);
  expect(new Date(later.next_scheduled).getTime()).toBeGreaterThan(ANCHOR.getTime());
});

test('/api/attention tags rows with the pipeline they came from', async () => {
  const cohort = repos.cohorts.create('Attn', null, true);
  const p = repos.profiles.add(cohort.id, 'https://www.linkedin.com/in/attn', null);
  repos.profiles.setStatus(p.id, 'failed', { last_error: 'boom' });

  const e = (await post('/api/engagements', { post_url: POST_URL, comment: 'hi' })).json();
  repos.engagements.setStatus(e.id, 'needs_attention', {
    last_error: 'interrupted mid-comment', scheduled_for: null,
  });
  // A healthy engagement must not show up.
  await post('/api/engagements', { post_url: SHARE_URL });

  const rows = (await get('/api/attention')).json() as Record<string, unknown>[];
  expect(rows).toHaveLength(2);
  expect(rows.map((r) => r.source).sort()).toEqual(['engagement', 'profile']);
  const eng = rows.find((r) => r.source === 'engagement')!;
  expect(eng.id).toBe(e.id);
  expect(eng.post_url).toBe(POST_URL);
  expect(eng.status).toBe('needs_attention');
  expect(eng.last_error).toBe('interrupted mid-comment');
  const prof = rows.find((r) => r.source === 'profile')!;
  expect(prof.profile_url).toBe('https://www.linkedin.com/in/attn');
  expect(prof.kind).toBe('invite');
});
