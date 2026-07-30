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
  const attention = (c.failed || 0) + (c.needs_attention || 0)
    + (mc.failed || 0) + (mc.needs_attention || 0);
  setText('outAttn', attention);
  const attnCard = document.getElementById('outAttnCard');
  if (attnCard) {
    attnCard.classList.toggle('has-attn', attention > 0);
    attnCard.classList.toggle('is-clickable', attention > 0);
  }

  // Show the bulk Retry button only when there's something to retry. Skip while a
  // retry is in flight so the poll doesn't clobber its "Requeued N" feedback.
  const retryBtn = $('#retryFailed');
  if (retryBtn && !retryBtn.dataset.busy) {
    retryBtn.hidden = attention === 0;
    retryBtn.textContent = attention ? `Retry failed (${attention})` : 'Retry failed';
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

/* The engine has one visual run-state: running, paused (amber), or halted (red).
   Stops the conveyor + pulse animations via CSS and shows a badge on the track.
   One pause state, one guardrail: both engines wear it. */
function applyEngineState(status) {
  const tripped = !!(status.guardrail && status.guardrail.tripped);
  const paused = !!status.paused;
  for (const [engine, badge, txt] of [
    [$('#engine'), $('#engineState'), $('#engineStateTxt')],
    [$('#msgEngine'), $('#msgEngineState'), $('#msgEngineStateTxt')],
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

function kindMark(kind) {
  const isMsg = kind === 'message';
  const node = el('span', {
    class: 'kind-mark' + (isMsg ? ' message' : ''),
    role: 'img',
    'aria-label': isMsg ? 'Message' : 'Connection request',
    title: isMsg ? 'Message to an existing connection' : 'Connection request',
  });
  node.innerHTML = isMsg ? ICON_KIND_MESSAGE : ICON_KIND_INVITE;
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
    class: 'note-btn' + (has ? '' : ' empty'),
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
    const { cohorts } = await api('/api/queue/grouped');
    const total = cohorts.reduce((n, c) => n + c.count, 0);
    count.textContent = `${total} up for processing`;
    if (!cohorts.length) { container.replaceChildren(); empty.hidden = false; return; }
    empty.hidden = true;
    container.replaceChildren(...cohorts.map(renderCohortGroup));
  } catch (_) { /* transient */ }
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

async function loadAttention() {
  const body = $('#attentionBody'), empty = $('#attentionEmpty');
  try {
    const rows = await api('/api/attention');
    if (!rows.length) { body.replaceChildren(); empty.hidden = false; return; }
    empty.hidden = true;
    // Both conveyors land here, so each row carries its kind glyph — same marker the
    // queue and the shared drill-downs use.
    body.replaceChildren(...rows.map((p) => el('tr', {},
      el('td', { class: 'trunc' }, el('div', { class: 'attn-profile' },
        kindMark(p.kind),
        el('a', { href: p.profile_url, target: '_blank', rel: 'noopener', title: p.profile_url || '', text: slugFromUrl(p.profile_url) }),
      )),
      el('td', { class: 'mono trunc', title: p.cohort_name || '' }, p.cohort_name || '—'),
      el('td', { class: 'status-cell' }, el('span', { class: `pill ${p.status}`, text: p.status.replace('_', ' ') })),
      el('td', { class: 'num mono' }, String(p.attempts ?? 0)),
      el('td', { class: 'err trunc', title: p.last_error || '' }, p.last_error || '—'),
      el('td', { class: 'row-actions' },
        el('button', { class: 'btn btn-ghost', onclick: (e) => actOnProfile(p, 'retry', e.currentTarget) }, 'Retry'),
        el('button', { class: 'btn btn-ghost', onclick: (e) => actOnProfile(p, 'dismiss', e.currentTarget) }, 'Dismiss'),
      ),
    )));
  } catch (_) { empty.hidden = false; }
}

async function actOnProfile(p, action, btn) {
  const result = $('#attentionResult');
  if (btn) { btn.disabled = true; btn.textContent = action === 'retry' ? 'Retrying…' : 'Dismissing…'; }
  try {
    await api(`/api/profiles/${p.id}/${action}`, { method: 'POST' });
    toast(result, action === 'retry'
      ? `Requeued ${slugFromUrl(p.profile_url)} — it's back in the queue.`
      : `Dismissed ${slugFromUrl(p.profile_url)}.`);
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

  $('#runNow').addEventListener('click', async () => {
    const btn = $('#runNow');
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Running…';
    try {
      const res = await api('/api/run-now', { method: 'POST' });
      btn.textContent = res && typeof res.promoted === 'number'
        ? `Triggered ${res.promoted}` : 'Triggered';
      await refreshStatus();
      await refreshQueue();
    } catch (_) {
      btn.textContent = 'Failed';
    }
    setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 2500);
  });

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
async function loadSettings() {
  try {
    const s = await api('/api/settings');
    $('#setWeeklyCap').value = s.weekly_cap ?? '';
    $('#setBatchSize').value = s.batch_size ?? '';
    $('#setBatchesPerDay').value = s.batches_per_day ?? '';
    $('#setMsgWeeklyCap').value = s.msg_weekly_cap ?? '';
    $('#setMsgBatchSize').value = s.msg_batch_size ?? '';
    $('#setMsgBatchesPerDay').value = s.msg_batches_per_day ?? '';
    $('#setReplyChecks').value = s.reply_checks_per_day ?? '';
    $('#setStart').value = s.workday_start_hour ?? '';
    $('#setEnd').value = s.workday_end_hour ?? '';
    $('#setRosterSync').value = s.roster_sync_per_day ?? '';
    // The key itself is never returned — only whether one is set.
    $('#apifyKeyState').textContent = s.apify_key_set ? '— configured' : '— not set';
    refreshConnections();
    loadLogs();
  } catch (_) { /* ignore */ }
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

  $('#enrichRetry')?.addEventListener('click', async () => {
    const r = await api('/api/enrichment/retry-failed', { method: 'POST', body: {} });
    toast(result(), `Re-queued ${fmtInt(r.requeued)} for another attempt.`);
    await refreshEnrichment();
  });

  $('#saveApifyKey')?.addEventListener('click', async () => {
    const key = $('#setApifyKey').value.trim();
    if (!key) { toast(result(), 'Paste a key first.', true); return; }
    try {
      await api('/api/settings', { method: 'POST', body: { apify_api_key: key } });
      $('#setApifyKey').value = '';   // never leave a credential sitting in the DOM
      toast(result(), 'Apify key saved.');
      await loadSettings();
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
    const num = (sel) => { const v = $(sel).value; return v === '' ? undefined : Number(v); };
    const patch = {
      weekly_cap: num('#setWeeklyCap'),
      batch_size: num('#setBatchSize'),
      batches_per_day: num('#setBatchesPerDay'),
      msg_weekly_cap: num('#setMsgWeeklyCap'),
      msg_batch_size: num('#setMsgBatchSize'),
      msg_batches_per_day: num('#setMsgBatchesPerDay'),
      reply_checks_per_day: num('#setReplyChecks'),
      workday_start_hour: num('#setStart'),
      workday_end_hour: num('#setEnd'),
      roster_sync_per_day: num('#setRosterSync'),
    };
    Object.keys(patch).forEach((k) => patch[k] === undefined && delete patch[k]);
    try {
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

/* ---------- boot ---------- */
function tick() { refreshStatus(); refreshQueue(); }

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
  initAttention();
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
