export interface BatchPlanOptions { startHour: number; endHour: number; count: number; }

export function planDailyBatches(
  day: Date,
  opts: BatchPlanOptions,
  rng: () => number = Math.random,
): Date[] {
  const windowMs = (opts.endHour - opts.startHour) * 60 * 60 * 1000;
  const base = new Date(day);
  base.setHours(opts.startHour, 0, 0, 0);
  const times: Date[] = [];
  for (let i = 0; i < opts.count; i++) {
    times.push(new Date(base.getTime() + Math.floor(rng() * windowMs)));
  }
  times.sort((a, b) => a.getTime() - b.getTime());
  return times;
}

export function assignSchedule<T>(
  profileIds: T[],
  batchTimes: Date[],
  batchSize: number,
): { id: T; when: Date }[] {
  const out: { id: T; when: Date }[] = [];
  let batch = 0;
  for (let i = 0; i < profileIds.length; i++) {
    if (i > 0 && i % batchSize === 0) batch++;
    const when = batchTimes[Math.min(batch, batchTimes.length - 1)];
    out.push({ id: profileIds[i], when });
  }
  return out;
}

export function pickDue<T extends { scheduled_for: string | null }>(
  rows: T[],
  now: Date,
  remaining: number,
): T[] {
  return rows
    .filter((r) => {
      if (r.scheduled_for === null) return false;
      // Normalise to local time by stripping any UTC suffix so the comparison
      // is consistent with a `now` that was also constructed from a local string.
      const local = r.scheduled_for.replace(/Z$/, '').replace(/[+-]\d{2}:\d{2}$/, '');
      return new Date(local) <= now;
    })
    .slice(0, Math.max(0, remaining));
}
