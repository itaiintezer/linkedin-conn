import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';

let repos: Repos;
beforeEach(() => { repos = new Repos(openDatabase(':memory:')); });

test('creates a cohort and finds it by name', () => {
  const c = repos.cohorts.create('Founders', 'Hi {firstName}!', false);
  expect(c.id).toBeGreaterThan(0);
  expect(repos.cohorts.findByName('Founders')!.id).toBe(c.id);
});

test('addProfile dedupes by normalized url and returns existing', () => {
  const c = repos.cohorts.create('A', null, true);
  const p1 = repos.profiles.add(c.id, 'https://www.linkedin.com/in/jane', null);
  const p2 = repos.profiles.add(c.id, 'https://www.linkedin.com/in/jane', null);
  expect(p2.id).toBe(p1.id);
  expect(repos.profiles.countAll()).toBe(1);
});

test('records send_log and events and counts sent in window', () => {
  const c = repos.cohorts.create('A', 'hi', true);
  const p = repos.profiles.add(c.id, 'https://www.linkedin.com/in/x', null);
  repos.events.recordSend(p.id, 'sent');
  expect(repos.events.countSentSince('1970-01-01T00:00:00Z')).toBe(1);
});

test('settings get returns defaults and update persists', () => {
  expect(repos.settings.get().weekly_cap).toBe(100);
  repos.settings.update({ weekly_cap: 50 });
  expect(repos.settings.get().weekly_cap).toBe(50);
});
