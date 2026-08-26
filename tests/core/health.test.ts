/**
 * Roster health alerts. Both conditions are silent failures — a roster that was never
 * imported, or one whose profiles never filled in — so these tests pin exactly when the
 * red strip appears and, just as deliberately, when it stays away.
 */
import { test, expect } from 'vitest';
import {
  computeHealthAlerts, ROSTER_EXPECTED_MIN, ENRICH_FAILED_MIN, ENRICH_FAILED_ABSOLUTE,
} from '../../src/core/health.js';

const ids = (alerts: { id: string }[]) => alerts.map((a) => a.id);

test('a healthy imported roster raises nothing', () => {
  expect(computeHealthAlerts({ connectionsTotal: 7155, enrichFailed: 3 })).toEqual([]);
});

test('an empty roster says it is empty, not just small', () => {
  const alerts = computeHealthAlerts({ connectionsTotal: 0, enrichFailed: 0 });
  expect(ids(alerts)).toEqual(['roster_missing']);
  expect(alerts[0].detail).toMatch(/empty/i);
});

test('a partial roster reports its actual size', () => {
  const alerts = computeHealthAlerts({ connectionsTotal: 412, enrichFailed: 0 });
  expect(ids(alerts)).toEqual(['roster_missing']);
  expect(alerts[0].detail).toContain('412');
});

test('the roster threshold is exact: one below fires, the boundary does not', () => {
  expect(ids(computeHealthAlerts({ connectionsTotal: ROSTER_EXPECTED_MIN - 1, enrichFailed: 0 })))
    .toEqual(['roster_missing']);
  expect(computeHealthAlerts({ connectionsTotal: ROSTER_EXPECTED_MIN, enrichFailed: 0 })).toEqual([]);
});

test('a handful of failures on a big roster does not nag', () => {
  // 24 is below the floor, and 100 of 10,000 is below the 5% share.
  expect(computeHealthAlerts({ connectionsTotal: 5000, enrichFailed: 24 })).toEqual([]);
  expect(computeHealthAlerts({ connectionsTotal: 10000, enrichFailed: 100 })).toEqual([]);
});

test('failures fire once they are both past the floor and a real share of the roster', () => {
  // 60 of 1,000 = 6% — past the 25 floor and the 5% share.
  const alerts = computeHealthAlerts({ connectionsTotal: 1000, enrichFailed: 60 });
  expect(ids(alerts)).toEqual(['enrich_failures']);
  expect(alerts[0].detail).toContain('60');
  // 30 of 1,000 = 3% — past the floor but not the share: stays quiet.
  expect(computeHealthAlerts({ connectionsTotal: 1000, enrichFailed: 30 })).toEqual([]);
});

test('enough absolute failures fire regardless of roster size', () => {
  // 250 of 50,000 is only 0.5%, but 250 broken profiles is worth a banner on its own.
  expect(ids(computeHealthAlerts({ connectionsTotal: 50000, enrichFailed: ENRICH_FAILED_ABSOLUTE })))
    .toEqual(['enrich_failures']);
});

test('a small mostly-failed roster raises both alerts at once', () => {
  const alerts = computeHealthAlerts({ connectionsTotal: 200, enrichFailed: 100 });
  expect(ids(alerts)).toEqual(['roster_missing', 'enrich_failures']);
});

test('the failure floor is exact on a tiny roster', () => {
  // On a sub-500 roster the 5% share is below the floor, so the floor decides.
  expect(ids(computeHealthAlerts({ connectionsTotal: 100, enrichFailed: ENRICH_FAILED_MIN })))
    .toContain('enrich_failures');
  expect(ids(computeHealthAlerts({ connectionsTotal: 100, enrichFailed: ENRICH_FAILED_MIN - 1 })))
    .toEqual(['roster_missing']);
});
