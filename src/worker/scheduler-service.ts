import type { Repos } from '../db/repositories.js';
import { planDailyBatches, assignSchedule } from '../core/schedule.js';
import { windowStartIso, remainingCapacity } from '../core/rate-limit.js';
import { dailyRemainingFor } from '../core/daily-budget.js';
import { log } from '../core/log.js';

/** How long a scheduled profile may sit past its slot before it's re-queued. */
export const OVERDUE_GRACE_MS = 10 * 60 * 1000;

/**
 * Return scheduled profiles that missed their slot by more than the grace period to
 * 'queued' so the planner re-flows them into a valid future working-hours slot.
 * Healthy items never hit this: the sender picks up anything due within a minute.
 * Only blocked slots accumulate here (paused, guardrail, logged out, app was off).
 */
export function requeueOverdue(repos: Repos, now: Date, graceMs: number = OVERDUE_GRACE_MS): number {
  const cutoff = now.getTime() - graceMs;
  const stale = repos.profiles.byStatus('scheduled')
    .filter((p) => p.scheduled_for !== null && new Date(p.scheduled_for).getTime() < cutoff);
  for (const p of stale) repos.profiles.setStatus(p.id, 'queued', { scheduled_for: null });
  if (stale.length > 0) log.info('scheduler', 'requeued overdue profiles for re-scheduling', { count: stale.length });
  return stale.length;
}

export function planAndAssignToday(repos: Repos, now: Date, rng: () => number = Math.random): void {
  // Self-heal first: stale past-due slots must not inflate committedToday() and zero out
  // the daily budget. Runs on every path (startup, hourly tick, resume, guardrail-ack).
  requeueOverdue(repos, now);
  const s = repos.settings.get();
  // While paused or halted the sender won't run — don't materialize slots that will
  // only go stale. /api/resume and a guardrail acknowledge re-plan immediately.
  if (s.paused || repos.appState.get().guardrail_tripped) return;
  if (s.weekdays_only && (now.getDay() === 0 || now.getDay() === 6)) return;

  // Never schedule outside today's working-hours window. Once the window has closed we
  // leave profiles queued; a later tick (next morning / next weekday) schedules them
  // in-window. This guarantees every send lands within working hours, even if the app
  // is started in the evening or on a weekend.
  const windowEnd = new Date(now);
  windowEnd.setHours(s.workday_end_hour, 0, 0, 0);
  if (now.getTime() >= windowEnd.getTime()) return;

  const sentInWindow = repos.events.countSentSince(windowStartIso(now));
  const weeklyRemaining = remainingCapacity(s.weekly_cap, sentInWindow);
  if (weeklyRemaining <= 0) return;

  // Pace by day, not just by week: the weekly cap is a backstop, but the intended daily
  // volume is batches_per_day * batch_size. Without this, a single day could spend the
  // entire weekly allowance at once (and a late-day run would pile it onto one slot).
  const batchSize = Math.max(1, s.batch_size);
  const dailyBudget = dailyRemainingFor(repos, s, now);
  if (dailyBudget <= 0) return;

  const allTimes = planDailyBatches(now, {
    startHour: s.workday_start_hour, endHour: s.workday_end_hour, count: s.batches_per_day,
  }, rng);
  let times = allTimes.filter((t) => t.getTime() > now.getTime());
  if (times.length === 0) {
    // Inside the window but every random slot fell before now: pick a random time in the
    // remaining window [now, end) so the send still lands within working hours (not the
    // old "now + 60s", which could fire after hours).
    const at = new Date(now.getTime() + Math.floor(rng() * Math.max(1, windowEnd.getTime() - now.getTime())));
    times = [at];
  }

  // Cap by (future slots * batch_size) so no single slot ever receives more than
  // batch_size — the assigner would otherwise clamp the overflow onto the last slot.
  const slotCapacity = times.length * batchSize;
  const budget = Math.min(weeklyRemaining, dailyBudget, slotCapacity);
  if (budget <= 0) return;

  const queued = repos.profiles.queuedByPriority().slice(0, budget);
  if (queued.length === 0) return;

  const assignments = assignSchedule(queued.map((p) => p.id), times, batchSize);
  for (const a of assignments) repos.profiles.setScheduled(a.id, a.when.toISOString());

  log.debug('scheduler', 'assigned slots', { count: assignments.length, slots: times.length, budget });
}

/**
 * Full rebuild: return EVERY scheduled profile to the queue (clearing its slot), then
 * re-flow the whole backlog into fresh policy-compliant batches. Called at startup so a
 * backlog of past-due (or otherwise stale) slots is re-sorted to policy — same batch size
 * and spacing — instead of firing as a burst or suppressing today's plan. `scheduled_for`
 * is always today-or-past (the planner never schedules beyond today's window), so requeuing
 * all scheduled rows is safe. Priority order is preserved: requeue leaves `priority` intact
 * and queuedByPriority() re-orders by (priority, id).
 */
export function resortSchedule(repos: Repos, now: Date, rng: () => number = Math.random): void {
  for (const p of repos.profiles.byStatus('scheduled')) {
    repos.profiles.setStatus(p.id, 'queued', { scheduled_for: null });
  }
  planAndAssignToday(repos, now, rng);
}
