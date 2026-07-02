import { test, expect } from 'vitest';
import { log } from '../../src/core/log.js';
import { LOG_PATH } from '../../src/config.js';

// Regression: every worker/api module logs through this shared singleton, and none of
// them inject a test logger — so importing them under vitest wrote real entries into
// the production data/relay.log. On 2026-07-02 those test-generated lines (fake profile
// urls, scripted guardrail trips) were interleaved with a real incident and confused the
// investigation. `process.env.VITEST` is set by the test runner itself (verified: vitest
// sets it to 'true'), so the shared logger must never point at LOG_PATH while it's set.
test('the shared logger does not write to the production log file under vitest', () => {
  expect(process.env.VITEST).toBeTruthy();
  expect(log.path).not.toBe(LOG_PATH);
});
