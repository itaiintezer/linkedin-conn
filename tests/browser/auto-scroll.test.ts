import { test, expect } from 'vitest';
import { scrollToLoad } from '../../src/browser/auto-scroll.js';

// A fake list whose loaded count follows a scripted sequence, one entry consumed per
// scroll gesture. `scrollOnce` advances the script; `count` reports the current value.
function fakeList(sequence: number[]) {
  let i = 0;
  let scrolls = 0;
  const counts = [sequence[0]]; // count() is first called before any scroll
  return {
    scrolls: () => scrolls,
    deps: {
      scrollOnce: async () => { scrolls++; i = Math.min(i + 1, sequence.length - 1); },
      count: async () => sequence[i],
      onRound: (_r: number, c: number) => counts.push(c),
    },
    rounds: counts,
  };
}

test('keeps scrolling while the list grows, up to maxRounds', async () => {
  // Grows by 20 every round and never stalls -> should use the full cap.
  const list = fakeList([20, 40, 60, 80, 100, 120, 140, 160, 180]);
  const res = await scrollToLoad(list.deps, 8);
  expect(res.rounds).toBe(8);
  expect(list.scrolls()).toBe(8);
  expect(res.finalCount).toBe(180); // 8 scrolls advance the script from index 0 to 8
});

test('stops after 2 consecutive no-growth rounds (confirming retry)', async () => {
  // Grows to 60 then flatlines. Round1:40>20, Round2:60>40, Round3:60 (stable=1),
  // Round4:60 (stable=2 -> break). Should NOT run all 8 rounds.
  const list = fakeList([20, 40, 60, 60, 60, 60, 60, 60, 60]);
  const res = await scrollToLoad(list.deps, 8);
  expect(res.rounds).toBe(4);
  expect(res.finalCount).toBe(60);
});

test('a single no-growth round does NOT stop it (slow-load tolerance)', async () => {
  // A stall at round 3, then growth resumes -> must keep going, not bail early.
  const list = fakeList([20, 40, 40, 60, 80, 100, 120, 140, 160]);
  const res = await scrollToLoad(list.deps, 8);
  expect(res.rounds).toBe(8);
  expect(res.finalCount).toBe(160);
});

test('never exceeds maxRounds even if the list never stalls', async () => {
  const list = fakeList(Array.from({ length: 50 }, (_, k) => (k + 1) * 10));
  await scrollToLoad(list.deps, 8);
  expect(list.scrolls()).toBe(8);
});

test('reports every round through onRound', async () => {
  const list = fakeList([20, 40, 60, 60, 60]);
  await scrollToLoad(list.deps, 8);
  // rounds[0] is the pre-scroll baseline, then one entry per scroll gesture.
  expect(list.rounds).toEqual([20, 40, 60, 60, 60]);
});

/* ---------- collectWhileScrolling ----------
   The inbox reader needs rows, not a count, and must be correct whether the list appends
   (rows persist) or virtualizes (rows are recycled out of the DOM as you scroll past).
   Accumulating per round is the only strategy that survives both. */

import { collectWhileScrolling } from '../../src/browser/auto-scroll.js';

/** A list that grows by appending: every round returns everything loaded so far. */
function appendingList(windows: string[][]) {
  let i = 0;
  return {
    scrolls: () => i,
    deps: {
      collect: async () => windows[Math.min(i, windows.length - 1)],
      key: (s: string) => s,
      scrollOnce: async () => { i++; },
    },
  };
}

test('collectWhileScrolling accumulates past the first screen and dedupes repeats', async () => {
  // This is the actual bug: only the first window was ever read.
  const list = appendingList([
    ['a', 'b'],
    ['a', 'b', 'c', 'd'],
    ['a', 'b', 'c', 'd', 'e'],
  ]);
  const res = await collectWhileScrolling(list.deps, 8);
  expect(res.items).toEqual(['a', 'b', 'c', 'd', 'e']);
  expect(res.exhausted).toBe(true); // stalled on its own, so we believe we saw everything
});

test('collectWhileScrolling captures every row of a VIRTUALIZED list', async () => {
  // Each round returns a disjoint window — earlier rows are gone from the DOM. A single
  // collect after scrolling (or dedupe-by-count) would lose the top of the list here.
  let round = 0;
  const windows = [['a', 'b'], ['c', 'd'], ['e', 'f'], ['e', 'f']];
  const res = await collectWhileScrolling({
    collect: async () => windows[Math.min(round, windows.length - 1)],
    key: (s: string) => s,
    scrollOnce: async () => { round++; },
  }, 8);
  expect(res.items).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
});

test('collectWhileScrolling reports exhausted=false when it stops at the round cap', async () => {
  // A list that never stops growing: the caller must be able to tell the snapshot is partial,
  // because silently returning a truncated inbox is exactly what hid the missed reply.
  let n = 0;
  const res = await collectWhileScrolling({
    collect: async () => [`row${n}`],
    key: (s: string) => s,
    scrollOnce: async () => { n++; },
  }, 3);
  expect(res.exhausted).toBe(false);
  expect(res.rounds).toBe(3);
  expect(res.items).toHaveLength(4); // the pre-scroll collect plus one per round
});

test('collectWhileScrolling keeps the FIRST sighting of a duplicate key', async () => {
  // The inbox is ordered most-recent-first and we scroll downward, so the first sighting is
  // the freshest row — which is the one whose "You:" prefix decides youSentLast.
  let round = 0;
  const res = await collectWhileScrolling({
    collect: async () => (round === 0
      ? [{ id: 'x', snippet: 'their reply' }]
      : [{ id: 'x', snippet: 'You: stale' }]),
    key: (r: { id: string }) => r.id,
    scrollOnce: async () => { round++; },
  }, 4);
  expect(res.items).toEqual([{ id: 'x', snippet: 'their reply' }]);
});

/**
 * A windowed list: only `window` rows are rendered at a time, and each scroll advances the
 * window by `step` rows. This is the shape that broke on 2026-07-29 — accumulating per round
 * is necessary but NOT sufficient, because a step wider than the window scrolls rows past
 * before anything snapshots them. The driver satisfies step <= window by scrolling half a
 * viewport; these two tests pin why that bound has to hold.
 */
function windowedList(total: number, window: number, step: number) {
  let offset = 0;
  return {
    collect: async () => Array.from(
      { length: Math.min(window, Math.max(0, total - offset)) },
      (_, i) => `row${offset + i}`,
    ),
    key: (s: string) => s,
    scrollOnce: async () => { offset = Math.min(offset + step, total); },
  };
}

test('collectWhileScrolling covers a windowed list when the step overlaps the window', async () => {
  const res = await collectWhileScrolling(windowedList(40, 10, 5), 30);
  expect(res.items).toHaveLength(40); // every row seen — consecutive windows overlap
  expect(res.exhausted).toBe(true);
});

test('a step WIDER than the window silently drops rows (the 1800px bug)', async () => {
  // Regression witness, not desired behaviour: 25-row strides past a 10-row window lose the
  // rows in between, and they go missing in contiguous runs exactly as observed in production.
  const res = await collectWhileScrolling(windowedList(100, 10, 25), 30);
  expect(res.items.length).toBeLessThan(100);
  expect(res.items).not.toContain('row15'); // fell in the first gap
});
