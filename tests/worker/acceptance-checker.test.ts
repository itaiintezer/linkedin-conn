import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { FakeDriver } from '../../src/browser/driver.js';
import { runAcceptanceCheck } from '../../src/worker/acceptance-checker.js';

let repos: Repos; let driver: FakeDriver;
beforeEach(() => { repos = new Repos(openDatabase(':memory:')); driver = new FakeDriver(); });

function seedSent(url: string, cohortId: number) {
  const p = repos.profiles.add(cohortId, url, null);
  repos.profiles.setStatus(p.id, 'sent', { sent_at: '2026-06-20T00:00:00Z' });
  return p;
}

test('marks accepted and expired based on driver pages', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  const a = seedSent('https://www.linkedin.com/in/a', c.id);
  const b = seedSent('https://www.linkedin.com/in/b', c.id);
  const cc = seedSent('https://www.linkedin.com/in/c', c.id);

  driver.pending = ['https://www.linkedin.com/in/a'];
  driver.connections = ['https://www.linkedin.com/in/b'];

  const now = new Date('2026-06-29T12:00:00Z');
  await runAcceptanceCheck(repos, driver, now);

  expect(repos.profiles.byStatus('sent').map((p) => p.id)).toEqual([a.id]);
  const accepted = repos.profiles.byStatus('accepted');
  expect(accepted.map((p) => p.id)).toEqual([b.id]);
  expect(accepted[0].accepted_at).toBe(now.toISOString());
  expect(repos.profiles.byStatus('expired').map((p) => p.id)).toEqual([cc.id]);
});

test('skips when paused', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  seedSent('https://www.linkedin.com/in/a', c.id);
  repos.settings.update({ paused: 1 });
  driver.connections = ['https://www.linkedin.com/in/a'];
  await runAcceptanceCheck(repos, driver, new Date());
  expect(repos.profiles.byStatus('accepted')).toHaveLength(0);
});
