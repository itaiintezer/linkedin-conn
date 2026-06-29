import { test, expect } from 'vitest';
import { planDailyBatches, assignSchedule, pickDue } from '../../src/core/schedule.js';

function seeded(seq: number[]): () => number {
  let i = 0;
  return () => seq[i++ % seq.length];
}

test('planDailyBatches returns N sorted times within the working window', () => {
  const day = new Date('2026-06-29T00:00:00');
  const times = planDailyBatches(day, { startHour: 8, endHour: 20, count: 4 }, seeded([0.1, 0.4, 0.6, 0.9]));
  expect(times).toHaveLength(4);
  for (const t of times) {
    expect(t.getHours()).toBeGreaterThanOrEqual(8);
    expect(t.getHours()).toBeLessThan(20);
  }
  const sorted = [...times].sort((a, b) => a.getTime() - b.getTime());
  expect(times).toEqual(sorted);
});

test('assignSchedule groups profiles into batches of batchSize', () => {
  const profiles = [1, 2, 3, 4, 5, 6, 7];
  const t0 = new Date('2026-06-29T09:00:00');
  const t1 = new Date('2026-06-29T13:00:00');
  const result = assignSchedule(profiles, [t0, t1], 5);
  expect(result.filter((r) => r.when === t0).map((r) => r.id)).toEqual([1, 2, 3, 4, 5]);
  expect(result.filter((r) => r.when === t1).map((r) => r.id)).toEqual([6, 7]);
});

test('pickDue returns only due profiles, capped by remaining', () => {
  const now = new Date('2026-06-29T13:30:00');
  const rows = [
    { id: 1, scheduled_for: '2026-06-29T09:00:00.000Z' },
    { id: 2, scheduled_for: '2026-06-29T13:00:00.000Z' },
    { id: 3, scheduled_for: '2026-06-29T18:00:00.000Z' },
  ];
  expect(pickDue(rows, now, 10).map((r) => r.id)).toEqual([1, 2]);
  expect(pickDue(rows, now, 1).map((r) => r.id)).toEqual([1]);
});
