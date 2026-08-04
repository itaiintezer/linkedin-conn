/* The Posts screen.
 *
 * Its own file rather than more of app.js, which is already ~3,000 lines. Loaded as a third
 * classic script AFTER app.js, so the helpers below (api, el, $, toast, REACTION_LABELS) are
 * the ones app.js already defines — classic scripts share one global scope in load order. No
 * build step, no module system, no refactor of app.js.
 *
 * CAREFUL: app.js and posts.js share ONE global lexical scope, so a top-level `const` or
 * `function` name declared in both throws "Identifier has already been declared" and kills
 * this whole file silently — no feature, no obvious cause. app.js already owns
 * REACTION_LABELS, reactionLabel, api, el, $, $$, toast, selected and fmtTime, so those are
 * REUSED here rather than redeclared. Before adding any new top-level name to this file, grep
 * app.js for it. `postReactionLabel` below exists precisely because `reactionLabel` is taken.
 */
'use strict';

/** Feed page size. Matches the server's default; the server caps at 100 regardless. */
const POSTS_PAGE = 25;

/* The six reactions get an emoji here only. Their NAMES come from app.js's REACTION_LABELS so
   the vocabulary lives in exactly one place, in step with src/core/engagement-action.ts. */
const POST_REACTION_EMOJI = {
  like: '👍', celebrate: '👏', support: '🤝', love: '❤️', insightful: '💡', funny: '😄',
};

/** "👍 Like", matching the hand-written options in the bulk bar's <select>. */
function postReactionLabel(r) {
  return `${POST_REACTION_EMOJI[r] || ''} ${reactionLabel(r)}`.trim();
}

/* Selection lives here rather than being read back off the DOM: a re-render replaces every
   card, and reading checkboxes would silently drop selections on refresh. `filter` and
   `cursor` sit alongside it because all three are one conversation with /api/posts. */
const postsState = { filter: 'new', selected: new Set(), cursor: null, loading: false };

/**
 * Roughly how much text needs clamping before offering the expander.
 *
 * A heuristic, deliberately: `.post-body.is-clamped` clamps at two lines and jsdom has no
 * layout, so the honest measurement (scrollHeight > clientHeight) is not available at build
 * time. Set low enough to err toward offering the control — a needless "Show more" is noise,
 * but a missing one hides the words the whole screen exists to show. A "Show more" that
 * visibly does nothing is worse than either, which is why short posts don't get one.
 */
const POSTS_CLAMP_HINT = 150;

/** "6h ago" / "3d ago" / a date once it stops being useful as a relative age. */
function postAge(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 60) return `${Math.max(0, mins)}m ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
  const days = Math.floor(mins / 1440);
  return days <= 30 ? `${days}d ago` : new Date(iso).toISOString().slice(0, 10);
}

/**
 * Which chip a post belongs to, mirroring the server's FILTER_SQL partition exactly.
 *
 * Order matters and matches the SQL: a reaction outranks the status, because a reaction on
 * LinkedIn is a fact while a status is bookkeeping. Then `failed`/`skipped` return to `new`
 * so they can be retried; everything else with an engagement is in flight, `needs_attention`
 * included. Every post lands in exactly one chip — if you change this, change FILTER_SQL in
 * `src/db/posts-repos.ts` in the same commit or the badge and the filter will disagree.
 */
function postPhase(p) {
  if (p.engagement_reacted_at) return 'engaged';
  if (p.engagement_status && !['failed', 'skipped'].includes(p.engagement_status)) return 'queued';
  return 'new';
}

/** One feed card. */
function postCard(p) {
  const phase = postPhase(p);
  const on = postsState.selected.has(p.id);
  const card = el('div', { class: `post-card${on ? ' is-selected' : ''}` });
  card.dataset.postId = String(p.id);

  /* A <label> wrapper, not the class on the input itself: styles.css defines `.post-select`
     as the gutter (`flex: none`) and `.post-select input` as the box, and a label makes the
     whole gutter a hit target instead of a 13px square. */
  const box = el('input', {
    type: 'checkbox',
    'aria-label': `Select post by ${p.author_display || 'unknown author'}`,
  });
  box.checked = on;
  box.dataset.act = 'select';
  card.appendChild(el('label', { class: 'post-select' }, box));

  const main = el('div', { class: 'post-main' });

  /* Every one of these is third-party text — the author renamed themselves, the headline and
     the body are whatever they typed. `el`'s `text:` key and textContent below are the only
     way any of it enters the document; innerHTML anywhere in this function is a hole. */
  const who = el('div', { class: 'post-who' });
  who.appendChild(el('span', { class: 'post-name', text: p.author_display || 'Unknown' }));
  if (p.is_repost) who.appendChild(el('span', { class: 'post-repost', text: 'repost' }));
  if (phase !== 'new') {
    // Same shape as every other status badge in the app (see renderQueue in app.js).
    const status = p.engagement_status || phase;
    who.appendChild(el('span', { class: `pill ${status}`, text: String(status).replace('_', ' ') }));
  }
  main.appendChild(who);

  const bits = [p.headline_display, postAge(p.posted_at)].filter(Boolean);
  main.appendChild(el('div', { class: 'post-meta', text: bits.join(' · ') }));

  const content = p.content || '';
  const body = el('div', { class: 'post-body is-clamped' });
  body.textContent = content;
  main.appendChild(body);

  if (content.length > POSTS_CLAMP_HINT || content.includes('\n')) {
    const expand = el('button', { class: 'post-expand', type: 'button', text: 'Show more' });
    expand.dataset.act = 'expand';
    main.appendChild(expand);
  }

  const acts = el('div', { class: 'post-actions' });
  if (phase === 'new') {
    const sel = el('select', { 'aria-label': 'Reaction' });
    sel.dataset.act = 'reaction';
    for (const value of Object.keys(REACTION_LABELS)) {
      sel.appendChild(el('option', { value, text: postReactionLabel(value) }));
    }
    acts.appendChild(sel);

    const commentBtn = el('button', { class: 'btn btn-ghost', type: 'button', text: '💬 Comment' });
    commentBtn.dataset.act = 'comment-toggle';
    acts.appendChild(commentBtn);

    const queue = el('button', { class: 'btn btn-green', type: 'button', text: 'Queue' });
    queue.dataset.act = 'queue';
    acts.appendChild(queue);
  } else if (p.engagement_reaction) {
    // What is actually queued or done, not what anyone picked most recently: a queued
    // reaction is immutable server-side, so this line is the row's own truth.
    acts.appendChild(el('span', {
      class: 'post-meta',
      text: `${postReactionLabel(p.engagement_reaction)} ${phase === 'engaged' ? 'sent' : 'queued'}`,
    }));
  }
  acts.appendChild(el('a', {
    class: 'btn btn-ghost', href: p.post_url, target: '_blank', rel: 'noopener noreferrer',
    text: 'Open ↗',
  }));
  main.appendChild(acts);

  if (phase === 'new') {
    const comment = el('textarea', {
      class: 'post-comment', rows: '2',
      placeholder: 'Comment (optional) — goes out under your name',
    });
    comment.dataset.act = 'comment';
    comment.hidden = true;
    main.appendChild(comment);
  }

  card.appendChild(main);
  return card;
}

/** What the empty feed should say, which depends on why it is empty. */
function postsEmptyText(payload) {
  if (!payload.tracked) return 'No posts yet. Track some profiles, then sweep.';
  if (postsState.filter === 'queued') return 'Nothing queued. Pick posts from New to queue a reaction.';
  if (postsState.filter === 'engaged') return 'Nothing engaged yet — queued reactions land here once they go out.';
  return payload.swept_at
    ? 'No new posts. The next sweep runs once a day.'
    : 'No posts yet — nothing has been swept. Press Sweep now.';
}

/** Render a whole payload from GET /api/posts. `append` keeps the existing cards. */
function renderPostsFeed(payload, append = false) {
  const p = payload || {};
  const feed = $('#postsFeed');
  if (!feed) return;
  if (!append) feed.replaceChildren();

  const posts = Array.isArray(p.posts) ? p.posts : [];
  for (const post of posts) feed.appendChild(postCard(post));

  const counts = p.counts || {};
  for (const key of ['new', 'queued', 'engaged']) {
    const n = document.querySelector(`[data-count="${key}"]`);
    if (n) n.textContent = String(counts[key] ?? 0);
  }
  // The server echoes the filter it actually served, which is the one to highlight.
  if (typeof p.filter === 'string') postsState.filter = p.filter;
  for (const chip of $$('.posts-chip')) {
    const active = chip.dataset.filter === postsState.filter;
    chip.classList.toggle('is-active', active);
    chip.setAttribute('aria-selected', active ? 'true' : 'false');
  }

  const strip = $('#postsStatus');
  if (strip) {
    strip.replaceChildren(
      el('span', { text: `${fmtInt(p.tracked ?? 0)} tracked` }),
      el('span', { text: p.swept_at ? `Last swept ${postAge(p.swept_at)}` : 'Never swept' }),
      // Informational only — a spend ceiling was declined, so this exists so the cost is a
      // number the operator can watch rather than a guess.
      el('span', {
        class: 'posts-cost',
        text: `${fmtInt((p.cost_30d || {}).posts ?? 0)} posts scraped in 30d (≈$${Number((p.cost_30d || {}).usd ?? 0).toFixed(2)})`,
      }),
    );
  }

  const halt = p.halt || {};
  const banner = $('#postsHalt');
  if (banner) {
    banner.hidden = !halt.halted;
    banner.textContent = halt.halted
      ? `Post sweeping is halted (${halt.reason || 'unknown'}): ${halt.detail || ''} — fix it, then press Sweep now.`
      : '';
  }

  postsState.cursor = p.next_cursor || null;
  const more = $('#postsMore');
  if (more) more.hidden = postsState.cursor === null;
  const empty = $('#postsEmpty');
  if (empty) {
    empty.hidden = feed.children.length > 0;
    if (!empty.hidden) empty.textContent = postsEmptyText(p);
  }
  renderPostsSelection();
}

/** This screen's own feedback line. Errors here are read, not thrown into the console. */
function postsToast(msg, isError = false) {
  const node = $('#postsToast');
  if (node) toast(node, msg, isError);
}

/** Fetch a page. `append` false resets to the top of the current filter. */
async function refreshPosts(append = false) {
  // A second in-flight request would race the first's render; the feed is one conversation.
  if (postsState.loading) return;
  postsState.loading = true;
  try {
    const q = new URLSearchParams({ filter: postsState.filter, limit: String(POSTS_PAGE) });
    if (append && postsState.cursor) q.set('before', postsState.cursor);
    renderPostsFeed(await api(`/api/posts?${q.toString()}`), append);
  } catch (err) {
    // Surfaced rather than rethrown: every caller is a click handler, and an unhandled
    // rejection is a screen that just stops updating with no explanation.
    postsToast(`Could not load posts: ${err.message}`, true);
  } finally {
    postsState.loading = false;
  }
}

/* Replaced in Task 13 with the real selection bar renderer. */
function renderPostsSelection() {}

/* Replaced in Task 13 with the real tracking table. */
async function refreshTracked() {}

function initPosts() {
  for (const chip of $$('.posts-chip')) {
    chip.addEventListener('click', () => {
      if (postsState.filter === chip.dataset.filter) return;
      postsState.filter = chip.dataset.filter;
      /* A filter change is a fresh page: carrying the old cursor forward would page into the
         middle of a different result set. The selection goes too — posts picked under a chip
         you have since left is exactly how the wrong reaction gets queued. */
      postsState.cursor = null;
      postsState.selected.clear();
      void refreshPosts(false);
    });
  }

  $('#postsMore')?.addEventListener('click', () => { void refreshPosts(true); });

  $('#postsManageToggle')?.addEventListener('click', () => {
    const panel = $('#postsManage');
    const btn = $('#postsManageToggle');
    if (!panel || !btn) return;
    panel.hidden = !panel.hidden;
    btn.setAttribute('aria-expanded', panel.hidden ? 'false' : 'true');
    if (!panel.hidden) void refreshTracked();
  });

  /* Load when the tab is opened, not at boot. initTabs() is a generic show/hide switcher that
     dispatches no custom event, so the hook is the tab button itself — registered after
     initTabs()'s own listener, so the panel is already visible when this runs. Fetching in
     init() instead would spend a request on every page load for a tab the operator may never
     open, and would still never refresh when they did. */
  $('.tab[data-tab="posts"]')?.addEventListener('click', () => { void refreshPosts(false); });
}
