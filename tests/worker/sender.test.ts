import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { FakeDriver } from '../../src/browser/driver.js';
import { runSenderOnce } from '../../src/worker/sender.js';

let repos: Repos; let driver: FakeDriver;
beforeEach(() => { repos = new Repos(openDatabase(':memory:')); driver = new FakeDriver(); });

function seedScheduled(url: string, whenIso: string, cohortId: number) {
  const p = repos.profiles.add(cohortId, url, null);
  repos.profiles.setScheduled(p.id, whenIso);
  return p;
}

test('sends due profiles, records sent status + event, respects remaining cap', async () => {
  const c = repos.cohorts.create('A', 'Hi {firstName}', true);
  seedScheduled('https://www.linkedin.com/in/a', '2026-06-29T09:00:00.000Z', c.id);
  seedScheduled('https://www.linkedin.com/in/b', '2026-06-29T09:00:00.000Z', c.id);

  const now = new Date('2026-06-29T10:00:00Z');
  await runSenderOnce(repos, driver, now);

  expect(driver.sentLog).toHaveLength(2);
  expect(driver.sentLog[0].message).toBe('Hi Test'); // driver substitutes the live name it reads ('Test')
  expect(repos.profiles.byStatus('sent')).toHaveLength(2);
  expect(repos.events.countSentSince('1970-01-01T00:00:00Z')).toBe(2);
});

test('already-connected -> skipped, not counted as sent', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  seedScheduled('https://www.linkedin.com/in/a', '2026-06-29T09:00:00.000Z', c.id);
  driver.scripted.set('https://www.linkedin.com/in/a', 'already');
  await runSenderOnce(repos, driver, new Date('2026-06-29T10:00:00Z'));
  expect(repos.profiles.byStatus('skipped')).toHaveLength(1);
  expect(repos.events.countSentSince('1970-01-01T00:00:00Z')).toBe(0);
});

test('checkpoint -> pauses queue and flags needs_attention', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  seedScheduled('https://www.linkedin.com/in/a', '2026-06-29T09:00:00.000Z', c.id);
  driver.scripted.set('https://www.linkedin.com/in/a', 'checkpoint');
  await runSenderOnce(repos, driver, new Date('2026-06-29T10:00:00Z'));
  expect(repos.settings.get().paused).toBe(1);
  expect(repos.profiles.byStatus('needs_attention')).toHaveLength(1);
});

test('note_quota with allow_no_note retries bare and sends', async () => {
  const c = repos.cohorts.create('A', 'hi {firstName}', true);
  seedScheduled('https://www.linkedin.com/in/a', '2026-06-29T09:00:00.000Z', c.id);
  let calls = 0;
  driver.sendConnectionRequest = async (url, message) => {
    calls++;
    driver.sentLog.push({ url, message });
    return calls === 1 ? { result: 'note_quota', firstName: 'T' } : { result: 'sent', firstName: 'T' };
  };
  await runSenderOnce(repos, driver, new Date('2026-06-29T10:00:00Z'));
  expect(driver.sentLog[1].message).toBeNull();
  expect(repos.profiles.byStatus('sent')).toHaveLength(1);
  expect(repos.settings.get().note_quota_exhausted).toBe(1);
});

test('does nothing when paused', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  seedScheduled('https://www.linkedin.com/in/a', '2026-06-29T09:00:00.000Z', c.id);
  repos.settings.update({ paused: 1 });
  await runSenderOnce(repos, driver, new Date('2026-06-29T10:00:00Z'));
  expect(driver.sentLog).toHaveLength(0);
});
