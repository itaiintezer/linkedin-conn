import { test, expect } from 'vitest';
import { computeCohortMetrics, type MetricRow } from '../../src/core/metrics.js';

test('aggregates funnel, acceptance rate, and median time-to-accept per cohort', () => {
  const rows: MetricRow[] = [
    { cohort_id: 1, cohort_name: 'A', kind: 'invite', status: 'sent', sent_at: '2026-06-01T00:00:00Z', accepted_at: null, replied_at: null },
    { cohort_id: 1, cohort_name: 'A', kind: 'invite', status: 'accepted', sent_at: '2026-06-01T00:00:00Z', accepted_at: '2026-06-03T00:00:00Z', replied_at: null },
    { cohort_id: 1, cohort_name: 'A', kind: 'invite', status: 'accepted', sent_at: '2026-06-01T00:00:00Z', accepted_at: '2026-06-05T00:00:00Z', replied_at: null },
    { cohort_id: 1, cohort_name: 'A', kind: 'invite', status: 'expired', sent_at: '2026-06-01T00:00:00Z', accepted_at: null, replied_at: null },
  ];
  const m = computeCohortMetrics(rows);
  expect(m).toHaveLength(1);
  const a = m[0];
  expect(a.cohort_name).toBe('A');
  expect(a.accepted).toBe(2);
  expect(a.pending).toBe(1);
  expect(a.expired).toBe(1);
  expect(a.total).toBe(4);
  expect(a.acceptance_rate).toBeCloseTo(2 / 4);
  expect(a.median_time_to_accept_days).toBeCloseTo(3);
});

test('counts skipped separately and excludes it from acceptance rate', () => {
  const rows: MetricRow[] = [
    { cohort_id: 1, cohort_name: 'A', kind: 'invite', status: 'accepted', sent_at: '2026-06-20T00:00:00Z', accepted_at: '2026-06-21T00:00:00Z', replied_at: null },
    { cohort_id: 1, cohort_name: 'A', kind: 'invite', status: 'skipped', sent_at: null, accepted_at: null, replied_at: null },
    { cohort_id: 1, cohort_name: 'A', kind: 'invite', status: 'sent', sent_at: '2026-06-20T00:00:00Z', accepted_at: null, replied_at: null },
  ];
  const [m] = computeCohortMetrics(rows);
  expect(m.skipped).toBe(1);
  // acceptance rate denominator = accepted + pending + expired = 2, not 3
  expect(m.acceptance_rate).toBeCloseTo(0.5);
});

test('message cohorts report replied counts, reply rate, and median days to reply', () => {
  const rows = [
    { cohort_id: 9, cohort_name: 'M', kind: 'message', status: 'replied', sent_at: '2026-07-01T00:00:00Z', accepted_at: null, replied_at: '2026-07-03T00:00:00Z' },
    { cohort_id: 9, cohort_name: 'M', kind: 'message', status: 'sent', sent_at: '2026-07-02T00:00:00Z', accepted_at: null, replied_at: null },
    { cohort_id: 9, cohort_name: 'M', kind: 'message', status: 'skipped', sent_at: null, accepted_at: null, replied_at: null },
  ];
  const [m] = computeCohortMetrics(rows as any);
  expect(m.kind).toBe('message');
  expect(m.replied).toBe(1);
  expect(m.pending).toBe(1);
  expect(m.reply_rate).toBeCloseTo(0.5);
  expect(m.median_time_to_reply_days).toBe(2);
});
