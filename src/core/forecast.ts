import type { Settings } from '../types.js';
import { dailyTargetFor } from './daily-budget.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Average sends per *sending day*, clamped by the weekly cap. 0 => never. */
function dailySendRate(s: Settings): number {
  const dailyTarget = dailyTargetFor(s);
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

export type NextBatch =
  | null
  | { estimated: false; at: string; count: number }
  | { estimated: true; at: string; count: number }
  | { blocked: true; reason: string };

export interface NextBatchContext {
  backlog: number;        // queued + scheduled remaining
  weeklyRemaining: number;
  dailyRemaining: number;
  guardrailTripped: boolean;
  paused: boolean;
  settings: Settings;
}

/** Local-time sending-day test, mirroring scheduler-service (which uses local time). */
function isLocalSendingDay(d: Date, weekdaysOnly: boolean): boolean {
  if (!weekdaysOnly) return true;
  const day = d.getDay();
  return day !== 0 && day !== 6;
}

function localWindowStart(day: Date, startHour: number): Date {
  const d = new Date(day);
  d.setHours(startHour, 0, 0, 0);
  return d;
}

/** Start of the next sending day's working window, strictly after `now`'s day. */
function nextSendingWindowStart(now: Date, s: Settings): Date {
  const d = new Date(now);
  for (let guard = 0; guard < 14; guard++) {
    d.setDate(d.getDate() + 1);
    if (isLocalSendingDay(d, s.weekdays_only === 1)) return localWindowStart(d, s.workday_start_hour);
  }
  return localWindowStart(d, s.workday_start_hour);
}

/**
 * Resolve what the "next batch" card should show. Priority order (first match wins):
 * empty backlog -> guardrail -> paused -> sending-disabled -> weekly-cap ->
 * exact materialized slot -> predicted next window.
 */
export function nextBatchForecast(
  scheduledRows: { scheduled_for: string | null }[],
  ctx: NextBatchContext,
  now: Date,
): NextBatch {
  const s = ctx.settings;
  if (ctx.backlog <= 0) return null;
  if (ctx.guardrailTripped) return { blocked: true, reason: 'Guardrail tripped' };
  if (ctx.paused) return { blocked: true, reason: 'Paused' };
  if (dailySendRate(s) <= 0) return { blocked: true, reason: 'Sending disabled' };
  if (ctx.weeklyRemaining <= 0) return { blocked: true, reason: 'Weekly cap reached' };

  const exact = nextBatch(scheduledRows, now);
  if (exact) return { estimated: false, at: exact.at, count: exact.count };

  const count = Math.min(Math.max(1, s.batch_size), ctx.backlog);
  const endToday = new Date(now);
  endToday.setHours(s.workday_end_hour, 0, 0, 0);
  const canRunToday =
    isLocalSendingDay(now, s.weekdays_only === 1) &&
    now.getTime() < endToday.getTime() &&
    ctx.dailyRemaining > 0;

  let at: Date;
  if (canRunToday) {
    const start = localWindowStart(now, s.workday_start_hour);
    at = now.getTime() > start.getTime() ? now : start;
  } else {
    at = nextSendingWindowStart(now, s);
  }
  return { estimated: true, at: at.toISOString(), count };
}
