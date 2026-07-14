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
  const c = status.counts || {};
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
  const nb = f.next_batch;
  if (!nb) fillPill('nextTxt', null, null, 'no batch queued');
  else if (nb.blocked) fillPill('nextTxt', null, null, nb.reason);
  else if (nb.estimated === false) fillPill('nextTxt', 'next batch', nb.count, `at ${fmtClock(nb.at)}`);
  else fillPill('nextTxt', 'next batch', `~${nb.count}`, `${fmtRelDay(nb.at)} ~${fmtClock(nb.at)}`);

  // --- Flow: conveyor stations ---
  setText('stQueued', c.queued || 0);
  setText('stScheduled', c.scheduled || 0);
  setText('stPending', c.sent || 0);
  setText('stAccepted', c.accepted || 0);
  setText('acceptedFoot', `checked ${status.acceptance_checked_at ? fmtClock(status.acceptance_checked_at) : 'never'}`);

  // --- Terminal outcomes ---
  setText('outExpired', c.expired || 0);
  setText('outSkipped', c.skipped || 0);
  const attention = (c.failed || 0) + (c.needs_attention || 0);
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
   Stops the conveyor + pulse animations via CSS and shows a badge on the track. */
function applyEngineState(status) {
  const engine = $('#engine'), badge = $('#engineState'), txt = $('#engineStateTxt');
  const tripped = !!(status.guardrail && status.guardrail.tripped);
  const paused = !!status.paused;
  engine.classList.toggle('is-paused', paused || tripped);
  engine.classList.toggle('is-halted', tripped);
  badge.hidden = !(paused || tripped);
  if (txt) txt.textContent = tripped ? 'Halted' : 'Paused';
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
   (keyed on trippedAt) so the status poll doesn't hammer /api/incidents. */
let shotLoadedFor = null;
async function loadGuardrailShot(g) {
  const link = $('#guardrailShot');
  if (!link || shotLoadedFor === g.trippedAt) return;
  shotLoadedFor = g.trippedAt;
  link.hidden = true;
  try {
    const rows = await api('/api/incidents?limit=1');
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
    el('span', { class: 'qg-name' }, c.name || '—'),
    el('span', { class: 'qg-count' }, `${c.count} in queue`),
    el('span', { class: 'qg-actions' },
      el('button', { class: 'qg-ico', title: 'Prioritize cohort', onclick: () => queueAction(`/api/queue/cohort/${c.id}/move`, { to: 'top' }) }, '⤒'),
      el('button', { class: 'qg-ico rm', title: 'Remove cohort from queue', onclick: () => queueAction(`/api/queue/cohort/${c.id}/remove`) }, '✕'),
    ),
  );
  const rows = c.profiles.map((p) => el('div', { class: 'qg-row' },
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
  expired: { field: 'sent_at', label: 'sent' },
};

/* Human labels for profiles.skip_reason; NULL (legacy rows) renders as a dash. */
const SKIP_REASON_LABEL = {
  already_connected: 'already connected',
  email_required: 'requires their email',
  unavailable: 'composer unavailable',
  dismissed: 'dismissed',
};

function closeDrawer() {
  $('#statusDrawer').hidden = true;
  $('#drawerBackdrop').hidden = true;
}

async function openDrawer(status, title) {
  const drawer = $('#statusDrawer'), body = $('#drawerBody');
  $('#drawerTitle').textContent = title;
  $('#drawerCount').textContent = 'loading…';
  body.replaceChildren();
  drawer.hidden = false;
  $('#drawerBackdrop').hidden = false;
  try {
    const rows = await api(`/api/profiles?status=${encodeURIComponent(status)}`);
    $('#drawerCount').textContent = `${rows.length} profile${rows.length === 1 ? '' : 's'}`;
    if (!rows.length) {
      body.replaceChildren(el('div', { class: 'drawer-empty', text: 'No profiles with this status yet.' }));
      return;
    }
    const d = DRILL_DATE[status] || { field: 'sent_at', label: 'sent' };
    body.replaceChildren(...rows.map((p) => el('div', { class: 'drawer-row' },
      el('a', { class: 'drawer-slug', href: p.profile_url, target: '_blank', rel: 'noopener', text: slugFromUrl(p.profile_url) }),
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
    const open = () => openDrawer(card.dataset.drill, card.dataset.drillTitle);
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
    body.replaceChildren(...rows.map((p) => el('tr', {},
      el('td', { class: 'trunc' }, el('a', { href: p.profile_url, target: '_blank', rel: 'noopener', title: p.profile_url || '', text: slugFromUrl(p.profile_url) })),
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

  const recheck = $('#recheckAccept');
  if (recheck) {
    // The Accepted station is a drill target; keep the button's own activation keys
    // (Enter/Space) from bubbling to the station's drill handler. Let every other key
    // through — notably Escape must still reach the document handler that closes drawers.
    recheck.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); });
    recheck.addEventListener('click', async (e) => {
      e.stopPropagation();
      recheck.disabled = true;
      recheck.classList.add('busy');
      const original = recheck.title;
      try {
        const res = await api('/api/recheck-acceptance', { method: 'POST' });
        const label = res && res.ran
          ? (res.accepted > 0 ? `Found ${res.accepted}` : 'No new acceptances')
          : ({ paused: 'Paused', guardrail: 'Blocked — check attention', no_pending: 'No pending invites',
               logged_out: 'Logged out', login_lost: 'Logged out', read_error: 'Read failed',
               empty_read: 'No new acceptances' }[res && res.reason] || 'Done');
        recheck.title = label;
        const status = $('#recheckStatus');
        if (status) status.textContent = label;
        await refreshStatus();
      } catch (_) {
        recheck.title = 'Failed';
        const status = $('#recheckStatus');
        if (status) status.textContent = 'Recheck failed';
      }
      recheck.classList.remove('busy');
      setTimeout(() => { recheck.title = original; recheck.disabled = false; }, 2500);
    });
  }

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

async function loadCohortOptions() {
  const sel = $('#listCohortSelect');
  if (!sel) return;
  const current = sel.value;
  try {
    const cohorts = await api('/api/cohorts');
    sel.replaceChildren(
      el('option', { value: '', text: 'New (auto-dated)' }),
      ...cohorts.map((c) => el('option', { value: c.name, text: c.name })),
    );
    sel.value = current; // preserve selection across refreshes when still present
  } catch (_) { /* leave the default option */ }
}

function initAddList() {
  const tpl = $('#listTemplate'), counter = $('#tplCount'), area = $('#listText');
  const updateTplCount = () => { counter.textContent = `${tpl.value.length} / 300`; };
  tpl.addEventListener('input', updateTplCount);
  updateTplCount();

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
  $('#listCohortSelect').addEventListener('change', async (e) => {
    const name = e.target.value;
    if (!name) { $('#listCohort').value = ''; $('#listCohort').disabled = false; return; }
    try {
      const cohorts = await api('/api/cohorts');
      const c = cohorts.find((x) => x.name === name);
      if (c) {
        $('#listCohort').value = c.name; $('#listCohort').disabled = true;
        tpl.value = c.message_template || ''; updateTplCount();
      }
    } catch (_) { /* ignore */ }
  });

  $('#listForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const result = $('#listResult');
    const payload = {
      cohort: $('#listCohort').value.trim() || undefined,
      text: area.value,
      message_template: tpl.value.trim() || undefined,
    };
    try {
      const r = await api('/api/lists', { method: 'POST', body: payload });
      toast(result, `Added ${r.added} of ${r.found} found.`);
      result.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      area.value = '';
      updateCount();
      loadCohortOptions();
    } catch (err) {
      toast(result, `Failed: ${err.message}`, true);
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
  renderMetricsTable(metrics);
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
  const stat = m
    ? `${m.total} profiles · ${m.sent} sent · ${Math.round((m.acceptance_rate || 0) * 100)}% accepted`
    : 'no sends yet';
  const tplText = (c.message_template && c.message_template.trim())
    ? el('div', { class: 'tpl', text: c.message_template })
    : el('div', { class: 'tpl none', text: 'No template (bare request)' });

  // Archive asks in place: the card flips to a confirm state, no browser dialogs.
  const card = el('div', {
    class: 'cohort-card',
    onclick: () => { if (!card.classList.contains('is-confirming')) openCohortEditor(c); },
  },
    el('div', { class: 'cc-main' },
      el('div', { class: 'name' },
        el('span', { text: c.name }),
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
  $('#cohortFormTitle').textContent = c ? `Edit “${c.name}”` : 'New cohort';
  $('#cohortName').value = c ? (c.name || '') : '';
  $('#cohortName').disabled = !!c; // name is the key; edit templates, not names
  $('#cohortTemplate').value = c ? (c.message_template || '') : '';
  updateCohortTplCount();
  $('#cohortModal').hidden = false;
  (c ? $('#cohortTemplate') : $('#cohortName')).focus();
}

function closeCohortModal() { $('#cohortModal').hidden = true; }

function updateCohortTplCount() {
  $('#cohortTplCount').textContent = `${$('#cohortTemplate').value.length} / 300`;
}

function initCohorts() {
  $('#cohortTemplate').addEventListener('input', updateCohortTplCount);
  $('#cohortModalClose').addEventListener('click', closeCohortModal);
  $('#cohortCancel').addEventListener('click', closeCohortModal);
  $('#cohortModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeCohortModal(); });
  $('#cohortForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      name: $('#cohortName').value.trim(),
      message_template: $('#cohortTemplate').value.trim() || undefined,
    };
    if (!payload.name) return;
    try {
      await api('/api/cohorts', { method: 'POST', body: payload });
      $('#cohortForm').reset();
      $('#cohortName').disabled = false;
      closeCohortModal();
      loadCohortsScreen();
    } catch (_) { /* ignore */ }
  });
}

/* ---------- settings ---------- */
async function loadSettings() {
  try {
    const s = await api('/api/settings');
    $('#setWeeklyCap').value = s.weekly_cap ?? '';
    $('#setBatchSize').value = s.batch_size ?? '';
    $('#setBatchesPerDay').value = s.batches_per_day ?? '';
    $('#setStart').value = s.workday_start_hour ?? '';
    $('#setEnd').value = s.workday_end_hour ?? '';
    $('#setAccountType').value = s.account_type || 'unknown';
    loadLogs();
  } catch (_) { /* ignore */ }
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
      workday_start_hour: num('#setStart'),
      workday_end_hour: num('#setEnd'),
      account_type: $('#setAccountType').value,
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
  const showStep = (n) => $$('#setupWizard [data-step]').forEach((s) => { s.hidden = s.dataset.step !== String(n); });

  const startLoginPoll = () => {
    if (pollId) return;
    pollId = setInterval(async () => {
      try {
        const { loggedIn } = await api('/api/login-status');
        $('#wizLoginState').innerHTML = loggedIn
          ? '<span class="led on"></span>Connected'
          : '<span class="led off"></span>Waiting for login…';
        $('#wizNext').disabled = !loggedIn;
      } catch (_) { /* keep waiting */ }
    }, 2000);
  };
  const stopLoginPoll = () => { if (pollId) { clearInterval(pollId); pollId = null; } };

  $('#wizConnectBtn').addEventListener('click', async () => {
    $('#wizLoginState').innerHTML = '<span class="led off"></span>Opening login window…';
    try { await api('/api/login', { method: 'POST' }); } catch (_) { /* surfaced via poll */ }
    startLoginPoll();
  });
  $('#wizNext').addEventListener('click', () => showStep(2));
  $('#wizFinish').addEventListener('click', async () => {
    const account_type = $('#wizAccountType').value;
    try { await api('/api/settings', { method: 'POST', body: { account_type, onboarded: 1 } }); } catch (_) { /* ignore */ }
    stopLoginPoll();
    wiz.hidden = true;
    refreshLogin();
    loadSettings();
  });

  api('/api/settings').then((s) => {
    if (!s.onboarded) { wiz.hidden = false; showStep(1); startLoginPoll(); }
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
