import type { Repos } from '../db/repositories.js';
import type { Settings } from '../types.js';

/** Intended sends per day: batches_per_day * batch_size (batch_size floored at 1). */
export function dailyTargetFor(s: Settings): number {
  return Math.max(0, s.batches_per_day * Math.max(1, s.batch_size));
}

/**
 * How many sends today's quota has already committed: profiles still scheduled
 * plus profiles already sent today. Subtracting this from the daily target keeps
 * repeated planning runs (startup + hourly) from stacking past the daily cap.
 */
export function committedToday(repos: Repos, now: Date): number {
  const dayStart = new Date(now);
  // Local day boundary on purpose: mirrors the scheduler's local-time working-hours window.
  dayStart.setHours(0, 0, 0, 0);
  const startIso = dayStart.toISOString();
  const scheduled = repos.profiles.byStatus('scheduled').length;
  const sentToday = repos.profiles.all().filter((p) => p.sent_at !== null && p.sent_at >= startIso).length;
  return scheduled + sentToday;
}

/** Remaining daily quota, never negative. */
export function dailyRemainingFor(repos: Repos, s: Settings, now: Date): number {
  return Math.max(0, dailyTargetFor(s) - committedToday(repos, now));
}
