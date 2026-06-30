import { test, expect } from 'vitest';
import { Mutex } from '../../src/core/mutex.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

test('tryRun executes fn and returns its result when unlocked', async () => {
  const m = new Mutex();
  const result = await m.tryRun(async () => 42);
  expect(result).toBe(42);
  expect(m.isLocked).toBe(false);
});

test('tryRun skips (returns undefined, fn not called) while locked', async () => {
  const m = new Mutex();
  const gate = deferred();
  let firstRan = false;
  let secondRan = false;
  const p1 = m.run(async () => { firstRan = true; await gate.promise; });
  // The first call has synchronously acquired the lock.
  const r2 = await m.tryRun(async () => { secondRan = true; return 'x'; });
  expect(r2).toBeUndefined();
  expect(secondRan).toBe(false);
  gate.resolve();
  await p1;
  expect(firstRan).toBe(true);
  expect(m.isLocked).toBe(false);
});

test('run serializes concurrent calls so they never overlap', async () => {
  const m = new Mutex();
  let active = 0;
  let max = 0;
  const work = async () => {
    active++;
    max = Math.max(max, active);
    await new Promise((r) => setTimeout(r, 10));
    active--;
  };
  await Promise.all([m.run(work), m.run(work), m.run(work)]);
  expect(max).toBe(1);
  expect(active).toBe(0);
  expect(m.isLocked).toBe(false);
});

test('lock is released after fn throws, so later calls proceed', async () => {
  const m = new Mutex();
  await expect(m.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
  expect(m.isLocked).toBe(false);
  const r = await m.run(async () => 'ok');
  expect(r).toBe('ok');
});

test('a queued run waits for the holder to release, then runs in order', async () => {
  const m = new Mutex();
  const gate = deferred();
  const order: string[] = [];
  const p1 = m.run(async () => { order.push('a-start'); await gate.promise; order.push('a-end'); });
  const p2 = m.run(async () => { order.push('b'); });
  await Promise.resolve();
  expect(order).toEqual(['a-start']); // b is queued, not running yet
  gate.resolve();
  await Promise.all([p1, p2]);
  expect(order).toEqual(['a-start', 'a-end', 'b']);
});
