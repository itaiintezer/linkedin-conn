import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { parseBelt, weeklyRemaining, preflight } from '../../src/worker/run-now.js';

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

test('weeklyRemaining subtracts what has already gone out this week', () => {
  repos.settings.update({ weekly_cap: 10, engage_weekly_cap: 30 });
  const c = repos.cohorts.create('C', null, true);
  const p = repos.profiles.add(c.id, 'https://www.linkedin.com/in/counted', null);
  repos.events.recordSend(p.id, 'sent', NOW.toISOString());
  expect(weeklyRemaining(repos, 'invite', NOW)).toBe(9);
  // Untouched by an invite send — proves per-belt capacity is actually per-belt.
  expect(weeklyRemaining(repos, 'message', NOW)).toBe(250);

  const e = repos.engagements.add('https://www.linkedin.com/posts/abc', 'urn:li:activity:1', 'like', null);
  repos.engagements.setStatus(e.id, 'sent', { reacted_at: NOW.toISOString() });
  expect(weeklyRemaining(repos, 'engagement', NOW)).toBe(29);
});

test('preflight refuses a paused engine and echoes the real pause reason', () => {
  repos.settings.update({ paused: 1, pause_reason: 'LinkedIn weekly invitation limit reached' });
  const r = preflight(repos, 'invite', NOW);
  expect(r?.code).toBe('paused');
  expect(r?.error).toContain('LinkedIn weekly invitation limit reached');
});

test('preflight refuses a tripped guardrail', () => {
  repos.appState.trip('repeated_failures', 'five in a row', NOW.toISOString());
  const r = preflight(repos, 'invite', NOW);
  expect(r?.code).toBe('guardrail');
});

test('preflight refuses when logged out', () => {
  repos.appState.setLogin({ loggedIn: false, cookieExpiry: null }, NOW.toISOString());
  expect(preflight(repos, 'invite', NOW)?.code).toBe('not_logged_in');
});

test('preflight refuses a belt whose weekly cap is spent, naming the cap', () => {
  repos.settings.update({ weekly_cap: 1 });
  const c = repos.cohorts.create('C', null, true);
  const p = repos.profiles.add(c.id, 'https://www.linkedin.com/in/spent', null);
  repos.events.recordSend(p.id, 'sent');
  const r = preflight(repos, 'invite', NOW);
  expect(r?.code).toBe('capped');
  expect(r?.error).toContain('1/1 invites');
});

test('a spent invite cap does not refuse the message belt', () => {
  repos.settings.update({ weekly_cap: 1 });
  const c = repos.cohorts.create('C', null, true);
  const p = repos.profiles.add(c.id, 'https://www.linkedin.com/in/spent', null);
  repos.events.recordSend(p.id, 'sent');
  expect(preflight(repos, 'message', NOW)).toBeNull();
});

test('the all alias checks only the shared gates, not any belt cap', () => {
  repos.settings.update({ weekly_cap: 0 });
  expect(preflight(repos, 'all', NOW)).toBeNull();
});
