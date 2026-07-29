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
import { test, expect, beforeEach, afterEach } from 'vitest';
import { loadApp, text, byId, stubFetchJson, type AppInternals } from './helpers/load-app.js';

let app: AppInternals;
const realFetch = globalThis.fetch;

beforeEach(() => {
  app = loadApp();
});

afterEach(() => {
  globalThis.fetch = realFetch;
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
