import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';

let repos: Repos;
beforeEach(() => { repos = new Repos(openDatabase(':memory:')); });

test('defaults: logged out, not tripped, zero streak', () => {
  const s = repos.appState.get();
  expect(s.login_logged_in).toBe(0);
  expect(s.guardrail_tripped).toBe(0);
  expect(s.failure_streak).toBe(0);
});

test('setLogin writes flag, expiry and confirmed-at', () => {
  repos.appState.setLogin({ loggedIn: true, cookieExpiry: '2027-01-01T00:00:00.000Z' }, '2026-06-30T10:00:00.000Z');
  const s = repos.appState.get();
  expect(s.login_logged_in).toBe(1);
  expect(s.login_cookie_expiry).toBe('2027-01-01T00:00:00.000Z');
  expect(s.login_confirmed_at).toBe('2026-06-30T10:00:00.000Z');
});

test('trip then clearGuardrail round-trips', () => {
  repos.appState.trip('checkpoint', 'captcha', '2026-06-30T10:00:00.000Z');
  let s = repos.appState.get();
  expect(s.guardrail_tripped).toBe(1);
  expect(s.guardrail_reason).toBe('checkpoint');
  expect(s.guardrail_detail).toBe('captcha');
  expect(s.guardrail_tripped_at).toBe('2026-06-30T10:00:00.000Z');
  repos.appState.clearGuardrail();
  s = repos.appState.get();
  expect(s.guardrail_tripped).toBe(0);
  expect(s.guardrail_reason).toBeNull();
  expect(s.guardrail_detail).toBeNull();
  expect(s.guardrail_tripped_at).toBeNull();
});

test('incFailureStreak returns the new value; reset zeroes it', () => {
  expect(repos.appState.incFailureStreak()).toBe(1);
  expect(repos.appState.incFailureStreak()).toBe(2);
  expect(repos.appState.get().failure_streak).toBe(2);
  repos.appState.resetFailureStreak();
  expect(repos.appState.get().failure_streak).toBe(0);
});
