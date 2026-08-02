/**
 * Behavioural lock on the planner across the planQueue extraction.
 *
 * Written and committed BEFORE the refactor so the snapshot records how planKind behaves
 * today. If extracting planQueue changes a single slot assignment — including the order in
 * which rng values are consumed across kinds — these snapshots fail.
 */
import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { planAndAssignToday } from '../../src/worker/scheduler-service.js';

let repos: Repos;
beforeEach(() => { repos = new Repos(openDatabase(':memory:')); });

/** A fixed, repeating rng so the plan is fully deterministic. */
function seededRng(): () => number {
  const seq = [0.11, 0.37, 0.52, 0.68, 0.83, 0.05, 0.94, 0.21];
  let i = 0;
  return () => seq[i++ % seq.length];
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
