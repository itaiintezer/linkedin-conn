/**
 * Behavioural lock on the planner across the planQueue extraction.
 *
 * Written and committed BEFORE the refactor so the snapshot records how planKind behaves
 * today. If extracting planQueue changes a single slot assignment — including the order in
 * which rng values are consumed across kinds — these snapshots fail.
 *
 * THE SEED IS LOAD-BEARING, and not any old seed will do. planAndAssignToday shares ONE rng
 * across every queue, so the property under test is "a queue that schedules nothing draws
 * nothing". A mutation that makes an empty queue consume its batchesPerDay draws shifts
 * every later queue's window along the sequence — and the lock only notices if that shift
 * changes the times the plan actually USES.
 *
 * It originally did not. The seed was a repeating [0.11, 0.37, 0.52, 0.68, 0.83, 0.05,
 * 0.94, 0.21]; a queue only ever fills its two earliest slots, so all that mattered was the
 * two smallest draws in the window. Sliding that window by 4 kept 0.05 and 0.11 inside it,
 * the message rows came out byte-identical, and the mutation went undetected. (An
 * odd-sized shift was caught, which is what made the hole so easy to miss.)
 *
 * The fix is a strictly INCREASING, NON-REPEATING sequence. Then the k smallest values in a
 * window are always its first k, so any shift at all moves them and the snapshot moves with
 * it. Exhausting the sequence throws rather than wrapping, because wrapping is precisely
 * what reintroduces the hole. Keep both properties if you ever touch this.
 *
 * THE ZONE IS LOAD-BEARING TOO, and it is pinned in vitest.config.ts (`env: { TZ: 'UTC' }`),
 * not here. `plan()` passes a LOCAL date literal and the planner slices the LOCAL workday,
 * but the snapshot records absolute UTC instants — so without the pin the whole file is
 * green on a UTC+3 machine and four-times red on a UTC one. Do not "fix" that by running
 * `vitest -u`: rewriting these snapshots is exactly how the rng-ordering guard above gets
 * silently destroyed. Every recorded instant must sit inside the local workday window
 * (08:00-20:00) and after the 08:00 `now`.
 */
import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { planAndAssignToday } from '../../src/worker/scheduler-service.js';

let repos: Repos;
beforeEach(() => { repos = new Repos(openDatabase(':memory:')); });

/**
 * A fixed, strictly increasing, non-repeating rng so the plan is fully deterministic AND
 * every window shift is observable. See the header note — do not make this wrap.
 *
 * The busiest test draws 10 values (4 for invites + 6 for messages); the spare headroom is
 * for the fallback path, which draws again when every slot lands before `now`.
 */
const RNG_SEQ = [
  0.05, 0.11, 0.19, 0.27, 0.34, 0.42, 0.51, 0.58,
  0.66, 0.73, 0.81, 0.86, 0.89, 0.92, 0.95, 0.98,
];

function seededRng(): () => number {
  let i = 0;
  return () => {
    if (i >= RNG_SEQ.length) {
      throw new Error('seededRng exhausted — extend RNG_SEQ; it must never wrap');
    }
    return RNG_SEQ[i++];
  };
}

function plan() {
  planAndAssignToday(repos, new Date('2026-08-03T08:00:00'), seededRng());
  return repos.profiles.all()
    .filter((p) => p.status === 'scheduled')
    .map((p) => `${p.kind} ${p.profile_url} @ ${p.scheduled_for}`)
    .sort();
}

test('invite-only plan is unchanged', () => {
  const c = repos.cohorts.create('inv', 'hi', true, 'invite');
  for (let i = 0; i < 9; i++) repos.profiles.add(c.id, `https://www.linkedin.com/in/i${i}`, null, 'invite');
  expect(plan()).toMatchSnapshot();
});

test('message-only plan is unchanged', () => {
  const c = repos.cohorts.create('msg', 'hi', false, 'message');
  for (let i = 0; i < 9; i++) repos.profiles.add(c.id, `https://www.linkedin.com/in/m${i}`, null, 'message');
  expect(plan()).toMatchSnapshot();
});

test('mixed plan is unchanged — this is the rng-ordering guard', () => {
  const inv = repos.cohorts.create('inv', 'hi', true, 'invite');
  const msg = repos.cohorts.create('msg', 'hi', false, 'message');
  for (let i = 0; i < 7; i++) repos.profiles.add(inv.id, `https://www.linkedin.com/in/i${i}`, null, 'invite');
  for (let i = 0; i < 7; i++) repos.profiles.add(msg.id, `https://www.linkedin.com/in/m${i}`, null, 'message');
  expect(plan()).toMatchSnapshot();
});

test('an empty invite queue costs zero rng draws, so the message plan is unshifted', () => {
  const msg = repos.cohorts.create('msg', 'hi', false, 'message');
  for (let i = 0; i < 7; i++) repos.profiles.add(msg.id, `https://www.linkedin.com/in/m${i}`, null, 'message');
  expect(plan()).toMatchSnapshot();
});
