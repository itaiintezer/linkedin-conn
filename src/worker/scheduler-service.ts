import type { Repos } from '../db/repositories.js';
import { planDailyBatches, assignSchedule } from '../core/schedule.js';
import { windowStartIso, remainingCapacity } from '../core/rate-limit.js';

export function planAndAssignToday(repos: Repos, now: Date, rng: () => number = Math.random): void {
  const s = repos.settings.get();
  if (s.weekdays_only && (now.getDay() === 0 || now.getDay() === 6)) return;

  const sentInWindow = repos.events.countSentSince(windowStartIso(now));
  const remaining = remainingCapacity(s.weekly_cap, sentInWindow);
  if (remaining <= 0) return;

  const queued = repos.profiles.byStatus('queued').slice(0, remaining);
  if (queued.length === 0) return;

  const allTimes = planDailyBatches(now, {
    startHour: s.workday_start_hour, endHour: s.workday_end_hour, count: s.batches_per_day,
  }, rng);
  const future = allTimes.filter((t) => t.getTime() > now.getTime());
  const times = future.length ? future : [new Date(now.getTime() + 60_000)];

  const assignments = assignSchedule(queued.map((p) => p.id), times, Math.max(1, s.batch_size));
  for (const a of assignments) repos.profiles.setScheduled(a.id, a.when.toISOString());
}
