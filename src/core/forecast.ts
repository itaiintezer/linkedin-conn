import type { Settings } from '../types.js';
import { dailyTargetFor } from './daily-budget.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Average sends per *sending day*, clamped by the weekly cap. 0 => never.
 *
 * Reads the plain `weekly_cap` / `batch_size` / `batches_per_day` fields. This whole
 * module is kind-agnostic on purpose: callers that want message pacing hand in a
 * REMAPPED Settings whose invite fields carry the msg_* values (see the msg_next_batch
 * caller in api/server.ts). Do not reintroduce a `kind` parameter here — a caller that
 * passed kind: 'message' with raw settings would read msg batch sizes against the
 * INVITE weekly cap, which is the bug the remap exists to prevent.
 */
function dailySendRate(s: Settings): number {
  const dailyTarget = dailyTargetFor(s, 'invite');
  const sendingDaysPerWeek = s.weekdays_only ? 5 : 7;
  if (dailyTarget <= 0 || sendingDaysPerWeek <= 0) return 0;
  const weeklyThroughput = Math.min(s.weekly_cap, dailyTarget * sendingDaysPerWeek);
  return weeklyThroughput / sendingDaysPerWeek;
}

// UTC day-of-week: used by estimateQueueCompletion where only the calendar date
// (not the wall-clock hour) matters. Batch-time prediction uses isLocalSendingDay.
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

export function orderUpcoming<T extends { id: number; status: string; scheduled_for: string | null; priority?: number }>(
  rows: T[],
): T[] {
  const scheduled = rows
    .filter((r) => r.status === 'scheduled')
    .sort((a, b) => (a.scheduled_for ?? '').localeCompare(b.scheduled_for ?? ''));
  const queued = rows
    .filter((r) => r.status === 'queued')
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0) || a.id - b.id);
  return [...scheduled, ...queued];
}

export type NextBatchResult =
  | null
  | { estimated: false; at: string; count: number }
  | { estimated: true; at: string; count: number }
  /**
   * Work is ready and today's window is open, but no slot has been materialized yet — the
   * next planning pass will place it. Deliberately carries NO `at`: the only times we could
   * offer are `now` (which reads as "sending right now" and advances with every poll) or the
   * next planning tick (which we can't see from here), so any clock value would be a guess
   * presented as a schedule. Callers must render this as a state, not a time.
   */
  | { estimated: true; pending: true; count: number }
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

/** Clone of `day` with the time set to `startHour:00:00.000` in local time. */
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
): NextBatchResult {
  const s = ctx.settings;
  const weekdaysOnly = s.weekdays_only === 1;
  if (ctx.backlog <= 0) return null;
  if (ctx.guardrailTripped) return { blocked: true, reason: 'Guardrail tripped' };
  if (ctx.paused) return { blocked: true, reason: 'Paused' };
  if (dailySendRate(s) <= 0) return { blocked: true, reason: 'Sending disabled' };
  if (ctx.weeklyRemaining <= 0) return { blocked: true, reason: 'Weekly cap reached' };

  const exact = nextBatch(scheduledRows, now);
  if (exact) return { estimated: false, at: exact.at, count: exact.count };

  // Approximate: one batch's worth, ignoring weekly/daily caps (display hint only).
  const count = Math.min(Math.max(1, s.batch_size), ctx.backlog);
  const endToday = new Date(now);
  endToday.setHours(s.workday_end_hour, 0, 0, 0);
  const canRunToday =
    isLocalSendingDay(now, weekdaysOnly) &&
    now.getTime() < endToday.getTime() &&
    ctx.dailyRemaining > 0;

  // Today is still open with budget to spare, so the batch is imminent — but the planner
  // assigns the actual minute and hasn't run yet. Report the state, not a fabricated time.
  if (canRunToday) return { estimated: true, pending: true, count };
  // Today is genuinely finished (or it's a non-sending day): the next window start is a
  // time we really do know, so keep predicting it.
  return { estimated: true, at: nextSendingWindowStart(now, s).toISOString(), count };
}
