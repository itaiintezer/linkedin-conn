import { describe, it, expect } from 'vitest';
import {
  conflictsWithReservation, filterReservedSlots, findFreeWindow,
} from '../../src/core/reservations.js';

const at = (hhmm: string) => new Date(`2026-08-03T${hhmm}:00`);
const res = (from: string, to: string) => ({ from_ts: at(from).toISOString(), to_ts: at(to).toISOString() });

describe('conflictsWithReservation', () => {
  const r = [res('14:00', '14:20')];

  it('flags a slot inside the window', () => {
    expect(conflictsWithReservation(at('14:05'), r)).toBe(true);
  });

  it('ignores a slot outside it', () => {
    expect(conflictsWithReservation(at('13:00'), r)).toBe(false);
    expect(conflictsWithReservation(at('15:00'), r)).toBe(false);
  });

  it('treats the window as half-open so a slot exactly at the end does not conflict', () => {
    expect(conflictsWithReservation(at('14:20'), r)).toBe(false);
    expect(conflictsWithReservation(at('14:00'), r)).toBe(true);
  });

  it('flags a slot that STARTS before the window but would still be running inside it', () => {
    // The real bug this exists to prevent: a batch takes minutes, so checking only the
    // start instant lets a 13:57 batch run straight into a 14:00 reservation.
    expect(conflictsWithReservation(at('13:57'), r)).toBe(false);
    expect(conflictsWithReservation(at('13:57'), r, 6 * 60 * 1000)).toBe(true);
  });

  it('is false when there are no reservations', () => {
    expect(conflictsWithReservation(at('14:05'), [])).toBe(false);
  });

  it('ignores a malformed or inverted window rather than blocking the whole day', () => {
    expect(conflictsWithReservation(at('14:05'), [res('15:00', '14:00')])).toBe(false);
    expect(conflictsWithReservation(at('14:05'), [{ from_ts: 'nonsense', to_ts: 'nonsense' }])).toBe(false);
  });
});

describe('filterReservedSlots', () => {
  it('drops only the colliding slots', () => {
    const times = [at('09:00'), at('14:10'), at('17:00')];
    const kept = filterReservedSlots(times, [res('14:00', '14:20')]);
    expect(kept.map((d) => d.getHours())).toEqual([9, 17]);
  });

  it('returns the input untouched when nothing is reserved', () => {
    const times = [at('09:00'), at('14:10')];
    expect(filterReservedSlots(times, [])).toBe(times);
  });
});

describe('findFreeWindow', () => {
  const base = { windowStart: at('08:00'), windowEnd: at('20:00'), durationMs: 20 * 60 * 1000 };

  it('centres the window in the largest gap', () => {
    // Busy at 09:00 and 11:00; the largest gap is 11:00->20:00, so a 20-minute window
    // centres at 15:20.
    const w = findFreeWindow({ ...base, busy: [at('09:00'), at('11:00')] })!;
    expect(w.from.getHours()).toBe(15);
    expect(w.from.getMinutes()).toBe(20);
    expect(w.to.getTime() - w.from.getTime()).toBe(20 * 60 * 1000);
  });

  it('uses the whole window when nothing is busy', () => {
    const w = findFreeWindow({ ...base, busy: [] })!;
    expect(w.from.getHours()).toBe(13);
    expect(w.from.getMinutes()).toBe(50);
  });

  it('returns null when no gap is long enough', () => {
    // A busy point every 10 minutes, each occupying 10 minutes, leaves no 20-minute gap.
    const busy: Date[] = [];
    for (let m = 0; m < 12 * 60; m += 10) {
      busy.push(new Date(at('08:00').getTime() + m * 60 * 1000));
    }
    expect(findFreeWindow({ ...base, busy, busyRuntimeMs: 10 * 60 * 1000 })).toBeNull();
  });

  it('routes around an existing reservation, not just around sends', () => {
    const w = findFreeWindow({
      ...base, busy: [], reservations: [res('08:00', '19:00')],
    })!;
    expect(w.from.getTime()).toBeGreaterThanOrEqual(at('19:00').getTime());
    expect(w.to.getTime()).toBeLessThanOrEqual(at('20:00').getTime());
  });

  it('merges overlapping busy spans so no phantom gap appears between them', () => {
    // Two sends 2 minutes apart, each occupying 6 minutes: there is no usable gap
    // between them, and a naive implementation would offer the 2-minute hole.
    const w = findFreeWindow({
      ...base,
      busy: [at('12:00'), at('12:02')],
      busyRuntimeMs: 6 * 60 * 1000,
      durationMs: 60 * 1000,
    })!;
    const inHole = w.from.getTime() >= at('12:00').getTime() && w.from.getTime() < at('12:08').getTime();
    expect(inHole).toBe(false);
  });

  it('returns null for a non-positive duration or a backwards window', () => {
    expect(findFreeWindow({ ...base, busy: [], durationMs: 0 })).toBeNull();
    expect(findFreeWindow({ ...base, busy: [], windowStart: at('20:00'), windowEnd: at('08:00') })).toBeNull();
  });
});
