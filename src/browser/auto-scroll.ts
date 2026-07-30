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

export interface CollectScrollDeps<T> {
  /** Snapshot the rows currently in the DOM. Called once BEFORE any scroll, then per round. */
  collect: () => Promise<T[]>;
  /** Stable identity for de-duplicating a row seen in more than one round. */
  key: (item: T) => string;
  scrollOnce: () => Promise<void>;
  onRound?: (round: number, total: number) => void;
}

/**
 * Scroll a lazy-loaded list while ACCUMULATING its rows, de-duplicated by `key`.
 *
 * Why accumulate instead of scrolling first and collecting once (which is what
 * scrollToLoad's callers do): that shortcut is only correct for a list whose rows persist.
 * If the list virtualizes — recycling rows out of the DOM as they leave the viewport — a
 * single final collect returns the BOTTOM of the list and silently drops the top. Merging
 * per round is correct either way, so it costs one extra evaluate per round and removes the
 * need to know which kind of list we're on.
 *
 * First sighting of a key wins. For a recency-ordered list scrolled downward that is the
 * freshest version of the row, which matters when its content (an inbox snippet, say)
 * decides something.
 *
 * `exhausted` distinguishes "the list stopped growing, so we believe we saw all of it" from
 * "we stopped at maxRounds and there may be more" — a truncated snapshot the caller must be
 * able to notice rather than mistake for a complete one.
 */
export async function collectWhileScrolling<T>(
  deps: CollectScrollDeps<T>,
  maxRounds: number,
  stableRounds = 2,
): Promise<{ items: T[]; rounds: number; exhausted: boolean }> {
  const seen = new Map<string, T>();
  const absorb = async (): Promise<void> => {
    for (const item of await deps.collect()) {
      const k = deps.key(item);
      if (!seen.has(k)) seen.set(k, item);
    }
  };

  await absorb(); // the first screen — the part the old inbox reader stopped at
  let prev = seen.size;
  let stable = 0;
  let rounds = 0;
  let exhausted = false;
  for (let i = 0; i < maxRounds; i++) {
    await deps.scrollOnce();
    rounds++;
    await absorb();
    deps.onRound?.(rounds, seen.size);
    if (seen.size > prev) {
      prev = seen.size;
      stable = 0;
    } else if (++stable >= stableRounds) {
      exhausted = true; // nothing new across `stableRounds` rounds — end of the list
      break;
    }
  }
  return { items: [...seen.values()], rounds, exhausted };
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
