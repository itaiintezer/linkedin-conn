// @vitest-environment jsdom
/// <reference lib="dom" />
/**
 * The Posts screen, against the REAL index.html and the REAL posts.js — so element ids and
 * structure are the ones the browser sees, not hand-rolled stubs. Same reasoning as the other
 * tests/web suites.
 */
import { test, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadApp, stubFetchRoutes, byId, type AppInternals, type RouteStub } from './helpers/load-app.js';

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

/* ---------- selection, bulk and per-post engage ---------- */

/**
 * Capture every fetch, and answer everything with one payload.
 *
 * `initPosts()` is called first in these tests on purpose: selection and queueing run through
 * ONE delegated listener on #postsFeed rather than per-card handlers, because a re-render
 * replaces every card and re-binding handlers each time is how listeners leak.
 */
function stubFetch(payload: unknown = feedPayload()) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({
      url, method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return { ok: true, status: 200, json: async () => payload } as Response;
  }));
  return calls;
}

const selectFirst = () =>
  (document.querySelector('.post-card [data-act="select"]') as HTMLInputElement).click();

test('the bulk bar stays hidden until something is selected', () => {
  internals.initPosts();
  internals.renderPostsFeed(feedPayload());
  expect(document.getElementById('postsSelectionBar')!.hidden).toBe(true);

  selectFirst();
  expect(document.getElementById('postsSelectionBar')!.hidden).toBe(false);
  expect(document.getElementById('postsSelectionCount')!.textContent).toContain('1');
});

test('selection survives a re-render', () => {
  internals.initPosts();
  internals.renderPostsFeed(feedPayload());
  selectFirst();
  // A refresh replaces every card; reading checkboxes off the DOM would lose this.
  internals.renderPostsFeed(feedPayload());
  expect(internals.postsState.selected.has(1)).toBe(true);
  expect((document.querySelector('.post-card [data-act="select"]') as HTMLInputElement).checked)
    .toBe(true);
  expect(document.querySelector('.post-card')!.classList.contains('is-selected')).toBe(true);
});

test('Clear empties the selection and hides the bar', () => {
  internals.initPosts();
  internals.renderPostsFeed(feedPayload());
  selectFirst();
  (document.getElementById('postsSelectionClear') as HTMLButtonElement).click();
  expect(internals.postsState.selected.size).toBe(0);
  expect(document.getElementById('postsSelectionBar')!.hidden).toBe(true);
});

test('bulk queue posts the selected ids and the chosen reaction, and no comment', async () => {
  const calls = stubFetch();
  internals.initPosts();
  internals.renderPostsFeed(feedPayload());
  selectFirst();
  (document.getElementById('postsBulkReaction') as HTMLSelectElement).value = 'insightful';
  (document.getElementById('postsBulkQueue') as HTMLButtonElement).click();

  await vi.waitFor(() => {
    const bulk = calls.find((c) => c.url.includes('/api/posts/engage'));
    expect(bulk).toBeTruthy();
    expect(bulk!.method).toBe('POST');
    expect(bulk!.body).toEqual({ post_ids: [1], reaction: 'insightful' });
    // The bulk payload must never carry a comment: identical text on several posts is a spam
    // pattern under the operator's own name.
    expect(Object.keys(bulk!.body as object)).not.toContain('comment');
  });
});

test('bulk queue does nothing when nothing is selected', async () => {
  const calls = stubFetch();
  internals.initPosts();
  internals.renderPostsFeed(feedPayload());
  (document.getElementById('postsBulkQueue') as HTMLButtonElement).click();
  await new Promise((r) => setTimeout(r, 5));
  expect(calls.filter((c) => c.url.includes('/api/posts/engage'))).toHaveLength(0);
});

test('bulk reports creates, re-queues and adoptions separately, never as one number', async () => {
  /* A re-queued engagement keeps its ORIGINAL reaction — `reaction` is immutable after
     creation — so reading `added` out loud as "queued 5 as Insightful" would claim four
     reactions nobody chose. This is the one place the UI can lie about an irreversible act. */
  stubFetchRoutes({
    '/api/posts': { body: feedPayload() },
    '/api/posts/engage': {
      body: { added: 5, post_ids: [1], adopted: [2, 5], requeued: [3, 4], rejected: [] },
    },
  });
  internals.initPosts();
  internals.renderPostsFeed(feedPayload());
  selectFirst();
  (document.getElementById('postsBulkReaction') as HTMLSelectElement).value = 'insightful';
  (document.getElementById('postsBulkQueue') as HTMLButtonElement).click();

  await vi.waitFor(() => {
    const msg = document.getElementById('postsToast')!.textContent!;
    expect(msg).toContain('Queued 1');
    expect(msg).toContain('2 already queued');
    expect(msg).toMatch(/re-queued 2 .*original reaction/i);
    // The picked reaction must never be attributed to the four that kept their own.
    expect(msg).not.toContain('Queued 5');
  });
});

test('a bulk rejection is named, not just counted', async () => {
  stubFetchRoutes({
    '/api/posts': { body: feedPayload() },
    '/api/posts/engage': {
      body: {
        added: 0, post_ids: [], adopted: [], requeued: [],
        rejected: [{ post_id: 1, reason: 'duplicate', message: 'already reacted as engagement 8 (sent)' }],
      },
    },
  });
  internals.initPosts();
  internals.renderPostsFeed(feedPayload());
  selectFirst();
  (document.getElementById('postsBulkQueue') as HTMLButtonElement).click();

  await vi.waitFor(() => {
    // "0 of 1 queued" leaves the operator guessing which one and why.
    expect(document.getElementById('postsToast')!.textContent)
      .toContain('already reacted as engagement 8');
  });
});

test('a failed bulk queue keeps the selection so it can be retried', async () => {
  stubFetchRoutes({
    '/api/posts': { body: feedPayload() },
    '/api/posts/engage': { status: 500, error: 'database is locked' },
  });
  internals.initPosts();
  internals.renderPostsFeed(feedPayload());
  selectFirst();
  (document.getElementById('postsBulkQueue') as HTMLButtonElement).click();

  await vi.waitFor(() => {
    expect(document.getElementById('postsToast')!.textContent).toContain('database is locked');
  });
  expect(internals.postsState.selected.has(1)).toBe(true);
  expect((document.getElementById('postsBulkQueue') as HTMLButtonElement).disabled).toBe(false);
});

test('per-post Queue sends the card reaction and the comment when one was typed', async () => {
  const calls = stubFetch();
  internals.initPosts();
  internals.renderPostsFeed(feedPayload());
  const card = document.querySelector('.post-card') as HTMLElement;
  (card.querySelector('[data-act="reaction"]') as HTMLSelectElement).value = 'celebrate';
  (card.querySelector('[data-act="comment-toggle"]') as HTMLButtonElement).click();
  const box = card.querySelector('[data-act="comment"]') as HTMLTextAreaElement;
  expect(box.hidden).toBe(false);
  box.value = 'Congrats!';
  (card.querySelector('[data-act="queue"]') as HTMLButtonElement).click();

  await vi.waitFor(() => {
    const one = calls.find((c) => c.url === '/api/posts/1/engage');
    expect(one).toBeTruthy();
    expect(one!.body).toEqual({ reaction: 'celebrate', comment: 'Congrats!' });
  });
});

test('a per-post Queue with no comment omits the field entirely', async () => {
  const calls = stubFetch();
  internals.initPosts();
  internals.renderPostsFeed(feedPayload());
  const card = document.querySelector('.post-card') as HTMLElement;
  (card.querySelector('[data-act="queue"]') as HTMLButtonElement).click();
  await vi.waitFor(() => {
    const one = calls.find((c) => c.url === '/api/posts/1/engage');
    expect(one!.body).toEqual({ reaction: 'like' });
  });
});

test('a per-post re-queue reports the reaction the row kept, not the one just picked', async () => {
  stubFetchRoutes({
    '/api/posts': { body: feedPayload() },
    '/api/posts/1/engage': {
      body: {
        post_id: 1, requeued: true,
        engagement: { id: 9, status: 'queued', reaction: 'celebrate', comment: null },
      },
    },
  });
  internals.initPosts();
  internals.renderPostsFeed(feedPayload());
  const card = document.querySelector('.post-card') as HTMLElement;
  (card.querySelector('[data-act="reaction"]') as HTMLSelectElement).value = 'insightful';
  (card.querySelector('[data-act="queue"]') as HTMLButtonElement).click();

  await vi.waitFor(() => {
    const msg = document.getElementById('postsToast')!.textContent!;
    expect(msg).toContain('Celebrate');
    expect(msg).toMatch(/Insightful.*not applied/i);
  });
});

test('a refused per-post Queue says why and leaves the button usable', async () => {
  stubFetchRoutes({
    '/api/posts': { body: feedPayload() },
    '/api/posts/1/engage': { status: 409, error: 'already queued as engagement 8 (sending)' },
  });
  internals.initPosts();
  internals.renderPostsFeed(feedPayload());
  const card = document.querySelector('.post-card') as HTMLElement;
  (card.querySelector('[data-act="queue"]') as HTMLButtonElement).click();

  await vi.waitFor(() => {
    expect(document.getElementById('postsToast')!.textContent)
      .toContain('already queued as engagement 8');
  });
  expect((document.querySelector('[data-act="queue"]') as HTMLButtonElement).disabled).toBe(false);
});

test('Show more unclamps a long body', () => {
  internals.initPosts();
  const long = `Alert triage is an ownership problem. ${'The rota is the tell. '.repeat(12)}`;
  internals.renderPostsFeed(feedPayload({
    posts: [{ ...feedPayload().posts[0], content: long }],
  }));
  const card = document.querySelector('.post-card') as HTMLElement;
  const body = card.querySelector('.post-body')!;
  expect(body.classList.contains('is-clamped')).toBe(true);
  const expand = card.querySelector('[data-act="expand"]') as HTMLButtonElement;
  expand.click();
  expect(body.classList.contains('is-clamped')).toBe(false);
  expect(expand.textContent).toBe('Show less');
});

test('a body short enough to fit gets no expander at all', () => {
  // A "Show more" that visibly does nothing is worse than none: the clamp is two lines.
  internals.renderPostsFeed(feedPayload());
  expect(document.querySelector('.post-card [data-act="expand"]')).toBeNull();
});

test('the expander is hidden when the measured body does not actually overflow', () => {
  /* This is the bug: a long-enough-by-character-count post can still render fully inside the
   * two-line clamp at a wide viewport, and the fix measures scrollHeight vs clientHeight to
   * catch exactly that case. jsdom has no layout engine — every real element reports both as
   * 0 — so a real card here would always take the "can't tell" fallback and never exercise the
   * `scrollHeight > clientHeight` comparison itself. To honestly test that comparison (not just
   * the fallback around it), the Element accessors are overridden for this test only, to values
   * that represent a body which fits (scrollHeight === clientHeight), and restored immediately
   * after so no other test observes the override. */
  const scrollDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight');
  const clientDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight');
  Object.defineProperty(Element.prototype, 'scrollHeight', { configurable: true, get() { return 48; } });
  Object.defineProperty(Element.prototype, 'clientHeight', { configurable: true, get() { return 48; } });
  try {
    const long = `Alert triage is an ownership problem. ${'The rota is the tell. '.repeat(12)}`;
    internals.renderPostsFeed(feedPayload({
      posts: [{ ...feedPayload().posts[0], content: long }],
    }));
    const expand = document.querySelector('.post-card [data-act="expand"]') as HTMLButtonElement;
    expect(expand).not.toBeNull();
    expect(expand.hidden).toBe(true);
  } finally {
    if (scrollDesc) Object.defineProperty(Element.prototype, 'scrollHeight', scrollDesc);
    if (clientDesc) Object.defineProperty(Element.prototype, 'clientHeight', clientDesc);
  }
});

test('the tracking table lists profiles with a Remove button', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, status: 200,
    json: async () => ({
      tracked: [{ id: 3, profile_url: 'https://www.linkedin.com/in/dana',
        full_name: 'Dana Reingold', post_count: 12, last_swept_at: '2026-08-04T09:00:00.000Z',
        last_sweep_error: null }],
      cap: 200, swept_at: '2026-08-04T09:00:00.000Z',
    }),
  } as Response)));
  await internals.refreshTracked();
  const rows = document.querySelectorAll('#postsTrackedRows tr');
  expect(rows).toHaveLength(1);
  expect(rows[0].textContent).toContain('Dana Reingold');
  expect(rows[0].querySelector('[data-act="untrack"]')).not.toBeNull();
  expect(document.getElementById('postsTrackCount')!.textContent).toContain('200');
});

test('a per-profile sweep error is surfaced in the tracking table', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, status: 200,
    json: async () => ({
      tracked: [{ id: 3, profile_url: 'https://www.linkedin.com/in/dana', full_name: null,
        post_count: 0, last_swept_at: null, last_sweep_error: 'Apify run FAILED' }],
      cap: 200, swept_at: null,
    }),
  } as Response)));
  await internals.refreshTracked();
  expect(document.querySelector('#postsTrackedRows .post-error')!.textContent)
    .toContain('Apify run FAILED');
});

test('a tracked profile name is text, never markup', async () => {
  // full_name comes from the same scrape as the post bodies.
  const calls = stubFetchRoutes({
    '/api/tracked-profiles': {
      body: {
        tracked: [{ id: 3, profile_url: 'https://www.linkedin.com/in/dana',
          full_name: '<img src=x onerror="window.__xss=1">', post_count: 0,
          last_swept_at: null, last_sweep_error: '<b>boom</b>' }],
        cap: 200, swept_at: null,
      },
    },
  });
  await internals.refreshTracked();
  expect(calls).toHaveLength(1);
  expect(document.querySelector('#postsTrackedRows img')).toBeNull();
  expect(document.querySelector('#postsTrackedRows b')).toBeNull();
});

test('Remove untracks the row, then reloads the table and the feed', async () => {
  const calls = stubFetchRoutes({
    '/api/tracked-profiles': {
      body: {
        tracked: [{ id: 3, profile_url: 'https://www.linkedin.com/in/dana', full_name: 'Dana',
          post_count: 1, last_swept_at: null, last_sweep_error: null }],
        cap: 200, swept_at: null,
      },
    },
    '/api/tracked-profiles/3': { body: { ok: true, id: 3 } },
    '/api/posts': { body: feedPayload() },
  });
  internals.initPosts();
  await internals.refreshTracked();
  (document.querySelector('#postsTrackedRows [data-act="untrack"]') as HTMLButtonElement).click();
  await vi.waitFor(() => {
    const del = calls.find((c) => c.path === '/api/tracked-profiles/3');
    expect(del).toBeTruthy();
    expect(del!.method).toBe('DELETE');
    expect(calls.some((c) => c.path.startsWith('/api/posts?'))).toBe(true);
  });
});

test('pasting profiles into the tracking box posts the raw text and reports rejects', async () => {
  const calls = stubFetchRoutes({
    '/api/tracked-profiles': {
      body: {
        added: 1, ids: [4],
        rejected: [{ profile_url: 'nope', reason: 'invalid_url', message: 'not a LinkedIn profile URL: nope' }],
        tracked: [], cap: 200, swept_at: null,
      },
    },
    '/api/posts': { body: feedPayload() },
  });
  internals.initPosts();
  (document.getElementById('postsTrackText') as HTMLTextAreaElement).value =
    'https://www.linkedin.com/in/dana\nnope';
  (document.getElementById('postsTrackAdd') as HTMLButtonElement).click();

  await vi.waitFor(() => {
    const post = calls.find((c) => c.method === 'POST' && c.path === '/api/tracked-profiles');
    expect(post).toBeTruthy();
    // The server owns the parsing (extractProfileUrls); the box sends its text verbatim.
    expect(post!.body).toEqual({ text: 'https://www.linkedin.com/in/dana\nnope' });
    expect(document.getElementById('postsToast')!.textContent)
      .toContain('not a LinkedIn profile URL: nope');
  });
});

test('Sweep now disables itself for the duration and reports what it found', async () => {
  stubFetchRoutes({
    '/api/posts/sweep-now': { body: { runs: 1, profilesSwept: 4, postsAdded: 9 } },
    '/api/posts': { body: feedPayload() },
  });
  internals.initPosts();
  const btn = document.getElementById('postsSweepNow') as HTMLButtonElement;
  btn.click();
  // Long on purpose — a second click would bill a second actor run.
  expect(btn.disabled).toBe(true);
  await vi.waitFor(() => {
    expect(document.getElementById('postsToast')!.textContent).toContain('9');
    expect(btn.disabled).toBe(false);
  });
  expect(btn.textContent).toBe('Sweep now');
});

/* ---------- the Connections "Track posts" button ---------- */

test('Track posts sends the selected connection URLs to the tracking endpoint', async () => {
  const calls = stubFetch({ added: 2, ids: [1, 2], rejected: [] });
  internals.initSearch();

  // `selected` is app.js's module-level Set of profile URLs (app.js:1879) — the SAME store
  // "Invite to event" and "Add to message campaign" already read. Seeded directly rather than
  // through a second selection mechanism.
  const urls = ['https://www.linkedin.com/in/dana', 'https://www.linkedin.com/in/marcus'];
  internals.searchSelection().clear();
  for (const u of urls) internals.searchSelection().add(u);

  (document.getElementById('selectionTrack') as HTMLButtonElement).click();
  await vi.waitFor(() => {
    const call = calls.find((c) => c.url === '/api/tracked-profiles');
    expect(call).toBeTruthy();
    expect(call!.method).toBe('POST');
    expect(call!.body).toEqual({ profile_urls: urls });
    expect(document.getElementById('selectionResult')!.textContent).toContain('2 people');
  });
});

test('Track posts reads the same selection the other two buttons do', () => {
  // Not a second store: a divergent one is how the wrong people get acted on.
  internals.initSearch();
  internals.searchSelection().clear();
  internals.searchSelection().add('https://www.linkedin.com/in/dana');
  expect(internals.postsState.selected.size).toBe(0);
  expect(internals.searchSelection().size).toBe(1);
});

test('Track posts does nothing with an empty selection', async () => {
  const calls = stubFetch({ added: 0, ids: [], rejected: [] });
  internals.initSearch();
  internals.searchSelection().clear();
  (document.getElementById('selectionTrack') as HTMLButtonElement).click();
  await new Promise((r) => setTimeout(r, 5));
  expect(calls).toHaveLength(0);
});

test('a rejected profile is named rather than silently dropped', async () => {
  stubFetch({
    added: 1, ids: [4],
    rejected: [{ profile_url: 'https://www.linkedin.com/in/dana', reason: 'cap_reached',
      message: 'tracking cap of 200 reached — remove some profiles first' }],
  });
  internals.initSearch();
  internals.searchSelection().clear();
  internals.searchSelection().add('https://www.linkedin.com/in/dana');
  (document.getElementById('selectionTrack') as HTMLButtonElement).click();
  await vi.waitFor(() => {
    expect(document.getElementById('selectionResult')!.textContent).toContain('tracking cap of 200');
  });
});

test('a failed Track posts leaves the button usable and says why', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: false, status: 400, statusText: 'Bad Request',
    json: async () => ({ error: 'no profile urls supplied' }),
  } as Response)));
  internals.initSearch();
  internals.searchSelection().clear();
  internals.searchSelection().add('https://www.linkedin.com/in/dana');
  const btn = document.getElementById('selectionTrack') as HTMLButtonElement;
  btn.click();
  await vi.waitFor(() => {
    expect(document.getElementById('selectionResult')!.textContent).toContain('no profile urls supplied');
  });
  expect(btn.disabled).toBe(false);
});

test('a chip click while a page is in flight is dropped whole, not half-applied', async () => {
  // Half-applying it — filter changed, fetch dropped by the re-entrancy guard — would strand
  // that chip: its own next click early-returns because postsState already holds the filter it
  // never loaded, so the chip is dead until another one is visited.
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url);
    if (calls.length === 1) await gate;
    return { ok: true, status: 200, json: async () => feedPayload({ filter: 'queued' }) } as Response;
  }));
  internals.initPosts();
  (document.querySelector('[data-filter="queued"]') as HTMLButtonElement).click();
  (document.querySelector('[data-filter="engaged"]') as HTMLButtonElement).click();
  expect(internals.postsState.filter).toBe('queued');
  expect(calls).toHaveLength(1);

  release();
  await vi.waitFor(() => {
    const active = document.querySelector('.posts-chip.is-active') as HTMLElement;
    expect(active.dataset.filter).toBe('queued');
  });
  // And the dropped chip still works once the feed has settled.
  (document.querySelector('[data-filter="engaged"]') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(calls.some((u) => u.includes('filter=engaged'))).toBe(true));
});


/* ---------- the tracking table's multi-select and bulk remove ----------
   Same checkbox column, header checkbox and selection bar as the Connections results table
   (tests/web/search-to-campaign.test.ts), against a table that is never paged. */

/** A tracking payload with `n` rows, ids 1..n. */
const trackedPayload = (n: number) => ({
  tracked: Array.from({ length: n }, (_, i) => ({
    id: i + 1, profile_url: `https://www.linkedin.com/in/p${i}`, full_name: `Person ${i}`,
    post_count: i, last_swept_at: null, last_sweep_error: null,
  })),
  cap: 200, swept_at: null,
});

/** Wire the screen, load `n` tracked rows, and hand back the recorded calls. */
async function tracked(n: number, untrackStub: RouteStub = { body: { ok: true, removed: [], missing: [] } }) {
  const calls = stubFetchRoutes({
    '/api/tracked-profiles': { body: trackedPayload(n) },
    '/api/tracked-profiles/untrack': untrackStub,
    '/api/posts': { body: feedPayload() },
  });
  internals.initPosts();
  internals.postsState.trackedSelected.clear();
  await internals.refreshTracked();
  return calls;
}

/** Tick row `i` the way a click does: set the box, then fire the event the handler listens on. */
const tick = (i: number) => {
  const boxes = byId('postsTrackedRows').querySelectorAll<HTMLInputElement>('input.row-select');
  boxes[i].checked = !boxes[i].checked;
  boxes[i].dispatchEvent(new Event('change', { bubbles: true }));
};

const toggleAll = (on: boolean) => {
  const all = byId<HTMLInputElement>('trackedSelectAll');
  all.checked = on;
  all.dispatchEvent(new Event('change', { bubbles: true }));
};

test('every tracked row gets a checkbox, and the bulk bar waits to be asked for', async () => {
  await tracked(3);
  expect(byId('postsTrackedRows').querySelectorAll('input.row-select')).toHaveLength(3);
  // Hidden at zero: a permanently visible bulk Remove beside the watch list is the accident.
  expect(byId('trackedSelectionBar').hidden).toBe(true);

  tick(0);
  expect(byId('trackedSelectionBar').hidden).toBe(false);
  expect(byId('trackedSelectionCount').textContent).toContain('1');
});

test('the header checkbox takes the whole table, and gives it all back', async () => {
  await tracked(3);
  toggleAll(true);
  expect(byId('trackedSelectionCount').textContent).toContain('3');
  expect(byId('postsTrackedRows').querySelectorAll('input.row-select:checked')).toHaveLength(3);

  toggleAll(false);
  expect(byId('trackedSelectionBar').hidden).toBe(true);
  expect(byId('postsTrackedRows').querySelectorAll('input.row-select:checked')).toHaveLength(0);
});

test('the header checkbox goes indeterminate on a partial selection', async () => {
  await tracked(3);
  tick(1);
  const all = byId<HTMLInputElement>('trackedSelectAll');
  expect(all.checked).toBe(false);
  expect(all.indeterminate).toBe(true);

  tick(0); tick(2);
  expect(all.checked).toBe(true);
  expect(all.indeterminate).toBe(false);
});

test('Clear drops the selection without touching the rows', async () => {
  await tracked(3);
  tick(0); tick(1);
  byId('trackedSelectionClear').dispatchEvent(new Event('click', { bubbles: true }));
  expect(byId('trackedSelectionBar').hidden).toBe(true);
  expect(byId('postsTrackedRows').querySelectorAll('tr')).toHaveLength(3);
  expect(internals.postsState.trackedSelected.size).toBe(0);
});

test('Remove asks first — one click sends nothing', async () => {
  const calls = await tracked(3);
  tick(0); tick(2);
  byId('trackedSelectionRemove').dispatchEvent(new Event('click', { bubbles: true }));

  expect(byId('trackedSelectionBar').classList.contains('is-confirming')).toBe(true);
  // The question names the count, so the operator is answering about the set they picked.
  expect(byId('trackedConfirmText').textContent).toContain('2 profiles');
  expect(calls.some((c) => c.path === '/api/tracked-profiles/untrack')).toBe(false);
});

test('confirming posts every ticked id in ONE call, then reloads the table and the feed', async () => {
  const calls = await tracked(3, { body: { ok: true, removed: [1, 3], missing: [] } });
  tick(0); tick(2);
  byId('trackedSelectionRemove').dispatchEvent(new Event('click', { bubbles: true }));
  byId('trackedConfirmRemove').dispatchEvent(new Event('click', { bubbles: true }));

  await vi.waitFor(() => {
    const sent = calls.filter((c) => c.path === '/api/tracked-profiles/untrack');
    expect(sent).toHaveLength(1);          // one request, not one per row
    expect(sent[0].method).toBe('POST');
    expect(sent[0].body).toEqual({ ids: [1, 3] });
    expect(calls.some((c) => c.path.startsWith('/api/posts?'))).toBe(true);
  });
  expect(internals.postsState.trackedSelected.size).toBe(0);
  expect(byId('postsToast').textContent).toContain('2 profiles');
});

test('Cancel keeps the selection so it can be corrected, not re-picked', async () => {
  const calls = await tracked(3);
  tick(0);
  byId('trackedSelectionRemove').dispatchEvent(new Event('click', { bubbles: true }));
  byId('trackedConfirmCancel').dispatchEvent(new Event('click', { bubbles: true }));

  expect(byId('trackedSelectionBar').classList.contains('is-confirming')).toBe(false);
  expect(byId('trackedSelectionBar').hidden).toBe(false);
  expect(internals.postsState.trackedSelected.size).toBe(1);
  expect(calls.some((c) => c.path === '/api/tracked-profiles/untrack')).toBe(false);
});

test('editing the selection drops a standing confirm', async () => {
  // Otherwise the confirm asks about 1 profile and Remove takes 2 — the near-miss the
  // two-step exists to prevent.
  await tracked(3);
  tick(0);
  byId('trackedSelectionRemove').dispatchEvent(new Event('click', { bubbles: true }));
  tick(1);
  expect(byId('trackedSelectionBar').classList.contains('is-confirming')).toBe(false);
});

test('a refused bulk remove keeps the ticks, so it can be retried', async () => {
  await tracked(3, { status: 500, error: 'database is locked' });
  tick(0); tick(1);
  byId('trackedSelectionRemove').dispatchEvent(new Event('click', { bubbles: true }));
  byId('trackedConfirmRemove').dispatchEvent(new Event('click', { bubbles: true }));

  await vi.waitFor(() => {
    expect(byId('postsToast').textContent).toContain('database is locked');
  });
  expect(internals.postsState.trackedSelected.size).toBe(2);
  expect(byId<HTMLButtonElement>('trackedConfirmRemove').disabled).toBe(false);
});

test('rows that were already gone are named, not counted as removed', async () => {
  await tracked(3, { body: { ok: true, removed: [1], missing: [3] } });
  tick(0); tick(2);
  byId('trackedSelectionRemove').dispatchEvent(new Event('click', { bubbles: true }));
  byId('trackedConfirmRemove').dispatchEvent(new Event('click', { bubbles: true }));

  await vi.waitFor(() => {
    const said = byId('postsToast').textContent ?? '';
    expect(said).toContain('1 profile');
    expect(said).toContain('already gone');
  });
});

test('the selection is pruned to the rows the server still returns', async () => {
  // A row untracked elsewhere would otherwise sit invisibly in the Set and be posted back.
  await tracked(3);
  toggleAll(true);
  expect(internals.postsState.trackedSelected.size).toBe(3);

  stubFetchRoutes({ '/api/tracked-profiles': { body: trackedPayload(1) } });
  await internals.refreshTracked();

  expect([...internals.postsState.trackedSelected]).toEqual([1]);
  expect(byId('trackedSelectionCount').textContent).toContain('1');
});

test('the feed selection and the tracking selection are separate stores', async () => {
  // Both tables can be on screen at once, and their ids come from different tables. Sharing
  // one Set would let a picked post untrack a person.
  await tracked(3);
  internals.renderPostsFeed(feedPayload());
  (document.querySelector('#postsFeed [data-act="select"]') as HTMLInputElement).click();
  tick(0);

  expect([...internals.postsState.selected]).toEqual([1]);        // post id
  expect([...internals.postsState.trackedSelected]).toEqual([1]); // tracked-profile id
  expect(byId('postsSelectionCount').textContent).toContain('1');
  expect(byId('trackedSelectionCount').textContent).toContain('1');
});
