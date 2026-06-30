import type { Repos } from '../db/repositories.js';
import { planDailyBatches, assignSchedule } from '../core/schedule.js';
import { windowStartIso, remainingCapacity } from '../core/rate-limit.js';

/**
 * How many sends today's quota has already committed: profiles still scheduled (for
 * today) plus profiles already sent today. Subtracting this from the daily target keeps
 * repeated planning runs (startup + hourly) from stacking past the daily cap.
 */
function committedToday(repos: Repos, now: Date): number {
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const startIso = dayStart.toISOString();
  const scheduled = repos.profiles.byStatus('scheduled').length;
  const sentToday = repos.profiles.all().filter((p) => p.sent_at !== null && p.sent_at >= startIso).length;
  return scheduled + sentToday;
}

export function planAndAssignToday(repos: Repos, now: Date, rng: () => number = Math.random): void {
  const s = repos.settings.get();
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
  const dailyTarget = Math.max(0, s.batches_per_day * batchSize);
  const dailyBudget = Math.max(0, dailyTarget - committedToday(repos, now));
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

  const queued = repos.profiles.byStatus('queued').slice(0, budget);
  if (queued.length === 0) return;

  const assignments = assignSchedule(queued.map((p) => p.id), times, batchSize);
  for (const a of assignments) repos.profiles.setScheduled(a.id, a.when.toISOString());
}
