const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function windowStartIso(now: Date): string {
  return new Date(now.getTime() - WEEK_MS).toISOString();
}

export function remainingCapacity(weeklyCap: number, sentInWindow: number): number {
  return Math.max(0, weeklyCap - sentInWindow);
}

/**
 * Local midnight for `now` — the boundary a *daily* cap counts from. Local on purpose:
 * it mirrors the working-hours window, which is local too.
 *
 * Shared rather than duplicated because the engagement comment cap is applied twice, in two
 * files: the scheduler applies it when planning, and the sender re-applies it as a backstop.
 * Two private copies of "where the day starts" would let those silently disagree — and a
 * planner counting a UTC day against a sender counting a local one is exactly the kind of
 * drift that publishes an over-budget comment.
 */
export function dayStartIso(now: Date): string {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}
