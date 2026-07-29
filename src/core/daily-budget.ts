import type { Repos } from '../db/repositories.js';
import type { Settings, CampaignKind } from '../types.js';
import { capsFor } from './caps.js';

/** Intended sends per day for a kind: batchesPerDay * batchSize (batchSize floored at 1). */
export function dailyTargetFor(s: Settings, kind: CampaignKind): number {
  const caps = capsFor(s, kind);
  return Math.max(0, caps.batchesPerDay * Math.max(1, caps.batchSize));
}

/**
 * How many sends today's quota has already committed FOR THIS KIND: profiles still
 * scheduled plus profiles already sent today. Subtracting this from the daily target
 * keeps repeated planning runs (startup + hourly) from stacking past the daily cap.
 */
export function committedToday(repos: Repos, now: Date, kind: CampaignKind): number {
  const dayStart = new Date(now);
  // Local day boundary on purpose: mirrors the scheduler's local-time working-hours window.
  dayStart.setHours(0, 0, 0, 0);
  const startIso = dayStart.toISOString();
  const scheduled = repos.profiles.byStatusKind('scheduled', kind).length;
  const sentToday = repos.profiles.all()
    .filter((p) => p.kind === kind && p.sent_at !== null && p.sent_at >= startIso).length;
  return scheduled + sentToday;
}

/** Remaining daily quota for the kind, never negative. */
export function dailyRemainingFor(repos: Repos, s: Settings, now: Date, kind: CampaignKind): number {
  return Math.max(0, dailyTargetFor(s, kind) - committedToday(repos, now, kind));
}
