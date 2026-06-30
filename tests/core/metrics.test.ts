import { test, expect } from 'vitest';
import { computeCohortMetrics, type MetricRow } from '../../src/core/metrics.js';

test('aggregates funnel, acceptance rate, and median time-to-accept per cohort', () => {
  const rows = [
    { cohort_id: 1, cohort_name: 'A', status: 'sent', sent_at: '2026-06-01T00:00:00Z', accepted_at: null },
    { cohort_id: 1, cohort_name: 'A', status: 'accepted', sent_at: '2026-06-01T00:00:00Z', accepted_at: '2026-06-03T00:00:00Z' },
    { cohort_id: 1, cohort_name: 'A', status: 'accepted', sent_at: '2026-06-01T00:00:00Z', accepted_at: '2026-06-05T00:00:00Z' },
    { cohort_id: 1, cohort_name: 'A', status: 'expired', sent_at: '2026-06-01T00:00:00Z', accepted_at: null },
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

test('counts already_connected separately and excludes it from acceptance rate', () => {
  const rows: MetricRow[] = [
    { cohort_id: 1, cohort_name: 'A', status: 'accepted', sent_at: '2026-06-20T00:00:00Z', accepted_at: '2026-06-21T00:00:00Z' },
    { cohort_id: 1, cohort_name: 'A', status: 'already_connected', sent_at: null, accepted_at: null },
    { cohort_id: 1, cohort_name: 'A', status: 'sent', sent_at: '2026-06-20T00:00:00Z', accepted_at: null },
  ];
  const [m] = computeCohortMetrics(rows);
  expect(m.already_connected).toBe(1);
  // acceptance rate denominator = accepted + pending + expired = 2, not 3
  expect(m.acceptance_rate).toBeCloseTo(0.5);
});
