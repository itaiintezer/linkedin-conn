import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { planAndAssignToday } from '../../src/worker/scheduler-service.js';

let repos: Repos;
beforeEach(() => { repos = new Repos(openDatabase(':memory:')); });

test('moves queued profiles to scheduled with future timestamps within today', () => {
  const c = repos.cohorts.create('A', 'hi', true);
  for (let i = 0; i < 12; i++) repos.profiles.add(c.id, `https://www.linkedin.com/in/p${i}`, null);
  const now = new Date('2026-06-29T08:00:00');
  const seq = [0.1, 0.3, 0.5, 0.7];
  planAndAssignToday(repos, now, () => seq[Math.floor(Math.random() * seq.length)]);
  const scheduled = repos.profiles.byStatus('scheduled');
  expect(scheduled.length).toBe(12);
  for (const p of scheduled) expect(p.scheduled_for).not.toBeNull();
  expect(repos.profiles.byStatus('queued')).toHaveLength(0);
});

test('does not schedule beyond remaining weekly capacity', () => {
  const c = repos.cohorts.create('A', 'hi', true);
  for (let i = 0; i < 5; i++) repos.profiles.add(c.id, `https://www.linkedin.com/in/p${i}`, null);
  repos.settings.update({ weekly_cap: 2 });
  planAndAssignToday(repos, new Date('2026-06-29T08:00:00'));
  expect(repos.profiles.byStatus('scheduled').length).toBe(2);
  expect(repos.profiles.byStatus('queued').length).toBe(3);
});
