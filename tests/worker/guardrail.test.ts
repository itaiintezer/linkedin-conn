import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import {
  isTripped, tripCheckpoint, tripLoginLost, recordFailure, recordSuccess, recordReadError,
} from '../../src/worker/guardrail.js';

let repos: Repos;
const NOW = new Date('2026-06-30T10:00:00.000Z');
beforeEach(() => { repos = new Repos(openDatabase(':memory:')); });

test('isTripped reflects app_state', () => {
  expect(isTripped(repos)).toBe(false);
  tripCheckpoint(repos, NOW);
  expect(isTripped(repos)).toBe(true);
  expect(repos.appState.get().guardrail_reason).toBe('checkpoint');
});

test('tripLoginLost sets login_lost reason', () => {
  tripLoginLost(repos, NOW);
  expect(repos.appState.get().guardrail_reason).toBe('login_lost');
  expect(isTripped(repos)).toBe(true);
});

test('recordFailure trips only at the threshold (default 3)', () => {
  expect(recordFailure(repos, 'err1', NOW)).toBe(false);
  expect(recordFailure(repos, 'err2', NOW)).toBe(false);
  expect(recordFailure(repos, 'err3', NOW)).toBe(true);
  expect(repos.appState.get().guardrail_reason).toBe('repeated_failures');
  expect(repos.appState.get().guardrail_detail).toBe('err3');
});

test('recordSuccess resets the streak so failures must re-accumulate', () => {
  recordFailure(repos, 'err1', NOW);
  recordFailure(repos, 'err2', NOW);
  recordSuccess(repos);
  expect(repos.appState.get().failure_streak).toBe(0);
  expect(recordFailure(repos, 'err1', NOW)).toBe(false); // streak is 1 again, not 3
});

test('threshold honors settings.failure_threshold', () => {
  repos.settings.update({ failure_threshold: 1 });
  expect(recordFailure(repos, 'boom', NOW)).toBe(true);
});

test('recordReadError with checkpoint text trips immediately as checkpoint', () => {
  recordReadError(repos, 'captcha challenge page', NOW);
  expect(repos.appState.get().guardrail_reason).toBe('checkpoint');
});

test('recordReadError with a plain error counts toward the streak', () => {
  recordReadError(repos, 'navigation timeout', NOW);
  expect(isTripped(repos)).toBe(false);
  expect(repos.appState.get().failure_streak).toBe(1);
});
