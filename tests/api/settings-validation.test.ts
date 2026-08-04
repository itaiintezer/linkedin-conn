/**
 * POST /api/settings range enforcement.
 *
 * The property that matters most is atomicity: a patch carrying one bad value must leave the
 * whole row untouched. Applying the legal half would put the engine in a state the operator
 * never asked for and cannot see.
 */
import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { FakeDriver } from '../../src/browser/driver.js';
import { buildServer } from '../../src/api/server.js';

let app: ReturnType<typeof buildServer>;
let repos: Repos;

beforeEach(() => {
  repos = new Repos(openDatabase(':memory:'));
  app = buildServer(repos, new FakeDriver());
});

const post = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/settings', payload });

test('an out-of-range value is a 400 naming the field in operator language', async () => {
  const res = await post({ weekly_cap: 5000 });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toBe('Weekly cap (invites) must be between 0 and 150.');
});

test('a rejected patch writes nothing at all', async () => {
  const before = repos.settings.get().batch_size;
  const res = await post({ batch_size: 7, weekly_cap: 5000 });   // one legal, one not
  expect(res.statusCode).toBe(400);
  expect(repos.settings.get().batch_size).toBe(before);          // the legal half did NOT land
});

test('a non-integer is rejected', async () => {
  expect((await post({ batches_per_day: 3.5 })).statusCode).toBe(400);
});

test('an inverted workday window is rejected', async () => {
  const res = await post({ workday_start_hour: 18, workday_end_hour: 9 });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toContain('must be after the start hour');
});

test('every failure comes back in fields[], with the first also as error', async () => {
  const body = (await post({ batch_size: 0, weekly_cap: 5000 })).json();
  expect(body.fields.map((f: { key: string }) => f.key)).toEqual(['weekly_cap', 'batch_size']);
  expect(body.error).toBe(body.fields[0].message);
});

test('an API-only key is ruled too', async () => {
  expect((await post({ min_delay_ms: -5 })).statusCode).toBe(400);
  expect((await post({ min_delay_ms: 30000 })).statusCode).toBe(200);
});

test('unruled keys still pass through untouched', async () => {
  expect((await post({ onboarded: 1, pause_reason: 'x' })).statusCode).toBe(200);
  expect(repos.settings.get().onboarded).toBe(1);
});

test('a valid patch still saves and echoes the settings back', async () => {
  const res = await post({ weekly_cap: 120 });
  expect(res.statusCode).toBe(200);
  expect(res.json().weekly_cap).toBe(120);
  expect(repos.settings.get().weekly_cap).toBe(120);
});

test('GET /api/settings serves the rule table for the form to stamp', async () => {
  const body = (await app.inject({ method: 'GET', url: '/api/settings' })).json();
  expect(body.rules.weekly_cap).toEqual({ label: 'Weekly cap (invites)', min: 0, max: 150 });
  expect(body.apify_key_set).toBe(false);        // the secret handling is unchanged
  expect(body.apify_api_key).toBeUndefined();
});
