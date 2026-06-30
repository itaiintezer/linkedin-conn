import { test, expect } from 'vitest';
import { estimateQueueCompletion, nextBatch, orderUpcoming } from '../../src/core/forecast.js';
import type { Settings } from '../../src/types.js';

function settings(over: Partial<Settings> = {}): Settings {
  return {
    id: 1, workday_start_hour: 8, workday_end_hour: 20, weekdays_only: 1,
    weekly_cap: 100, batch_size: 5, batches_per_day: 4, acceptance_checks_per_day: 1,
    account_type: 'unknown', note_quota_exhausted: 0, min_delay_ms: 20000, max_delay_ms: 90000,
    paused: 0, pause_reason: null, onboarded: 1, failure_threshold: 3, ...over,
  };
}

test('estimateQueueCompletion: empty queue finishes now', () => {
  expect(estimateQueueCompletion(0, settings(), new Date('2026-06-30T10:00:00Z')))
    .toEqual({ sendingDays: 0, finishDate: null });
});

test('estimateQueueCompletion: 20/day rate, 40 remaining => 2 sending days', () => {
  // batches_per_day*batch_size = 20; weekly clamp 100 > 20*5 -> rate 20/day
  const r = estimateQueueCompletion(40, settings(), new Date('2026-06-30T10:00:00Z')); // Tue
  expect(r.sendingDays).toBe(2);
});

test('estimateQueueCompletion: weekly cap clamps the daily rate', () => {
  // dailyTarget 200, weekly_cap=100 -> weeklyThroughput=100 over 5 days = 20/day
  const r = estimateQueueCompletion(40, settings({ batches_per_day: 40 }), new Date('2026-06-30T10:00:00Z'));
  expect(r.sendingDays).toBe(2);
});

test('estimateQueueCompletion: zero rate => never (null finishDate)', () => {
  const r = estimateQueueCompletion(10, settings({ batches_per_day: 0 }), new Date('2026-06-30T10:00:00Z'));
  expect(r).toEqual({ sendingDays: 0, finishDate: null });
});

test('estimateQueueCompletion: weekend-aware finish date (Fri + 2 sending days => Mon)', () => {
  // 2026-07-03 is a Friday. 40 remaining at 20/day = 2 sending days: Fri(1), Mon(2).
  const r = estimateQueueCompletion(40, settings(), new Date('2026-07-03T10:00:00Z'));
  expect(new Date(r.finishDate!).getUTCDay()).toBe(1); // Monday
});

test('nextBatch: earliest future timestamp and its group size', () => {
  const rows = [
    { scheduled_for: '2026-06-30T09:00:00.000Z' },
    { scheduled_for: '2026-06-30T11:00:00.000Z' },
    { scheduled_for: '2026-06-30T11:00:00.000Z' },
  ];
  const now = new Date('2026-06-30T10:00:00.000Z'); // 09:00 is past
  expect(nextBatch(rows, now)).toEqual({ at: '2026-06-30T11:00:00.000Z', count: 2 });
});

test('nextBatch: null when nothing scheduled in the future', () => {
  const rows = [{ scheduled_for: '2026-06-30T08:00:00.000Z' }];
  expect(nextBatch(rows, new Date('2026-06-30T10:00:00.000Z'))).toBeNull();
});

test('orderUpcoming: scheduled (by time) before queued (by id)', () => {
  const rows = [
    { id: 3, status: 'queued', scheduled_for: null },
    { id: 1, status: 'scheduled', scheduled_for: '2026-06-30T11:00:00.000Z' },
    { id: 2, status: 'scheduled', scheduled_for: '2026-06-30T09:00:00.000Z' },
    { id: 4, status: 'queued', scheduled_for: null },
    { id: 5, status: 'sent', scheduled_for: null },
  ];
  expect(orderUpcoming(rows).map((r) => r.id)).toEqual([2, 1, 3, 4]);
});
