import { test, expect } from 'vitest';
import { mayHaveBeenDelivered, CHECK_THREAD_HINT } from '../../src/core/retry-safety.js';

test('a message parked as submitted-but-unconfirmed may have been delivered', () => {
  expect(mayHaveBeenDelivered({ kind: 'message', last_error: `message submitted but not confirmed — ${CHECK_THREAD_HINT}` })).toBe(true);
});

test('the offline-mid-send and interrupted-mid-send parks carry the same hint', () => {
  expect(mayHaveBeenDelivered({ kind: 'message', last_error: `went offline mid-send — the message may have been sent; ${CHECK_THREAD_HINT}` })).toBe(true);
  expect(mayHaveBeenDelivered({ kind: 'message', last_error: `interrupted mid-send — it may have been sent; ${CHECK_THREAD_HINT}` })).toBe(true);
});

test('the LEGACY false-negative error string is protected too — rows parked before the fix', () => {
  // Dominic's 8 rows and Jacob's 3 sit as `failed` with exactly this text. After the update,
  // "Retry all" must still leave them alone: every one of them was delivered.
  expect(mayHaveBeenDelivered({ kind: 'message', last_error: 'message send not confirmed (composer/thread state)' })).toBe(true);
});

test('an invite is never excluded — LinkedIn dedupes a second request', () => {
  expect(mayHaveBeenDelivered({ kind: 'invite', last_error: `invite submitted but not confirmed — check the profile before retrying` })).toBe(false);
  expect(mayHaveBeenDelivered({ kind: 'invite', last_error: 'message send not confirmed (composer/thread state)' })).toBe(false);
});

test('a message that provably never left is retryable in bulk', () => {
  expect(mayHaveBeenDelivered({ kind: 'message', last_error: 'send button never enabled after typing' })).toBe(false);
  expect(mayHaveBeenDelivered({ kind: 'message', last_error: 'message composer unavailable' })).toBe(false);
  expect(mayHaveBeenDelivered({ kind: 'message', last_error: 'page.goto: net::ERR_NAME_NOT_RESOLVED' })).toBe(false);
  expect(mayHaveBeenDelivered({ kind: 'message', last_error: null })).toBe(false);
});
