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

test('frontBlock creates a -1 block when the queue floor is 0', () => {
  const c = repos.cohorts.create('FB', null, true);
  const a = repos.profiles.add(c.id, 'https://www.linkedin.com/in/fb-a', null);
  const b = repos.profiles.add(c.id, 'https://www.linkedin.com/in/fb-b', null);
  const d = repos.profiles.add(c.id, 'https://www.linkedin.com/in/fb-d', null);
  repos.profiles.frontBlock([d.id]);
  expect(repos.profiles.findById(d.id)!.priority).toBe(-1);
  expect(repos.profiles.queuedByPriority().map((p) => p.id)).toEqual([d.id, a.id, b.id]);
});

test('frontBlock: one-by-one adds converge on the same order as a single list', () => {
  const c = repos.cohorts.create('FB2', null, true);
  const backlog = repos.profiles.add(c.id, 'https://www.linkedin.com/in/fb2-old', null);
  // One-by-one: each call JOINS the front block instead of jumping ahead of the last —
  // the (priority, id) tie-break keeps arrival order.
  const a = repos.profiles.add(c.id, 'https://www.linkedin.com/in/fb2-a', null);
  repos.profiles.frontBlock([a.id]);
  const b = repos.profiles.add(c.id, 'https://www.linkedin.com/in/fb2-b', null);
  repos.profiles.frontBlock([b.id]);
  expect(repos.profiles.findById(a.id)!.priority).toBe(-1);
  expect(repos.profiles.findById(b.id)!.priority).toBe(-1);
  expect(repos.profiles.queuedByPriority().map((p) => p.id)).toEqual([a.id, b.id, backlog.id]);
});

test('frontBlock joins an existing deeper block rather than going below it', () => {
  const c = repos.cohorts.create('FB3', null, true);
  const a = repos.profiles.add(c.id, 'https://www.linkedin.com/in/fb3-a', null);
  const b = repos.profiles.add(c.id, 'https://www.linkedin.com/in/fb3-b', null);
  repos.profiles.setPriority(a.id, -5);
  repos.profiles.frontBlock([b.id]);
  expect(repos.profiles.findById(b.id)!.priority).toBe(-5);
  // Same priority -> id order: the older row keeps its lead.
  expect(repos.profiles.queuedByPriority().map((p) => p.id)).toEqual([a.id, b.id]);
});

test('frontBlock with no ids is a no-op', () => {
  const c = repos.cohorts.create('FB4', null, true);
  const a = repos.profiles.add(c.id, 'https://www.linkedin.com/in/fb4-a', null);
  repos.profiles.frontBlock([]);
  expect(repos.profiles.findById(a.id)!.priority).toBe(0);
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

test('add re-queues a dismissed profile into the new cohort', () => {
  const old = repos.cohorts.create('OldArch', null, true);
  const p = repos.profiles.add(old.id, 'https://www.linkedin.com/in/redo', 'old note');
  repos.cohorts.setArchived(old.id, true);
  repos.profiles.skipCohortQueue(old.id);
  const next = repos.cohorts.create('NextUp', null, true);
  const again = repos.profiles.add(next.id, 'https://www.linkedin.com/in/redo', null);
  expect(again.id).toBe(p.id);
  expect(again.cohort_id).toBe(next.id);
  expect(again.status).toBe('queued');
  expect(again.skip_reason).toBeNull();
  expect(again.custom_message).toBeNull(); // the old campaign's note must not follow it
});

test('add never re-queues a profile skipped for a LinkedIn-observed reason', () => {
  const c1 = repos.cohorts.create('Verdict1', null, true);
  const p = repos.profiles.add(c1.id, 'https://www.linkedin.com/in/conn', null);
  repos.profiles.setStatus(p.id, 'skipped', { skip_reason: 'already_connected' });
  const c2 = repos.cohorts.create('Verdict2', null, true);
  const again = repos.profiles.add(c2.id, 'https://www.linkedin.com/in/conn', null);
  expect(again.status).toBe('skipped');
  expect(again.skip_reason).toBe('already_connected');
  expect(again.cohort_id).toBe(c1.id);
});

test('add never re-queues a profile with real send history', () => {
  const c1 = repos.cohorts.create('Sent1', null, true);
  const p = repos.profiles.add(c1.id, 'https://www.linkedin.com/in/was-sent', null);
  repos.profiles.setStatus(p.id, 'sent', { sent_at: '2026-01-01T00:00:00.000Z' });
  const c2 = repos.cohorts.create('Sent2', null, true);
  const again = repos.profiles.add(c2.id, 'https://www.linkedin.com/in/was-sent', null);
  expect(again.status).toBe('sent');
  expect(again.cohort_id).toBe(c1.id);
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

// ── send_log / profile_events timestamp format ──────────────────────────────────────────
// countSentSince compares `at` as TEXT against windowStartIso(), which is toISOString().
// TEXT >= TEXT is only a chronological comparison while both sides are that one shape.
// These pin it. See the same reasoning, and the CHECK that enforces it, on `engagements`.

test('recordSend stores `at` in the toISOString() shape countSentSince compares against', () => {
  const c = repos.cohorts.create('A', 'hi', true);
  const p = repos.profiles.add(c.id, 'https://www.linkedin.com/in/x', null);
  repos.events.recordSend(p.id, 'sent');
  const row = repos.db.prepare('SELECT at FROM send_log').get() as unknown as { at: string };
  expect(row.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('recordEvent stores `at` in the same shape', () => {
  const c = repos.cohorts.create('A', 'hi', true);
  const p = repos.profiles.add(c.id, 'https://www.linkedin.com/in/x', null);
  repos.events.recordEvent(p.id, 'accepted');
  const row = repos.db.prepare('SELECT at FROM profile_events').get() as unknown as { at: string };
  expect(row.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

// The boundary that the space-form got wrong. A different-date case passes even with the
// bug present (byte 0-9 decides it before reaching the separator), so it would give false
// confidence — the window start here shares its calendar date with both sends, which is
// exactly when byte 10 (' ' 0x20 vs 'T' 0x54) decided the comparison instead.
test('countSentSince includes and excludes correctly at a same-calendar-date window boundary', () => {
  const c = repos.cohorts.create('A', 'hi', true);
  const inside = repos.profiles.add(c.id, 'https://www.linkedin.com/in/inside', null);
  const outside = repos.profiles.add(c.id, 'https://www.linkedin.com/in/outside', null);
  repos.events.recordSend(inside.id, 'sent', '2026-07-26T14:00:00.000Z');
  repos.events.recordSend(outside.id, 'sent', '2026-07-26T08:00:00.000Z');
  expect(repos.events.countSentSince('2026-07-26T09:00:00.000Z', 'invite')).toBe(1);
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
