import { test, expect } from 'vitest';
import { windowStartIso, remainingCapacity } from '../../src/core/rate-limit.js';

const now = new Date('2026-06-29T12:00:00Z');

test('window start is 7 days before now (ISO)', () => {
  expect(windowStartIso(now)).toBe('2026-06-22T12:00:00.000Z');
});

test('remaining capacity is cap minus sent-in-window, floored at 0', () => {
  expect(remainingCapacity(100, 30)).toBe(70);
  expect(remainingCapacity(100, 100)).toBe(0);
  expect(remainingCapacity(100, 130)).toBe(0);
});
