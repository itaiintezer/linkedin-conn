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

test('queuedByPriority orders by (priority, id)', () => {
  const c = repos.cohorts.create('P', null, true);
  const a = repos.profiles.add(c.id, 'https://www.linkedin.com/in/a', null);
  const b = repos.profiles.add(c.id, 'https://www.linkedin.com/in/b', null);
  repos.profiles.setPriority(b.id, -1);
  const ordered = repos.profiles.queuedByPriority().map((p) => p.id);
  expect(ordered).toEqual([b.id, a.id]);
});

test('moveProfile top/bottom repositions within the queued pool', () => {
  const c = repos.cohorts.create('M', null, true);
  const a = repos.profiles.add(c.id, 'https://www.linkedin.com/in/a', null);
  const b = repos.profiles.add(c.id, 'https://www.linkedin.com/in/b', null);
  const d = repos.profiles.add(c.id, 'https://www.linkedin.com/in/d', null);
  repos.profiles.moveProfile(d.id, 'top');
  repos.profiles.moveProfile(a.id, 'bottom');
  expect(repos.profiles.queuedByPriority().map((p) => p.id)).toEqual([d.id, b.id, a.id]);
});

test('prioritizeCohort moves a cohort block ahead of others', () => {
  const c1 = repos.cohorts.create('C1', null, true);
  const c2 = repos.cohorts.create('C2', null, true);
  const a = repos.profiles.add(c1.id, 'https://www.linkedin.com/in/a', null);
  const b = repos.profiles.add(c2.id, 'https://www.linkedin.com/in/b', null);
  const e = repos.profiles.add(c2.id, 'https://www.linkedin.com/in/e', null);
  repos.profiles.prioritizeCohort(c2.id, 'top');
  const ordered = repos.profiles.queuedByPriority().map((p) => p.id);
  expect(ordered.slice(0, 2).sort()).toEqual([b.id, e.id].sort());
  expect(ordered[2]).toBe(a.id);
});

test('reorderCohorts recomputes queued priorities from the given order', () => {
  const c1 = repos.cohorts.create('C1', null, true);
  const c2 = repos.cohorts.create('C2', null, true);
  const a = repos.profiles.add(c1.id, 'https://www.linkedin.com/in/a', null);
  const b = repos.profiles.add(c2.id, 'https://www.linkedin.com/in/b', null);
  repos.profiles.reorderCohorts([c2.id, c1.id]);
  expect(repos.profiles.queuedByPriority().map((p) => p.id)).toEqual([b.id, a.id]);
});

test('skipCohortQueue marks queued and scheduled profiles skipped', () => {
  const c = repos.cohorts.create('S', null, true);
  const a = repos.profiles.add(c.id, 'https://www.linkedin.com/in/a', null);
  const b = repos.profiles.add(c.id, 'https://www.linkedin.com/in/b', null);
  repos.profiles.setScheduled(b.id, '2099-01-01T00:00:00.000Z');
  repos.profiles.skipCohortQueue(c.id);
  expect(repos.profiles.findById(a.id)!.status).toBe('skipped');
  expect(repos.profiles.findById(b.id)!.status).toBe('skipped');
});

/* ---------- cohort archive ---------- */

test('setArchived hides a cohort from list() and listArchived() shows it', () => {
  const c = repos.cohorts.create('ArchRepo', null, true);
  repos.cohorts.setArchived(c.id, true);
  expect(repos.cohorts.list().find((x) => x.id === c.id)).toBeUndefined();
  expect(repos.cohorts.listArchived().find((x) => x.id === c.id)).toBeDefined();
  repos.cohorts.setArchived(c.id, false);
  expect(repos.cohorts.list().find((x) => x.id === c.id)).toBeDefined();
});

test('getOrCreate resurrects an archived cohort instead of writing into a hidden one', () => {
  const c = repos.cohorts.create('Zombie', null, true);
  repos.cohorts.setArchived(c.id, true);
  const again = repos.cohorts.getOrCreate('Zombie', null, true);
  expect(again.id).toBe(c.id);
  expect(again.archived).toBe(0);
  expect(repos.cohorts.list().find((x) => x.id === c.id)).toBeDefined();
});
