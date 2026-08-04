/* ============================================================
   THE MACHINE — front-end controller
   Vanilla JS. Wires against /api/* (see server.ts).
   ============================================================ */
'use strict';

const STATUS_ORDER = ['queued', 'scheduled', 'sending', 'sent', 'accepted', 'expired', 'skipped', 'failed', 'needs_attention'];

/* ---------- tiny helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

async function api(path, { method = 'GET', body } = {}) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error || ''; } catch (_) { /* ignore */ }
    throw new Error(detail || `${res.status} ${res.statusText}`);
  }
  return res.json();
}

function slugFromUrl(url) {
  if (!url) return '(unknown)';
  const m = String(url).match(/\/in\/([^/?#]+)/i);
  return m ? m[1] : String(url).replace(/^https?:\/\//, '').replace(/\/$/, '');
}

/* A post URL, shortened for display the same way an event campaign's is (renderEventGroup).
   The full URL always stays on the link's href and title — a post is identified by its urn,
   which is unreadable, so there is no slug to fall back on. */
function postLabel(url) {
  if (!url) return '(unknown post)';
  return String(url).replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
}

/* Reaction names as LinkedIn writes them. Keep in step with REACTIONS
   (src/core/engagement-action.ts); an unknown value renders as-is rather than vanishing. */
const REACTION_LABELS = {
  like: 'Like', celebrate: 'Celebrate', support: 'Support',
  love: 'Love', insightful: 'Insightful', funny: 'Funny',
};
function reactionLabel(r) { return REACTION_LABELS[r] || String(r || 'Like'); }

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function toast(node, msg, isError = false) {
  node.textContent = msg;
  node.className = 'toast' + (isError ? ' error' : '');
  node.hidden = false;
}

/* ---------- tab navigation ---------- */
function switchTab(name) {
  const tab = $$('.tab').find((t) => t.dataset.tab === name);
  if (tab) tab.click();
}

function initTabs() {
  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach((t) => t.classList.toggle('is-active', t === tab));
      const name = tab.dataset.tab;
      $$('main > .panel').forEach((p) => { p.hidden = p.id !== `tab-${name}`; });
      if (name === 'add') loadCohortOptions();
      if (name === 'cohorts') loadCohortsScreen();
      if (name === 'events') loadEventsScreen();
      if (name === 'docs') loadDocs();
      if (name === 'settings') { loadSettings(); scrollLogToEnd(); }
    });
  });
}

/* ---------- login status ---------- */
async function refreshLogin() {
  const led = $('#loginLed'), label = $('#loginLabel'), btn = $('#connectBtn');
  try {
    const { loggedIn, asOf } = await api('/api/login-status');
    led.className = 'led ' + (loggedIn ? 'on' : 'off');
    label.textContent = loggedIn ? 'linked' : 'not logged in';
    label.title = asOf ? `as of ${fmtTime(asOf)}` : '';
    btn.hidden = loggedIn;
  } catch (_) {
    led.className = 'led off';
    label.textContent = 'link error';
    label.title = '';
    btn.hidden = false;
  }
}

function initLogin() {
  $('#connectBtn').addEventListener('click', async () => {
    const btn = $('#connectBtn');
    btn.disabled = true; btn.textContent = 'Opening…';
    try { await api('/api/login', { method: 'POST' }); }
    catch (_) { /* surfaced via status poll */ }
    setTimeout(() => { btn.disabled = false; btn.textContent = 'Connect LinkedIn'; refreshLogin(); }, 1500);
  });
}

/* ---------- dashboard ---------- */
let lastPaused = null;

function fmtClock(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function fmtRelDay(iso, now = new Date()) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(d) - startOf(now)) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  return d.toLocaleDateString(undefined, { weekday: 'short' });
}

function fmtEta(eta) {
  if (!eta || eta.finishDate == null) {
    return { value: '—', foot: eta && eta.sendingDays === 0 ? 'queue empty' : 'no capacity' };
  }
  const d = eta.sendingDays;
  const by = new Date(eta.finishDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return { value: `~${d}d`, foot: `by ${by}` };
}

/* "1 location" / "3 locations", with an escape hatch for the irregulars ("person",
   "people"). English-only, like every other string in this file. */
function plural(n, one, many = `${one}s`) { return `${n} ${n === 1 ? one : many}`; }

function setText(id, value) {
  const node = document.getElementById(id);
  if (node) node.textContent = String(value);
}

/* Fill an engine pill's text span: optional lead text, an emphasized value, and a tail. */
function fillPill(id, lead, value, tail) {
  const span = document.getElementById(id);
  if (!span) return;
  const kids = [];
  if (lead) kids.push(document.createTextNode(lead + ' '));
  if (value != null) kids.push(el('b', { text: String(value) }));
  if (tail) kids.push(document.createTextNode((value != null ? ' ' : '') + tail));
  span.replaceChildren(...kids);
}

// Render the live engine by updating numbers IN PLACE — never re-rendering the
// DOM — so the conveyor animation runs continuously across 15s status polls.
function renderEngine(status) {
  const c = status.counts || {};   // invite-only, by design (see /api/status)
  const mc = status.msg_counts || {};
  const f = status.forecast || {};

  // --- Pace: weekly "fuel" ---
  const pct = status.weekly_cap ? Math.min(100, Math.round((status.weekly_sent / status.weekly_cap) * 100)) : 0;
  setText('fuelSent', status.weekly_sent ?? 0);
  setText('fuelCap', status.weekly_cap ?? 0);
  const fuelBar = document.getElementById('fuelBar');
  if (fuelBar) fuelBar.style.width = `${pct}%`;

  // --- Pace: ETA pill ---
  const eta = fmtEta(f.eta);
  if (eta.value === '—') fillPill('etaTxt', null, null, eta.foot);
  else fillPill('etaTxt', 'finishes in', eta.value, eta.foot);

  // --- Pace: next-batch pill ---
  // Four states, and the order matters: `pending` carries no `at` at all (see NextBatchResult)
  // because the planner hasn't placed the batch yet. Rendering a clock time there — which is
  // what showing `now` amounted to — reads as a promise the engine hasn't made.
  const nb = f.next_batch;
  if (!nb) fillPill('nextTxt', null, null, 'no batch queued');
  else if (nb.blocked) fillPill('nextTxt', null, null, nb.reason);
  else if (nb.pending) fillPill('nextTxt', 'next batch', `~${nb.count}`, 'awaiting scheduling');
  else if (nb.estimated === false) fillPill('nextTxt', 'next batch', nb.count, `at ${fmtClock(nb.at)}`);
  else fillPill('nextTxt', 'next batch', `~${nb.count}`, `${fmtRelDay(nb.at)} ~${fmtClock(nb.at)}`);

  // --- Flow: conveyor stations ---
  setText('stQueued', c.queued || 0);
  setText('stScheduled', c.scheduled || 0);
  setText('stPending', c.sent || 0);
  setText('stAccepted', c.accepted || 0);
  setText('acceptedFoot', `checked ${status.acceptance_checked_at ? fmtClock(status.acceptance_checked_at) : 'never'}`);

  // --- Terminal outcomes ---
  // Skipped and Needs-attention are SHARED cards (their drill-downs pass no kind, so they
  // already list both conveyors) — they must sum invite + message counts. `status.counts`
  // is invite-only by design, so reading it alone made every message-side failure invisible
  // AND unreachable: the Attention card is the only entry point to the attention modal, and
  // it only becomes clickable when the number is non-zero. A message campaign whose template
  // was blanked would drain silently, each profile burning a slot for nothing.
  // Expired stays invite-only on purpose: a sent DM never expires, only an invite does.
  setText('outExpired', c.expired || 0);
  setText('outSkipped', (c.skipped || 0) + (mc.skipped || 0));
  // Engagements land in the same modal (see /api/attention), so they must be in the same
  // number — for exactly the reason the message side had to be: the card is the modal's only
  // entry point and it only becomes clickable when the count is non-zero. A run where the
  // only casualties are posts would otherwise be invisible AND unreachable.
  const ec = (status.engagements && status.engagements.counts) || {};
  const engAttention = (ec.failed ?? 0) + (ec.needs_attention ?? 0);
  // Split out, because the two bulk buttons below can only reach the profiles.
  const profileAttention = (c.failed || 0) + (c.needs_attention || 0)
    + (mc.failed || 0) + (mc.needs_attention || 0);
  const attention = profileAttention + engAttention;
  setText('outAttn', attention);
  const attnCard = document.getElementById('outAttnCard');
  if (attnCard) {
    attnCard.classList.toggle('has-attn', attention > 0);
    attnCard.classList.toggle('is-clickable', attention > 0);
  }

  // Show the bulk Retry button only when there's something to retry. Skip while a
  // retry is in flight so the poll doesn't clobber its "Requeued N" feedback.
  //
  // Counted on PROFILES only: /api/retry walks the profiles table and nothing else, so a
  // count that included posts would put a number on this button that pressing it cannot
  // deliver. Stuck engagements are retried row by row from the modal instead.
  const retryBtn = $('#retryFailed');
  if (retryBtn && !retryBtn.dataset.busy) {
    retryBtn.hidden = profileAttention === 0;
    retryBtn.textContent = profileAttention ? `Retry failed (${profileAttention})` : 'Retry failed';
  }

  // --- Messages engine: same in-place update discipline, its own counts + caps ---
  const msgPct = status.msg_weekly_cap
    ? Math.min(100, Math.round(((status.msg_weekly_sent || 0) / status.msg_weekly_cap) * 100)) : 0;
  setText('msgFuelSent', status.msg_weekly_sent ?? 0);
  setText('msgFuelCap', status.msg_weekly_cap ?? 0);
  const msgFuelBar = document.getElementById('msgFuelBar');
  if (msgFuelBar) msgFuelBar.style.width = `${msgPct}%`;

  const mnb = f.msg_next_batch;
  if (!mnb) fillPill('msgNextTxt', null, null, 'no batch queued');
  else if (mnb.blocked) fillPill('msgNextTxt', null, null, mnb.reason);
  else if (mnb.pending) fillPill('msgNextTxt', 'next batch', `~${mnb.count}`, 'awaiting scheduling');
  else if (mnb.estimated === false) fillPill('msgNextTxt', 'next batch', mnb.count, `at ${fmtClock(mnb.at)}`);
  else fillPill('msgNextTxt', 'next batch', `~${mnb.count}`, `${fmtRelDay(mnb.at)} ~${fmtClock(mnb.at)}`);

  setText('msgQueued', mc.queued || 0);
  setText('msgScheduled', mc.scheduled || 0);
  setText('msgSent', mc.sent || 0);
  setText('msgReplied', mc.replied || 0);
  setText('repliedFoot', `checked ${status.replies_checked_at ? fmtClock(status.replies_checked_at) : 'never'}`);

  // No message profiles at all -> stay collapsed to the slim placeholder row. The
  // markup ships collapsed so an invites-only account never sees the conveyor flash.
  const msgTotal = Object.values(mc).reduce((n, v) => n + v, 0);
  const msgEngine = document.getElementById('msgEngine');
  if (msgEngine) {
    msgEngine.classList.toggle('is-idle', msgTotal === 0);
    const idle = document.getElementById('msgEngineIdle');
    if (idle) idle.hidden = msgTotal !== 0;
  }

  // --- Event invites: the third conveyor ---
  // Paced in RUNS, not sends: one run books the browser for a reserved block of the day,
  // so the fuel gauge counts today's runs against events_per_day rather than invitations.
  const ev = status.event || {};
  const evCap = Math.max(1, ev.events_per_day || 1);
  const evRuns = ev.runs_today || 0;
  setText('evFuelSent', evRuns);
  setText('evFuelCap', evCap);
  const evFuelBar = document.getElementById('evFuelBar');
  if (evFuelBar) evFuelBar.style.width = `${Math.min(100, Math.round((evRuns / evCap) * 100))}%`;

  // Three states, and "armed but unscheduled" is a real one: arming does not place the
  // window — the hourly planner does, once the day has 20 free minutes. Saying "next run
  // 42" with a clock time we do not have would be the same lie the invite pill used to tell.
  const nr = ev.next_run;
  if (!nr) fillPill('evNextTxt', null, null, ev.campaigns ? 'nothing armed' : 'no campaigns');
  else if (nr.from) fillPill('evNextTxt', 'next run', ev.up_next || 0, `${fmtRelDay(nr.from)} ~${fmtClock(nr.from)}`);
  else fillPill('evNextTxt', 'next run', ev.up_next || 0, 'awaiting a free window');

  setText('evListed', ev.listed || 0);
  setText('evUpNext', ev.up_next || 0);
  setText('evInvited', ev.invited || 0);
  const locNext = ev.locations_next || 0;
  setText('evUpNextFoot', locNext ? plural(locNext, 'location') : 'no run planned');

  // The locations that will NOT fit today, and the people no filter can reach. Neither has
  // a station to live in — rounding them away is how "best effort" quietly becomes "some
  // of these people were never going to be invited and nobody said so".
  const locLeft = ev.locations_left || 0;
  const evUnreachable = ev.unreachable || 0;
  const evFootLeft = $('#evFootLeft');
  if (evFootLeft) {
    evFootLeft.hidden = locLeft === 0;
    if (locLeft) fillPill('evFootLeft', null, locLeft, `more ${locLeft === 1 ? 'location' : 'locations'} after that run`);
  }
  const evFootUn = $('#evFootUnreachable');
  if (evFootUn) {
    evFootUn.hidden = evUnreachable === 0;
    if (evUnreachable) fillPill('evFootUnreachable', null, evUnreachable, 'unreachable by location');
  }
  const evFoot = $('#evEngineFoot');
  if (evFoot) evFoot.hidden = locLeft === 0 && evUnreachable === 0;

  const evRunning = $('#evRunningPill');
  if (evRunning) {
    evRunning.hidden = !ev.running;
    if (ev.running) {
      const who = ev.running.title || `campaign #${ev.running.event_id}`;
      $('#evRunningTxt').textContent = `inviting · ${who}`;
      evRunning.title = `An event run is working through its locations: ${who}`;
    }
  }

  // Never used the pipeline -> stay collapsed, exactly like the messages engine.
  const evEngine = document.getElementById('evEngine');
  if (evEngine) {
    const none = !ev.campaigns;
    evEngine.classList.toggle('is-idle', none);
    const idle = document.getElementById('evEngineIdle');
    if (idle) idle.hidden = !none;
  }

  // --- Post engagements: the fourth conveyor ---
  renderEngagements(status.engagements);

  // --- Now processing ---
  const pill = $('#sendingPill');
  if (pill) {
    const sending = status.sending || [];
    pill.hidden = sending.length === 0;
    if (sending.length) {
      const label = sending.map((p) => slugFromUrl(p.profile_url)).join(', ');
      $('#sendingTxt').textContent = `processing ${label}`;
      pill.title = `Now sending: ${label}`;
    }
  }
}

/**
 * The engagements engine, from the `engagements` block of the same /api/status poll the
 * other three read. Same in-place discipline: numbers are written into existing nodes so
 * the conveyor animation survives a poll.
 *
 * TWO rules this function exists to keep:
 *
 * 1. `counts` OMITS any status with no rows, so every read goes through `?? 0`. A missing
 *    key is zero, not "unknown" — but `||` on an absent key and `||` on a real 0 are the
 *    same, which is why the absent case is worth a test of its own.
 *
 * 2. `next_scheduled` is a REAL timestamp or null, and null renders the words "Not
 *    scheduled" — never a clock time. This is the whole reason /api/status carries
 *    MIN(scheduled_for) instead of a forecast: the invite-side next-batch pill has a known
 *    defect where an estimated forecast pins `at = now`, so an unplanned queue advertises
 *    an imminent batch. Do not reintroduce that here by falling back to a guess.
 */
function renderEngagements(engagements) {
  const e = engagements || {};
  const c = e.counts || {};
  const n = (k) => c[k] ?? 0;   // absent status key === zero rows (see rule 1)

  // Weekly fuel: reactions, the unit the weekly cap actually rations.
  const used = e.weekly_used ?? 0;
  const cap = e.weekly_cap ?? 0;
  setText('engFuelSent', used);
  setText('engFuelCap', cap);
  const bar = document.getElementById('engFuelBar');
  if (bar) bar.style.width = `${cap ? Math.min(100, Math.round((used / cap) * 100)) : 0}%`;

  // Comments have their own daily ceiling, so they get their own pill rather than being
  // folded into a number that would then mean two different things.
  fillPill('engCommentsTxt', 'comments today', `${e.comments_today ?? 0} / ${e.comment_daily_cap ?? 0}`);

  // Rule 2. Three states and no fourth: a time, "nothing queued", or "Not scheduled".
  const next = e.next_scheduled || null;
  const backlog = n('queued') + n('scheduled');
  if (next) fillPill('engNextTxt', `next ${fmtRelDay(next)}`, fmtClock(next), null);
  else if (backlog === 0) fillPill('engNextTxt', null, null, 'nothing queued');
  else fillPill('engNextTxt', null, null, 'Not scheduled');

  setText('engQueued', n('queued'));
  setText('engScheduled', n('scheduled'));
  setText('engSent', n('sent'));
  setText('engScheduledFoot', next ? `from ${fmtClock(next)}` : 'not scheduled');

  // `sending` is a real engagement status, but /api/status's top-level `sending` list is
  // profiles-only (it maps profile_url), so the count is all this side has to show. A number
  // is enough for a pipeline that never runs more than one post at a time.
  const sending = n('sending');
  const sendPill = $('#engSendingPill');
  if (sendPill) {
    sendPill.hidden = sending === 0;
    if (sending) {
      const txt = `engaging · ${plural(sending, 'post')}`;
      setText('engSendingTxt', txt);
      sendPill.title = `The sender is working through ${txt.replace('engaging · ', '')}`;
    }
  }

  const attn = n('needs_attention');
  const failed = n('failed');
  const footAttn = $('#engFootAttn');
  if (footAttn) {
    footAttn.hidden = attn === 0;
    if (attn) fillPill('engFootAttn', null, attn, 'parked for a manual look');
  }
  const footFailed = $('#engFootFailed');
  if (footFailed) {
    footFailed.hidden = failed === 0;
    if (failed) fillPill('engFootFailed', null, failed, 'failed');
  }
  const foot = $('#engEngineFoot');
  if (foot) foot.hidden = attn === 0 && failed === 0;

  // Never used the pipeline -> stay collapsed, exactly like the other two optional engines.
  const engEngine = document.getElementById('engEngine');
  if (engEngine) {
    const none = Object.values(c).reduce((sum, v) => sum + (v || 0), 0) === 0;
    engEngine.classList.toggle('is-idle', none);
    const idle = document.getElementById('engEngineIdle');
    if (idle) idle.hidden = !none;
  }
}

/* How many upcoming posts the card names, and how deep it looks to find them. */
const ENG_UPNEXT_SHOW = 5;
const ENG_UPNEXT_FETCH = 100;

/**
 * The named "Up next" rows, from /api/engagements?status=scheduled.
 *
 * That route is `ORDER BY id DESC` — newest ENQUEUED first, which for "what happens next"
 * is the wrong axis entirely: a post added this morning can be scheduled days after one
 * added last week. So it is fetched deep and re-sorted here by `scheduled_for` ascending,
 * which also makes the first row agree with the card's next-scheduled pill (that pill is
 * MIN(scheduled_for) server-side). Rows with no `scheduled_for` sort last rather than
 * being dropped — a scheduled row without a time is a bug worth seeing, not hiding.
 *
 * On its own request because the counts come from /api/status and this does not: rows carry
 * URLs and comment text, which is per-row data the status poll has no business shipping.
 * Runs on the same 15s tick as refreshQueue, so it adds a request per tick, not a timer.
 */
async function refreshEngagementUpNext() {
  const wrap = $('#engUpNext'), list = $('#engUpNextList');
  if (!wrap || !list) return;
  try {
    const rows = await api(`/api/engagements?status=scheduled&limit=${ENG_UPNEXT_FETCH}`);
    if (!rows.length) { wrap.hidden = true; list.replaceChildren(); return; }
    const sorted = rows.slice().sort((a, b) => {
      if (!a.scheduled_for) return 1;
      if (!b.scheduled_for) return -1;
      return a.scheduled_for < b.scheduled_for ? -1 : a.scheduled_for > b.scheduled_for ? 1 : 0;
    });
    const shown = sorted.slice(0, ENG_UPNEXT_SHOW);
    const kids = shown.map(renderEngagementUpNextRow);
    if (sorted.length > shown.length) {
      kids.push(el('li', { class: 'eng-up-more', text: `+${sorted.length - shown.length} more scheduled` }));
    }
    list.replaceChildren(...kids);
    wrap.hidden = false;
  } catch (_) { /* transient; next tick retries */ }
}

const ICON_ENG_COMMENT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7A8.5 8.5 0 1 1 21 11.5z" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function renderEngagementUpNextRow(e) {
  const when = e.scheduled_for
    ? el('span', { class: 'eng-up-when', text: `${fmtRelDay(e.scheduled_for)} ~${fmtClock(e.scheduled_for)}` })
    : el('span', { class: 'eng-up-when is-unscheduled', text: 'no slot yet' });
  const row = el('li', { class: 'eng-up' },
    when,
    el('span', { class: 'eng-up-react', text: reactionLabel(e.reaction) }),
  );
  // A row that will also leave a comment is marked: it is the louder half of the action and
  // it is rationed by a different cap, so "this one comments" has to be visible up front.
  if (e.comment_text) {
    const mark = el('span', {
      class: 'eng-up-comment', role: 'img',
      'aria-label': 'leaves a comment too', title: e.comment_text,
    });
    mark.innerHTML = ICON_ENG_COMMENT;
    row.appendChild(mark);
  }
  row.appendChild(el('a', {
    class: 'eng-up-url', href: e.post_url, target: '_blank', rel: 'noopener',
    title: e.post_url || '', text: postLabel(e.post_url),
  }));
  return row;
}

/* The engine has one visual run-state: running, paused (amber), or halted (red).
   Stops the conveyor + pulse animations via CSS and shows a badge on the track.
   One pause state, one guardrail: both engines wear it. */
function applyEngineState(status) {
  const tripped = !!(status.guardrail && status.guardrail.tripped);
  const paused = !!status.paused;
  for (const [engine, badge, txt] of [
    [$('#engine'), $('#engineState'), $('#engineStateTxt')],
    [$('#msgEngine'), $('#msgEngineState'), $('#msgEngineStateTxt')],
    [$('#evEngine'), $('#evEngineState'), $('#evEngineStateTxt')],
    [$('#engEngine'), $('#engEngineState'), $('#engEngineStateTxt')],
  ]) {
    if (!engine) continue;
    engine.classList.toggle('is-paused', paused || tripped);
    engine.classList.toggle('is-halted', tripped);
    if (badge) badge.hidden = !(paused || tripped);
    if (txt) txt.textContent = tripped ? 'Halted' : 'Paused';
  }
  const dot = $('#refreshDot');
  if (dot) dot.classList.toggle('is-still', paused || tripped);
}

function applyPauseUi(status) {
  const banner = $('#pauseBanner');
  const toggle = $('#pauseToggle');
  const paused = !!status.paused;
  banner.hidden = !paused;
  if (paused) $('#pauseReason').textContent = status.pause_reason || 'No reason given.';
  if (paused !== lastPaused) {
    toggle.textContent = paused ? 'Resume' : 'Pause';
    toggle.className = 'btn ' + (paused ? 'btn-green resume' : 'btn-amber');
    lastPaused = paused;
  }
}

const GUARDRAIL_TEXT = {
  checkpoint: 'LinkedIn showed a captcha or security check. Solve it in the browser window, then re-check.',
  login_lost: 'Your LinkedIn session was lost. Log back in via the browser window, then re-check.',
  repeated_failures: 'Several actions failed in a row (LinkedIn may have changed its UI or is blocking us). Check the browser window, then re-check.',
};

/* Why automatic enrichment stopped, in the operator's terms rather than Apify's. Keep in
   step with EnrichHaltReason (src/types.ts) — but an unknown reason must still render, so
   the fallback below uses the server's detail rather than leaving an empty amber bar. */
const ENRICH_HALT_TEXT = {
  no_api_key: 'No Apify API key is configured, so new connections can’t be enriched. Add one below.',
  auth: 'Apify rejected your API key. It may have been rotated or revoked — press Replace below and paste a fresh one.',
  billing: 'Apify refused the run for billing reasons — your plan may be out of credit.',
  rate_limit: 'Apify is rate-limiting this account. It usually clears on its own.',
  upstream: 'Apify is returning server errors. This is usually temporary.',
  repeated_errors: 'Several profiles failed in a row, so enrichment stopped instead of burning attempts on all of them.',
};

/* Enrichment halt banner. Unattended work needs a visible failure: without this, a rotated
   key is a line in relay.log while the roster quietly stops growing. */
function applyEnrichHaltUi(status) {
  const banner = $('#enrichBanner');
  if (!banner) return;
  const h = (status && status.enrich_halt) || null;
  banner.hidden = !h;
  if (!h) return;
  $('#enrichHaltReason').textContent = ENRICH_HALT_TEXT[h.reason] || h.detail || 'Enrichment stopped.';
  // Only show the raw error when it adds something beyond the sentence above.
  $('#enrichHaltDetail').textContent = ENRICH_HALT_TEXT[h.reason] && h.detail ? h.detail : '';
  $('#enrichHaltTime').textContent = h.at ? `Stopped ${fmtTime(h.at)}` : '';
}

function applyGuardrailUi(status) {
  const banner = $('#guardrailBanner');
  const g = (status && status.guardrail) || {};
  const tripped = !!g.tripped;
  banner.hidden = !tripped;
  if (tripped) {
    $('#guardrailReason').textContent = GUARDRAIL_TEXT[g.reason] || g.detail || 'Automation was halted.';
    // The specific cause (which page, which pattern, screenshot path) — everything
    // beyond the generic reason text — so "what actually happened?" is answerable.
    const generic = !g.detail || g.detail === 'Captcha/checkpoint detected';
    $('#guardrailDetail').textContent = generic ? '' : g.detail;
    $('#guardrailTime').textContent = g.trippedAt ? `Halted ${fmtTime(g.trippedAt)}` : '';
    loadGuardrailShot(g);
  }
}

/* Link the banner to the screenshot captured at trip time. Fetched once per trip
   (keyed on trippedAt) so the status poll doesn't hammer /api/incidents.
   Only evidence from THIS trip qualifies: the tripping attempt starts minutes
   before the trip is recorded, so allow a 10-minute lead — anything older is a
   past incident and linking it misleads (the 2026-07-27 halt showed a 5-day-old
   email-required capture as if it were the cause). */
let shotLoadedFor = null;
async function loadGuardrailShot(g) {
  const link = $('#guardrailShot');
  if (!link || shotLoadedFor === g.trippedAt) return;
  shotLoadedFor = g.trippedAt;
  link.hidden = true;
  if (!g.trippedAt) return;
  try {
    const since = new Date(new Date(g.trippedAt).getTime() - 10 * 60 * 1000).toISOString();
    const rows = await api(`/api/incidents?limit=1&since=${encodeURIComponent(since)}`);
    if (rows.length && rows[0].screenshot) { link.href = rows[0].screenshot; link.hidden = false; }
  } catch (_) { /* no evidence captured for this trip */ }
}

async function refreshStatus() {
  try {
    const status = await api('/api/status');
    renderEngine(status);
    applyEngineState(status);
    applyPauseUi(status);
    applyGuardrailUi(status);
    applyEnrichHaltUi(status);
  } catch (_) { /* transient; next tick retries */ }
}

/* ---------- note hover popover ----------
   The "Up next" notes don't fit inline, so each row shows a small glyph that
   reveals the full note on hover/focus. The popover lives on <body> with
   position:fixed so it escapes the table's overflow:hidden (rounded corners),
   and flips above→below when there isn't room overhead. */
const ICON_NOTE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_NONOTE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6 18.4 18.4" stroke-linecap="round"/></svg>';

/* ---------- campaign-kind marker ----------
   Invite and message rows interleave in the queue and in the shared outcome
   drill-downs, so each row carries a small glyph: a person-plus for connection
   requests, an envelope for messages (teal — the messages identity colour). */
const ICON_KIND_INVITE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><path d="M15.5 20v-1.6a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20" stroke-linecap="round"/><circle cx="8.75" cy="7.5" r="3.5"/><path d="M18.5 7.5h4M20.5 5.5v4" stroke-linecap="round"/></svg>';
const ICON_KIND_MESSAGE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="m3.9 7 8.1 5.8L20.1 7" stroke-linecap="round"/></svg>';

const ICON_KIND_EVENT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><rect x="3" y="4.5" width="18" height="16" rx="2.5"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4" stroke-linecap="round"/></svg>';

/* A post engagement isn't a campaign KIND — its rows live in their own table and target a
   post, not a person — but it shares the Attention table with the three that are, so it
   needs a glyph in the same family. */
const ICON_KIND_ENGAGE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><path d="M7 21V10.5l4.2-7a1.6 1.6 0 0 1 2.9 1.2L13.3 9h4.9a2 2 0 0 1 2 2.3l-1.2 7A2 2 0 0 1 17 20H7z" stroke-linecap="round" stroke-linejoin="round"/><rect x="3" y="10.5" width="4" height="10.5" rx="1"/></svg>';

const KIND_MARKS = {
  message: { icon: ICON_KIND_MESSAGE, cls: ' message', label: 'Message', title: 'Message to an existing connection' },
  event: { icon: ICON_KIND_EVENT, cls: ' event', label: 'Event invite', title: 'Invitation to a LinkedIn event' },
  engagement: { icon: ICON_KIND_ENGAGE, cls: ' engagement', label: 'Post engagement', title: 'Reaction (and optional comment) on a post' },
  invite: { icon: ICON_KIND_INVITE, cls: '', label: 'Connection request', title: 'Connection request' },
};

function kindMark(kind) {
  const mark = KIND_MARKS[kind] || KIND_MARKS.invite;
  const node = el('span', {
    class: `kind-mark${mark.cls}`, role: 'img', 'aria-label': mark.label, title: mark.title,
  });
  node.innerHTML = mark.icon;
  return node;
}

let notePop = null;
function ensureNotePop() {
  if (!notePop) {
    notePop = el('div', { class: 'note-pop', role: 'tooltip' });
    notePop.hidden = true;
    document.body.appendChild(notePop);
  }
  return notePop;
}
function showNotePop(anchor, text) {
  const pop = ensureNotePop();
  pop.textContent = text;
  pop.hidden = false;
  const a = anchor.getBoundingClientRect();
  const p = pop.getBoundingClientRect();
  const below = a.top - p.height - 8 < 8;
  const top = below ? a.bottom + 8 : a.top - p.height - 8;
  let left = a.left + a.width / 2 - p.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - p.width - 8));
  pop.style.top = `${top}px`;
  pop.style.left = `${left}px`;
  pop.classList.toggle('below', below);
}
function hideNotePop() { if (notePop) notePop.hidden = true; }

function noteButton(note) {
  const has = !!(note && note.trim());
  const text = has ? note : 'No note — bare request';
  const btn = el('button', {
    // `is-empty`, NOT `empty`: `.empty` is the page-level empty-state block
    // (padding: 48px 20px). Same specificity as `.note-btn` and declared later, so it
    // won the padding cascade and — box-sizing being border-box — clamped the glyph's
    // height:30px up to its own padding, blowing every note-less queue row out to ~114px.
    class: 'note-btn' + (has ? '' : ' is-empty'),
    type: 'button',
    'aria-label': has ? `Note: ${note}` : 'No note — bare request',
    onmouseenter: function () { showNotePop(this, text); },
    onmouseleave: hideNotePop,
    onfocus: function () { showNotePop(this, text); },
    onblur: hideNotePop,
  });
  btn.innerHTML = has ? ICON_NOTE : ICON_NONOTE;
  return btn;
}

let queueDragging = false;

/* Queue cohorts start collapsed (they can be huge); the ids the user expanded
   survive the 15s re-render and full reloads. */
const expandedCohorts = new Set(
  (() => { try { return JSON.parse(localStorage.getItem('machine.expandedCohorts') || '[]'); } catch (_) { return []; } })(),
);
function isCohortCollapsed(id) { return !expandedCohorts.has(id); }
function toggleCohortCollapse(id) {
  if (expandedCohorts.has(id)) expandedCohorts.delete(id); else expandedCohorts.add(id);
  try { localStorage.setItem('machine.expandedCohorts', JSON.stringify([...expandedCohorts])); } catch (_) { /* ignore */ }
}

/* A scheduled time in the past means "sends on the next tick (or gets re-flowed)" —
   show that instead of a stale timestamp. */
function fmtQueueTime(p) {
  if (p.status === 'scheduled' && p.scheduled_for && new Date(p.scheduled_for).getTime() <= Date.now()) return 'due now';
  return fmtTime(p.scheduled_for);
}

async function refreshQueue() {
  if (queueDragging) return; // don't clobber an in-progress drag / action
  const container = $('#queueGroups'), empty = $('#queueEmpty'), count = $('#queueCount');
  try {
    const { cohorts, events = [] } = await api('/api/queue/grouped');
    const total = cohorts.reduce((n, c) => n + c.count, 0);
    const evTotal = events.reduce((n, e) => n + (e.pending || 0), 0);
    count.textContent = evTotal
      ? `${total} up for processing · ${plural(evTotal, 'event invite')}`
      : `${total} up for processing`;
    if (!cohorts.length && !events.length) { container.replaceChildren(); empty.hidden = false; return; }
    empty.hidden = true;
    // Event runs lead: one holds a reserved block of the day, and the send planner routes
    // the cohorts below it around that block rather than the other way round.
    container.replaceChildren(...events.map(renderEventGroup), ...cohorts.map(renderCohortGroup));
  } catch (_) { /* transient */ }
}

/**
 * An armed event campaign, as a queue group.
 *
 * Rows are LOCATIONS, not people — that is the unit a run actually works through, and the
 * unit that decides whether someone gets reached at all. No drag handle and no remove
 * button: the run's place in the day is the planner's to give, and the only edits that are
 * safe (dropping a location, stopping the campaign) live on the Events tab where the full
 * ladder is visible.
 */
function renderEventGroup(e) {
  const when = e.reserved_from
    ? el('span', { class: 'qg-when', text: `${fmtRelDay(e.reserved_from)} ~${fmtClock(e.reserved_from)}` })
    : el('span', { class: 'qg-when is-unscheduled', text: 'awaiting a free window' });

  const header = el('div', { class: 'qg-head' },
    kindMark('event'),
    el('span', { class: 'qg-name', text: e.title || e.event_url.replace(/^https?:\/\/(www\.)?/, '') }),
    el('span', { class: 'qg-count', text: `${plural(e.pending || 0, 'person', 'people')} to invite` }),
    when,
    el('span', { class: 'qg-actions' },
      el('button', {
        class: 'qg-ico', title: 'Open this campaign', 'aria-label': 'Open this campaign',
        onclick: () => { switchTab('events'); void evOpen(e.id); },
      }, '↗'),
    ),
  );

  const rows = (e.buckets || []).map((b) => el('div', { class: 'qg-row' },
    el('span', { class: 'qg-loc-rank', text: String(b.rank + 1) }),
    el('span', { class: 'qg-loc' }, b.label,
      el('small', { text: `${fmtInt(b.roster_count)} connections to page through` })),
    el('span', { class: 'qg-loc-n', text: `${b.target_count} to invite` }),
  ));
  const body = el('div', { class: 'qg-body' }, ...rows);
  if (e.locations_left > 0) {
    body.appendChild(el('div', {
      class: 'qg-foot',
      text: `${plural(e.locations_left, 'location')} roll into a later run.`,
    }));
  }
  return el('div', { class: 'qg qg-event' }, header, body);
}

function renderCohortGroup(c) {
  const collapsed = isCohortCollapsed(c.id);
  const groupKind = (c.profiles[0] && c.profiles[0].kind) || 'invite';
  const chevron = el('button', {
    class: 'qg-ico qg-chevron' + (collapsed ? ' is-collapsed' : ''),
    type: 'button',
    title: collapsed ? 'Expand cohort' : 'Collapse cohort',
    'aria-expanded': String(!collapsed),
    onclick: (e) => {
      e.stopPropagation();
      toggleCohortCollapse(c.id);
      const qg = e.currentTarget.closest('.qg');
      const isNow = isCohortCollapsed(c.id);
      qg.classList.toggle('is-collapsed', isNow);
      e.currentTarget.classList.toggle('is-collapsed', isNow);
      e.currentTarget.title = isNow ? 'Expand cohort' : 'Collapse cohort';
      e.currentTarget.setAttribute('aria-expanded', String(!isNow));
    },
  }, '⌄');
  const header = el('div', {
    class: 'qg-head', draggable: 'true', 'data-cohort': String(c.id),
    ondragstart: (e) => { queueDragging = true; e.dataTransfer.setData('text/plain', String(c.id)); e.dataTransfer.effectAllowed = 'move'; },
    ondragend: () => { queueDragging = false; },
    ondragover: (e) => { e.preventDefault(); e.currentTarget.classList.add('drop-hint'); },
    ondragleave: (e) => e.currentTarget.classList.remove('drop-hint'),
    ondrop: (e) => { e.preventDefault(); e.currentTarget.classList.remove('drop-hint'); onCohortDrop(Number(e.dataTransfer.getData('text/plain')), c.id); },
  },
    chevron,
    el('span', { class: 'qg-drag', 'aria-hidden': 'true' }, '⋮⋮'),
    // Cohort kind is fixed at creation, so the group speaks for all its rows — which
    // matters most while the group is collapsed and the rows are hidden.
    kindMark(groupKind),
    el('span', { class: 'qg-name' }, c.name || '—'),
    el('span', { class: 'qg-count' }, `${c.count} in queue`),
    el('span', { class: 'qg-actions' },
      el('button', { class: 'qg-ico', title: 'Prioritize cohort', onclick: () => queueAction(`/api/queue/cohort/${c.id}/move`, { to: 'top' }) }, '⤒'),
      el('button', { class: 'qg-ico rm', title: 'Remove cohort from queue', onclick: () => queueAction(`/api/queue/cohort/${c.id}/remove`) }, '✕'),
    ),
  );
  const rows = c.profiles.map((p) => el('div', { class: 'qg-row' },
    kindMark(p.kind),
    el('a', { class: 'qg-slug', href: p.profile_url, target: '_blank', rel: 'noopener', text: slugFromUrl(p.profile_url) }),
    el('span', { class: `pill ${p.status}`, text: p.status.replace('_', ' ') }),
    el('span', { class: 'qg-time mono', text: fmtQueueTime(p) }),
    el('span', { class: 'qg-actions' },
      noteButton(p.note),
      el('button', { class: 'qg-ico', title: 'Send next', onclick: () => queueAction(`/api/queue/profile/${p.id}/move`, { to: 'top' }) }, '⤒'),
      el('button', { class: 'qg-ico rm', title: 'Remove', onclick: () => queueAction(`/api/queue/profile/${p.id}/remove`) }, '✕'),
    ),
  ));
  return el('div', { class: 'qg' + (collapsed ? ' is-collapsed' : '') }, header, el('div', { class: 'qg-body' }, ...rows));
}

async function onCohortDrop(draggedId, targetId) {
  if (!draggedId || draggedId === targetId) { queueDragging = false; return; }
  const order = $$('#queueGroups .qg-head').map((h) => Number(h.dataset.cohort));
  const from = order.indexOf(draggedId), to = order.indexOf(targetId);
  if (from === -1 || to === -1) { queueDragging = false; return; }
  order.splice(to, 0, order.splice(from, 1)[0]);
  queueDragging = false;
  await queueAction('/api/queue/cohorts/reorder', { order });
}

async function queueAction(path, body) {
  try {
    await api(path, { method: 'POST', body: body ?? {} });
    await refreshQueue();
    await refreshStatus();
  } catch (_) { /* ignore */ }
}

/* ---------- status drill-down drawer ----------
   The engine's Pending / Accepted stations and Expired / Already-connected outcome
   cards open a slide-over listing the profiles behind that number. */
const DRILL_DATE = {
  sent: { field: 'sent_at', label: 'sent' },
  accepted: { field: 'accepted_at', label: 'accepted' },
  replied: { field: 'replied_at', label: 'replied' },
  expired: { field: 'sent_at', label: 'sent' },
};

/* Human labels for profiles.skip_reason; NULL (legacy rows) renders as a dash. */
const SKIP_REASON_LABEL = {
  already_connected: 'already connected',
  email_required: 'requires their email',
  not_found: 'profile no longer exists',
  unavailable: 'composer unavailable',
  dismissed: 'dismissed',
  not_connected: 'not a 1st-degree connection',
};

function closeDrawer() {
  $('#statusDrawer').hidden = true;
  $('#drawerBackdrop').hidden = true;
}

/* `kind` narrows the drill to one campaign kind (each engine's stations pass their
   own); left undefined for the shared outcomes, which list both kinds together. */
async function openDrawer(status, title, kind) {
  const drawer = $('#statusDrawer'), body = $('#drawerBody');
  $('#drawerTitle').textContent = title;
  $('#drawerCount').textContent = 'loading…';
  body.replaceChildren();
  drawer.hidden = false;
  $('#drawerBackdrop').hidden = false;
  try {
    const query = `/api/profiles?status=${encodeURIComponent(status)}`
      + (kind ? `&kind=${encodeURIComponent(kind)}` : '');
    const rows = await api(query);
    $('#drawerCount').textContent = `${rows.length} profile${rows.length === 1 ? '' : 's'}`;
    if (!rows.length) {
      body.replaceChildren(el('div', { class: 'drawer-empty', text: 'No profiles with this status yet.' }));
      return;
    }
    const d = DRILL_DATE[status] || { field: 'sent_at', label: 'sent' };
    body.replaceChildren(...rows.map((p) => el('div', { class: 'drawer-row' },
      // A kind-filtered drill needs no marker — every row is that kind. The shared
      // outcomes mix both, and there "not a 1st-degree connection" only parses if you
      // can see the row is a message.
      el('div', { class: 'drawer-slug-cell' },
        kind ? null : kindMark(p.kind),
        el('a', { class: 'drawer-slug', href: p.profile_url, target: '_blank', rel: 'noopener', text: slugFromUrl(p.profile_url) }),
      ),
      el('span', { class: 'drawer-cohort', text: p.cohort_name || '—' }),
      status === 'skipped'
        ? el('span', { class: 'drawer-date', text: SKIP_REASON_LABEL[p.skip_reason] || '—' })
        : el('span', { class: 'drawer-date mono', text: p[d.field] ? `${d.label} ${fmtTime(p[d.field])}` : '—' }),
    )));
  } catch (_) {
    $('#drawerCount').textContent = '';
    body.replaceChildren(el('div', { class: 'drawer-empty', text: 'Failed to load profiles.' }));
  }
}

function initDrawer() {
  $$('.is-drill').forEach((card) => {
    const open = () => openDrawer(card.dataset.drill, card.dataset.drillTitle, card.dataset.drillKind);
    card.addEventListener('click', open);
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  });
  $('#drawerClose').addEventListener('click', closeDrawer);
  $('#drawerBackdrop').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeDrawer();
    closeAttentionModal();
    closeCohortModal();
  });
}

/* ---------- needs-attention modal ---------- */
function openAttentionModal() {
  $('#attentionResult').hidden = true; // stale toast from a previous open
  $('#attentionModal').hidden = false;
  loadAttention();
}
function closeAttentionModal() { $('#attentionModal').hidden = true; }

/**
 * Which table an Attention row belongs to.
 *
 * /api/attention interleaves TWO tables — profiles and engagements — and their ids are
 * independent sequences, so the discriminator is the only thing standing between a Retry
 * button and a write aimed at an unrelated row. Getting this wrong is not a cosmetic bug:
 * POSTing an engagement's id to /api/profiles/:id/retry re-queues whichever PERSON happens
 * to share that number, and that person gets contacted again.
 *
 * The server tags both sides (see /api/attention), so the tag is normally just read. The
 * shape fallback covers an untagged row rather than guessing: an engagement carries
 * post_url and never profile_url, so the two are distinguishable without the tag at all.
 */
function attentionRowSource(row) {
  if (row.source === 'engagement' || row.source === 'profile') return row.source;
  return row.post_url && !row.profile_url ? 'engagement' : 'profile';
}

/** The retry/dismiss endpoint for one Attention row. Pure, and tested as such. */
function attentionActionPath(row, action) {
  const base = attentionRowSource(row) === 'engagement' ? '/api/engagements' : '/api/profiles';
  return `${base}/${row.id}/${action}`;
}

/** How a row names itself in a toast. */
function attentionRowLabel(row) {
  return attentionRowSource(row) === 'engagement'
    ? postLabel(row.post_url)
    : slugFromUrl(row.profile_url);
}

function attentionActions(row) {
  return el('td', { class: 'row-actions' },
    el('button', { class: 'btn btn-ghost', onclick: (e) => actOnAttentionRow(row, 'retry', e.currentTarget) }, 'Retry'),
    el('button', { class: 'btn btn-ghost', onclick: (e) => actOnAttentionRow(row, 'dismiss', e.currentTarget) }, 'Dismiss'),
  );
}

function attnStatusCell(status) {
  return el('td', { class: 'status-cell' },
    el('span', { class: `pill ${status}`, text: String(status).replace('_', ' ') }));
}

/* A profile row: unchanged from before engagements existed. */
function renderProfileAttentionRow(p) {
  return el('tr', {},
    el('td', { class: 'trunc' }, el('div', { class: 'attn-profile' },
      kindMark(p.kind),
      el('a', { href: p.profile_url, target: '_blank', rel: 'noopener', title: p.profile_url || '', text: slugFromUrl(p.profile_url) }),
    )),
    el('td', { class: 'mono trunc', title: p.cohort_name || '' }, p.cohort_name || '—'),
    attnStatusCell(p.status),
    el('td', { class: 'num mono' }, String(p.attempts ?? 0)),
    el('td', { class: 'err trunc', title: p.last_error || '' }, p.last_error || '—'),
    attentionActions(p),
  );
}

/**
 * An engagement row: a POST, not a person, so it fills the shared table's two identity
 * columns with what it actually has — the post URL, and the reaction it was going to leave.
 *
 * The comment's state is called out on purpose. `needs_attention` on this pipeline usually
 * means the reaction landed but the comment could not be verified, and that is precisely
 * the case where the operator must open the post before deciding to retry.
 *
 * Which is why a parked row NEVER reads "comment posted". commented_at is stamped on an
 * unverified comment too — it records the irreversible submit click so the daily comment
 * cap counts it (see the `unverified` branch in worker/sender.ts) — so on a parked row the
 * timestamp means "may be live", not "confirmed". Reading it as posted would tell the
 * operator the one thing this row exists to say cannot be assumed.
 */
function renderEngagementAttentionRow(e) {
  const unverifiedComment = !!e.comment_text && e.status === 'needs_attention';
  const pendingComment = !!e.comment_text && !e.commented_at && !unverifiedComment;
  const detail = el('div', { class: 'attn-engage' },
    el('span', { class: 'eng-up-react', text: reactionLabel(e.reaction) }),
  );
  if (unverifiedComment) detail.appendChild(el('span', { class: 'attn-comment', text: 'comment unverified' }));
  else if (pendingComment) detail.appendChild(el('span', { class: 'attn-comment', text: 'comment pending' }));
  else if (e.comment_text) detail.appendChild(el('span', { class: 'attn-comment is-done', text: 'comment posted' }));

  return el('tr', {},
    el('td', { class: 'trunc' }, el('div', { class: 'attn-profile' },
      kindMark('engagement'),
      el('a', { href: e.post_url, target: '_blank', rel: 'noopener', title: e.post_url || '', text: postLabel(e.post_url) }),
    )),
    el('td', { class: 'trunc' }, detail),
    attnStatusCell(e.status),
    el('td', { class: 'num mono' }, String(e.attempts ?? 0)),
    el('td', { class: 'err trunc', title: e.last_error || '' }, e.last_error || '—'),
    attentionActions(e),
  );
}

async function loadAttention() {
  const body = $('#attentionBody'), empty = $('#attentionEmpty');
  try {
    const rows = await api('/api/attention');
    if (!rows.length) { body.replaceChildren(); empty.hidden = false; return; }
    empty.hidden = true;
    // Both PIPELINES land here — three campaign kinds of person plus posts — so every row
    // carries a kind glyph and is rendered by the branch that knows its fields.
    body.replaceChildren(...rows.map((row) => (attentionRowSource(row) === 'engagement'
      ? renderEngagementAttentionRow(row)
      : renderProfileAttentionRow(row))));
  } catch (_) { empty.hidden = false; }
}

async function actOnAttentionRow(row, action, btn) {
  const result = $('#attentionResult');
  const label = attentionRowLabel(row);
  if (btn) { btn.disabled = true; btn.textContent = action === 'retry' ? 'Retrying…' : 'Dismissing…'; }
  try {
    await api(attentionActionPath(row, action), { method: 'POST' });
    toast(result, action === 'retry'
      ? `Requeued ${label} — it's back in the queue.`
      : `Dismissed ${label}.`);
    await loadAttention();
    await refreshStatus();
  } catch (err) {
    toast(result, `Failed: ${err.message}`, true);
    if (btn) { btn.disabled = false; btn.textContent = action === 'retry' ? 'Retry' : 'Dismiss'; }
  }
}

function initAttention() {
  $('#attentionClose').addEventListener('click', closeAttentionModal);
  $('#attentionModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeAttentionModal(); });
  const retryAll = $('#attentionRetryAll');
  if (retryAll) retryAll.addEventListener('click', async () => {
    const result = $('#attentionResult');
    retryAll.disabled = true;
    const original = retryAll.textContent;
    retryAll.textContent = 'Retrying…';
    try {
      const res = await api('/api/retry', { method: 'POST' });
      const n = res && typeof res.retried === 'number' ? res.retried : 0;
      retryAll.textContent = `Requeued ${n}`;
      toast(result, n ? `Requeued ${n} profile${n === 1 ? '' : 's'} — they'll be re-scheduled and retried.` : 'Nothing to retry.');
      await loadAttention();
      await refreshStatus();
    } catch (err) {
      retryAll.textContent = 'Failed';
      toast(result, `Failed: ${err.message}`, true);
    }
    setTimeout(() => { retryAll.textContent = original; retryAll.disabled = false; }, 2500);
  });
}

/* Reasons a forced reconciliation pass didn't run; shared by both recheck buttons
   (the acceptance and reply checkers report the same gate names). */
const RECHECK_REASON = {
  paused: 'Paused',
  guardrail: 'Blocked — check attention',
  logged_out: 'Logged out',
  login_lost: 'Logged out',
  read_error: 'Read failed',
};

/* Wire a station's recheck button: POST, then report the verdict through the button's
   tooltip and a visually-hidden aria-live span, and re-enable after a beat. */
function wireRecheck({ btn, statusEl, endpoint, countKey, none, reasons }) {
  if (!btn) return;
  // The station itself is a drill target; keep the button's own activation keys
  // (Enter/Space) from bubbling to the station's drill handler. Let every other key
  // through — notably Escape must still reach the document handler that closes drawers.
  btn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); });
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    btn.disabled = true;
    btn.classList.add('busy');
    const original = btn.title;
    try {
      const res = await api(endpoint, { method: 'POST' });
      const found = res ? res[countKey] : 0;
      const label = res && res.ran
        ? (found > 0 ? `Found ${found}` : none)
        : ({ ...RECHECK_REASON, ...reasons }[res && res.reason] || 'Done');
      btn.title = label;
      if (statusEl) statusEl.textContent = label;
      await refreshStatus();
    } catch (_) {
      btn.title = 'Failed';
      if (statusEl) statusEl.textContent = 'Recheck failed';
    }
    btn.classList.remove('busy');
    setTimeout(() => { btn.title = original; btn.disabled = false; }, 2500);
  });
}

/* ---------- per-conveyor manual trigger ---------- */

/**
 * Short button labels for each pre-flight refusal code (POST /api/run-now answers 409).
 * The full sentence goes in the tooltip and out over the live region instead: the button is
 * sized for "Nothing queued", not for "Weekly cap reached — 100/100 invitations this week",
 * and a truncated reason is exactly how an operator ends up guessing at why nothing sent.
 *
 * A code missing from this table (`internal_error`, or whatever a later server adds) falls
 * back to 'Failed' rather than putting the raw token on the face — the sentence beside it
 * is written for a human, the code is not.
 */
const RUN_BELT_LABELS = {
  paused: 'Paused',
  guardrail: 'Halted',
  not_logged_in: 'Not logged in',
  capped: 'Capped',
  nothing_armed: 'Nothing armed',
  // NOT 'Running': the in-flight label on this same button is 'Running…', and a refusal that
  // reads as the state it is refusing is a refusal an operator will not notice. Every label
  // here also stays within "Nothing queued", the longest string .run-belt's min-width is
  // sized for, so reporting a verdict never resizes the button.
  already_running: 'In progress',
  daily_cap: 'Daily cap',
};

/* How long a verdict stays on the face before the button goes back to reading "Run now". */
const RUN_BELT_REVERT_MS = 2500;

/* A trigger's live region: the one .run-belt-status in its own pills row. Paired by class
   rather than by #run<Belt>Status id, so four buttons need no id table over here —
   index.html documents that class as precisely this hook. */
function beltStatusEl(btn) {
  return btn.parentElement ? $('.run-belt-status', btn.parentElement) : null;
}

/* The conveyor's name as this app speaks it ("connection requests"), read off the button's
   own aria-label ("Run now, connection requests") rather than from a second table here.
   The announcement needs the name: heard with no card around it, four belts' worth of
   "Queued 3" are indistinguishable, and they fire four different irreversible actions.
   Deriving it means the spoken name cannot drift from the one index.html declares; if that
   label is ever reworded past recognition this degrades to the belt key rather than lying. */
function beltName(btn) {
  const label = btn.getAttribute('aria-label') || '';
  const comma = label.indexOf(',');
  return comma < 0 ? (btn.dataset.belt || 'this conveyor') : label.slice(comma + 1).trim();
}

/**
 * What one /api/run-now answer means, in the three registers the UI reports it in: `label`
 * for the button face (short — see RUN_BELT_LABELS), `title` for the tooltip, and `say` for
 * the aria-live span, which is heard with no card and no button around it and so names the
 * conveyor and carries the whole reason.
 */
function runBeltVerdict(ok, data, belt, name) {
  if (!ok) {
    // A 409 refusal always carries both fields. The other two failures fall through to
    // 'Failed' by design: a 400 (unknown belt) has an `error` and no `code` at all, and the
    // event belt's 500 has `internal_error`, a code deliberately left out of the table.
    const why = data.error || 'Could not run this batch';
    return {
      label: RUN_BELT_LABELS[data.code] || 'Failed',
      title: why,
      say: `Cannot run ${name}: ${why}`,
    };
  }
  if (belt === 'event') {
    // Returns BEFORE the `promoted` checks below, and that ordering is load-bearing: the
    // event answer has no `promoted` field at all — there is no unit to count, the moved run
    // window IS the payload — so falling through would read the absence as a zero and report
    // "Nothing queued" for a run that is about to start.
    return {
      label: 'Starting…',
      title: 'Run window moved to now — the next pass starts it',
      say: `Starting the next run for ${name}.`,
    };
  }
  // Every sender-belt success carries a numeric `promoted` (server.ts sends an explicit 0
  // when nothing moved), so a falsy value here is a real zero, not a missing field.
  const n = data.promoted;
  if (!n) {
    return {
      label: 'Nothing queued',
      title: 'Nothing was waiting to send',
      say: `Nothing queued for ${name}.`,
    };
  }
  if (data.started) {
    return {
      label: `Triggered ${n}`,
      title: `Sending ${n} now`,
      say: `Triggered ${n} ${name}, sending now.`,
    };
  }
  // Promoted but not started: the rows ARE due now and the next pass drains them. Saying
  // "Triggered" here would report a send that has not happened.
  const why = data.deferred || 'the browser is busy';
  return {
    label: `Queued ${n}`,
    title: `${n} are due now — ${why}; the next pass sends them`,
    say: `Queued ${n} ${name} — ${why}. The next pass sends them.`,
  };
}

/**
 * One conveyor's manual trigger.
 *
 * Reports the verdict three ways: the button face (for a glance), the tooltip (the full
 * sentence), and the card's visually-hidden aria-live span — the same contract .recheck-btn
 * follows (wireRecheck above), and the reason index.html gives each button a status span. A
 * rewritten label is silent to a screen reader once focus has moved on, and these buttons
 * fire irreversible LinkedIn actions.
 *
 * Uses fetch directly rather than api(): a refusal body carries BOTH a `code` (which picks
 * the short label) and an `error` (the sentence), and api() throws away all but `error`.
 *
 * `state` is this one button's, created per button in initDashboard. It holds the pristine
 * idle label and the pending revert, neither of which may leak into the next click.
 */
async function runBelt(btn, state) {
  // A re-entrancy guard, not just `disabled`. The second click of a double-click is one POST
  // away from a burst of real sends, so it is dropped here rather than trusted to an
  // attribute — a synthetic click, or a stray render that re-enables the button mid-flight,
  // still reaches this listener.
  if (state.running) return;
  state.running = true;

  // Captured ONCE, on the first click, and never re-read. Re-reading per click latches: a
  // click landing while "Triggered 4" is still on the face would take THAT as the label to
  // restore, and the button would read "Triggered 4" for the rest of the session.
  if (!state.idle) state.idle = { label: btn.textContent, title: btn.title };
  clearTimeout(state.revert); // a verdict still showing belongs to the previous run

  const statusEl = beltStatusEl(btn);
  const name = beltName(btn);
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  btn.textContent = 'Running…';
  // Announced before the verdict, so that two identical verdicts in a row still change this
  // region's text between them and are therefore both spoken.
  if (statusEl) statusEl.textContent = `Running ${name} now…`;

  let verdict;
  try {
    const res = await fetch('/api/run-now', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ belt: btn.dataset.belt }),
    });
    let data = {};
    try { data = await res.json(); } catch (_) { /* keep the empty object */ }
    verdict = runBeltVerdict(res.ok, data, btn.dataset.belt, name);
  } catch (_) {
    // fetch rejects only on a transport failure, and a POST that died in flight may well
    // have been received and acted on. A flat 'Failed' would be a claim we cannot support;
    // the only honest thing to report is that we do not know.
    verdict = {
      label: 'No response',
      title: 'Could not reach Relay — this batch may or may not have started',
      say: `No response from Relay for ${name}. The batch may or may not have started.`,
    };
  }

  btn.textContent = verdict.label;
  btn.title = verdict.title;
  btn.removeAttribute('aria-busy');
  if (statusEl) statusEl.textContent = verdict.say;

  // Deliberately after the verdict is already on the button, and in a try of their own. Both
  // of these swallow their own errors today, but the label is the only receipt an operator
  // gets for an irreversible action: it must not be reachable from a refresh's failure path,
  // where a batch that really did fire would end up reported as 'Failed'. Nor may a stale
  // panel cost the button its revert and leave it disabled for good.
  try {
    await refreshStatus();
    await refreshQueue();
  } catch (_) { /* transient; the 15s poll catches the panel up */ }

  state.running = false;
  state.revert = setTimeout(() => {
    btn.textContent = state.idle.label;
    btn.title = state.idle.title;
    btn.disabled = false;
    // The announcement is left standing, as wireRecheck leaves its own: a live region going
    // quiet is not news, and the next run overwrites it.
  }, RUN_BELT_REVERT_MS);
}

function initDashboard() {
  // The "Needs attention" outcome opens the attention modal — but only when it
  // carries a count (renderEngine toggles `is-clickable`).
  const attnCard = $('#outAttnCard');
  if (attnCard) attnCard.addEventListener('click', () => {
    if (attnCard.classList.contains('is-clickable')) openAttentionModal();
  });

  $('#pauseToggle').addEventListener('click', async () => {
    const btn = $('#pauseToggle');
    btn.disabled = true;
    try {
      await api(lastPaused ? '/api/resume' : '/api/pause', { method: 'POST' });
      await refreshStatus();
    } catch (_) { /* ignore */ }
    btn.disabled = false;
  });

  // Each engine's terminal station carries a "recheck now" button: same busy/label/
  // aria-live contract, different endpoint and wording.
  wireRecheck({
    btn: $('#recheckAccept'), statusEl: $('#recheckStatus'),
    endpoint: '/api/recheck-acceptance', countKey: 'accepted', none: 'No new acceptances',
    reasons: { no_pending: 'No pending invites', empty_read: 'No new acceptances' },
  });
  wireRecheck({
    btn: $('#recheckReplies'), statusEl: $('#recheckRepliesStatus'),
    endpoint: '/api/recheck-replies', countKey: 'replied', none: 'No new replies',
    reasons: { no_pending: 'No messages awaiting a reply', empty_read: 'No new replies' },
  });

  const idleCta = $('#msgEngineIdleCta');
  if (idleCta) idleCta.addEventListener('click', () => switchTab('add'));
  const evIdleCta = $('#evEngineIdleCta');
  if (evIdleCta) evIdleCta.addEventListener('click', () => switchTab('events'));

  // One handler per conveyor's manual trigger; the belt travels in data-belt. Each button
  // carries its own state: the pristine idle label to restore, and the pending revert timer.
  for (const btn of $$('.run-belt')) {
    const state = { running: false, idle: null, revert: 0 };
    btn.addEventListener('click', () => { void runBelt(btn, state); });
  }

  $('#retryFailed').addEventListener('click', async () => {
    const btn = $('#retryFailed');
    btn.disabled = true;
    btn.dataset.busy = '1'; // renderEngine leaves the label alone while set
    const original = btn.textContent;
    btn.textContent = 'Retrying…';
    try {
      const res = await api('/api/retry', { method: 'POST' });
      const n = res && typeof res.retried === 'number' ? res.retried : 0;
      btn.textContent = `Requeued ${n}`;
      await refreshStatus();
      await refreshQueue();
    } catch (_) {
      btn.textContent = 'Failed';
    }
    setTimeout(() => { btn.textContent = original; btn.disabled = false; delete btn.dataset.busy; refreshStatus(); }, 2500);
  });

  $('#guardrailRecheck').addEventListener('click', async () => {
    const btn = $('#guardrailRecheck');
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Re-checking…';
    try {
      const res = await api('/api/guardrail/acknowledge', { method: 'POST' });
      btn.textContent = res && res.resumed ? 'Resumed' : 'Still blocked';
      await refreshStatus();
    } catch (_) {
      btn.textContent = 'Failed';
    }
    setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 2500);
  });
}

/* ---------- add list ---------- */
function countProfiles(text) {
  const re = /https?:\/\/[^\s,"'<>]*linkedin\.com\/in\/[A-Za-z0-9\-_%]+\/?/gi;
  const seen = new Set();
  for (const m of String(text).matchAll(re)) seen.add(m[0].toLowerCase().replace(/\/+$/, ''));
  return seen.size;
}

/* Which campaign kind the Add List form is building. */
function selectedListKind() {
  const checked = $$('input[name="listKind"]').find((r) => r.checked);
  return (checked && checked.value) === 'message' ? 'message' : 'invite';
}

/* Cohorts as of the last load — the dropdown only carries names, so picking one needs
   the full row (its template, its kind) without a second round trip. */
let cohortCache = [];

function unlockListCohortName() {
  const name = $('#listCohort');
  if (!name) return;
  name.value = '';
  name.disabled = false;
}

async function loadCohortOptions() {
  const sel = $('#listCohortSelect');
  if (!sel) return;
  const current = sel.value;
  try { cohortCache = await api('/api/cohorts'); } catch (_) { return; } // leave the options as they are
  // A cohort only accepts profiles of its own kind (the API 409s otherwise), so the
  // dropdown offers exactly the cohorts this campaign type can be added to.
  const kind = selectedListKind();
  const matching = cohortCache.filter((c) => (c.kind || 'invite') === kind);
  sel.replaceChildren(
    el('option', { value: '', text: 'New (auto-dated)' }),
    ...matching.map((c) => el('option', { value: c.name, text: c.name })),
  );
  // Preserve the selection when it survived the filter; otherwise fall back to "New"
  // and release the name field the old selection had locked.
  const keep = matching.some((c) => c.name === current);
  sel.value = keep ? current : '';
  if (!keep && current) unlockListCohortName();
}

function initAddList() {
  const tpl = $('#listTemplate'), counter = $('#tplCount'), area = $('#listText');
  const updateTplCount = () => { counter.textContent = `${tpl.value.length} / ${tpl.maxLength}`; };
  tpl.addEventListener('input', updateTplCount);

  // Campaign type reshapes the rail: message bodies are ~7x longer than invite notes,
  // they're mandatory rather than optional, and only same-kind cohorts can receive them.
  const applyKindUi = () => {
    const msg = selectedListKind() === 'message';
    tpl.maxLength = msg ? 2000 : 300;
    tpl.placeholder = msg
      ? 'Hey {firstName}, great to be connected — I wanted to share…'
      : 'Hi {firstName}, I came across your work and…';
    $('#tplLabel').textContent = msg ? 'Message' : 'Message template';
    $('#tplHelp').innerHTML = msg
      ? 'Use <code>{firstName}</code> to personalize. Required — this is the message that gets sent.'
      : 'Use <code>{firstName}</code> to personalize. Leave blank to send without a note.';
    updateTplCount();
    loadCohortOptions();
  };
  $$('input[name="listKind"]').forEach((r) => r.addEventListener('change', applyKindUi));
  applyKindUi();

  $('#listCohort').placeholder = 'e.g. Founders Q3';

  const submitBtn = $('#listForm button[type="submit"]');
  const updateCount = () => {
    const n = countProfiles(area.value);
    $('#listCount').textContent = `${n} profile${n === 1 ? '' : 's'} detected`;
    if (submitBtn) submitBtn.textContent = n ? `Enqueue ${n}` : 'Enqueue';
  };
  area.addEventListener('input', updateCount);
  updateCount();

  // Drag-drop a .csv/.txt onto the profiles box (replaces the old file picker).
  ['dragover', 'dragenter'].forEach((ev) => area.addEventListener(ev, (e) => { e.preventDefault(); area.classList.add('drag'); }));
  ['dragleave', 'dragend'].forEach((ev) => area.addEventListener(ev, () => area.classList.remove('drag')));
  area.addEventListener('drop', (e) => {
    e.preventDefault();
    area.classList.remove('drag');
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const existing = area.value.trim();
      area.value = existing ? existing + '\n' + reader.result : String(reader.result);
      updateCount();
    };
    reader.readAsText(file);
  });

  // Pick an existing cohort -> prefill + lock its name, prefill its template. "New" -> unlock.
  $('#listCohortSelect').addEventListener('change', (e) => {
    const name = e.target.value;
    if (!name) { unlockListCohortName(); return; }
    const c = cohortCache.find((x) => x.name === name);
    if (c) {
      $('#listCohort').value = c.name; $('#listCohort').disabled = true;
      tpl.value = c.message_template || ''; updateTplCount();
    }
  });

  $('#listForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const result = $('#listResult');
    const kind = selectedListKind();
    const template = tpl.value.trim() || undefined;
    // The API 400s on this too, but there's no reason to make the user wait for a
    // round trip to be told a message campaign needs a message.
    if (kind === 'message' && !template) {
      toast(result, 'Messages need a template — write the message that should be sent.', true);
      tpl.focus();
      return;
    }
    const payload = {
      cohort: $('#listCohort').value.trim() || undefined,
      kind,
      text: area.value,
      message_template: template,
    };
    try {
      const r = await api('/api/lists', { method: 'POST', body: payload });
      toast(result, `Added ${r.added} of ${r.found} found.`);
      result.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      area.value = '';
      updateCount();
      loadCohortOptions();
    } catch (err) {
      // A cohort's kind is fixed at creation. That 409 is the one failure here the
      // user can act on, so it gets a sentence instead of a raw error.
      const clash = /is an? (message|invite) cohort/.exec(err.message);
      toast(result, clash
        ? `That cohort already exists as a ${clash[1] === 'message' ? 'message' : 'connection request'} campaign. Use a different name, or switch the campaign type.`
        : `Failed: ${err.message}`, true);
    }
  });
}

/* ---------- cohorts + metrics (merged screen) ---------- */
async function loadCohortsScreen() {
  const [cohorts, metrics, archived] = await Promise.all([
    api('/api/cohorts').catch(() => []),
    api('/api/metrics').catch(() => []),
    api('/api/cohorts/archived').catch(() => []),
  ]);
  // Two funnels, two tables: invites are measured on acceptance, messages on replies.
  const msgRows = metrics.filter((m) => m.kind === 'message');
  renderMetricsTable(metrics.filter((m) => (m.kind || 'invite') === 'invite'));
  renderMsgMetricsTable(msgRows);
  // The invite table only needs a heading once there's a second table to tell it from.
  $('#inviteMetricsHead').hidden = msgRows.length === 0;
  renderCohortList(cohorts, metrics);
  renderArchivedList(archived);
}

function renderMetricsTable(rows) {
  const body = $('#metricsBody'), empty = $('#metricsEmpty');
  if (!rows.length) { body.replaceChildren(); empty.hidden = false; return; }
  empty.hidden = true;
  body.replaceChildren(...rows.map((m) => {
    const pct = Math.round((m.acceptance_rate || 0) * 100);
    const rateCell = el('div', { class: 'rate-cell' },
      el('div', { class: 'rate-bar' }, el('i', { style: `width:${pct}%` })),
      el('span', { class: 'rate-val', text: `${pct}%` }),
    );
    const median = (m.median_time_to_accept_days == null) ? '—' : m.median_time_to_accept_days.toFixed(1);
    return el('tr', {},
      el('td', { class: 'mono' }, m.cohort_name || '—'),
      el('td', { class: 'num mono' }, String(m.total)),
      el('td', { class: 'num mono' }, String(m.sent)),
      el('td', { class: 'num mono' }, String(m.accepted)),
      el('td', { class: 'num mono' }, String(m.pending)),
      el('td', { class: 'num mono' }, String(m.expired)),
      el('td', {}, rateCell),
      el('td', { class: 'num mono' }, median),
    );
  }));
}

/* Message cohorts: same table, reply columns. `sent` counts everything delivered
   (replied + still awaiting); messages never expire, so there's no expiry column. */
function renderMsgMetricsTable(rows) {
  const body = $('#msgMetricsBody'), block = $('#msgMetricsBlock');
  if (!body) return;
  block.hidden = rows.length === 0;
  if (!rows.length) { body.replaceChildren(); return; }
  body.replaceChildren(...rows.map((m) => {
    const pct = Math.round((m.reply_rate || 0) * 100);
    const rateCell = el('div', { class: 'rate-cell' },
      el('div', { class: 'rate-bar msg' }, el('i', { style: `width:${pct}%` })),
      el('span', { class: 'rate-val', text: `${pct}%` }),
    );
    const median = (m.median_time_to_reply_days == null) ? '—' : m.median_time_to_reply_days.toFixed(1);
    return el('tr', {},
      el('td', { class: 'mono' }, m.cohort_name || '—'),
      el('td', { class: 'num mono' }, String(m.total)),
      el('td', { class: 'num mono' }, String(m.sent)),
      el('td', { class: 'num mono' }, String(m.replied)),
      el('td', { class: 'num mono' }, String(m.pending)),
      el('td', {}, rateCell),
      el('td', { class: 'num mono' }, median),
    );
  }));
}

function renderCohortList(cohorts, metrics) {
  const list = $('#cohortList'), empty = $('#cohortEmpty');
  const byName = Object.fromEntries(metrics.map((m) => [m.cohort_name, m]));
  empty.hidden = cohorts.length > 0;
  const newTile = el('button', { class: 'cohort-card cohort-new', type: 'button', onclick: () => openCohortEditor(null) },
    el('span', { class: 'cohort-new-plus', 'aria-hidden': 'true' }, '+'),
    el('span', { text: 'New cohort' }),
  );
  list.replaceChildren(...cohorts.map((c) => renderCohortCard(c, byName[c.name])), newTile);
}

function renderCohortCard(c, m) {
  const kind = c.kind || 'invite';
  const isMsg = kind === 'message';
  // Each funnel gets its own headline rate: acceptance for invites, replies for messages.
  const stat = m
    ? (isMsg
      ? `${m.total} profiles · ${m.sent} sent · ${Math.round((m.reply_rate || 0) * 100)}% replied`
      : `${m.total} profiles · ${m.sent} sent · ${Math.round((m.acceptance_rate || 0) * 100)}% accepted`)
    : 'no sends yet';
  const tplText = (c.message_template && c.message_template.trim())
    ? el('div', { class: 'tpl', text: c.message_template })
    : el('div', { class: 'tpl none', text: isMsg ? 'No message set — profiles will need attention' : 'No template (bare request)' });

  // Archive asks in place: the card flips to a confirm state, no browser dialogs.
  const card = el('div', {
    class: 'cohort-card' + (isMsg ? ' is-message' : ''),
    onclick: () => { if (!card.classList.contains('is-confirming')) openCohortEditor(c); },
  },
    el('div', { class: 'cc-main' },
      el('div', { class: 'name' },
        el('span', { text: c.name }),
        el('span', { class: `tag kind-tag ${kind}`, text: isMsg ? 'messages' : 'invites' }),
        el('button', {
          class: 'btn btn-ghost cohort-archive', type: 'button', title: 'Archive cohort',
          onclick: (e) => { e.stopPropagation(); card.classList.add('is-confirming'); },
        }, 'Archive'),
      ),
      el('div', { class: 'cohort-stat', text: stat }),
      tplText,
    ),
    el('div', { class: 'cc-confirm', onclick: (e) => e.stopPropagation() },
      el('p', { class: 'cc-confirm-txt' },
        el('strong', { text: `Archive “${c.name}”?` }),
        ` Anything still queued stops sending. History is kept — restore it any time from “Archived cohorts”.`,
      ),
      el('div', { class: 'cc-confirm-actions' },
        el('button', { class: 'btn btn-ghost', type: 'button', onclick: () => card.classList.remove('is-confirming') }, 'Cancel'),
        el('button', {
          class: 'btn btn-danger', type: 'button',
          onclick: async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true; btn.textContent = 'Archiving…';
            try { await api(`/api/cohorts/${c.id}/archive`, { method: 'POST' }); loadCohortsScreen(); }
            catch (_) { btn.disabled = false; btn.textContent = 'Archive'; }
          },
        }, 'Archive'),
      ),
    ),
  );
  return card;
}

function renderArchivedList(archived) {
  const block = $('#archivedBlock'), list = $('#archivedList'), count = $('#archivedCount');
  if (!block) return;
  block.hidden = !archived.length;
  if (!archived.length) { list.replaceChildren(); return; }
  count.textContent = `(${archived.length})`;
  list.replaceChildren(...archived.map((c) => el('div', { class: 'cohort-card is-archived' },
    el('div', { class: 'name' },
      el('span', { text: c.name }),
      el('button', {
        class: 'btn btn-ghost cohort-archive', type: 'button', title: 'Restore cohort',
        onclick: async () => {
          try { await api(`/api/cohorts/${c.id}/unarchive`, { method: 'POST' }); loadCohortsScreen(); } catch (_) { /* ignore */ }
        },
      }, 'Restore'),
    ),
    el('div', { class: 'cohort-stat', text: 'archived' }),
  )));
}

function openCohortEditor(c) {
  $('#cohortResult').hidden = true; // stale toast from a previous open
  $('#cohortFormTitle').textContent = c ? `Edit “${c.name}”` : 'New cohort';
  $('#cohortName').value = c ? (c.name || '') : '';
  $('#cohortName').disabled = !!c; // name is the key; edit templates, not names
  // Kind is chosen once, at creation: its profiles are already queued as that kind
  // and the API refuses to flip it.
  const kindSel = $('#cohortKind');
  kindSel.value = c ? (c.kind || 'invite') : 'invite';
  kindSel.disabled = !!c;
  $('#cohortKindHelp').hidden = !c;
  $('#cohortTemplate').value = c ? (c.message_template || '') : '';
  applyCohortKindUi();
  $('#cohortModal').hidden = false;
  (c ? $('#cohortTemplate') : $('#cohortName')).focus();
}

function closeCohortModal() { $('#cohortModal').hidden = true; }

function updateCohortTplCount() {
  const tpl = $('#cohortTemplate');
  $('#cohortTplCount').textContent = `${tpl.value.length} / ${tpl.maxLength}`;
}

/* Same rules as the Add List rail: longer, mandatory text for message cohorts. */
function applyCohortKindUi() {
  const msg = $('#cohortKind').value === 'message';
  const tpl = $('#cohortTemplate');
  tpl.maxLength = msg ? 2000 : 300;
  tpl.placeholder = msg ? 'Hey {firstName}, great to be connected — …' : 'Hi {firstName}, …';
  $('#cohortTplLabel').textContent = msg ? 'Message' : 'Message template';
  $('#cohortTplHelp').innerHTML = msg
    ? 'Use <code>{firstName}</code> to personalize. Required — this is the message that gets sent.'
    : 'Use <code>{firstName}</code> to personalize. Leave blank to send bare requests without a note.';
  updateCohortTplCount();
}

function initCohorts() {
  $('#cohortTemplate').addEventListener('input', updateCohortTplCount);
  $('#cohortKind').addEventListener('change', applyCohortKindUi);
  $('#cohortModalClose').addEventListener('click', closeCohortModal);
  $('#cohortCancel').addEventListener('click', closeCohortModal);
  $('#cohortModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeCohortModal(); });
  $('#cohortForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const result = $('#cohortResult');
    const kind = $('#cohortKind').value === 'message' ? 'message' : 'invite';
    const template = $('#cohortTemplate').value.trim() || undefined;
    const payload = { name: $('#cohortName').value.trim(), kind, message_template: template };
    if (!payload.name) return;
    // A message cohort with no message has nothing to send: every profile in it would
    // land in "needs attention". Catch it here rather than at send time.
    if (kind === 'message' && !template) {
      toast(result, 'Messages need a template — write the message that should be sent.', true);
      $('#cohortTemplate').focus();
      return;
    }
    try {
      await api('/api/cohorts', { method: 'POST', body: payload });
      $('#cohortForm').reset();
      $('#cohortName').disabled = false;
      $('#cohortKind').disabled = false;
      closeCohortModal();
      loadCohortsScreen();
    } catch (err) {
      toast(result, `Failed: ${err.message}`, true);
    }
  });
}

/* ---------- settings ---------- */
/**
 * The Settings form's numeric fields, in one place.
 *
 * Load, validation and submit all walk this list. The id<->key mapping used to be spelled
 * out separately in loadSettings() and in the submit handler, which meant a new setting had
 * to be added in two places and a typo in either was silent.
 */
const SETTINGS_FIELDS = [
  { key: 'weekly_cap', id: 'setWeeklyCap' },
  { key: 'batch_size', id: 'setBatchSize' },
  { key: 'batches_per_day', id: 'setBatchesPerDay' },
  { key: 'msg_weekly_cap', id: 'setMsgWeeklyCap' },
  { key: 'msg_batch_size', id: 'setMsgBatchSize' },
  { key: 'msg_batches_per_day', id: 'setMsgBatchesPerDay' },
  { key: 'reply_checks_per_day', id: 'setReplyChecks' },
  { key: 'workday_start_hour', id: 'setStart' },
  { key: 'workday_end_hour', id: 'setEnd' },
  { key: 'roster_sync_per_day', id: 'setRosterSync' },
  { key: 'events_per_day', id: 'setEventsPerDay' },
  { key: 'event_invite_cap', id: 'setEventInviteCap' },
  { key: 'event_bucket_ceiling', id: 'setEventBucketCeiling' },
  { key: 'event_run_budget_minutes', id: 'setEventBudget' },
  { key: 'engage_weekly_cap', id: 'setEngageWeeklyCap' },
  { key: 'engage_batch_size', id: 'setEngageBatchSize' },
  { key: 'engage_batches_per_day', id: 'setEngageBatchesPerDay' },
  { key: 'engage_comment_daily_cap', id: 'setEngageCommentCap' },
];

/** Ranges from the last GET /api/settings, keyed by setting name. Empty until one lands. */
let settingRules = {};

/**
 * Stamp the server's ranges onto the inputs, so index.html holds no limits of its own.
 *
 * Tolerates a response carrying no `rules` — an older server, or a test stubbing the
 * endpoint. The inputs keep type=number, the local check finds no rule and skips, and POST
 * still rejects anything out of range. Degraded, never broken.
 */
function applySettingRules(rules) {
  settingRules = rules || {};
  SETTINGS_FIELDS.forEach(({ key, id }) => {
    const rule = settingRules[key];
    const input = $(`#${id}`);
    if (!rule || !input) return;
    input.min = String(rule.min);
    input.max = String(rule.max);
    input.step = '1';
  });
}

/**
 * Show or clear one field's error message.
 *
 * The <p> is created on demand rather than shipped empty in index.html — eighteen unused
 * error slots would be eighteen more things to keep in step with SETTINGS_FIELDS.
 */
function setFieldError(input, message) {
  const field = input.closest('.field');
  if (!field) return;
  let note = field.querySelector('.field-error');
  if (!message) {
    if (note) note.remove();
    input.classList.remove('is-invalid');
    input.removeAttribute('aria-invalid');
    input.removeAttribute('aria-describedby');
    return;
  }
  if (!note) {
    note = document.createElement('p');
    note.className = 'field-error';
    note.id = `${input.id}-err`;
    field.appendChild(note);
  }
  note.textContent = message;
  input.classList.add('is-invalid');
  input.setAttribute('aria-invalid', 'true');
  input.setAttribute('aria-describedby', note.id);
}

/**
 * Check every settings input against the served rules, marking each offending field.
 * Returns the failures; empty means the form is safe to post.
 *
 * Runs on load as well as on submit. Two ceilings tightened when this shipped (reply checks
 * 24->4, events/day 10->2), so a database written by an older build can hold a value the
 * rules now reject. The load-time pass names it the moment Settings opens, rather than
 * letting the operator edit something unrelated and get a rejection about a field they
 * never touched.
 *
 * The rules come from the server, so this can only ever agree with what POST will accept —
 * but POST re-checks regardless. This is the message, not the guarantee.
 */
function validateSettings() {
  const failures = [];
  const values = {};
  SETTINGS_FIELDS.forEach(({ key, id }) => {
    const input = $(`#${id}`);
    if (!input) return;
    setFieldError(input, null);
    if (input.value === '') return;
    const n = Number(input.value);
    values[key] = n;
    const rule = settingRules[key];
    if (!rule) return;
    let message = null;
    if (!Number.isInteger(n)) message = `${rule.label} must be a whole number.`;
    else if (n < rule.min || n > rule.max) message = `${rule.label} must be between ${rule.min} and ${rule.max}.`;
    if (message) { setFieldError(input, message); failures.push({ id, message }); }
  });

  // The one cross-field rule with two form fields. Skipped when either hour already failed
  // its own range — "must be after the start hour" stacked on "must be between 0 and 23" is
  // noise, and the server applies the same restraint.
  const alreadyBad = failures.some((f) => f.id === 'setStart' || f.id === 'setEnd');
  if (!alreadyBad && values.workday_start_hour !== undefined && values.workday_end_hour !== undefined
      && values.workday_end_hour <= values.workday_start_hour) {
    const message = `Workday end hour must be after the start hour (currently ${values.workday_start_hour}).`;
    setFieldError($('#setEnd'), message);
    failures.push({ id: 'setEnd', message });
  }
  return failures;
}

async function loadSettings() {
  try {
    const s = await api('/api/settings');
    applySettingRules(s.rules);
    SETTINGS_FIELDS.forEach(({ key, id }) => {
      const input = $(`#${id}`);
      if (input) input.value = s[key] ?? '';
    });
    validateSettings();   // flag anything the stored row already violates
    renderApifyKey(s);
    refreshConnections();
    loadLogs();
  } catch (_) { /* ignore */ }
}

/**
 * The Apify key field has two states, because the key is write-only: the server can prove a
 * key exists and show a mask of it, but can never hand it back.
 *
 *   stored  -> a readonly mask + "Replace"
 *   entry   -> an empty password input + "Save key" (+ "Cancel", only if replacing)
 *
 * Previously it was always the entry state, so a saved key showed an EMPTY box beside the
 * words "— configured". The empty box is the louder signal and operators read it as "my key
 * didn't save". Showing the mask makes the two agree.
 */
function renderApifyKey(s) {
  const has = !!s.apify_key_set;
  const state = $('#apifyKeyState');
  state.hidden = false;
  state.textContent = has ? 'Configured' : 'Not set';
  state.classList.toggle('on', has);

  $('#apifyKeyMask').value = s.apify_key_hint ?? '';
  $('#setApifyKey').value = '';            // never leave a credential sitting in the DOM
  $('#apifyKeySaved').hidden = !has;
  $('#apifyKeyEdit').hidden = has;
  $('#cancelApifyKey').hidden = !has;      // nothing to go back to when no key is stored
}

/* ---------- connections roster (Settings → Connections) ----------
   The only surface that tells an operator whether their roster actually landed, so
   every path here reports what happened — including the ones that did nothing. */
const fmtInt = (n) => Number(n ?? 0).toLocaleString();

async function refreshConnections() {
  try {
    const s = await api('/api/connections/stats');
    $('#connTotal').textContent = fmtInt(s.total);
    $('#connEnriched').textContent = fmtInt(s.by_enrich_status.enriched);
    $('#connPending').textContent = fmtInt(s.by_enrich_status.pending);
    $('#connSynced').textContent = s.last_synced_at ? fmtTime(s.last_synced_at) : 'never';
  } catch (_) { /* leave the last-known figures rather than blanking the panel */ }
  await refreshEnrichment();
}

/** One import path for both the pasted textarea and the wizard — the endpoint only ever
 *  receives text, so an uploaded file is read into the textarea rather than posted. */
async function importConnections(text, resultNode) {
  try {
    const r = await api('/api/connections/import', { method: 'POST', body: { text } });
    const bits = [`${fmtInt(r.inserted)} added`, `${fmtInt(r.updated)} updated`];
    if (r.skipped) bits.push(`${fmtInt(r.skipped)} skipped (no usable URL)`);
    toast(resultNode, bits.join(' · '));
    await refreshConnections();
  } catch (err) {
    toast(resultNode, err.message, true);
  }
}

/* ---------- connection search (Connections tab) ---------- */
const SEARCH_PAGE = 25;
let searchState = { query: null, offset: 0, total: 0 };

/** "a, b , c" -> ["a","b","c"]. Blank input yields undefined so the field is omitted. */
function csvTerms(sel) {
  const raw = ($(sel)?.value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return raw.length ? raw : undefined;
}

function buildSearchQuery() {
  return {
    name_any: csvTerms('#sqName'),
    title_any: csvTerms('#sqTitle'),
    location_any: csvTerms('#sqLocation'),
    company_any: csvTerms('#sqCompany'),
    exclude_any: csvTerms('#sqExclude'),
    q: ($('#sqFree')?.value ?? '').trim() || undefined,
    include_past_roles: $('#sqPast')?.checked === true,
  };
}

/* Selected profile URLs. Survives Load more (you build a selection across pages of ONE
   result set) but is wiped by a new search — a selection made under a filter you've since
   changed is exactly how the wrong people get queued. */
const selected = new Set();

function connRow(r) {
  const slug = slugFromUrl(r.profile_url);
  const tr = el('tr', { class: 'search-row', 'data-slug': slug, 'data-url': r.profile_url });
  const box = el('input', { type: 'checkbox', class: 'row-select', 'aria-label': `Select ${r.full_name || slug}` });
  box.checked = selected.has(r.profile_url);
  tr.appendChild(el('td', { class: 'c-select' }, box));
  const name = el('td', {},
    el('span', { class: 'search-name', text: r.full_name || slug }),
    r.headline ? el('span', { class: 'search-headline', text: r.headline }) : null,
  );
  tr.appendChild(name);
  tr.appendChild(el('td', { text: r.current_title || '—' }));
  tr.appendChild(el('td', { text: r.current_company || '—' }));
  tr.appendChild(el('td', { text: r.location_raw || '—' }));
  tr.appendChild(el('td', { class: 'mono-cell', text: r.connected_on || '—' }));
  return tr;
}

function renderCoverage(cov) {
  const node = $('#searchCoverage');
  if (!node) return;
  // Always visible: an agent OR a human needs to know the corpus is still filling, or a
  // thin result set reads as "nobody matches" when it means "we haven't looked yet".
  const bits = [`${fmtInt(cov.enriched)} of ${fmtInt(cov.total)} searchable`];
  if (cov.pending) bits.push(`${fmtInt(cov.pending)} still enriching`);
  if (cov.unresolvable) bits.push(`${fmtInt(cov.unresolvable)} unreachable`);
  node.textContent = bits.join(' · ');
}

function renderSelection() {
  const n = selected.size;
  $('#selectionBar').hidden = n === 0;
  $('#selectionCount').textContent = `${fmtInt(n)} selected`;

  // The escape hatch only makes sense once the whole loaded page is taken AND more match.
  const loaded = $$('#searchResults .row-select');
  const pageAllChecked = loaded.length > 0 && loaded.every((b) => b.checked);
  const more = searchState.total > loaded.length;
  const hatch = $('#selectAllMatching');
  hatch.hidden = !(pageAllChecked && more);
  hatch.textContent = `Select all ${fmtInt(searchState.total)} connections matching this search`;
  const head = $('#selectAllPage');
  if (head) { head.checked = pageAllChecked; head.indeterminate = !pageAllChecked && n > 0; }
}

function clearSelection() {
  selected.clear();
  $$('#searchResults .row-select').forEach((b) => { b.checked = false; });
  renderSelection();
}

async function runSearch(append = false) {
  if (!append) selected.clear();
  const body = { ...searchState.query, limit: SEARCH_PAGE, offset: append ? searchState.offset : 0 };
  const res = await api('/api/connections/search', { method: 'POST', body });

  searchState.total = res.total;
  searchState.offset = (append ? searchState.offset : 0) + res.results.length;

  const tbody = $('#searchResults');
  if (!append) tbody.replaceChildren();
  for (const r of res.results) tbody.appendChild(connRow(r));

  renderCoverage(res.coverage);
  $('#searchResultsWrap').hidden = res.total === 0;
  $('#searchEmpty').hidden = res.total !== 0;
  $('#searchEmpty').textContent = res.coverage.pending
    ? `No matches yet — but ${fmtInt(res.coverage.pending)} connections are still being enriched, so try again shortly.`
    : 'No connections match those filters.';
  $('#searchMeta').hidden = false;
  $('#searchMeta').textContent = `${fmtInt(res.total)} match${res.total === 1 ? '' : 'es'}`;
  $('#searchMore').hidden = searchState.offset >= res.total;
  renderSelection();
}

/* ---------- selection -> message campaign ----------
   No new backend: search hands back profile_url, /api/lists already takes a newline-joined
   list plus a cohort and a kind. This is a checkbox column and a dialog. */

/** Pull every matching URL, not just the loaded page, by walking the same search endpoint. */
async function fetchAllMatchingUrls() {
  const urls = [];
  const PAGE = 200; // MAX_LIMIT server-side
  for (let offset = 0; offset < searchState.total; offset += PAGE) {
    const res = await api('/api/connections/search', {
      method: 'POST', body: { ...searchState.query, limit: PAGE, offset },
    });
    urls.push(...res.results.map((r) => r.profile_url));
    if (res.results.length === 0) break; // defensive: never loop forever on a shrinking set
  }
  return urls;
}

async function openCampaignDialog() {
  const sel = $('#campCohort');
  const result = $('#campResult');
  result.hidden = true;

  const [cohorts, settings] = await Promise.all([api('/api/cohorts'), api('/api/settings')]);
  // Message cohorts only. Offering an invite cohort would earn a 409 from /api/lists, and
  // everyone here is already a connection so an invite would just be skipped anyway.
  // Terminology: the app calls the container a COHORT everywhere it is picked or named
  // ("Add to cohort", "Cohort name", "New cohort"); "campaign" is reserved for its TYPE
  // ("Campaign type"). The dialog follows that.
  const msgCohorts = cohorts.filter((c) => c.kind === 'message');
  sel.replaceChildren(
    ...msgCohorts.map((c) => el('option', { value: c.name, text: c.name, 'data-template': c.message_template || '' })),
    el('option', { value: '__new__', text: '+ New cohort…' }),
  );
  if (msgCohorts.length === 0) sel.value = '__new__';

  const cap = settings.msg_weekly_cap || 0;
  const n = selected.size;
  const weeks = cap > 0 ? Math.ceil(n / cap) : 0;
  const who = `${fmtInt(n)} ${n === 1 ? 'person' : 'people'}`;
  $('#campImpact').textContent = weeks > 1
    ? `${who} · about ${weeks} weeks to send at ${fmtInt(cap)}/week`
    : `${who} · under a week at ${fmtInt(cap)}/week`;

  syncCampaignTemplate();
  $('#campModal').hidden = false;
}

/** An existing cohort's template is shown but locked: /api/lists overwrites it, which would
 *  rewrite the message for everyone already queued-but-unsent in that campaign. */
function syncCampaignTemplate() {
  const sel = $('#campCohort');
  const isNew = sel.value === '__new__';
  const ta = $('#campTemplate');
  $('#campNameField').hidden = !isNew;
  ta.readOnly = !isNew;
  ta.classList.toggle('is-locked', !isNew);
  $('#campTemplateHint').textContent = isNew
    ? 'required — {firstName} is substituted at send time'
    : "this cohort's existing message · edit it in the Cohorts tab";
  const opt = sel.selectedOptions[0];
  ta.value = isNew ? '' : (opt ? opt.dataset.template || '' : '');
}

function closeCampaignDialog() { $('#campModal').hidden = true; }

async function submitCampaign() {
  const result = $('#campResult');
  const isNew = $('#campCohort').value === '__new__';
  const name = isNew ? $('#campName').value.trim() : $('#campCohort').value;
  const template = $('#campTemplate').value.trim();

  if (isNew && !name) { toast(result, 'Name the new cohort first.', true); return; }
  if (isNew && !template) { toast(result, 'A message cohort needs a message body.', true); return; }
  if (selected.size === 0) { toast(result, 'Nothing selected.', true); return; }

  const body = { cohort: name, kind: 'message', text: [...selected].join('\n') };
  // Only send a template for a NEW cohort — see syncCampaignTemplate.
  if (isNew) body.message_template = template;

  const btn = $('#campConfirm');
  btn.disabled = true;
  try {
    const r = await api('/api/lists', { method: 'POST', body });
    const dupes = r.found - r.added;
    const bits = [`Added ${fmtInt(r.added)} to “${name}”`];
    // /api/lists dedupes on (profile_url, kind), so anyone already in a message cohort is
    // skipped. Say so — silence here reads as a partial failure.
    if (dupes > 0) bits.push(`${fmtInt(dupes)} ${dupes === 1 ? 'was' : 'were'} already in a message cohort`);
    toast(result, `${bits.join(' · ')}.`);
    clearSelection();
  } catch (err) {
    toast(result, err.message, true);
  } finally {
    btn.disabled = false;
  }
}

/* ---------- selection -> event campaign ----------
   The other half of what a search result is for. Everyone here is already a 1st-degree
   connection, which is exactly the precondition an event invitation has — so the same
   checkboxes that feed a message campaign feed this.

   It builds a DRAFT and stops. Nothing is armed, nothing is sent: the value of this
   pipeline is the bucket ladder on the Events tab, which says how much of the list a run
   can actually reach before an irreversible invitation goes anywhere. */

/** Draft campaigns can still take people; armed ones have a frozen location plan. */
async function openEventDialog() {
  const sel = $('#evtCampaign');
  $('#evtResult').hidden = true;
  $('#evtConfirm').hidden = false;
  $('#evtOpen').hidden = true;

  const drafts = (await api('/api/events')).filter((e) => e.status === 'draft');
  sel.replaceChildren(
    ...drafts.map((e) => el('option', {
      value: String(e.id),
      text: e.title || e.event_url.replace(/^https?:\/\/(www\.)?/, ''),
    })),
    el('option', { value: '__new__', text: '+ New event campaign…' }),
  );
  sel.value = drafts.length ? String(drafts[0].id) : '__new__';

  const n = selected.size;
  $('#evtImpact').textContent =
    `${fmtInt(n)} ${n === 1 ? 'person' : 'people'} · matched against your roster, then ranked by location`;
  syncEventDialog();
  $('#evtModal').hidden = false;
}

function syncEventDialog() {
  const isNew = $('#evtCampaign').value === '__new__';
  $('#evtUrlField').hidden = !isNew;
  $('#evtConfirm').textContent = isNew ? 'Build the plan' : 'Add to campaign';
  $('#evtCampaignHint').textContent = isNew
    ? 'A new draft. Nothing is sent until you review the locations and arm it.'
    : 'Adding re-ranks the whole location plan — only drafts allow it.';
}

function closeEventDialog() { $('#evtModal').hidden = true; }

async function submitEventInvite() {
  const result = $('#evtResult');
  const sel = $('#evtCampaign');
  const isNew = sel.value === '__new__';
  const url = $('#evtUrl').value.trim();

  if (selected.size === 0) { toast(result, 'Nothing selected.', true); return; }
  if (isNew && !url) { toast(result, 'Paste the LinkedIn event URL first.', true); return; }

  const btn = $('#evtConfirm');
  btn.disabled = true;
  try {
    const body = { profile_urls: [...selected] };
    const r = isNew
      ? await api('/api/events', { method: 'POST', body: { ...body, event_url: url } })
      : await api(`/api/events/${sel.value}/invitees`, { method: 'POST', body });

    // Say what did NOT make it, here, while the selection that produced it is still on
    // screen. "Best effort" is only honest if the effort's edges are stated up front.
    const bits = [`${fmtInt(r.added)} on the list`];
    if (r.rejected.length) bits.push(`${fmtInt(r.rejected.length)} not in your roster`);
    if (r.unreachable.length) bits.push(`${fmtInt(r.unreachable.length)} with no location we can filter on`);
    toast(result, `${bits.join(' · ')}.`);
    clearSelection();

    const id = r.event.id;
    btn.hidden = true;
    const open = $('#evtOpen');
    open.hidden = false;
    open.onclick = () => { closeEventDialog(); switchTab('events'); void evOpen(id); };
  } catch (err) {
    toast(result, err.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function openConnection(slug) {
  const drawer = $('#connDrawer'); const backdrop = $('#drawerBackdrop');
  const body = $('#connDrawerBody');
  body.replaceChildren(el('p', { class: 'empty', text: 'loading…' }));
  drawer.hidden = false; backdrop.hidden = false;

  try {
    const c = await api(`/api/connections/${encodeURIComponent(slug)}`);
    $('#connDrawerName').textContent = c.full_name || slug;
    $('#connDrawerSub').textContent = [c.current_title, c.current_company].filter(Boolean).join(' · ') || slug;
    body.replaceChildren(renderConnectionDetail(c, slug));
  } catch (err) {
    body.replaceChildren(el('p', { class: 'empty', text: `Could not load: ${err.message}` }));
  }
}

function detailSection(title, children) {
  if (!children.length) return null;
  return el('section', { class: 'cd-section' }, el('h4', { text: title }), ...children);
}

function renderConnectionDetail(c, slug) {
  const p = c.profile || {};
  const wrap = el('div', { class: 'conn-detail' });

  wrap.appendChild(el('div', { class: 'cd-meta' },
    el('a', { class: 'btn btn-ghost', href: c.profile_url, target: '_blank', rel: 'noopener', text: 'Open on LinkedIn' }),
    el('button', { class: 'btn', id: 'cdRefresh', type: 'button', 'data-slug': slug, text: 'Refresh from LinkedIn' }),
  ));

  const facts = [
    ['Location', c.location_raw], ['Connected', c.connected_on],
    ['Enriched', c.enriched_at ? fmtTime(c.enriched_at) : 'not yet'],
    ['Source', c.source],
  ].filter(([, v]) => v);
  wrap.appendChild(el('dl', { class: 'cd-facts' },
    ...facts.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: String(v) })])));

  if (p.about) wrap.appendChild(detailSection('About', [el('p', { class: 'cd-about', text: p.about })]));

  const exp = (p.experience || []).map((e) => el('div', { class: 'cd-item' },
    el('span', { class: 'cd-item-title', text: e.title || '—' }),
    el('span', { class: 'cd-item-sub', text: [e.companyName, e.duration].filter(Boolean).join(' · ') }),
  ));
  wrap.appendChild(detailSection('Experience', exp));

  const edu = (p.education || []).map((e) => el('div', { class: 'cd-item' },
    el('span', { class: 'cd-item-title', text: e.schoolName || '—' }),
    el('span', { class: 'cd-item-sub', text: [e.degree, e.fieldOfStudy].filter(Boolean).join(' · ') }),
  ));
  wrap.appendChild(detailSection('Education', edu));

  const skills = (p.skills || []).map((s) => el('span', { class: 'cd-chip', text: s }));
  wrap.appendChild(detailSection('Skills', skills.length ? [el('div', { class: 'cd-chips' }, ...skills)] : []));

  if (!c.enriched_at) {
    wrap.appendChild(el('p', { class: 'hint', text: 'This connection has not been enriched yet — only what the import supplied is shown.' }));
  }
  return wrap;
}

function closeConnDrawer() {
  $('#connDrawer').hidden = true;
  if ($('#statusDrawer').hidden) $('#drawerBackdrop').hidden = true;
}

function initSearch() {
  $('#searchForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    searchState.query = buildSearchQuery();
    try { await runSearch(false); } catch (err) { toast($('#searchMeta'), err.message, true); }
  });

  $('#sqClear')?.addEventListener('click', () => {
    for (const id of ['#sqName', '#sqTitle', '#sqLocation', '#sqCompany', '#sqExclude', '#sqFree']) $(id).value = '';
    $('#sqPast').checked = false;
    $('#searchResults').replaceChildren();
    $('#searchResultsWrap').hidden = true;
    $('#searchMeta').hidden = true;
    $('#searchEmpty').hidden = false;
    $('#searchEmpty').textContent = 'Search your connections above.';
  });

  $('#searchMore')?.addEventListener('click', () => { void runSearch(true); });

  $('#searchResults')?.addEventListener('click', (ev) => {
    // A click on the checkbox cell must not also open the drawer.
    if (ev.target.closest('.c-select')) return;
    const row = ev.target.closest('.search-row');
    if (row) void openConnection(row.dataset.slug);
  });

  $('#searchResults')?.addEventListener('change', (ev) => {
    const box = ev.target.closest('.row-select');
    if (!box) return;
    const url = box.closest('.search-row').dataset.url;
    if (box.checked) selected.add(url); else selected.delete(url);
    renderSelection();
  });

  $('#selectAllPage')?.addEventListener('change', (ev) => {
    const on = ev.target.checked;
    for (const box of $$('#searchResults .row-select')) {
      box.checked = on;
      const url = box.closest('.search-row').dataset.url;
      if (on) selected.add(url); else selected.delete(url);
    }
    renderSelection();
  });

  $('#selectAllMatching')?.addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Collecting…';
    try {
      for (const u of await fetchAllMatchingUrls()) selected.add(u);
      renderSelection();
      $('#selectAllMatching').hidden = true;   // the whole set is taken; nothing left to offer
    } finally {
      btn.disabled = false;
    }
  });

  $('#selectionClear')?.addEventListener('click', clearSelection);
  $('#selectionAdd')?.addEventListener('click', () => { void openCampaignDialog(); });
  $('#selectionEvent')?.addEventListener('click', () => { void openEventDialog(); });
  $('#evtClose')?.addEventListener('click', closeEventDialog);
  $('#evtCampaign')?.addEventListener('change', syncEventDialog);
  $('#evtConfirm')?.addEventListener('click', () => { void submitEventInvite(); });
  $('#campClose')?.addEventListener('click', closeCampaignDialog);
  $('#campCohort')?.addEventListener('change', syncCampaignTemplate);
  $('#campConfirm')?.addEventListener('click', () => { void submitCampaign(); });

  $('#connDrawerClose')?.addEventListener('click', closeConnDrawer);
  $('#drawerBackdrop')?.addEventListener('click', closeConnDrawer);

  $('#connDrawerBody')?.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('#cdRefresh');
    if (!btn) return;
    btn.disabled = true; btn.textContent = 'Refreshing…';
    try {
      await api(`/api/connections/${encodeURIComponent(btn.dataset.slug)}/refresh`, { method: 'POST', body: {} });
      await openConnection(btn.dataset.slug);
    } catch (err) {
      btn.disabled = false; btn.textContent = `Refresh failed: ${err.message}`;
    }
  });
}

/* ---------- enrichment ----------
   Poll only while a run is live: an idle dashboard should not wake up every 3s forever. */
let enrichPollTimer = null;

function renderEnrichment(p) {
  const panel = byIdOrNull('connEnrich');
  if (!panel) return;
  panel.hidden = p.total === 0;

  const done = p.enriched;
  const parked = p.empty + p.failed;
  const pct = p.total ? (100 * done) / p.total : 0;
  const parkedPct = p.total ? (100 * parked) / p.total : 0;
  $('#enrichFill').style.width = `${pct}%`;
  $('#enrichParked').style.width = `${parkedPct}%`;
  $('#enrichBar').setAttribute('aria-valuenow', Math.round(pct));

  // The dashboard banner already shouts about a halt; this repeats it where the operator
  // comes to fix it (the key field is right below).
  const alert = byIdOrNull('enrichPanelAlert');
  if (alert) {
    alert.hidden = !p.halt;
    if (p.halt) alert.textContent = ENRICH_HALT_TEXT[p.halt.reason] || p.halt.detail || 'Enrichment stopped.';
  }

  const bits = [`${fmtInt(done)} of ${fmtInt(p.total)} enriched`];
  if (p.pending) bits.push(`${fmtInt(p.pending)} pending`);
  if (p.failed) bits.push(`${fmtInt(p.failed)} failed`);
  if (p.empty) bits.push(`${fmtInt(p.empty)} unreachable`);
  $('#enrichLegend').textContent = bits.join(' · ');

  const start = $('#enrichStart');
  start.disabled = p.running || p.pending === 0;
  start.textContent = p.running
    ? 'Running…'
    : p.pending
      ? `Start enrichment — ${fmtInt(p.pending)} · ~$${(p.pending * 0.004).toFixed(2)}`
      : 'Everything enriched';
  $('#enrichPause').hidden = !p.running;
  $('#enrichRetry').hidden = parked === 0 || p.running;
}

async function refreshEnrichment() {
  try {
    const p = await api('/api/enrichment/status');
    renderEnrichment(p);
    // Self-terminating poll: start it when a run begins, stop as soon as it ends.
    if (p.running && !enrichPollTimer) enrichPollTimer = setInterval(refreshEnrichment, 3000);
    if (!p.running && enrichPollTimer) { clearInterval(enrichPollTimer); enrichPollTimer = null; }
  } catch (_) { /* leave the last-known figures on screen */ }
}

function byIdOrNull(id) { return document.getElementById(id); }

function initEnrichment() {
  const result = () => $('#connImportResult');

  $('#enrichStart')?.addEventListener('click', async () => {
    try {
      const r = await api('/api/enrichment/start', { method: 'POST', body: {} });
      toast(result(), `Enriching ${fmtInt(r.queued)} connections — about $${r.estimated_cost_usd.toFixed(2)}. You can leave this page.`);
      await refreshEnrichment();
    } catch (err) {
      toast(result(), err.message, true);
    }
  });

  $('#enrichPause')?.addEventListener('click', async () => {
    const r = await api('/api/enrichment/pause', { method: 'POST', body: {} });
    toast(result(), r.paused ? 'Paused. Restart any time — it picks up where it left off.' : 'Nothing was running.', !r.paused);
    await refreshEnrichment();
  });

  // The banner's "I've fixed it": clear the halt and start a run now, so the operator sees
  // whether the fix worked instead of waiting on the next 60-second tick.
  $('#enrichHaltRetry')?.addEventListener('click', async () => {
    const btn = $('#enrichHaltRetry');
    btn.disabled = true;
    try {
      await api('/api/enrichment/resume', { method: 'POST', body: {} });
      $('#enrichBanner').hidden = true;
      await refreshEnrichment();
    } catch (err) {
      // Still broken — leave the banner up and say what happened this time.
      $('#enrichHaltDetail').textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  $('#enrichRetry')?.addEventListener('click', async () => {
    const r = await api('/api/enrichment/retry-failed', { method: 'POST', body: {} });
    toast(result(), `Re-queued ${fmtInt(r.requeued)} for another attempt.`);
    await refreshEnrichment();
  });

  // Swap to the entry state. The stored mask stays rendered underneath so Cancel can
  // restore it without another round-trip.
  $('#replaceApifyKey')?.addEventListener('click', () => {
    $('#apifyKeySaved').hidden = true;
    $('#apifyKeyEdit').hidden = false;
    $('#setApifyKey').focus();
  });

  $('#cancelApifyKey')?.addEventListener('click', () => {
    $('#setApifyKey').value = '';
    $('#apifyKeyEdit').hidden = true;
    $('#apifyKeySaved').hidden = false;
    $('#replaceApifyKey').focus();   // put focus back where it came from
  });

  // Enter submits: a one-field row where the only action is Save should not need the mouse.
  $('#setApifyKey')?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); $('#saveApifyKey').click(); }
  });

  $('#saveApifyKey')?.addEventListener('click', async () => {
    const key = $('#setApifyKey').value.trim();
    if (!key) { toast(result(), 'Paste a key first.', true); return; }
    try {
      await api('/api/settings', { method: 'POST', body: { apify_api_key: key } });
      $('#setApifyKey').value = '';   // never leave a credential sitting in the DOM
      toast(result(), 'Apify key saved.');
      await loadSettings();           // re-renders into the stored state, mask and all
    } catch (err) {
      toast(result(), err.message, true);
    }
  });
}

function initConnections() {
  const file = $('#connImportFile');
  if (file) {
    file.addEventListener('change', async (ev) => {
      const f = ev.target.files && ev.target.files[0];
      if (!f) return;
      $('#connImportText').value = await f.text();
      const label = $('.conn-file span');
      if (label) label.textContent = f.name;
    });
  }

  const form = $('#connImportForm');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      await importConnections($('#connImportText').value, $('#connImportResult'));
    });
  }

  const wizBtn = $('#wizImportBtn');
  if (wizBtn) {
    wizBtn.addEventListener('click', async () => {
      await importConnections($('#wizImportText').value, $('#wizImportResult'));
    });
  }

  const sync = $('#connSyncNow');
  if (sync) {
    sync.addEventListener('click', async () => {
      const result = $('#connImportResult');
      sync.disabled = true;
      try {
        const r = await api('/api/roster/sync-now', { method: 'POST', body: {} });
        // A pass that declined to run must say WHY — reporting it as a no-op success is
        // how a broken selector or a lost session goes unnoticed for days.
        toast(result, r.ran
          ? `Synced — ${fmtInt(r.seen)} read, ${fmtInt(r.discovered)} new`
          : `Did not run (${r.reason})`, !r.ran);
        await refreshConnections();
      } catch (err) {
        toast(result, `Sync failed: ${err.message}`, true);
      } finally {
        sync.disabled = false;
      }
    });
  }
}

/* ---------- run log viewer ----------
   Renders at most LOG_RENDER_CAP lines (the full file is one Download away) so the
   view stays snappy, colorizes by level, and always lands scrolled to the newest. */
const LOG_RENDER_CAP = 300;
let logLines = [];

async function loadLogs() {
  const view = $('#logView');
  try {
    const { lines } = await api('/api/logs?tail=1000');
    logLines = lines;
    renderLogView();
  } catch (_) { if (view) view.textContent = 'failed to load log'; }
}

function logLineClass(line) {
  if (line.includes(' ERROR ')) return 'log-line err';
  if (line.includes(' WARN ')) return 'log-line warn';
  if (line.includes(' verdict ')) return 'log-line verdict';
  if (line.includes(' DEBUG ')) return 'log-line dim';
  return 'log-line';
}

function renderLogView() {
  const view = $('#logView'), meta = $('#logMeta');
  if (!view) return;
  const q = ($('#logFilter').value || '').toLowerCase();
  const matches = q ? logLines.filter((l) => l.toLowerCase().includes(q)) : logLines;
  const shown = matches.slice(-LOG_RENDER_CAP);
  if (meta) {
    meta.textContent = matches.length > shown.length
      ? `last ${shown.length} of ${matches.length}${q ? ' matching' : ''} lines`
      : `${shown.length}${q ? ' matching' : ''} lines`;
  }
  if (!shown.length) {
    view.textContent = q ? '(no matching lines)' : '(log is empty)';
    return;
  }
  view.replaceChildren(...shown.map((l) => el('div', { class: logLineClass(l), text: l })));
  scrollLogToEnd();
}

function scrollLogToEnd() {
  // Synchronous (layout is up to date after replaceChildren); the timeout re-asserts
  // after paint settles. Not rAF: it never fires while the tab is unfocused.
  const view = $('#logView');
  if (!view) return;
  view.scrollTop = view.scrollHeight;
  setTimeout(() => { view.scrollTop = view.scrollHeight; }, 60);
}

function initLogViewer() {
  const refresh = $('#logRefresh'), filter = $('#logFilter');
  if (refresh) refresh.addEventListener('click', loadLogs);
  if (filter) filter.addEventListener('input', renderLogView);
}

/* ---------- docs ---------- */
let docsLoaded = false;
async function loadDocs() {
  const nav = $('#docsNav');
  try {
    const docs = await api('/api/docs');
    nav.replaceChildren(...docs.map((d, idx) =>
      el('button', {
        class: 'docs-nav-item' + (idx === 0 ? ' is-active' : ''),
        type: 'button', 'data-slug': d.slug,
        onclick: (e) => selectDoc(d.slug, e.currentTarget),
      }, d.title)));
    if (!docsLoaded && docs.length) { await selectDoc(docs[0].slug, nav.firstChild); docsLoaded = true; }
  } catch (_) { $('#docsContent').textContent = 'Failed to load docs.'; }
}
async function selectDoc(slug, btn) {
  $$('.docs-nav-item').forEach((b) => b.classList.toggle('is-active', b === btn));
  try {
    const doc = await api(`/api/docs/${slug}`);
    $('#docsContent').innerHTML = window.renderMarkdown(doc.markdown);
  } catch (_) { $('#docsContent').textContent = 'Failed to load document.'; }
}

function initSettings() {
  $('#settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const result = $('#settingsResult');
    // Local check first: no request goes out for a value the server would only reject.
    const failures = validateSettings();
    if (failures.length) {
      const first = $(`#${failures[0].id}`);
      if (first) first.focus();
      toast(result, failures.length === 1 ? failures[0].message : `Fix ${failures.length} settings before saving.`, true);
      return;
    }
    try {
      // Inside the try on purpose: a missing input id throws here, and outside the try that
      // becomes an unhandled rejection in an async listener — no toast, nothing in the
      // result box, a Save button that visibly does nothing. Loud beats silent.
      const patch = {};
      SETTINGS_FIELDS.forEach(({ key, id }) => {
        const v = $(`#${id}`).value;
        if (v !== '') patch[key] = Number(v);
      });
      await api('/api/settings', { method: 'POST', body: patch });
      toast(result, 'Settings saved.');
    } catch (err) {
      toast(result, `Failed: ${err.message}`, true);
    }
  });
}

/* ---------- first-run setup wizard ---------- */
function initWizard() {
  const wiz = $('#setupWizard');
  if (!wiz) return;
  let pollId = null;

  const startLoginPoll = () => {
    if (pollId) return;
    pollId = setInterval(async () => {
      try {
        const { loggedIn } = await api('/api/login-status');
        $('#wizLoginState').innerHTML = loggedIn
          ? '<span class="led on"></span>Connected'
          : '<span class="led off"></span>Waiting for login…';
        $('#wizFinish').disabled = !loggedIn;
      } catch (_) { /* keep waiting */ }
    }, 2000);
  };
  const stopLoginPoll = () => { if (pollId) { clearInterval(pollId); pollId = null; } };

  $('#wizConnectBtn').addEventListener('click', async () => {
    $('#wizLoginState').innerHTML = '<span class="led off"></span>Opening login window…';
    try { await api('/api/login', { method: 'POST' }); } catch (_) { /* surfaced via poll */ }
    startLoginPoll();
  });
  $('#wizFinish').addEventListener('click', async () => {
    try { await api('/api/settings', { method: 'POST', body: { onboarded: 1 } }); } catch (_) { /* ignore */ }
    stopLoginPoll();
    wiz.hidden = true;
    refreshLogin();
    loadSettings();
  });

  api('/api/settings').then((s) => {
    if (!s.onboarded) { wiz.hidden = false; startLoginPoll(); }
  }).catch(() => { /* if settings unreachable, don't block the app */ });
}


/* ============================================================
   EVENT INVITES
   ============================================================ */

/* The picker's hard row cap. The ladder is drawn against this fixed scale rather
   than against the largest bucket, so the ceiling line sits at the same x on
   every rung and "this one overflows" is visible without reading a number. */
const PICKER_ROW_CAP = 1000;

let evOpenId = null;
let evPollTimer = null;

const EV_UNREACHABLE_COPY = {
  no_country: 'no country on their roster record',
  us_without_state: 'in the US with no state on record',
};

function evBadge(status) {
  return el('span', { class: `ev-badge ${status}`, text: status });
}

/**
 * One rung.
 *
 * `scale` is the number of rows the full track width represents, and it is shared by
 * every rung so the bars stay comparable. It is the largest bucket when any bucket
 * overflows the picker's 1000-row cap, otherwise the cap itself — which is what puts the
 * ceiling line at a position that means something. Scaling each rung to the cap instead
 * would paint a 2,000-connection bucket as a full bar with the ceiling pinned uselessly
 * to the right edge, hiding the very overflow the line exists to show.
 */
function evRung(bucket, opts = {}) {
  const { editable = false, live = null, onDrop = null, scale = PICKER_ROW_CAP } = opts;
  const roster = Math.max(0, bucket.roster_count || 0);
  const listable = Math.min(roster, PICKER_ROW_CAP);
  const pct = (n) => `${Math.max(0, Math.min(100, (n / scale) * 100))}%`;

  const track = el('div', { class: 'rung-track' },
    el('div', { class: 'rung-cost', style: `width:${pct(listable)}` }),
  );
  // The slice LinkedIn will never render, drawn only when it actually exists.
  if (roster > PICKER_ROW_CAP) {
    track.appendChild(el('div', {
      class: 'rung-over',
      style: `left:${pct(PICKER_ROW_CAP)};width:${pct(roster - PICKER_ROW_CAP)};right:auto`,
    }));
    track.appendChild(el('div', { class: 'rung-cap', style: `left:${pct(PICKER_ROW_CAP)}` }));
  }
  if (live && live.rows_loaded > 0) {
    track.appendChild(el('div', { class: 'rung-fill', style: `width:${pct(live.rows_loaded)}` }));
  }
  const inked = live
    ? `${live.matched} of ${bucket.target_count} found`
    : `${bucket.target_count} to invite`;
  track.appendChild(el('div', { class: 'rung-targets', text: inked }));

  const label = el('div', { class: 'rung-label' },
    el('span', { text: bucket.label }),
    el('span', {
      class: 'rung-sub',
      text: roster > PICKER_ROW_CAP
        ? `${roster.toLocaleString()} connections — only the first 1,000 are listable`
        : `${roster.toLocaleString()} connections to page through`,
    }),
  );

  const rung = el('div', {
    class: 'rung'
      + (bucket.status === 'skipped' || bucket.status === 'failed' ? ' is-skipped' : '')
      + (live && !live.outcome ? ' is-live' : ''),
  },
  el('div', { class: 'rung-rank', text: String(bucket.rank + 1) }),
  label,
  track,
  el('div', { class: 'rung-num', text: bucket.status === 'pending' ? '—' : bucket.status }),
  editable
    ? el('button', {
      class: 'rung-drop', title: `Drop ${bucket.label}`, 'aria-label': `Drop ${bucket.label}`,
      onclick: (e) => { e.stopPropagation(); onDrop(bucket.rank); },
    }, '×')
    : el('span'),
  );
  return rung;
}

function evStat(n, label, tone = '') {
  return el('div', { class: `ev-stat ${tone}` },
    el('div', { class: 'ev-stat-n', text: String(n) }),
    el('div', { class: 'ev-stat-l', text: label }),
  );
}

function evRunBlock(run) {
  const head = el('div', { class: 'ev-run-head' },
    el('span', { class: `mode ${run.mode}`, text: run.mode }),
    el('span', { text: fmtTime(run.started_at) }),
    el('span', { text: run.ended_at ? `${run.outcome || 'done'} — ${run.invited_count} invited` : 'running…' }),
  );
  const block = el('div', { class: 'ev-run' }, head);
  if (run.error) block.appendChild(el('div', { class: 'rung-sub', text: run.error }));
  return block;
}

function evRenderDetail(detail) {
  const host = $('#evDetail');
  host.innerHTML = '';
  host.hidden = false;
  const { event, counts, buckets, reservation, runs } = detail;
  const pending = counts.pending || 0;
  const invited = counts.invited || 0;
  const unreachable = counts.unreachable || 0;
  const total = pending + invited + unreachable + (counts.failed || 0);
  const editable = event.status === 'draft';
  const liveRun = runs.find((r) => !r.ended_at) || null;
  const liveByBucket = new Map((liveRun ? liveRun.buckets : []).map((b) => [b.bucket_id, b]));

  const actions = el('div', { class: 'ev-detail-actions' });
  if (event.status === 'draft') {
    actions.appendChild(el('button', {
      class: 'btn btn-primary', text: 'Arm campaign',
      onclick: () => evAction(event.id, 'arm'),
    }));
  }
  if (event.status === 'draft' || event.status === 'armed') {
    actions.appendChild(el('button', {
      class: 'btn btn-ghost', text: 'Dry run',
      title: 'Does everything except send — selects people, then discards the selection',
      onclick: () => evAction(event.id, 'dry-run'),
    }));
  }
  if (event.status === 'armed') {
    actions.appendChild(el('button', {
      class: 'btn btn-ghost', text: 'Run now',
      onclick: () => evAction(event.id, 'run-now'),
    }));
  }
  if (event.status !== 'done' && event.status !== 'stopped') {
    actions.appendChild(el('button', {
      class: 'btn btn-ghost', text: 'Stop', onclick: () => evAction(event.id, 'stop'),
    }));
  }

  host.appendChild(el('div', { class: 'ev-detail-head' },
    el('div', {},
      el('h3', { text: event.title || 'Untitled event' }),
      el('div', { class: 'rung-sub' },
        el('a', { href: event.event_url, target: '_blank', rel: 'noopener', text: event.event_url })),
      event.starts_at
        ? el('div', { class: 'rung-sub', text: `Starts ${fmtTime(event.starts_at)}` })
        : null,
      reservation
        ? el('div', { class: 'rung-sub', text: `Window reserved ${fmtTime(reservation.from_ts)} – ${fmtTime(reservation.to_ts)}` })
        : null,
      event.close_reason ? el('div', { class: 'rung-sub', text: event.close_reason }) : null,
    ),
    actions,
  ));

  host.appendChild(el('div', { class: 'ev-stats' },
    evStat(total, 'on the list'),
    evStat(invited, 'invited', 'good'),
    evStat(pending, 'still to reach'),
    evStat(unreachable, 'unreachable', unreachable > 0 ? 'warn' : 'muted'),
    evStat(`${event.bucket_cursor}/${buckets.length}`, 'buckets worked', 'muted'),
  ));

  // Say the quiet part out loud, before arming rather than after running.
  const reachable = buckets.reduce((n, b) => n + b.target_count, 0);
  if (unreachable > 0 || reachable < pending + invited) {
    host.appendChild(el('div', { class: 'ev-reach' },
      el('strong', { text: `Best effort: ${reachable} of ${total} are reachable by location.` }),
      el('span', {
        text: unreachable > 0
          ? `${unreachable} have no location we can filter on and will never be invited.`
          : 'The rest are not in any bucket we can filter on.',
      }),
    ));
  }

  const perDay = Math.max(1, event.bucket_ceiling);
  host.appendChild(el('div', { class: 'section-divider' },
    el('span', { text: `Location buckets — ${perDay} per run, densest first` })));

  if (buckets.length === 0) {
    host.appendChild(el('div', { class: 'empty', text: 'No location buckets — nothing on this list can be reached.' }));
  } else {
    const ladder = el('div', { class: 'ladder' },
      el('div', { class: 'ladder-head' },
        el('span', { text: '#' }),
        el('span', { text: 'Location' }),
        el('span', { class: 'col-track', text: 'Rows to page through' }),
        el('span', { class: 'num', text: 'State' }),
        el('span'),
      ));
    // One shared scale, so a long bar always means more paging than a short one.
    const scale = Math.max(PICKER_ROW_CAP, ...buckets.map((b) => b.roster_count || 0));
    for (const b of buckets) {
      ladder.appendChild(evRung(b, {
        editable,
        scale,
        live: liveByBucket.get(b.id) || null,
        onDrop: (rank) => evDropBucket(event.id, rank),
      }));
    }
    host.appendChild(ladder);
  }

  if (runs.length > 0) {
    const wrap = el('div', { class: 'ev-runs' },
      el('div', { class: 'section-divider' }, el('span', { text: 'Runs' })));
    runs.forEach((r) => wrap.appendChild(evRunBlock(r)));
    host.appendChild(wrap);
  }

  // Poll only while something is actually moving.
  clearTimeout(evPollTimer);
  if (liveRun || event.status === 'running') {
    evPollTimer = setTimeout(() => evOpen(event.id, true), 4000);
  }
}

async function evOpen(id, quiet = false) {
  evOpenId = id;
  try {
    const detail = await api(`/api/events/${id}`);
    evRenderDetail(detail);
    // $$ (querySelectorAll), not $ — `$('.ev-card').forEach` threw a TypeError on every
    // open, and the catch below turned it into "Could not load the campaign: …" beside a
    // campaign that had in fact just loaded.
    $$('.ev-card').forEach((c) => c.classList.toggle('is-open', Number(c.dataset.id) === id));
  } catch (e) {
    if (!quiet) alert(`Could not load the campaign: ${e.message}`);
  }
}

async function evAction(id, action) {
  const verb = { arm: 'Arm', 'run-now': 'Run', 'dry-run': 'Dry run', stop: 'Stop' }[action];
  // Arming and running are the two that can lead to real invitations going out.
  if ((action === 'arm' || action === 'run-now')
      && !confirm(`${verb} this campaign? Invitations sent to LinkedIn cannot be recalled.`)) return;
  try {
    await api(`/api/events/${id}/${action}`, { method: 'POST', body: {} });
    await evLoadList();
    await evOpen(id);
  } catch (e) {
    alert(`${verb} failed: ${e.message}`);
  }
}

async function evDropBucket(id, rank) {
  try {
    const detail = await api(`/api/events/${id}/buckets/remove`, { method: 'POST', body: { ranks: [rank] } });
    evRenderDetail(detail);
  } catch (e) {
    alert(`Could not drop that bucket: ${e.message}`);
  }
}

async function evLoadList() {
  const list = $('#evList');
  const events = await api('/api/events');
  list.innerHTML = '';
  $('#evEmpty').hidden = events.length > 0;
  for (const e of events) {
    const counts = e.counts || {};
    const invited = counts.invited || 0;
    const pending = counts.pending || 0;
    const card = el('div', { class: 'ev-card', 'data-id': String(e.id) },
      el('div', { class: 'ev-card-title', text: e.title || e.event_url.replace(/^https?:\/\/(www\.)?/, '') }),
      el('div', { class: 'ev-card-sub', text: `${invited} invited · ${pending} to go${e.starts_at ? ` · starts ${fmtTime(e.starts_at)}` : ''}` }),
      el('div', { class: 'ev-card-right' }, evBadge(e.status)),
    );
    card.addEventListener('click', () => evOpen(e.id));
    list.appendChild(card);
  }
  if (evOpenId !== null && !events.some((e) => e.id === evOpenId)) {
    evOpenId = null;
    $('#evDetail').hidden = true;
  }
}

async function loadEventsScreen() {
  await evLoadList();
  if (evOpenId !== null) await evOpen(evOpenId, true);
}

function initEvents() {
  const form = $('#evCreateForm');
  const msg = $('#evCreateMsg');

  $('#evNewBtn').addEventListener('click', () => {
    form.hidden = !form.hidden;
    if (!form.hidden) $('#evUrl').focus();
  });
  $('#evCancelBtn').addEventListener('click', () => { form.hidden = true; msg.textContent = ''; });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#evCreateBtn');
    btn.disabled = true;
    msg.className = 'ev-create-msg';
    msg.textContent = 'Matching against your roster…';
    try {
      const body = { event_url: $('#evUrl').value.trim(), text: $('#evProfiles').value };
      const created = await api('/api/events', { method: 'POST', body });
      const parts = [`${created.added} on the list`];
      if (created.rejected.length) parts.push(`${created.rejected.length} not connections`);
      if (created.unreachable.length) {
        const why = created.unreachable
          .map((u) => EV_UNREACHABLE_COPY[u.reason] || u.reason)
          .filter((v, i, a) => a.indexOf(v) === i)
          .join('; ');
        parts.push(`${created.unreachable.length} unreachable (${why})`);
      }
      msg.textContent = parts.join(' · ');
      form.hidden = true;
      $('#evProfiles').value = '';
      $('#evUrl').value = '';
      await evLoadList();
      await evOpen(created.event.id);
    } catch (err) {
      msg.className = 'ev-create-msg is-error';
      msg.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });
}

/* ---------- boot ---------- */
function tick() { refreshStatus(); refreshQueue(); refreshEngagementUpNext(); }

function init() {
  initTabs();
  initLogin();
  initDashboard();
  initDrawer();
  initAddList();
  initCohorts();
  initSettings();
  initConnections();
  initEnrichment();
  initSearch();
  initAttention();
  initEvents();
  initLogViewer();
  initWizard();

  refreshLogin();
  tick();
  setInterval(tick, 15000);
  setInterval(refreshLogin, 30000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
