import { test, expect } from 'vitest';
import { computeAccepted, computeExpiredByAge } from '../../src/core/acceptance.js';

const S = (id: number, slug: string, sent_at: string | null = null) =>
  ({ id, profile_url: `https://www.linkedin.com/in/${slug}`, sent_at });

test('computeAccepted returns only sent profiles present in the connections list', () => {
  const sent = [S(1, 'a'), S(2, 'b'), S(3, 'c')];
  const conns = new Set(['https://www.linkedin.com/in/b']);
  expect(computeAccepted(sent, conns)).toEqual([2]);
});

test('computeAccepted never infers expiry from absence — missing means still pending', () => {
  const sent = [S(1, 'a'), S(2, 'b')];
  const conns = new Set<string>(); // e.g. an empty/partial read
  expect(computeAccepted(sent, conns)).toEqual([]); // nobody accepted, and nobody expired
});

test('computeExpiredByAge is disabled when expiryDays <= 0', () => {
  const sent = [S(1, 'a', '2020-01-01T00:00:00Z')];
  expect(computeExpiredByAge(sent, new Date('2026-01-01T00:00:00Z'), 0)).toEqual([]);
});

test('computeExpiredByAge expires only invites older than the threshold', () => {
  const now = new Date('2026-06-29T00:00:00Z');
  const sent = [
    S(1, 'old', '2026-05-01T00:00:00Z'), // 59 days -> expired
    S(2, 'new', '2026-06-25T00:00:00Z'), // 4 days  -> kept
    S(3, 'nodate', null),                // no sent_at -> never
  ];
  expect(computeExpiredByAge(sent, now, 42)).toEqual([1]);
});
