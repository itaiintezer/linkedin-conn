/**
 * Loop control for lazy-loaded list scrolling, kept free of Playwright types so it can
 * be unit-tested with plain callbacks. The caller supplies `scrollOnce` (perform one
 * real scroll gesture + settle wait) and `count` (how many items are currently loaded).
 *
 * Scrolls until the loaded count stops growing for `stableRounds` CONSECUTIVE rounds
 * (so a single slow network response doesn't end it prematurely), hard-capped at
 * `maxRounds` scroll gestures. Returns how many rounds ran and the final count.
 */
export interface ScrollDeps {
  scrollOnce: () => Promise<void>;
  count: () => Promise<number>;
  onRound?: (round: number, count: number) => void;
}

export async function scrollToLoad(
  deps: ScrollDeps,
  maxRounds: number,
  stableRounds = 2,
): Promise<{ rounds: number; finalCount: number }> {
  let prev = await deps.count();
  let stable = 0;
  let rounds = 0;
  for (let i = 0; i < maxRounds; i++) {
    await deps.scrollOnce();
    rounds++;
    const count = await deps.count();
    deps.onRound?.(rounds, count);
    if (count > prev) {
      prev = count;
      stable = 0;
    } else if (++stable >= stableRounds) {
      break; // list stopped growing across `stableRounds` rounds — done
    }
  }
  return { rounds, finalCount: prev };
}
