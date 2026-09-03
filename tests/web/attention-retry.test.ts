// @vitest-environment jsdom
/**
 * The Attention tab's two retry surfaces after the 2026-09-02 send-confirmation fix:
 * the "Retry all profiles" toast names the message rows the server left alone, and the
 * per-row Retry asks first when the DM may already have landed.
 */
import { test, expect, beforeEach } from 'vitest';
import { loadApp, type AppInternals } from './helpers/load-app.js';

let app: AppInternals;
beforeEach(() => { app = loadApp(); });

test('retryAllSummary: plain requeue reads as before', () => {
  expect(app.retryAllSummary({ ok: true, retried: 3, skipped: 0 }))
    .toBe("Requeued 3 profiles — they'll be re-scheduled and retried.");
  expect(app.retryAllSummary({ ok: true, retried: 1 })).toMatch(/^Requeued 1 profile —/);
  expect(app.retryAllSummary({ ok: true, retried: 0, skipped: 0 })).toBe('Nothing to retry.');
  expect(app.retryAllSummary(null)).toBe('Nothing to retry.');
});

test('retryAllSummary: skipped message rows are named, with what to do about them', () => {
  const s = app.retryAllSummary({ ok: true, retried: 6, skipped: 2 });
  expect(s).toContain('Requeued 6 profiles');
  expect(s).toContain('2 messages left alone — they may already have been delivered.');
  expect(s).toMatch(/Check the conversation, then use Retry on that row/);
  // Only skips, nothing requeued: no misleading "Nothing to retry".
  const only = app.retryAllSummary({ ok: true, retried: 0, skipped: 1 });
  expect(only).toContain('1 message left alone — it may already have been delivered.');
  expect(only).not.toContain('Nothing to retry');
});

test('retryNeedsConfirmation: only message rows whose send may have landed', () => {
  const parked = (last_error: string, kind = 'message', extra: Record<string, unknown> = {}) =>
    ({ source: 'profile', id: 1, kind, profile_url: 'https://www.linkedin.com/in/p', last_error, ...extra });
  expect(app.retryNeedsConfirmation(parked('message submitted but not confirmed — check the conversation before retrying'))).toBe(true);
  expect(app.retryNeedsConfirmation(parked('went offline mid-send — the message may have been sent; check the conversation before retrying'))).toBe(true);
  // Legacy rows parked by the old check, before the update.
  expect(app.retryNeedsConfirmation(parked('message send not confirmed (composer/thread state)'))).toBe(true);
  // Never left the account.
  expect(app.retryNeedsConfirmation(parked('send button never enabled after typing'))).toBe(false);
  expect(app.retryNeedsConfirmation(parked('message composer unavailable'))).toBe(false);
  // Invites and posts never ask — a duplicate invite is deduped by LinkedIn, and comments
  // have their own unverified handling.
  expect(app.retryNeedsConfirmation(parked('message send not confirmed (composer/thread state)', 'invite'))).toBe(false);
  expect(app.retryNeedsConfirmation({ source: 'engagement', id: 3, post_url: 'https://www.linkedin.com/posts/x', last_error: 'message send not confirmed' })).toBe(false);
});
