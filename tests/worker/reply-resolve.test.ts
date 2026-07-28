import { test, expect } from 'vitest';
import { buildPendingIndex, resolveRow } from '../../src/worker/reply-checker.js';
import type { InboxRow, Profile } from '../../src/types.js';

// resolveRow is a pure policy function: no SQLite fixture, no fake driver. Only these
// three profile fields participate in matching, so a partial stand-in is honest here.
function prof(id: number, full_name: string | null, thread_url: string | null = null): Profile {
  return { id, full_name, thread_url, profile_url: `https://www.linkedin.com/in/p${id}` } as Profile;
}
function row(name: string, extra: Partial<InboxRow> = {}): InboxRow {
  return { name, snippet: 'x', youSentLast: false, ...extra };
}
function resolve(rows: InboxRow, pending: Profile[]) {
  return resolveRow(rows, buildPendingIndex(pending));
}

// --- CRITICAL 1: a known thread id vetoes a name match from another conversation ------

test('a name match is vetoed when the row is a different conversation than the contact', () => {
  const p = prof(1, 'Keren Tevet', 'https://www.linkedin.com/messaging/thread/2-real/');
  const res = resolve(row('Keren Tevet', { threadUrl: '/messaging/thread/2-stranger/' }), [p]);
  expect(res.outcome).toBe('none');
  expect(res.vetoed.map((v) => v.id)).toEqual([1]);
});

test('the veto also applies to the containment tier', () => {
  const p = prof(1, 'Keren Yosef Tevet', 'https://www.linkedin.com/messaging/thread/2-real/');
  const res = resolve(row('Keren Tevet', { threadUrl: '/messaging/thread/2-stranger/' }), [p]);
  expect(res.outcome).toBe('none');
});

test('the veto is silent when the row carries no thread id — name matching still runs', () => {
  const p = prof(1, 'Keren Tevet', 'https://www.linkedin.com/messaging/thread/2-real/');
  const res = resolve(row('Keren Tevet'), [p]);
  expect(res.outcome).toBe('match');
  expect(res.profile?.id).toBe(1);
  expect(res.via).toBe('canonical');
});

test('the veto is silent when the contact has no thread id of its own', () => {
  const p = prof(1, 'Keren Tevet', null);
  const res = resolve(row('Keren Tevet', { threadUrl: '/messaging/thread/2-whatever/' }), [p]);
  expect(res.outcome).toBe('match');
  expect(res.via).toBe('canonical');
});

test('the veto can rescue a match by removing the impostor from an ambiguous pair', () => {
  const real = prof(1, 'Keren Tevet', null);
  const other = prof(2, 'Keren Tevet', 'https://www.linkedin.com/messaging/thread/2-other/');
  const res = resolve(row('Keren Tevet', { threadUrl: '/messaging/thread/2-real/' }), [real, other]);
  expect(res.outcome).toBe('match');
  expect(res.profile?.id).toBe(1);
});

// --- ISSUE 8: `via` travels with the candidate, it is not inferred from bucket sizes --

test('via reports the tier that actually produced the surviving candidate', () => {
  const exact = prof(1, 'Keren Tevet', null);
  const loose = prof(2, 'Keren Yosef Tevet', 'https://www.linkedin.com/messaging/thread/2-other/');
  // Both tiers hit, but the loose one is vetoed away — the survivor is still 'canonical'.
  const a = resolve(row('Keren Tevet', { threadUrl: '/messaging/thread/2-real/' }), [exact, loose]);
  expect(a.outcome).toBe('match');
  expect(a).toMatchObject({ profile: { id: 1 }, via: 'canonical' });
  // And with the exact profile vetoed away instead, the survivor reports 'containment'.
  const b = resolve(
    row('Keren Tevet', { threadUrl: '/messaging/thread/2-real/' }),
    [prof(1, 'Keren Tevet', 'https://www.linkedin.com/messaging/thread/2-other/'), prof(2, 'Keren Yosef Tevet', null)],
  );
  expect(b).toMatchObject({ outcome: 'match', profile: { id: 2 }, via: 'containment' });
});

// --- MINOR 5: youSentLast is decided in one place, before the ambiguity verdict -------

test('a You-prefixed row is never a reply and never inflates ambiguity, in either tier', () => {
  const thread = resolve(
    row('Whoever', { youSentLast: true, threadUrl: '/messaging/thread/2-dup/' }),
    [prof(1, 'A One', 'https://www.linkedin.com/messaging/thread/2-dup/'),
      prof(2, 'B Two', 'https://www.linkedin.com/messaging/thread/2-dup/')],
  );
  expect(thread.outcome).toBe('not_a_reply');
  expect(thread.candidates.map((c) => c.id)).toEqual([1, 2]); // still "seen"

  const name = resolve(
    row('Keren Tevet', { youSentLast: true }),
    [prof(1, 'Keren Tevet'), prof(2, 'Keren Tevet')],
  );
  expect(name.outcome).toBe('not_a_reply');
  expect(name.candidates).toHaveLength(2);
});

// --- MINOR 10: 'new' is not a thread id ----------------------------------------------

test('the placeholder /thread/new/ id is not a shared matching key', () => {
  const a = prof(1, 'Aaa One', 'https://www.linkedin.com/messaging/thread/new/?recipient=aaa');
  const b = prof(2, 'Bbb Two', 'https://www.linkedin.com/messaging/thread/new/?recipient=bbb');
  const res = resolve(row('Bbb Two', { threadUrl: '/messaging/thread/new/?recipient=bbb' }), [a, b]);
  // No thread key on either side, so this resolves purely by name — and cleanly.
  expect(res).toMatchObject({ outcome: 'match', profile: { id: 2 }, via: 'canonical' });
});

// --- The repro family from the earlier review, now at the policy level ---------------

test('name-level false positives all resolve to none', () => {
  expect(resolve(row('Cohen, Rachel'), [prof(1, 'Cohen, David')]).outcome).toBe('none');
  expect(resolve(row('Cohen, RACHEL'), [prof(1, 'Cohen, DAVID')]).outcome).toBe('none');
  expect(resolve(row('Jon B Smith'), [prof(1, 'Jon A Smith')]).outcome).toBe('none');
  expect(resolve(row('Ana Sofia Perez Lopez'), [prof(1, 'Ana Maria Garcia Lopez')]).outcome).toBe('none');
  expect(resolve(row('Ana Maria Garcia Lopez'), [prof(1, 'Ana Lopez')]).outcome).toBe('none');
  expect(resolve(row('David Cohen Levi'), [prof(1, 'David Cohen')]).outcome).toBe('none');
  expect(resolve(row('Acme Recruiting Team'), [prof(1, 'Acme Recruiting')]).outcome).toBe('none');
  expect(resolve(row('John Smith, Sr.'), [prof(1, 'John Smith, Jr.')]).outcome).toBe('none');
  expect(resolve(row(''), [prof(1, ' ')]).outcome).toBe('none');
  expect(resolve(row('(Hiring Bot)'), [prof(1, '(Recruiter)')]).outcome).toBe('none');
});

test('the motivating true positives still resolve', () => {
  expect(resolve(row('Keren Tevet'), [prof(1, 'Keren (Yosef) Tevet')])).toMatchObject({
    outcome: 'match', via: 'canonical',
  });
  expect(resolve(row('Keren Tevet'), [prof(1, 'Keren Yosef Tevet')])).toMatchObject({
    outcome: 'match', via: 'containment',
  });
  expect(resolve(
    row('Utterly Different Rendering', { threadUrl: '/messaging/thread/2-AbC=/?f=1' }),
    [prof(1, 'Keren Tevet', 'https://www.linkedin.com/messaging/thread/2-AbC=/')],
  )).toMatchObject({ outcome: 'match', via: 'thread' });
});

test('two pending profiles behind one key are ambiguous, in either tier', () => {
  expect(resolve(row('Keren Tevet'), [prof(1, 'Keren Tevet'), prof(2, 'Keren Yosef Tevet')]).outcome)
    .toBe('ambiguous');
  expect(resolve(
    row('Whoever', { threadUrl: '/messaging/thread/2-dup/' }),
    [prof(1, 'A One', 'https://www.linkedin.com/messaging/thread/2-dup/'),
      prof(2, 'B Two', 'https://www.linkedin.com/messaging/thread/2-dup/')],
  ).outcome).toBe('ambiguous');
});
