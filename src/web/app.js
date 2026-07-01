/* ============================================================
   RELAY — front-end controller
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
      if (name === 'settings') loadSettings();
      if (name === 'attention') loadAttention();
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
  setText('outAlready', c.already_connected || 0);
  const attention = (c.failed || 0) + (c.needs_attention || 0);
  setText('outAttn', attention);
  const attnCard = document.getElementById('outAttnCard');
  if (attnCard) {
    attnCard.classList.toggle('has-attn', attention > 0);
    attnCard.classList.toggle('is-clickable', attention > 0);
  }

  // Show the bulk Retry button only when there's something to retry.
  const retryBtn = $('#retryFailed');
  if (retryBtn) {
    retryBtn.hidden = attention === 0;
    retryBtn.textContent = attention ? `Retry failed (${attention})` : 'Retry failed';
  }
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
    $('#guardrailTime').textContent = g.trippedAt ? `Halted ${fmtTime(g.trippedAt)}` : '';
  }
}

async function refreshStatus() {
  try {
    const status = await api('/api/status');
    renderEngine(status);
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

function noteCell(note) {
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
  return el('td', { class: 'note-col' }, btn);
}

let queueLimit = 10;

async function refreshQueue() {
  const body = $('#queueBody'), empty = $('#queueEmpty'), count = $('#queueCount'), more = $('#queueMore');
  try {
    const { upcoming, total_remaining } = await api(`/api/queue?limit=${queueLimit}`);
    count.textContent = `${total_remaining} up for processing`;
    if (more) more.hidden = total_remaining <= upcoming.length;
    if (!upcoming.length) { body.replaceChildren(); empty.hidden = false; return; }
    empty.hidden = true;
    body.replaceChildren(...upcoming.map((p) => el('tr', {},
      el('td', {}, el('a', { href: p.profile_url, target: '_blank', rel: 'noopener', text: slugFromUrl(p.profile_url) })),
      el('td', { class: 'mono' }, p.cohort_name || '—'),
      el('td', {}, el('span', { class: `pill ${p.status}`, text: p.status.replace('_', ' ') })),
      el('td', { class: 'mono' }, fmtTime(p.scheduled_for)),
      noteCell(p.note),
    )));
  } catch (_) { /* transient */ }
}

async function loadAttention() {
  const body = $('#attentionBody'), empty = $('#attentionEmpty');
  try {
    const rows = await api('/api/attention');
    if (!rows.length) { body.replaceChildren(); empty.hidden = false; return; }
    empty.hidden = true;
    body.replaceChildren(...rows.map((p) => el('tr', {},
      el('td', {}, el('a', { href: p.profile_url, target: '_blank', rel: 'noopener', text: slugFromUrl(p.profile_url) })),
      el('td', { class: 'mono' }, p.cohort_name || '—'),
      el('td', {}, el('span', { class: `pill ${p.status}`, text: p.status.replace('_', ' ') })),
      el('td', { class: 'num mono' }, String(p.attempts ?? 0)),
      el('td', { class: 'err', title: p.last_error || '' }, p.last_error || '—'),
      el('td', { class: 'row-actions' },
        el('button', { class: 'btn btn-ghost', onclick: () => actOnProfile(p.id, 'retry') }, 'Retry'),
        el('button', { class: 'btn btn-ghost', onclick: () => actOnProfile(p.id, 'dismiss') }, 'Dismiss'),
      ),
    )));
  } catch (_) { empty.hidden = false; }
}

async function actOnProfile(id, action) {
  try {
    await api(`/api/profiles/${id}/${action}`, { method: 'POST' });
    await loadAttention();
    await refreshStatus();
  } catch (_) { /* ignore */ }
}

function initAttention() {
  const more = $('#queueMore');
  if (more) more.addEventListener('click', () => {
    queueLimit = queueLimit >= 1000 ? 10 : 1000;
    more.textContent = queueLimit >= 1000 ? 'Show less' : 'View more';
    refreshQueue();
  });
  const retryAll = $('#attentionRetryAll');
  if (retryAll) retryAll.addEventListener('click', async () => {
    retryAll.disabled = true;
    try { await api('/api/retry', { method: 'POST' }); await loadAttention(); await refreshStatus(); }
    catch (_) { /* ignore */ }
    retryAll.disabled = false;
  });
}

function initDashboard() {
  // The "Needs attention" outcome jumps to the Attention tab — but only when it
  // carries a count (renderEngine toggles `is-clickable`).
  const attnCard = $('#outAttnCard');
  if (attnCard) attnCard.addEventListener('click', () => {
    if (attnCard.classList.contains('is-clickable')) switchTab('attention');
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
    try {
      await api('/api/retry', { method: 'POST' });
      await refreshStatus();
      await refreshQueue();
    } catch (_) { /* ignore */ }
    btn.disabled = false;
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
function todayCohortName() {
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const d = new Date();
  return `${M[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

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

  $('#listCohort').placeholder = todayCohortName();

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
  const [cohorts, metrics] = await Promise.all([
    api('/api/cohorts').catch(() => []),
    api('/api/metrics').catch(() => []),
  ]);
  renderMetricsTable(metrics);
  renderCohortList(cohorts, metrics);
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
    const median = (m.median_time_to_accept_days == null) ? '—' : String(m.median_time_to_accept_days);
    return el('tr', {},
      el('td', { class: 'mono' }, m.cohort_name || '—'),
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
  if (!cohorts.length) { list.replaceChildren(); empty.hidden = false; return; }
  empty.hidden = true;
  list.replaceChildren(...cohorts.map((c) => {
    const m = byName[c.name];
    const stat = m
      ? `${m.sent} sent · ${Math.round((m.acceptance_rate || 0) * 100)}% accepted`
      : 'no sends yet';
    const tplText = (c.message_template && c.message_template.trim())
      ? el('div', { class: 'tpl', text: c.message_template })
      : el('div', { class: 'tpl none', text: 'No template (bare request)' });
    return el('div', { class: 'cohort-card', onclick: () => openCohortEditor(c) },
      el('div', { class: 'name' }, el('span', { text: c.name })),
      el('div', { class: 'cohort-stat', text: stat }),
      tplText,
    );
  }));
}

function openCohortEditor(c) {
  const form = $('#cohortForm');
  form.hidden = false;
  $('#cohortFormTitle').textContent = c ? `Edit “${c.name}”` : 'New cohort';
  $('#cohortName').value = c ? (c.name || '') : '';
  $('#cohortName').disabled = !!c; // name is the key; edit templates, not names
  $('#cohortTemplate').value = c ? (c.message_template || '') : '';
  $('#cohortName').focus();
  form.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function initCohorts() {
  const newBtn = $('#cohortNewBtn');
  if (newBtn) newBtn.addEventListener('click', () => openCohortEditor(null));
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
      $('#cohortForm').hidden = true;
      $('#cohortName').disabled = false;
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

/* ---------- run log viewer ---------- */
let logLines = [];
async function loadLogs() {
  const view = $('#logView');
  try {
    const { lines } = await api('/api/logs?tail=1000');
    logLines = lines;
    renderLogView();
  } catch (_) { if (view) view.textContent = 'failed to load log'; }
}
function renderLogView() {
  const view = $('#logView');
  if (!view) return;
  const q = ($('#logFilter').value || '').toLowerCase();
  const shown = q ? logLines.filter((l) => l.toLowerCase().includes(q)) : logLines;
  view.textContent = shown.length ? shown.join('\n') : '(no matching lines)';
  view.scrollTop = view.scrollHeight;
}
function initLogViewer() {
  const refresh = $('#logRefresh'), filter = $('#logFilter');
  if (refresh) refresh.addEventListener('click', loadLogs);
  if (filter) filter.addEventListener('input', renderLogView);
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
