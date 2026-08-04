// @vitest-environment jsdom
/// <reference lib="dom" />
/**
 * The Posts screen, against the REAL index.html and the REAL posts.js — so element ids and
 * structure are the ones the browser sees, not hand-rolled stubs. Same reasoning as the other
 * tests/web suites.
 */
import { test, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadApp, type AppInternals } from './helpers/load-app.js';

let internals: AppInternals;
const realFetch = globalThis.fetch;

const feedPayload = (over: Record<string, unknown> = {}) => ({
  posts: [
    {
      id: 1, post_urn: 'urn:li:activity:1',
      post_url: 'https://www.linkedin.com/feed/update/urn:li:activity:1/',
      author_display: 'Dana Reingold', headline_display: 'VP Security',
      content: 'Alert triage is an ownership problem.',
      posted_at: '2026-08-03T09:00:00.000Z', is_repost: 0,
      engagement_status: null, engagement_reaction: null, engagement_reacted_at: null,
    },
    {
      id: 2, post_urn: 'urn:li:activity:2',
      post_url: 'https://www.linkedin.com/feed/update/urn:li:activity:2/',
      author_display: 'Marcus Oyelaran', headline_display: 'CISO',
      content: 'We ran a tabletop.', posted_at: '2026-08-02T09:00:00.000Z', is_repost: 1,
      engagement_status: 'scheduled', engagement_reaction: 'insightful',
      engagement_reacted_at: null,
    },
  ],
  filter: 'new',
  counts: { new: 23, queued: 4, engaged: 61 },
  next_cursor: null,
  tracked: 187,
  swept_at: '2026-08-04T09:20:00.000Z',
  cost_30d: { posts: 640, usd: 1.28 },
  ...over,
});

beforeEach(() => { internals = loadApp(); });
afterEach(() => { vi.unstubAllGlobals(); globalThis.fetch = realFetch; });

test('renders one card per post, newest first, with author and body', () => {
  internals.renderPostsFeed(feedPayload());
  const cards = document.querySelectorAll('#postsFeed .post-card');
  expect(cards).toHaveLength(2);
  expect(cards[0].querySelector('.post-name')!.textContent).toBe('Dana Reingold');
  expect(cards[0].querySelector('.post-body')!.textContent)
    .toBe('Alert triage is an ownership problem.');
});

test('post text is inserted as text, never as HTML', () => {
  // Post content is attacker-influenced: it is whatever a tracked person typed on LinkedIn.
  internals.renderPostsFeed(feedPayload({
    posts: [{ ...feedPayload().posts[0], content: '<img src=x onerror="window.__xss=1">' }],
  }));
  expect(document.querySelector('#postsFeed img')).toBeNull();
  expect(document.querySelector('.post-body')!.textContent)
    .toBe('<img src=x onerror="window.__xss=1">');
});

test('author name and headline are text too, not markup', () => {
  // The same third party controls these: they arrive from the scrape, not from our DB.
  internals.renderPostsFeed(feedPayload({
    posts: [{
      ...feedPayload().posts[0],
      author_display: '<b>Dana</b>', headline_display: '<i>VP</i>',
    }],
  }));
  expect(document.querySelector('#postsFeed b')).toBeNull();
  expect(document.querySelector('#postsFeed i')).toBeNull();
  expect(document.querySelector('.post-name')!.textContent).toBe('<b>Dana</b>');
});

test('chip counts render and the active chip reflects the filter', () => {
  internals.renderPostsFeed(feedPayload());
  expect(document.querySelector('[data-count="new"]')!.textContent).toBe('23');
  expect(document.querySelector('[data-count="engaged"]')!.textContent).toBe('61');
  const active = document.querySelector('.posts-chip.is-active') as HTMLElement;
  expect(active.dataset.filter).toBe('new');
});

test('a queued post shows its engagement status and offers no Queue button', () => {
  internals.renderPostsFeed(feedPayload());
  const second = document.querySelectorAll('#postsFeed .post-card')[1];
  expect(second.querySelector('.pill')!.textContent!.toLowerCase()).toContain('scheduled');
  expect(second.querySelector('[data-act="queue"]')).toBeNull();
  // A new post does offer one.
  const first = document.querySelectorAll('#postsFeed .post-card')[0];
  expect(first.querySelector('[data-act="queue"]')).not.toBeNull();
});

test('a failed engagement with no reaction is back in New, and re-queueable', () => {
  // Mirrors FILTER_SQL: failed/skipped without a reaction return to `new` so they retry.
  internals.renderPostsFeed(feedPayload({
    posts: [{
      ...feedPayload().posts[0],
      engagement_status: 'failed', engagement_reaction: 'like', engagement_reacted_at: null,
    }],
  }));
  const card = document.querySelector('.post-card')!;
  expect(card.querySelector('[data-act="queue"]')).not.toBeNull();
});

test('a reaction that landed outranks the status', () => {
  // `needs_attention` with a reaction is `engaged`, not `queued`: the reaction is a fact.
  internals.renderPostsFeed(feedPayload({
    posts: [{
      ...feedPayload().posts[0],
      engagement_status: 'needs_attention', engagement_reaction: 'like',
      engagement_reacted_at: '2026-08-04T08:00:00.000Z',
    }],
  }));
  const card = document.querySelector('.post-card')!;
  expect(card.querySelector('[data-act="queue"]')).toBeNull();
});

test('a repost is labelled', () => {
  internals.renderPostsFeed(feedPayload());
  const second = document.querySelectorAll('#postsFeed .post-card')[1];
  expect(second.querySelector('.post-repost')).not.toBeNull();
});

test('the status strip shows tracked count, last sweep and the cost readout', () => {
  internals.renderPostsFeed(feedPayload());
  const strip = document.getElementById('postsStatus')!.textContent!;
  expect(strip).toContain('187');
  expect(strip).toMatch(/1\.28/);
});

test('the empty state shows only when there are no posts', () => {
  internals.renderPostsFeed(feedPayload({ posts: [], counts: { new: 0, queued: 0, engaged: 0 } }));
  expect(document.getElementById('postsEmpty')!.hidden).toBe(false);
  internals.renderPostsFeed(feedPayload());
  expect(document.getElementById('postsEmpty')!.hidden).toBe(true);
});

test('the empty state says something true for the filter being looked at', () => {
  // "Track some profiles, then sweep" is a lie on the Engaged chip of a working install.
  internals.renderPostsFeed(feedPayload({ posts: [], filter: 'engaged', tracked: 187 }));
  expect(document.getElementById('postsEmpty')!.textContent!.toLowerCase())
    .not.toContain('track some profiles');
  internals.renderPostsFeed(feedPayload({ posts: [], filter: 'new', tracked: 0 }));
  expect(document.getElementById('postsEmpty')!.textContent!.toLowerCase())
    .toContain('track');
});

test('Load more shows only when the server reported another page', () => {
  internals.renderPostsFeed(feedPayload({ next_cursor: null }));
  expect((document.getElementById('postsMore') as HTMLButtonElement).hidden).toBe(true);
  internals.renderPostsFeed(feedPayload({ next_cursor: '2026-08-02T09:00:00.000Z|2' }));
  expect((document.getElementById('postsMore') as HTMLButtonElement).hidden).toBe(false);
});

test('a halted sweep shows the banner with its reason', () => {
  internals.renderPostsFeed(feedPayload({
    halt: { halted: 1, reason: 'auth', detail: 'Apify rejected the API key' },
  }));
  const banner = document.getElementById('postsHalt')!;
  expect(banner.hidden).toBe(false);
  expect(banner.textContent).toContain('Apify rejected the API key');
});

test('clicking a chip refetches with that filter', async () => {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => feedPayload({ filter: 'engaged' }) } as Response;
  }));
  internals.initPosts();
  (document.querySelector('[data-filter="engaged"]') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(calls.some((u) => u.includes('filter=engaged'))).toBe(true));
  // A filter change starts a fresh page rather than carrying the old cursor forward.
  expect(calls.every((u) => !u.includes('before='))).toBe(true);
});

test('nothing is fetched until the Posts tab is actually opened', async () => {
  // initTabs() has no custom event, so posts.js hooks the tab button itself. Fetching in
  // init() would cost every page load a feed request for a tab the operator may never open.
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => feedPayload() } as Response;
  }));
  internals.initPosts();
  await new Promise((r) => setTimeout(r, 5));
  expect(calls).toHaveLength(0);

  (document.querySelector('.tab[data-tab="posts"]') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(calls.some((u) => u.startsWith('/api/posts?'))).toBe(true));
});

test('Load more pages forward with the cursor the server handed back', async () => {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => feedPayload({ next_cursor: null }) } as Response;
  }));
  internals.initPosts();
  internals.renderPostsFeed(feedPayload({ next_cursor: '2026-08-02T09:00:00.000Z|2' }));
  (document.getElementById('postsMore') as HTMLButtonElement).click();
  await vi.waitFor(() => {
    expect(calls.some((u) => u.includes('before=2026-08-02T09%3A00%3A00.000Z%7C2'))).toBe(true);
    // Appended, not replaced: paging must not throw away the page already being read.
    expect(document.querySelectorAll('#postsFeed .post-card')).toHaveLength(4);
  });
});
