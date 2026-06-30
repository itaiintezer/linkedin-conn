import { test, expect } from 'vitest';
import { defaultCohortName } from '../../src/core/cohort-name.js';

test('formats a date as "Mon D, YYYY"', () => {
  expect(defaultCohortName(new Date(2026, 5, 30))).toBe('Jun 30, 2026');
  expect(defaultCohortName(new Date(2026, 0, 1))).toBe('Jan 1, 2026');
});
