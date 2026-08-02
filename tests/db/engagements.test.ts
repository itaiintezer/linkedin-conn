import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';

let repos: Repos;
beforeEach(() => { repos = new Repos(openDatabase(':memory:')); });

const URN = 'urn:li:activity:7123456789012345678';
const URL = `https://www.linkedin.com/feed/update/${URN}/`;

test('add stores a reaction-only task in the queued state', () => {
  const e = repos.engagements.add(URL, URN, 'insightful', null);
  expect(e.post_urn).toBe(URN);
  expect(e.reaction).toBe('insightful');
  expect(e.comment_text).toBeNull();
  expect(e.status).toBe('queued');
  expect(e.attempts).toBe(0);
  expect(e.reacted_at).toBeNull();
  expect(e.commented_at).toBeNull();
});

test('add is idempotent per post — one engagement per post', () => {
  const first = repos.engagements.add(URL, URN, 'like', null);
  const second = repos.engagements.add(URL, URN, 'celebrate', 'different text');
  expect(second.id).toBe(first.id);
  expect(second.reaction).toBe('like'); // the original wins; the API 409s before reaching here
  expect(repos.engagements.all()).toHaveLength(1);
});

test('findByUrn locates the row the API needs for its duplicate check', () => {
  const e = repos.engagements.add(URL, URN, 'like', null);
  expect(repos.engagements.findByUrn(URN)?.id).toBe(e.id);
  expect(repos.engagements.findByUrn('urn:li:activity:9')).toBeUndefined();
});

test('setStatus rejects a column that is not on the allow-list', () => {
  const e = repos.engagements.add(URL, URN, 'like', null);
  expect(() => repos.engagements.setStatus(e.id, 'sent', { post_urn: 'x' } as never))
    .toThrow(/Illegal engagement column/);
});

test('setStatus with no fields writes only the status', () => {
  // The sender's happy path is setStatus(id, 'sent', {}) — an empty SET list would be a
  // syntax error, so pin that the status-only UPDATE is well formed and touches nothing else.
  const e = repos.engagements.add(URL, URN, 'like', null);
  repos.engagements.setScheduled(e.id, '2026-08-02T10:00:00.000Z');
  repos.engagements.setStatus(e.id, 'sent');
  repos.engagements.setStatus(e.id, 'sent', {});
  const row = repos.engagements.findById(e.id)!;
  expect(row.status).toBe('sent');
  expect(row.scheduled_for).toBe('2026-08-02T10:00:00.000Z');
  expect(row.post_urn).toBe(URN);
  expect(row.attempts).toBe(0);
});

test('setScheduled moves a row to scheduled with its slot', () => {
  const e = repos.engagements.add(URL, URN, 'like', null);
  repos.engagements.setScheduled(e.id, '2026-08-02T10:00:00.000Z');
  const row = repos.engagements.findById(e.id)!;
  expect(row.status).toBe('scheduled');
  expect(row.scheduled_for).toBe('2026-08-02T10:00:00.000Z');
});

test('queuedByPriority orders by priority then id', () => {
  const a = repos.engagements.add('u1', 'urn:li:activity:1', 'like', null);
  const b = repos.engagements.add('u2', 'urn:li:activity:2', 'like', null);
  repos.db.prepare('UPDATE engagements SET priority = -1 WHERE id = ?').run(b.id);
  expect(repos.engagements.queuedByPriority().map((e) => e.id)).toEqual([b.id, a.id]);
});

test('byStatus returns only the rows in that state, ordered by id', () => {
  const a = repos.engagements.add('u1', 'urn:li:activity:1', 'like', null);
  const b = repos.engagements.add('u2', 'urn:li:activity:2', 'like', null);
  repos.engagements.setStatus(b.id, 'sent');
  expect(repos.engagements.byStatus('queued').map((e) => e.id)).toEqual([a.id]);
  expect(repos.engagements.byStatus('sent').map((e) => e.id)).toEqual([b.id]);
});

test('countReactedSince counts the weekly cap unit, not rows', () => {
  const a = repos.engagements.add('u1', 'urn:li:activity:1', 'like', null);
  const b = repos.engagements.add('u2', 'urn:li:activity:2', 'like', null);
  repos.engagements.setStatus(a.id, 'sent', { reacted_at: '2026-08-02T09:00:00.000Z' });
  repos.engagements.setStatus(b.id, 'sent', { reacted_at: '2026-07-01T09:00:00.000Z' });
  expect(repos.engagements.countReactedSince('2026-08-01T00:00:00.000Z')).toBe(1);
});

test('countReactedSince is inclusive of the boundary instant and excludes NULLs', () => {
  // TEXT >= TEXT is a byte comparison, which is only a date comparison because every
  // timestamp we write is the same fixed-width UTC ISO-8601 shape. Pin both halves: the
  // exact-boundary row counts, the microsecond-earlier one does not, and a queued row with
  // a NULL reacted_at is excluded (NULL >= x is NULL, i.e. not true — never counted).
  const cutoff = '2026-08-01T00:00:00.000Z';
  const onIt = repos.engagements.add('u1', 'urn:li:activity:1', 'like', null);
  const justBefore = repos.engagements.add('u2', 'urn:li:activity:2', 'like', null);
  const justAfter = repos.engagements.add('u3', 'urn:li:activity:3', 'like', null);
  repos.engagements.add('u4', 'urn:li:activity:4', 'like', null); // never reacted
  repos.engagements.setStatus(onIt.id, 'sent', { reacted_at: cutoff });
  repos.engagements.setStatus(justBefore.id, 'sent', { reacted_at: '2026-07-31T23:59:59.999Z' });
  repos.engagements.setStatus(justAfter.id, 'sent', { reacted_at: '2026-08-01T00:00:00.001Z' });
  expect(repos.engagements.countReactedSince(cutoff)).toBe(2);
  // Year boundaries and single-digit months stay ordered because the format is zero-padded.
  expect(repos.engagements.countReactedSince('2025-12-31T00:00:00.000Z')).toBe(3);
  expect(repos.engagements.countReactedSince('2026-09-01T00:00:00.000Z')).toBe(0);
});

test('countCommentedSince counts only rows that actually commented', () => {
  const a = repos.engagements.add('u1', 'urn:li:activity:1', 'like', 'hello');
  const b = repos.engagements.add('u2', 'urn:li:activity:2', 'like', 'hello');
  repos.engagements.setStatus(a.id, 'sent', {
    reacted_at: '2026-08-02T09:00:00.000Z', commented_at: '2026-08-02T09:00:05.000Z',
  });
  repos.engagements.setStatus(b.id, 'sent', { reacted_at: '2026-08-02T09:00:00.000Z' });
  expect(repos.engagements.countCommentedSince('2026-08-02T00:00:00.000Z')).toBe(1);
});

// ── The timestamp-format CHECKs ─────────────────────────────────────────────────────────
// countReactedSince / countCommentedSince compare these columns as TEXT, which is only a
// chronological comparison while every value is the one fixed-width shape toISOString()
// produces. send_log.at is the live proof of the alternative: it holds the datetime('now')
// space-form and silently drops out of EventRepo.countSentSince's `>=`. These pin the shape
// in the schema so a future writer cannot reintroduce that bug here.

test('a real toISOString() value is accepted into both timestamp columns', () => {
  const iso = new Date().toISOString();
  const e = repos.engagements.add(URL, URN, 'like', 'hello');
  repos.engagements.setStatus(e.id, 'sent', { reacted_at: iso, commented_at: iso });
  const row = repos.engagements.findById(e.id)!;
  expect(row.reacted_at).toBe(iso);
  expect(row.commented_at).toBe(iso);
});

test('NULL is accepted in both timestamp columns — an un-run task has neither', () => {
  const e = repos.engagements.add(URL, URN, 'like', null);
  expect(e.reacted_at).toBeNull();
  expect(e.commented_at).toBeNull();
  // And explicitly clearing them back to NULL is legal too (the retry path).
  repos.engagements.setStatus(e.id, 'queued', { reacted_at: null, commented_at: null });
  const row = repos.engagements.findById(e.id)!;
  expect(row.reacted_at).toBeNull();
  expect(row.commented_at).toBeNull();
});

test("the datetime('now') space-form is rejected — this is the send_log bug", () => {
  const e = repos.engagements.add(URL, URN, 'like', 'hello');
  expect(() => repos.engagements.setStatus(e.id, 'sent', { reacted_at: '2026-07-31 16:50:00' }))
    .toThrow(/CHECK constraint failed/);
  expect(() => repos.engagements.setStatus(e.id, 'sent', { commented_at: '2026-07-31 16:50:00' }))
    .toThrow(/CHECK constraint failed/);
  expect(repos.engagements.findById(e.id)!.reacted_at).toBeNull();
});

test('a local-offset timestamp is rejected — the window maths assumes UTC', () => {
  const e = repos.engagements.add(URL, URN, 'like', 'hello');
  expect(() => repos.engagements.setStatus(e.id, 'sent', { reacted_at: '2026-08-02T12:00:00+03:00' }))
    .toThrow(/CHECK constraint failed/);
  expect(() => repos.engagements.setStatus(e.id, 'sent', { commented_at: '2026-08-02T12:00:00+03:00' }))
    .toThrow(/CHECK constraint failed/);
});

test('a seconds-precision ISO form and an empty string are rejected too', () => {
  // Not fixed-width, so it sorts wrong against a .sss value sharing its second.
  const e = repos.engagements.add(URL, URN, 'like', null);
  expect(() => repos.engagements.setStatus(e.id, 'sent', { reacted_at: '2026-08-02T12:00:00Z' }))
    .toThrow(/CHECK constraint failed/);
  expect(() => repos.engagements.setStatus(e.id, 'sent', { reacted_at: '' }))
    .toThrow(/CHECK constraint failed/);
});

test('reconcileUrn rewrites a row to the URN the driver actually observed', () => {
  const e = repos.engagements.add(URL, 'urn:li:share:7489401095899770880', 'like', null);
  expect(repos.engagements.reconcileUrn(e.id, 'urn:li:activity:7489401096851906561'))
    .toBe('reconciled');
  expect(repos.engagements.findById(e.id)!.post_urn).toBe('urn:li:activity:7489401096851906561');
});

test('reconcileUrn reports a duplicate rather than colliding with an existing row', () => {
  const canonical = repos.engagements.add('u1', 'urn:li:activity:7489401096851906561', 'like', null);
  const dupe = repos.engagements.add('u2', 'urn:li:share:7489401095899770880', 'like', null);
  expect(repos.engagements.reconcileUrn(dupe.id, canonical.post_urn)).toBe('duplicate');
  // The row is NOT rewritten — the caller retires it instead of engaging twice.
  expect(repos.engagements.findById(dupe.id)!.post_urn).toBe('urn:li:share:7489401095899770880');
});

test('reconcileUrn is a no-op when the URN already matches', () => {
  const e = repos.engagements.add(URL, URN, 'like', null);
  expect(repos.engagements.reconcileUrn(e.id, URN)).toBe('unchanged');
});

test('reconcileUrn throws on an id that does not exist', () => {
  // Deliberately NOT folded into 'unchanged'. A caller that reconciles a vanished row has a
  // bug, and 'unchanged' would tell it "your URN is already canonical" — which would then
  // let it engage with the post under the wrong identity. Loud beats silent.
  expect(() => repos.engagements.reconcileUrn(999, URN)).toThrow(/No engagement 999/);
});

test('countsByStatus reports every status the dashboard renders', () => {
  const a = repos.engagements.add('u1', 'urn:li:activity:1', 'like', null);
  repos.engagements.add('u2', 'urn:li:activity:2', 'like', null);
  repos.engagements.setStatus(a.id, 'failed', { last_error: 'boom' });
  expect(repos.engagements.countsByStatus()).toMatchObject({ queued: 1, failed: 1 });
});
