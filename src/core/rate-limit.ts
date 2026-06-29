const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function windowStartIso(now: Date): string {
  return new Date(now.getTime() - WEEK_MS).toISOString();
}

export function remainingCapacity(weeklyCap: number, sentInWindow: number): number {
  return Math.max(0, weeklyCap - sentInWindow);
}
