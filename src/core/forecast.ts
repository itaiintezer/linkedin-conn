import type { Settings } from '../types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Average sends per *sending day*, clamped by the weekly cap. 0 => never. */
function dailySendRate(s: Settings): number {
  const dailyTarget = Math.max(0, s.batches_per_day * Math.max(1, s.batch_size));
  const sendingDaysPerWeek = s.weekdays_only ? 5 : 7;
  if (dailyTarget <= 0 || sendingDaysPerWeek <= 0) return 0;
  const weeklyThroughput = Math.min(s.weekly_cap, dailyTarget * sendingDaysPerWeek);
  return weeklyThroughput / sendingDaysPerWeek;
}

function isSendingDay(d: Date, weekdaysOnly: boolean): boolean {
  if (!weekdaysOnly) return true;
  const day = d.getUTCDay();
  return day !== 0 && day !== 6;
}

/** The calendar date of the n-th sending day counting from `start` (inclusive). */
function addSendingDays(start: Date, n: number, weekdaysOnly: boolean): Date {
  let d = new Date(start);
  let counted = 0;
  // Walk forward until we've passed `n` sending days.
  for (let guard = 0; guard < 10000; guard++) {
    if (isSendingDay(d, weekdaysOnly)) {
      counted++;
      if (counted >= n) return d;
    }
    d = new Date(d.getTime() + DAY_MS);
  }
  return d;
}

export function estimateQueueCompletion(
  remaining: number,
  s: Settings,
  now: Date,
): { sendingDays: number; finishDate: string | null } {
  if (remaining <= 0) return { sendingDays: 0, finishDate: null };
  const rate = dailySendRate(s);
  if (rate <= 0) return { sendingDays: 0, finishDate: null };
  const sendingDays = Math.ceil(remaining / rate);
  return { sendingDays, finishDate: addSendingDays(now, sendingDays, s.weekdays_only === 1).toISOString() };
}

export function nextBatch(
  rows: { scheduled_for: string | null }[],
  now: Date,
): { at: string; count: number } | null {
  const future = rows
    .map((r) => r.scheduled_for)
    .filter((t): t is string => t !== null && new Date(t).getTime() > now.getTime());
  if (future.length === 0) return null;
  const at = future.reduce((min, t) => (t < min ? t : min), future[0]);
  return { at, count: future.filter((t) => t === at).length };
}

export function orderUpcoming<T extends { id: number; status: string; scheduled_for: string | null }>(
  rows: T[],
): T[] {
  const scheduled = rows
    .filter((r) => r.status === 'scheduled')
    .sort((a, b) => (a.scheduled_for ?? '').localeCompare(b.scheduled_for ?? ''));
  const queued = rows.filter((r) => r.status === 'queued').sort((a, b) => a.id - b.id);
  return [...scheduled, ...queued];
}
