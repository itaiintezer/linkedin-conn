import { test, expect } from 'vitest';
import { capsFor } from '../../src/core/caps.js';

const settings = {
  weekly_cap: 100, batch_size: 5, batches_per_day: 4,
  msg_weekly_cap: 200, msg_batch_size: 7, msg_batches_per_day: 3,
} as any;

test('capsFor returns the invite numbers for invite', () => {
  expect(capsFor(settings, 'invite')).toEqual({ weeklyCap: 100, batchSize: 5, batchesPerDay: 4 });
});

test('capsFor returns the message numbers for message', () => {
  expect(capsFor(settings, 'message')).toEqual({ weeklyCap: 200, batchSize: 7, batchesPerDay: 3 });
});
