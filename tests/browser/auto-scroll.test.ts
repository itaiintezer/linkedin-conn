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
