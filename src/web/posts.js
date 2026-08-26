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
const postsState = {
  filter: 'new',
  selected: new Set(),
  /* Tracked-profile ids ticked in the manager's table, for the bulk remove. A SECOND store
     rather than a reuse of `selected`: that one holds post ids from the feed, both tables are
     on screen at once, and mixing the two keyspaces would let a feed selection untrack
     people. Kept here, not read back off the DOM, for the same reason as `selected` —
     refreshTracked() replaces every row. */
  trackedSelected: new Set(),
  cursor: null,
  loading: false,
};

/**
 * Roughly how much text needs clamping before BUILDING the expander at all.
 *
 * A heuristic, deliberately: at build time the card is a detached node (`scrollHeight` and
 * `clientHeight` are both 0 until it's in the document), so there's no honest measurement to
 * consult yet. Set low enough to err toward building the control — skipping it here can never
 * be corrected later, whereas building one that turns out unneeded gets caught and hidden by
 * `bodyOverflowsClamp` once the card is actually laid out (see `renderPostsFeed`).
 */
const POSTS_CLAMP_HINT = 150;

/**
 * Does a clamped post body actually overflow its two-line box? The one honest way to know,
 * once the node is laid out — unlike `POSTS_CLAMP_HINT`, which only guesses before that.
 *
 * jsdom has no layout engine, so a real card's `.post-body` reports both metrics as exactly 0
 * regardless of content — indistinguishable from "fits exactly". Treat that specific reading
 * as "can't tell, so show it" rather than as "doesn't overflow": the alternative (naively
 * trusting `scrollHeight > clientHeight`) is false for every post in that environment, which
 * would hide every expander and break the tests that click one. This is the only case jsdom
 * can express, and it's also the safer default in a real browser that somehow reports 0/0.
 */
function bodyOverflowsClamp(body) {
  const { scrollHeight, clientHeight } = body;
  if (scrollHeight === 0 && clientHeight === 0) return true;
  return scrollHeight > clientHeight;
}

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
  const appended = [];
  for (const post of posts) {
    const card = postCard(post);
    feed.appendChild(card);
    appended.push(card);
  }

  /* One measurement pass over exactly the cards just appended, now that they're actually in
     the document (a detached node's scrollHeight/clientHeight are both 0, so this can't run
     any earlier). Batched here rather than inside postCard() so reading layout doesn't force
     a reflow between every single card. */
  for (const card of appended) {
    const expand = card.querySelector('[data-act="expand"]');
    if (!expand) continue;
    const body = card.querySelector('.post-body');
    if (body && !bodyOverflowsClamp(body)) expand.hidden = true;
  }

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

/**
 * Show the bulk bar only while something is selected, and keep its count honest.
 *
 * Drives the checkboxes FROM postsState rather than the other way round, so a refresh that
 * replaces every card puts the ticks back where they were.
 */
function renderPostsSelection() {
  const n = postsState.selected.size;
  const count = $('#postsSelectionCount');
  if (count) count.textContent = `${fmtInt(n)} selected`;
  // Hidden at zero, deliberately: a permanently visible queue affordance beside a feed is how
  // engagements get queued that nobody meant to queue.
  const bar = $('#postsSelectionBar');
  if (bar) bar.hidden = n === 0;
  for (const card of $$('.post-card')) {
    const on = postsState.selected.has(Number(card.dataset.postId));
    card.classList.toggle('is-selected', on);
    const box = card.querySelector('[data-act="select"]');
    if (box) box.checked = on;
  }
}

/** The tracking manager's table. */
async function refreshTracked() {
  const body = $('#postsTrackedRows');
  if (!body) return;
  let payload;
  try {
    payload = await api('/api/tracked-profiles');
  } catch (err) {
    postsToast(`Could not load the tracked profiles: ${err.message}`, true);
    return;
  }
  const rows = Array.isArray(payload && payload.tracked) ? payload.tracked : [];
  /* Prune the selection to what the server just returned. A row that went away in the
     meantime — the bulk remove that triggered this refresh, a single Remove, another tab —
     would otherwise sit invisibly in the Set and be posted back by the next bulk remove,
     inflating the count the confirm asks about. */
  const live = new Set(rows.map((t) => t.id));
  for (const id of [...postsState.trackedSelected]) {
    if (!live.has(id)) postsState.trackedSelected.delete(id);
  }

  body.replaceChildren();
  for (const t of rows) {
    const tr = el('tr', {});
    tr.dataset.trackedId = String(t.id);

    /* The same `.c-select` / `.row-select` pair as the Connections results table, so the
       column width, the hit target and the header checkbox all behave identically. */
    const box = el('input', {
      type: 'checkbox', class: 'row-select',
      'aria-label': `Select ${t.full_name || t.profile_url}`,
    });
    box.checked = postsState.trackedSelected.has(t.id);
    tr.appendChild(el('td', { class: 'c-select' }, box));

    // full_name and last_sweep_error are third-party strings like the post bodies: the name
    // comes from the scrape, the error from whatever Apify said. `text:` only.
    const who = el('td', {}, el('div', { text: t.full_name || t.profile_url }));
    if (t.full_name) who.appendChild(el('div', { class: 'post-meta', text: t.profile_url }));
    if (t.last_sweep_error) {
      who.appendChild(el('div', { class: 'post-error', text: t.last_sweep_error }));
    }
    tr.appendChild(who);

    tr.appendChild(el('td', { text: fmtInt(t.post_count ?? 0) }));
    tr.appendChild(el('td', { text: t.last_swept_at ? postAge(t.last_swept_at) : 'never' }));

    const remove = el('button', { class: 'btn btn-ghost', type: 'button', text: 'Remove' });
    remove.dataset.act = 'untrack';
    tr.appendChild(el('td', {}, remove));

    body.appendChild(tr);
  }
  const cap = $('#postsTrackCount');
  if (cap) cap.textContent = `${fmtInt(rows.length)} of ${fmtInt(payload.cap ?? 0)} tracked`;
  renderTrackedSelection();
}

/**
 * The tracking table's bulk bar: visible only while something is ticked, with an honest count
 * and a header checkbox that reflects the rows on screen.
 *
 * Drives the checkboxes FROM postsState, like renderPostsSelection, so the refresh that
 * follows a remove puts the surviving ticks back where they were.
 */
function renderTrackedSelection() {
  const n = postsState.trackedSelected.size;
  const count = $('#trackedSelectionCount');
  if (count) count.textContent = `${fmtInt(n)} selected`;

  const bar = $('#trackedSelectionBar');
  if (bar) {
    // Hidden at zero, for the same reason as the feed's bar: a permanently visible bulk
    // Remove beside a table is how a watch list gets emptied by accident.
    bar.hidden = n === 0;
    /* Any change to the selection also drops a standing confirm. It names a count ("Stop
       tracking 12 profiles?"), and answering that question about a set edited since it was
       asked is precisely the near-miss the confirm step exists to prevent. */
    bar.classList.remove('is-confirming');
  }

  const boxes = $$('#postsTrackedRows .row-select');
  for (const box of boxes) {
    box.checked = postsState.trackedSelected.has(Number(box.closest('tr').dataset.trackedId));
  }
  const head = $('#trackedSelectAll');
  if (head) {
    const all = boxes.length > 0 && boxes.every((b) => b.checked);
    head.checked = all;
    head.indeterminate = !all && n > 0;
  }
}

/**
 * What a single engage actually did.
 *
 * The response is the authority, not the picked reaction: `reaction` is immutable once an
 * engagement exists, so a re-queue keeps the one it was created with. Echoing the operator's
 * choice back at them would claim a reaction that will never be sent — the one place this
 * screen could lie about something irreversible.
 */
function queueOneSummary(res, picked) {
  const kept = res && res.engagement ? res.engagement.reaction : null;
  if (res && res.requeued) {
    return kept && kept !== picked
      ? `Re-queued with its original ${postReactionLabel(kept)} — a queued reaction cannot be changed, so ${postReactionLabel(picked)} was not applied.`
      : `Re-queued as ${postReactionLabel(kept || picked)} for another attempt.`;
  }
  if (res && res.adopted) {
    return `Already queued as ${postReactionLabel(kept || picked)} — linked to this post, nothing new was added.`;
  }
  return `Queued ${postReactionLabel(kept || picked)}.`;
}

/**
 * What a bulk engage actually did, from the three id arrays rather than the one total.
 *
 * `added` is their sum, and reading it out loud as "queued 5 as Insightful" would attribute
 * the picked reaction to rows that kept their own. So creates, re-queues and adoptions are
 * counted apart, and a rejection is NAMED — "3 of 5 queued" leaves the operator guessing
 * which two and why.
 */
function bulkQueueSummary(res, reaction) {
  const size = (v) => (Array.isArray(v) ? v.length : 0);
  const created = size(res && res.post_ids);
  const requeued = size(res && res.requeued);
  const adopted = size(res && res.adopted);
  const rejected = Array.isArray(res && res.rejected) ? res.rejected : [];

  const bits = [];
  if (created > 0) bits.push(`Queued ${fmtInt(created)} as ${postReactionLabel(reaction)}`);
  if (requeued > 0) {
    bits.push(`re-queued ${fmtInt(requeued)} with their original reaction, not ${postReactionLabel(reaction)}`);
  }
  if (adopted > 0) bits.push(`${fmtInt(adopted)} already queued`);
  if (rejected.length > 0) bits.push(`${fmtInt(rejected.length)} skipped: ${rejected[0].message}`);
  return bits.length === 0 ? 'Nothing was queued.' : `${bits.join(' · ')}.`;
}

/** Queue one post. `comment` is omitted entirely when empty, never sent as ''. */
async function queuePost(card, id, button) {
  const reaction = card.querySelector('[data-act="reaction"]')?.value || 'like';
  const box = card.querySelector('[data-act="comment"]');
  // Only a REVEALED box counts: text left in a collapsed composer was not the operator's
  // intent, and a comment goes out under their own name.
  const comment = box && !box.hidden ? box.value.trim() : '';
  const payload = comment === '' ? { reaction } : { reaction, comment };
  if (button) button.disabled = true;
  try {
    const res = await api(`/api/posts/${id}/engage`, { method: 'POST', body: payload });
    postsToast(queueOneSummary(res, reaction));
    await refreshPosts(false);
  } catch (err) {
    postsToast(`Not queued: ${err.message}`, true);
  } finally {
    // The card is replaced by the refresh above, so this re-enables a detached node on the
    // happy path and the real button on the failed one — which is the one that matters.
    if (button) button.disabled = false;
  }
}

/**
 * Bulk: one reaction across the selection. No comment parameter exists here by design —
 * see POST /api/posts/engage. Identical comment text on several posts is a recognizable spam
 * pattern under the operator's own name, and the daily comment cap is 10.
 */
async function bulkQueue() {
  const ids = [...postsState.selected];
  if (ids.length === 0) return;
  const reaction = $('#postsBulkReaction')?.value || 'like';
  const btn = $('#postsBulkQueue');
  if (btn) btn.disabled = true;
  try {
    const res = await api('/api/posts/engage', { method: 'POST', body: { post_ids: ids, reaction } });
    // Cleared only once the server has answered: a thrown call leaves the selection intact so
    // the operator can retry it rather than re-tick a page of cards.
    postsState.selected.clear();
    postsToast(bulkQueueSummary(res, reaction), Number(res && res.added) === 0);
    await refreshPosts(false);
  } catch (err) {
    postsToast(`Nothing was queued: ${err.message}`, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

/** Add whatever is in the paste box to the tracked set. */
async function addTracked() {
  const area = $('#postsTrackText');
  const text = area ? area.value.trim() : '';
  if (text === '') return;
  const btn = $('#postsTrackAdd');
  if (btn) btn.disabled = true;
  try {
    // Sent verbatim: the server owns the parsing (extractProfileUrls), so a second copy of
    // "what counts as a profile URL" cannot drift from it here.
    const res = await api('/api/tracked-profiles', { method: 'POST', body: { text } });
    if (area) area.value = '';
    const rejects = Array.isArray(res && res.rejected) ? res.rejected : [];
    postsToast(rejects.length === 0
      ? `Now tracking ${fmtInt(res.added)} ${res.added === 1 ? 'profile' : 'profiles'}.`
      : `Tracking ${fmtInt(res.added)} · ${fmtInt(rejects.length)} skipped: ${rejects[0].message}`,
    res.added === 0);
    await refreshTracked();
    await refreshPosts(false);
  } catch (err) {
    postsToast(`Nothing was tracked: ${err.message}`, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

/** Untrack. Soft server-side, so the posts already collected stay in the feed. */
async function untrack(id) {
  try {
    await api(`/api/tracked-profiles/${id}`, { method: 'DELETE' });
    await refreshTracked();
    await refreshPosts(false);
  } catch (err) {
    postsToast(`Could not untrack: ${err.message}`, true);
  }
}

/**
 * Untrack the whole ticked selection in ONE request.
 *
 * Not a loop of single DELETEs: the watch list holds up to 200 rows, and a loop that dies on
 * row 40 leaves the operator with a table they have to diff by eye against what they meant to
 * remove. The endpoint answers with `removed` and `missing` per id, and the toast reads both
 * out rather than claiming the count that was asked for.
 */
async function bulkUntrack() {
  const ids = [...postsState.trackedSelected];
  if (ids.length === 0) return;
  const btn = $('#trackedConfirmRemove');
  if (btn) btn.disabled = true;
  try {
    const res = await api('/api/tracked-profiles/untrack', { method: 'POST', body: { ids } });
    const removed = Array.isArray(res && res.removed) ? res.removed.length : 0;
    const missing = Array.isArray(res && res.missing) ? res.missing.length : 0;
    // Cleared only once the server has answered, exactly like bulkQueue: a thrown call leaves
    // the ticks in place so the operator can retry instead of re-picking a table of 200.
    postsState.trackedSelected.clear();
    postsToast(missing === 0
      ? `Stopped tracking ${plural(removed, 'profile')}. Posts already collected stay in the feed.`
      : `Stopped tracking ${plural(removed, 'profile')} · ${fmtInt(missing)} were already gone.`,
    removed === 0);
    await refreshTracked();
    // The feed's "N tracked" readout and its empty-state text both depend on the watch list.
    await refreshPosts(false);
  } catch (err) {
    postsToast(`Nothing was untracked: ${err.message}`, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

/**
 * Manual sweep. Long on purpose — it returns only after the actor run finishes, so the button
 * is disabled for the duration rather than inviting a second click that would bill again.
 */
async function sweepNow() {
  const btn = $('#postsSweepNow');
  if (btn) { btn.disabled = true; btn.textContent = 'Sweeping…'; }
  try {
    const res = await api('/api/posts/sweep-now', { method: 'POST', body: {} });
    postsToast(res && typeof res.postsAdded === 'number'
      ? `Swept ${fmtInt(res.profilesSwept)} profiles · ${fmtInt(res.postsAdded)} new posts.`
      : 'Sweep finished.');
    await refreshPosts(false);
  } catch (err) {
    postsToast(`Sweep failed: ${err.message}`, true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Sweep now'; }
  }
}

function initPosts() {
  for (const chip of $$('.posts-chip')) {
    chip.addEventListener('click', () => {
      /* Dropped WHOLE while a page is in flight, state included. Changing the filter and then
         losing the fetch to refreshPosts's re-entrancy guard would strand this chip: the row
         would still highlight the filter on screen while postsState held the one it never
         loaded, so this chip's own next click would early-return below and do nothing. */
      if (postsState.loading) return;
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

  /* ONE delegated listener on the feed rather than per-card handlers: a re-render replaces
     every card, and re-binding handlers each time is how listeners leak. */
  $('#postsFeed')?.addEventListener('click', (ev) => {
    const target = ev.target.closest?.('[data-act]');
    if (!target) return;
    const card = target.closest('.post-card');
    if (!card) return;
    const act = target.dataset.act;
    const id = Number(card.dataset.postId);

    if (act === 'select') {
      if (target.checked) postsState.selected.add(id); else postsState.selected.delete(id);
      renderPostsSelection();
      return;
    }
    if (act === 'expand') {
      const body = card.querySelector('.post-body');
      const clamped = body.classList.toggle('is-clamped');
      target.textContent = clamped ? 'Show more' : 'Show less';
      return;
    }
    if (act === 'comment-toggle') {
      const box = card.querySelector('[data-act="comment"]');
      if (!box) return;
      box.hidden = !box.hidden;
      if (!box.hidden) box.focus();
      return;
    }
    if (act === 'queue') void queuePost(card, id, target);
  });

  $('#postsSelectionClear')?.addEventListener('click', () => {
    postsState.selected.clear();
    renderPostsSelection();
  });

  $('#postsBulkQueue')?.addEventListener('click', () => { void bulkQueue(); });
  $('#postsTrackAdd')?.addEventListener('click', () => { void addTracked(); });
  $('#postsSweepNow')?.addEventListener('click', () => { void sweepNow(); });

  $('#postsTrackedRows')?.addEventListener('click', (ev) => {
    const btn = ev.target.closest?.('[data-act="untrack"]');
    if (!btn) return;
    void untrack(Number(btn.closest('tr').dataset.trackedId));
  });

  /* Delegated on the tbody, not per row: refreshTracked() replaces every <tr>. `change`
     rather than `click`, for the same reason as the Connections table — it is the event that
     reports the box's settled state, keyboard toggles included. */
  $('#postsTrackedRows')?.addEventListener('change', (ev) => {
    const box = ev.target.closest?.('.row-select');
    if (!box) return;
    const id = Number(box.closest('tr').dataset.trackedId);
    if (box.checked) postsState.trackedSelected.add(id); else postsState.trackedSelected.delete(id);
    renderTrackedSelection();
  });

  /* Header checkbox. Its scope is the rows on screen, which for this table is the whole
     active watch list — it is not paged, so there is no "select all matching" escape hatch to
     offer the way the Connections results table has to. */
  $('#trackedSelectAll')?.addEventListener('change', (ev) => {
    const on = ev.target.checked;
    for (const box of $$('#postsTrackedRows .row-select')) {
      const id = Number(box.closest('tr').dataset.trackedId);
      if (on) postsState.trackedSelected.add(id); else postsState.trackedSelected.delete(id);
    }
    renderTrackedSelection();
  });

  $('#trackedSelectionClear')?.addEventListener('click', () => {
    postsState.trackedSelected.clear();
    renderTrackedSelection();
  });

  /* Two clicks, in the bar itself — the cohort card's confirm treatment, no browser dialog.
     Select-all here can lift the entire watch list in one gesture. */
  $('#trackedSelectionRemove')?.addEventListener('click', () => {
    const n = postsState.trackedSelected.size;
    if (n === 0) return;
    const txt = $('#trackedConfirmText');
    if (txt) {
      txt.textContent =
        `Stop tracking ${plural(n, 'profile')}? Posts already collected stay in the feed.`;
    }
    $('#trackedSelectionBar')?.classList.add('is-confirming');
  });

  $('#trackedConfirmCancel')?.addEventListener('click', () => {
    $('#trackedSelectionBar')?.classList.remove('is-confirming');
  });

  $('#trackedConfirmRemove')?.addEventListener('click', () => { void bulkUntrack(); });

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
