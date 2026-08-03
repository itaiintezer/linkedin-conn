import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { parseBelt, weeklyRemaining } from '../../src/worker/run-now.js';

let repos: Repos;
const NOW = new Date('2026-08-04T10:00:00.000Z');

beforeEach(() => {
  repos = new Repos(openDatabase(':memory:'));
  repos.appState.setLogin({ loggedIn: true, cookieExpiry: null }, NOW.toISOString());
});

test('parseBelt accepts the four belts, defaults to all, rejects anything else', () => {
  expect(parseBelt('invite')).toBe('invite');
  expect(parseBelt('message')).toBe('message');
  expect(parseBelt('engagement')).toBe('engagement');
  expect(parseBelt('event')).toBe('event');
  expect(parseBelt('all')).toBe('all');
  expect(parseBelt(undefined)).toBe('all');
  expect(parseBelt(null)).toBe('all');
  expect(parseBelt('invites')).toBeNull();
  expect(parseBelt(7)).toBeNull();
});

test('weeklyRemaining reads each belt against its own cap', () => {
  repos.settings.update({ weekly_cap: 10, msg_weekly_cap: 20, engage_weekly_cap: 30 });
  expect(weeklyRemaining(repos, 'invite', NOW)).toBe(10);
  expect(weeklyRemaining(repos, 'message', NOW)).toBe(20);
  expect(weeklyRemaining(repos, 'engagement', NOW)).toBe(30);
});
