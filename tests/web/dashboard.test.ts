// @vitest-environment jsdom
/// <reference lib="dom" />
/**
 * Dashboard controller tests (src/web/app.js) — the first coverage this file has had.
 *
 * Motivating regression: the shared "Skipped" and "Needs attention" outcome cards were
 * computed from `status.counts`, which /api/status defines as INVITE-ONLY. Every
 * message-side failure therefore rendered as 0, the attention card never gained
 * `is-clickable`, and #retryFailed stayed hidden — and since that card is the only entry
 * point to the attention modal, a message campaign with a blanked template drained
 * silently, each profile burning a send slot for nothing. Fixed in f4e256b; locked here.
 */
import { test, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadApp, text, byId, stubFetchJson, stubFetchRoutes, type AppInternals } from './helpers/load-app.js';

let app: AppInternals;
const realFetch = globalThis.fetch;

beforeEach(() => {
  app = loadApp();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
});

/** A /api/status payload; per-kind count buckets are the part that matters here. */
function status(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    paused: 0, counts: {}, msg_counts: {}, forecast: {},
    weekly_sent: 0, weekly_cap: 100, msg_weekly_sent: 0, msg_weekly_cap: 250,
    sending: [], guardrail: { tripped: 0 },
    ...over,
  };
}

test('shared outcome cards sum both kinds; Expired stays invite-only', () => {
  app.renderEngine(status({
    counts: { skipped: 2, failed: 1, expired: 3 },
    msg_counts: { skipped: 5, needs_attention: 4 },
  }));

  expect(text('outSkipped')).toBe('7');           // 2 invite + 5 message
  expect(text('outAttn')).toBe('5');              // 1 invite failed + 4 message needs_attention
  // A sent DM never expires — only an invite does, so this card must NOT sum msg_counts.
  expect(text('outExpired')).toBe('3');
});

test('a message-only failure still reaches the operator (the shipped bug)', () => {
  // No invite is in trouble at all: pre-fix this rendered 0 / not clickable / no button,
  // leaving these rows unreachable because the card is the modal's only entry point.
  app.renderEngine(status({ counts: {}, msg_counts: { needs_attention: 3 } }));

  expect(text('outAttn')).toBe('3');
  const card = byId('outAttnCard');
  expect(card.classList.contains('has-attn')).toBe(true);
  expect(card.classList.contains('is-clickable')).toBe(true);

  const retry = byId<HTMLButtonElement>('retryFailed');
  expect(retry.hidden).toBe(false);
  expect(retry.textContent).toBe('Retry failed (3)');
});

test('with nothing in trouble the attention card is inert and the retry button hidden', () => {
  app.renderEngine(status({ counts: { sent: 4 }, msg_counts: { sent: 2 } }));

  expect(text('outAttn')).toBe('0');
  const card = byId('outAttnCard');
  expect(card.classList.contains('has-attn')).toBe(false);
  expect(card.classList.contains('is-clickable')).toBe(false);

  const retry = byId<HTMLButtonElement>('retryFailed');
  expect(retry.hidden).toBe(true);
  expect(retry.textContent).toBe('Retry failed');
});

test('an in-flight retry keeps its own feedback label across a poll', () => {
  const retry = byId<HTMLButtonElement>('retryFailed');
  retry.dataset.busy = '1';
  retry.textContent = 'Requeued 3';

  app.renderEngine(status({ msg_counts: { needs_attention: 3 } }));

  expect(retry.textContent).toBe('Requeued 3'); // poll must not clobber it mid-action
});

test('each conveyor reads only its own kind counts', () => {
  app.renderEngine(status({
    counts: { queued: 7, scheduled: 2, sent: 3, accepted: 1 },
    msg_counts: { queued: 4, scheduled: 3, sent: 5, replied: 2 },
  }));

  expect([text('stQueued'), text('stScheduled'), text('stPending'), text('stAccepted')])
    .toEqual(['7', '2', '3', '1']);
  expect([text('msgQueued'), text('msgScheduled'), text('msgSent'), text('msgReplied')])
    .toEqual(['4', '3', '5', '2']);
});

test('the messages conveyor collapses only while that funnel is completely empty', () => {
  app.renderEngine(status({ counts: { queued: 9 }, msg_counts: {} }));
  expect(byId('msgEngine').classList.contains('is-idle')).toBe(true);
  expect(byId('msgEngineIdle').hidden).toBe(false);

  // A single skipped message is still a message campaign: unfold.
  app.renderEngine(status({ counts: { queued: 9 }, msg_counts: { skipped: 1 } }));
  expect(byId('msgEngine').classList.contains('is-idle')).toBe(false);
  expect(byId('msgEngineIdle').hidden).toBe(true);
});

test('pause and halt tint both engines', () => {
  app.applyEngineState(status({ paused: 1, guardrail: { tripped: 0 } }));
  for (const id of ['engine', 'msgEngine']) {
    expect(byId(id).classList.contains('is-paused')).toBe(true);
    expect(byId(id).classList.contains('is-halted')).toBe(false);
  }

  app.applyEngineState(status({ paused: 0, guardrail: { tripped: 1 } }));
  for (const id of ['engine', 'msgEngine']) {
    expect(byId(id).classList.contains('is-halted')).toBe(true);
  }
});

test('loadAttention renders one row per profile, tagged with its campaign kind', async () => {
  stubFetchJson([
    { id: 1, profile_url: 'https://www.linkedin.com/in/alice', status: 'failed', attempts: 2, last_error: 'boom', cohort_name: 'Founders', kind: 'invite' },
    { id: 2, profile_url: 'https://www.linkedin.com/in/bob', status: 'needs_attention', attempts: 1, last_error: null, cohort_name: 'Connected', kind: 'message' },
  ]);

  await app.loadAttention();

  const rows = document.querySelectorAll('#attentionBody tr');
  expect(rows).toHaveLength(2);
  expect(byId('attentionEmpty').hidden).toBe(true);

  // The glyph is how an operator tells which conveyor a stuck row came from.
  const marks = document.querySelectorAll('#attentionBody .kind-mark');
  expect(marks).toHaveLength(2);
  expect(marks[0].getAttribute('aria-label')).toBe('Connection request');
  expect(marks[0].classList.contains('message')).toBe(false);
  expect(marks[1].getAttribute('aria-label')).toBe('Message');
  expect(marks[1].classList.contains('message')).toBe(true);

  // Slug, cohort and error still render for the message row.
  expect(rows[1].textContent).toContain('bob');
  expect(rows[1].textContent).toContain('Connected');
  expect(rows[1].textContent).toContain('needs attention'); // underscore humanized
});

test('loadAttention shows the empty state and clears stale rows', async () => {
  stubFetchJson([{ id: 1, profile_url: 'https://www.linkedin.com/in/alice', status: 'failed', attempts: 1, cohort_name: 'X', kind: 'invite' }]);
  await app.loadAttention();
  expect(document.querySelectorAll('#attentionBody tr')).toHaveLength(1);

  stubFetchJson([]);
  await app.loadAttention();
  expect(document.querySelectorAll('#attentionBody tr')).toHaveLength(0);
  expect(byId('attentionEmpty').hidden).toBe(false);
});

test('kindMark is accessible for both kinds', () => {
  const invite = app.kindMark('invite');
  const message = app.kindMark('message');
  expect(invite.getAttribute('role')).toBe('img');
  expect(invite.getAttribute('aria-label')).toBe('Connection request');
  expect(message.getAttribute('aria-label')).toBe('Message');
  // The inner SVG is decorative — the label lives on the wrapper.
  expect(message.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
});

test('an unscheduled batch reads as awaiting scheduling, never as a clock time', () => {
  // The pill's whole job is to answer "when will this send?". Showing `now` — which is what
  // an unmaterialized forecast used to carry — made it read as an imminent commitment while
  // the queue was in fact untouched, so the operator went looking for a bug that wasn't there.
  app.renderEngine(status({
    counts: { queued: 12 },
    msg_counts: { queued: 19 },
    forecast: {
      next_batch: { estimated: true, pending: true, count: 5 },
      msg_next_batch: { estimated: true, pending: true, count: 5 },
    },
  }));

  for (const id of ['nextTxt', 'msgNextTxt']) {
    expect(text(id)).toBe('next batch ~5 awaiting scheduling');
    expect(text(id)).not.toMatch(/AM|PM|today/);
  }
});

test('a materialized slot still shows its exact time, and a prediction its day', () => {
  const at = new Date(2026, 6, 1, 15, 30).toISOString();
  app.renderEngine(status({
    counts: { scheduled: 5 },
    msg_counts: { queued: 9 },
    forecast: {
      next_batch: { estimated: false, at, count: 5 },
      msg_next_batch: { estimated: true, at, count: 3 },
    },
  }));

  expect(text('nextTxt')).toMatch(/^next batch 5 at /);      // exact: no tilde
  expect(text('msgNextTxt')).toMatch(/^next batch ~3 .*~/);   // prediction: tilde + relative day
});

/* ---------- the per-conveyor Run now buttons ---------- */

/** The routes initDashboard's handlers touch, beyond the one under test. */
function beltRoutes(runNow: Record<string, unknown>): Record<string, { body?: unknown; status?: number }> {
  return {
    '/api/run-now': runNow,
    '/api/status': { body: status() },
    '/api/queue': { body: [] },
    '/api/queue/grouped': { body: { cohorts: [], events: [] } },
  };
}

/** Click a conveyor's Run now button and let the handler's promise chain settle. */
async function clickBelt(belt: string): Promise<void> {
  beltBtn(belt).click();
  await new Promise((r) => setTimeout(r, 0));
}

function beltBtn(belt: string): HTMLButtonElement {
  const btn = document.querySelector<HTMLButtonElement>(`.run-belt[data-belt="${belt}"]`);
  if (!btn) throw new Error(`no Run now button for belt ${belt}`);
  return btn;
}

/**
 * The bootstrap must survive being called. Task 8 removed the global #runNow button from
 * index.html while app.js still did `$('#runNow').addEventListener(...)` — a bare
 * querySelector, so an unguarded null deref. initDashboard is the 3rd of 14 calls in init(),
 * which meant the whole dashboard died on load: no pause toggle, no polling, no cohorts, no
 * settings. The entire suite stayed green, because nothing in tests/ had ever called it.
 * One assertion is enough to keep that class of bug from shipping twice.
 */
test('initDashboard wires the whole dashboard without throwing', () => {
  expect(() => app.initDashboard()).not.toThrow();
});

test('every conveyor has its own Run now button', () => {
  const belts = [...document.querySelectorAll('.run-belt')].map((b) => (b as HTMLElement).dataset.belt);
  expect(belts.sort()).toEqual(['engagement', 'event', 'invite', 'message']);
});

test('a Run now click posts its own belt and reports what happened', async () => {
  const calls = stubFetchRoutes(beltRoutes({ body: { ok: true, belt: 'message', promoted: 4, started: true } }));
  app.initDashboard();

  await clickBelt('message');

  const post = calls.find((c) => c.path === '/api/run-now');
  expect(post?.method).toBe('POST');
  expect(post?.body).toEqual({ belt: 'message' });
  expect(beltBtn('message').textContent).toBe('Triggered 4');
  // A rewritten label is silent to a screen reader; the card's live region is what speaks.
  expect(text('runMessageStatus')).toBe('Triggered 4 messages, sending now.');
  // Only this belt ran: the other three buttons are untouched.
  expect(beltBtn('invite').textContent).toBe('Run now');
});

test('a busy browser reads as queued, not as a send that happened', async () => {
  stubFetchRoutes(beltRoutes({
    body: { ok: true, belt: 'invite', promoted: 3, started: false, deferred: 'browser busy' },
  }));
  app.initDashboard();

  await clickBelt('invite');

  const btn = beltBtn('invite');
  expect(btn.textContent).toBe('Queued 3');
  expect(btn.textContent).not.toContain('Triggered');
  // The button has no room for the reason, so the reason lives in the tooltip and the
  // announcement — an operator who only saw "Queued 3" would not know why.
  expect(btn.title).toContain('browser busy');
  expect(text('runInviteStatus')).toBe('Queued 3 connection requests — browser busy. The next pass sends them.');
});

test('an empty belt says so rather than claiming a batch went out', async () => {
  stubFetchRoutes(beltRoutes({
    body: { ok: true, belt: 'invite', promoted: 0, started: false, deferred: 'nothing queued' },
  }));
  app.initDashboard();

  await clickBelt('invite');

  expect(beltBtn('invite').textContent).toBe('Nothing queued');
});

test('a refusal shows its short label and puts the reason in the tooltip', async () => {
  stubFetchRoutes(beltRoutes({
    status: 409,
    body: { ok: false, belt: 'invite', code: 'paused', error: 'Paused — Manual pause' },
  }));
  app.initDashboard();

  await clickBelt('invite');

  const btn = beltBtn('invite');
  expect(btn.textContent).toBe('Paused');
  expect(btn.title).toContain('Manual pause');
  // The whole sentence is spoken, not the truncated label a sighted user reads off the face.
  expect(text('runInviteStatus')).toBe('Cannot run connection requests: Paused — Manual pause');
});

test('"already running" cannot be mistaken for the in-flight label it is refusing', async () => {
  // The button says 'Running…' while a click is in flight. A refusal reading 'Running' next
  // to it is a refusal nobody notices — the operator walks away believing a batch went out.
  stubFetchRoutes(beltRoutes({
    status: 409,
    body: { ok: false, belt: 'event', code: 'already_running', error: 'Summit is already running' },
  }));
  app.initDashboard();

  await clickBelt('event');

  const btn = beltBtn('event');
  expect(btn.textContent).toBe('In progress');
  expect(btn.textContent).not.toMatch(/^Running/);
  expect(btn.title).toBe('Summit is already running');
});

test('an unmapped refusal code degrades to Failed rather than showing the raw token', async () => {
  stubFetchRoutes(beltRoutes({
    status: 500,
    body: { ok: false, belt: 'event', code: 'internal_error', error: 'Could not open a run window' },
  }));
  app.initDashboard();

  await clickBelt('event');

  const btn = beltBtn('event');
  expect(btn.textContent).toBe('Failed');
  expect(btn.textContent).not.toContain('internal_error');
  expect(btn.title).toBe('Could not open a run window');
});

test('the event belt reports a start, not the "Nothing queued" its missing count would imply', async () => {
  // The event answer deliberately carries NO `promoted` — there is no unit to count for an
  // event run. Read as a sender answer, the absent field is a zero and the operator is told
  // nothing happened, seconds before an event campaign starts inviting people.
  stubFetchRoutes(beltRoutes({
    body: { ok: true, belt: 'event', started: false, event_id: 3, from: 'a', to: 'b' },
  }));
  app.initDashboard();

  await clickBelt('event');

  const btn = beltBtn('event');
  expect(btn.textContent).toBe('Starting…');
  expect(btn.textContent).not.toBe('Nothing queued');
  expect(text('runEventStatus')).toBe('Starting the next run for event invites.');
});

test('a transport failure admits it does not know, instead of reporting a failed send', async () => {
  // The POST may have been received and acted on. "Failed" would be a claim about LinkedIn
  // state that this handler is in no position to make.
  globalThis.fetch = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;
  app.initDashboard();

  await clickBelt('invite');

  const btn = beltBtn('invite');
  expect(btn.textContent).toBe('No response');
  expect(btn.title).toContain('may or may not have started');
});

test('a second click while a run is in flight cannot fire a second batch', async () => {
  const calls = stubFetchRoutes(beltRoutes({ body: { ok: true, belt: 'invite', promoted: 3, started: true } }));
  app.initDashboard();
  const btn = beltBtn('invite');

  btn.click();
  // `disabled` alone is not the guard being tested: clear it the way a stray re-render or an
  // AT activation path could, and the handler must still refuse to start a second run.
  btn.disabled = false;
  btn.click();
  await new Promise((r) => setTimeout(r, 0));

  expect(calls.filter((c) => c.path === '/api/run-now')).toHaveLength(1);
  expect(btn.textContent).toBe('Triggered 3');
});

test('the idle label always comes back — a verdict can never latch onto the button', async () => {
  // The revert used to restore whatever textContent read at click time. A click landing
  // while "Triggered 3" was still on the face would capture THAT as the idle label and the
  // button would say "Triggered 3" for the rest of the session.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  stubFetchRoutes(beltRoutes({ body: { ok: true, belt: 'invite', promoted: 3, started: true } }));
  app.initDashboard();
  const btn = beltBtn('invite');

  btn.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(btn.textContent).toBe('Triggered 3');

  await vi.advanceTimersByTimeAsync(2600);      // past RUN_BELT_REVERT_MS
  expect(btn.textContent).toBe('Run now');
  expect(btn.title).toBe('Send one invite batch right now');
  expect(btn.disabled).toBe(false);

  // Second run, and the pristine label survives it too.
  btn.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(btn.textContent).toBe('Triggered 3');
  await vi.advanceTimersByTimeAsync(2600);
  expect(btn.textContent).toBe('Run now');
});
