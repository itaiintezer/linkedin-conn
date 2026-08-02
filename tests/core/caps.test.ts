import { test, expect } from 'vitest';
import { capsFor, engagementCaps } from '../../src/core/caps.js';

const settings = {
  weekly_cap: 100, batch_size: 5, batches_per_day: 4,
  msg_weekly_cap: 200, msg_batch_size: 7, msg_batches_per_day: 3,
  engage_weekly_cap: 500, engage_batch_size: 15, engage_batches_per_day: 6,
} as any;

test('capsFor returns the invite numbers for invite', () => {
  expect(capsFor(settings, 'invite')).toEqual({ weeklyCap: 100, batchSize: 5, batchesPerDay: 4 });
});

test('capsFor returns the message numbers for message', () => {
  expect(capsFor(settings, 'message')).toEqual({ weeklyCap: 200, batchSize: 7, batchesPerDay: 3 });
});

test('engagementCaps reads the engage_* columns, not the invite ones', () => {
  expect(engagementCaps(settings)).toEqual({ weeklyCap: 500, batchSize: 15, batchesPerDay: 6 });
});

// The two live side by side and are easy to transpose. Engagements are paced far more
// generously than invites, so a mix-up would silently throttle one pipeline or over-run
// the other rather than failing loudly.
test('engagementCaps and capsFor do not read each other’s settings', () => {
  expect(engagementCaps(settings)).not.toEqual(capsFor(settings, 'invite'));
  expect(engagementCaps(settings)).not.toEqual(capsFor(settings, 'message'));
});
