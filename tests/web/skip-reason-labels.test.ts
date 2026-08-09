// @vitest-environment jsdom
/// <reference lib="dom" />
/**
 * Every skip_reason the sender can write must render a human label in the drawer —
 * an unmapped reason falls back to a dash, which is indistinguishable from the legacy
 * NULL rows and hides the verdict from the operator. invite_pending split off from
 * already_connected on 2026-08-08 (they were never the same fact).
 */
import { test, expect, beforeEach } from 'vitest';
import { loadApp, type AppInternals } from './helpers/load-app.js';

let app: AppInternals;
beforeEach(() => { app = loadApp(); });

const SENDER_SKIP_REASONS = [
  'already_connected', 'invite_pending', 'email_required', 'not_found',
  'unavailable', 'dismissed', 'not_connected',
] as const;

test('every sender skip_reason has a label (no dash fallbacks)', () => {
  for (const reason of SENDER_SKIP_REASONS) {
    expect(app.SKIP_REASON_LABEL[reason], reason).toBeTruthy();
  }
});

test('the two already-facts read differently to the operator', () => {
  expect(app.SKIP_REASON_LABEL['invite_pending']).not.toBe(app.SKIP_REASON_LABEL['already_connected']);
});
