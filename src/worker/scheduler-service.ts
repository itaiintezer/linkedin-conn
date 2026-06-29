import type { Repos } from '../db/repositories.js';
import { planDailyBatches, assignSchedule } from '../core/schedule.js';
import { windowStartIso, remainingCapacity } from '../core/rate-limit.js';

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
  const remaining = remainingCapacity(s.weekly_cap, sentInWindow);
  if (remaining <= 0) return;

  const queued = repos.profiles.byStatus('queued').slice(0, remaining);
  if (queued.length === 0) return;

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

  const assignments = assignSchedule(queued.map((p) => p.id), times, Math.max(1, s.batch_size));
  for (const a of assignments) repos.profiles.setScheduled(a.id, a.when.toISOString());
}
