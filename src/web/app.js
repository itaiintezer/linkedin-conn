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
function initTabs() {
  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach((t) => t.classList.toggle('is-active', t === tab));
      const name = tab.dataset.tab;
      $$('main > .panel').forEach((p) => { p.hidden = p.id !== `tab-${name}`; });
      if (name === 'cohorts') loadCohorts();
      if (name === 'metrics') loadMetrics();
      if (name === 'settings') loadSettings();
    });
  });
}

/* ---------- login status ---------- */
async function refreshLogin() {
  const led = $('#loginLed'), label = $('#loginLabel'), btn = $('#connectBtn');
  try {
    const { loggedIn } = await api('/api/login-status');
    led.className = 'led ' + (loggedIn ? 'on' : 'off');
    label.textContent = loggedIn ? 'linked' : 'not logged in';
    btn.hidden = loggedIn;
  } catch (_) {
    led.className = 'led off';
    label.textContent = 'link error';
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

function renderCards(status) {
  const c = status.counts || {};
  const pct = status.weekly_cap ? Math.min(100, Math.round((status.weekly_sent / status.weekly_cap) * 100)) : 0;
  const cards = [
    { cls: 'accent-week', label: 'This week', value: `${status.weekly_sent}`, sub: ` / ${status.weekly_cap}`, meter: pct },
    { cls: 'accent-queued', label: 'Queued', value: c.queued || 0 },
    { cls: 'accent-sched', label: 'Scheduled', value: c.scheduled || 0 },
    { cls: 'accent-sent', label: 'Sent', value: c.sent || 0 },
    { cls: 'accent-accepted', label: 'Accepted', value: c.accepted || 0 },
    { cls: 'accent-attn', label: 'Needs attention', value: c.needs_attention || 0 },
  ];
  // Show the Retry button only when there's something to retry.
  const retryable = (c.failed || 0) + (c.needs_attention || 0);
  const retryBtn = $('#retryFailed');
  if (retryBtn) {
    retryBtn.hidden = retryable === 0;
    retryBtn.textContent = retryable ? `Retry failed (${retryable})` : 'Retry failed';
  }
  const wrap = $('#statCards');
  wrap.replaceChildren(...cards.map((card) => {
    const valNode = el('div', { class: 'value' }, String(card.value));
    if (card.sub) valNode.appendChild(el('span', { class: 'sub', text: card.sub }));
    const children = [el('div', { class: 'label', text: card.label }), valNode];
    if (card.meter != null) {
      children.push(el('div', { class: 'meter' }, el('i', { style: `width:${card.meter}%` })));
    }
    return el('div', { class: `card ${card.cls}` }, ...children);
  }));
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

async function refreshStatus() {
  try {
    const status = await api('/api/status');
    renderCards(status);
    applyPauseUi(status);
  } catch (_) { /* transient; next tick retries */ }
}

async function refreshQueue() {
  const body = $('#queueBody'), empty = $('#queueEmpty'), count = $('#queueCount');
  try {
    const rows = await api('/api/profiles');
    count.textContent = `${rows.length} record${rows.length === 1 ? '' : 's'}`;
    if (!rows.length) { body.replaceChildren(); empty.hidden = false; return; }
    empty.hidden = true;
    body.replaceChildren(...rows.map((p) => el('tr', {},
      el('td', {}, el('a', { href: p.profile_url, target: '_blank', rel: 'noopener', text: slugFromUrl(p.profile_url) })),
      el('td', { class: 'mono' }, p.cohort_name || '—'),
      el('td', {}, el('span', { class: `pill ${p.status}`, text: p.status.replace('_', ' ') })),
      el('td', { class: 'mono' }, fmtTime(p.scheduled_for)),
      el('td', { class: p.last_error ? 'err' : 'mono', title: p.last_error || '' }, p.last_error || '—'),
    )));
  } catch (_) { /* transient */ }
}

function initDashboard() {
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
}

/* ---------- add list ---------- */
function initAddList() {
  const tpl = $('#listTemplate'), counter = $('#tplCount');
  const updateCount = () => { counter.textContent = `${tpl.value.length} / 300`; };
  tpl.addEventListener('input', updateCount);
  updateCount();

  $('#listFile').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const existing = $('#listText').value.trim();
      $('#listText').value = existing ? existing + '\n' + reader.result : String(reader.result);
    };
    reader.readAsText(file);
  });

  $('#listForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const result = $('#listResult');
    const payload = {
      cohort: $('#listCohort').value.trim(),
      text: $('#listText').value,
      message_template: tpl.value.trim() || undefined,
      allow_no_note: $('#listAllowNoNote').checked,
    };
    if (!payload.cohort) { toast(result, 'Cohort name is required.', true); return; }
    try {
      const r = await api('/api/lists', { method: 'POST', body: payload });
      toast(result, `Added ${r.added} of ${r.found} found.`);
      $('#listText').value = '';
      $('#listFile').value = '';
    } catch (err) {
      toast(result, `Failed: ${err.message}`, true);
    }
  });
}

/* ---------- cohorts ---------- */
async function loadCohorts() {
  const list = $('#cohortList'), empty = $('#cohortEmpty');
  try {
    const cohorts = await api('/api/cohorts');
    if (!cohorts.length) { list.replaceChildren(); empty.hidden = false; return; }
    empty.hidden = true;
    list.replaceChildren(...cohorts.map((c) => {
      const tplText = (c.message_template && c.message_template.trim())
        ? el('div', { class: 'tpl', text: c.message_template })
        : el('div', { class: 'tpl none', text: 'No template (bare request)' });
      return el('div', { class: 'cohort-card', onclick: () => fillCohortForm(c) },
        el('div', { class: 'name' },
          el('span', { text: c.name }),
          el('span', { class: 'tag' + (c.allow_no_note ? ' on' : ''), text: c.allow_no_note ? 'no-note ok' : 'note req' }),
        ),
        tplText,
      );
    }));
  } catch (_) { empty.hidden = false; }
}

function fillCohortForm(c) {
  $('#cohortName').value = c.name || '';
  $('#cohortTemplate').value = c.message_template || '';
  $('#cohortAllowNoNote').checked = !!c.allow_no_note;
  $('#cohortName').focus();
}

function initCohorts() {
  $('#cohortForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      name: $('#cohortName').value.trim(),
      message_template: $('#cohortTemplate').value.trim() || undefined,
      allow_no_note: $('#cohortAllowNoNote').checked,
    };
    if (!payload.name) return;
    try {
      await api('/api/cohorts', { method: 'POST', body: payload });
      $('#cohortForm').reset();
      loadCohorts();
    } catch (_) { /* ignore */ }
  });
}

/* ---------- metrics ---------- */
async function loadMetrics() {
  const body = $('#metricsBody'), empty = $('#metricsEmpty');
  try {
    const rows = await api('/api/metrics');
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
  } catch (_) { empty.hidden = false; }
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
  } catch (_) { /* ignore */ }
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

/* ---------- boot ---------- */
function tick() { refreshStatus(); refreshQueue(); }

function init() {
  initTabs();
  initLogin();
  initDashboard();
  initAddList();
  initCohorts();
  initSettings();

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
