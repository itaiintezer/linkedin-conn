import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import {
  isTripped, tripCheckpoint, tripLoginLost, recordFailure, recordSuccess, recordReadError,
} from '../../src/worker/guardrail.js';

let repos: Repos;
const NOW = new Date('2026-06-30T10:00:00.000Z');
// Deterministic probes so no test ever does a real DNS lookup.
const online = async () => true;
const offline = async () => false;
beforeEach(() => { repos = new Repos(openDatabase(':memory:')); });

test('isTripped reflects app_state', () => {
  expect(isTripped(repos)).toBe(false);
  tripCheckpoint(repos, NOW);
  expect(isTripped(repos)).toBe(true);
  expect(repos.appState.get().guardrail_reason).toBe('checkpoint');
});

test('tripCheckpoint records a specific detail when given one', () => {
  tripCheckpoint(repos, NOW, 'Checkpoint page at https://www.linkedin.com/checkpoint/challenge/x (matched "security verification")');
  expect(repos.appState.get().guardrail_detail).toContain('checkpoint/challenge/x');
  expect(repos.appState.get().guardrail_detail).toContain('security verification');
});

test('tripCheckpoint keeps the generic detail when none is given', () => {
  tripCheckpoint(repos, NOW);
  expect(repos.appState.get().guardrail_detail).toBe('Captcha/checkpoint detected');
});

test('tripLoginLost sets login_lost reason', () => {
  tripLoginLost(repos, NOW);
  expect(repos.appState.get().guardrail_reason).toBe('login_lost');
  expect(isTripped(repos)).toBe(true);
});

test('recordFailure trips only at the threshold (default 3)', async () => {
  expect(await recordFailure(repos, 'err1', NOW, online)).toBe('counted');
  expect(await recordFailure(repos, 'err2', NOW, online)).toBe('counted');
  expect(await recordFailure(repos, 'err3', NOW, online)).toBe('tripped');
  expect(repos.appState.get().guardrail_reason).toBe('repeated_failures');
  expect(repos.appState.get().guardrail_detail).toBe('err3');
});

test('recordSuccess resets the streak so failures must re-accumulate', async () => {
  await recordFailure(repos, 'err1', NOW, online);
  await recordFailure(repos, 'err2', NOW, online);
  recordSuccess(repos);
  expect(repos.appState.get().failure_streak).toBe(0);
  expect(await recordFailure(repos, 'err1', NOW, online)).toBe('counted'); // streak is 1 again, not 3
});

test('threshold honors settings.failure_threshold', async () => {
  repos.settings.update({ failure_threshold: 1 });
  expect(await recordFailure(repos, 'boom', NOW, online)).toBe('tripped');
});

test('recordReadError with checkpoint text trips immediately as checkpoint', async () => {
  await recordReadError(repos, 'captcha challenge page', NOW, online);
  expect(repos.appState.get().guardrail_reason).toBe('checkpoint');
});

test('recordReadError with a plain error counts toward the streak', async () => {
  await recordReadError(repos, 'navigation timeout', NOW, online);
  expect(isTripped(repos)).toBe(false);
  expect(repos.appState.get().failure_streak).toBe(1);
});

// --- Offline forgiveness: the machine being asleep/disconnected is not LinkedIn ---------

const SUSPENDED = 'page.goto: net::ERR_NETWORK_IO_SUSPENDED at https://www.linkedin.com/messaging/ '
  + "Call log: navigating to 'https://www.linkedin.com/messaging/', waiting until 'domcontentloaded'";

test('a definitely-offline error is forgiven: no streak, no trip, no probe needed', async () => {
  const probeMustNotRun = async (): Promise<boolean> => { throw new Error('probe should not be consulted'); };
  expect(await recordFailure(repos, SUSPENDED, NOW, probeMustNotRun)).toBe('offline');
  expect(repos.appState.get().failure_streak).toBe(0);
  expect(isTripped(repos)).toBe(false);
});

test.each([
  'net::ERR_INTERNET_DISCONNECTED',
  'net::ERR_NAME_NOT_RESOLVED',
  'net::ERR_NETWORK_CHANGED',
  'net::ERR_ADDRESS_UNREACHABLE',
])('%s never accumulates to a halt, however many times it repeats', async (code) => {
  for (let i = 0; i < 5; i++) {
    expect(await recordFailure(repos, `page.goto: ${code} at https://x`, NOW)).toBe('offline');
  }
  expect(isTripped(repos)).toBe(false);
  expect(repos.appState.get().failure_streak).toBe(0);
});

test('an ambiguous goto timeout is forgiven when the probe says offline', async () => {
  const msg = "page.goto: Timeout 30000ms exceeded. Call log: navigating to 'https://www.linkedin.com/messaging/'";
  expect(await recordFailure(repos, msg, NOW, offline)).toBe('offline');
  expect(repos.appState.get().failure_streak).toBe(0);
});

test('an ambiguous goto timeout still counts when the probe says online', async () => {
  const msg = 'page.goto: Timeout 30000ms exceeded.';
  expect(await recordFailure(repos, msg, NOW, online)).toBe('counted');
  expect(repos.appState.get().failure_streak).toBe(1);
});

test('a non-network failure counts even while offline — it is not connectivity-shaped', async () => {
  // e.g. a broken selector: forgiving it because Wi-Fi happens to be down would hide rot.
  expect(await recordFailure(repos, 'send composer unavailable', NOW, offline)).toBe('counted');
  expect(repos.appState.get().failure_streak).toBe(1);
});

test('recordReadError forgives offline reads (the 01:14 AM reply-check halt scenario)', async () => {
  for (let i = 0; i < 4; i++) await recordReadError(repos, SUSPENDED, NOW);
  expect(isTripped(repos)).toBe(false);
  expect(repos.appState.get().failure_streak).toBe(0);
});

test('offline failures do not RESET a real streak either — they are simply ignored', async () => {
  await recordFailure(repos, 'err1', NOW, online);
  await recordFailure(repos, SUSPENDED, NOW);
  expect(repos.appState.get().failure_streak).toBe(1); // untouched, not cleared
  await recordFailure(repos, 'err2', NOW, online);
  expect(await recordFailure(repos, 'err3', NOW, online)).toBe('tripped');
});
