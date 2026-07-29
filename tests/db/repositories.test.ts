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
  expect(repos.events.countSentSince('1970-01-01T00:00:00Z', 'invite')).toBe(1);
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

/* ---------- kind-aware repositories ---------- */

test('cohort kind: create carries kind; getOrCreate defaults to invite', () => {
  const m = repos.cohorts.create('Msgs Q3', 'Hey {firstName}', true, 'message');
  expect(m.kind).toBe('message');
  const i = repos.cohorts.getOrCreate('Inv Q3', null, true);
  expect(i.kind).toBe('invite');
});

test('profile add dedupes per (url, kind) and stamps the cohort kind', () => {
  const inv = repos.cohorts.create('I', null, true);
  const msg = repos.cohorts.create('M', 'hi', true, 'message');
  const a = repos.profiles.add(inv.id, 'https://www.linkedin.com/in/x', null);
  const b = repos.profiles.add(msg.id, 'https://www.linkedin.com/in/x', null, 'message');
  expect(a.id).not.toBe(b.id);
  expect(a.kind).toBe('invite');
  expect(b.kind).toBe('message');
  // Same (url, kind) returns the existing row.
  expect(repos.profiles.add(msg.id, 'https://www.linkedin.com/in/x', null, 'message').id).toBe(b.id);
});

test('byStatusKind filters by kind; setStatus accepts the new columns', () => {
  const msg = repos.cohorts.create('M', 'hi', true, 'message');
  const p = repos.profiles.add(msg.id, 'https://www.linkedin.com/in/y', null, 'message');
  repos.profiles.setStatus(p.id, 'sent', {
    sent_at: '2026-07-28T10:00:00.000Z', full_name: 'Y Person', thread_url: 'https://www.linkedin.com/messaging/thread/t1/',
  });
  expect(repos.profiles.byStatusKind('sent', 'message')).toHaveLength(1);
  expect(repos.profiles.byStatusKind('sent', 'invite')).toHaveLength(0);
  repos.profiles.setStatus(p.id, 'replied', { replied_at: '2026-07-29T10:00:00.000Z', resolved_at: '2026-07-29T10:00:00.000Z' });
  expect(repos.profiles.findById(p.id)!.replied_at).toBe('2026-07-29T10:00:00.000Z');
});

test('countSentSince counts per kind via the profile join', () => {
  const inv = repos.cohorts.create('I', null, true);
  const msg = repos.cohorts.create('M', 'hi', true, 'message');
  const a = repos.profiles.add(inv.id, 'https://www.linkedin.com/in/a', null);
  const b = repos.profiles.add(msg.id, 'https://www.linkedin.com/in/b', null, 'message');
  repos.events.recordSend(a.id, 'sent');
  repos.events.recordSend(b.id, 'sent');
  expect(repos.events.countSentSince('1970-01-01T00:00:00Z', 'invite')).toBe(1);
  expect(repos.events.countSentSince('1970-01-01T00:00:00Z', 'message')).toBe(1);
});

test('queuedByPriorityKind filters by kind and orders by (priority, id)', () => {
  const inv = repos.cohorts.create('QI', null, true);
  const msg = repos.cohorts.create('QM', 'hi', true, 'message');
  const a = repos.profiles.add(inv.id, 'https://www.linkedin.com/in/qa', null);
  const b = repos.profiles.add(msg.id, 'https://www.linkedin.com/in/qb', null, 'message');
  const c = repos.profiles.add(msg.id, 'https://www.linkedin.com/in/qc', null, 'message');
  repos.profiles.setPriority(c.id, -1);
  const rows = repos.profiles.queuedByPriorityKind('message');
  expect(rows.map((r) => r.id)).toEqual([c.id, b.id]);
  expect(repos.profiles.queuedByPriorityKind('invite').map((r) => r.id)).toEqual([a.id]);
});

test('appState.setRepliesChecked stamps replies_checked_at', () => {
  repos.appState.setRepliesChecked('2026-07-28T12:00:00.000Z');
  expect(repos.appState.get().replies_checked_at).toBe('2026-07-28T12:00:00.000Z');
});
