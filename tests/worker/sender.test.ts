import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { FakeDriver } from '../../src/browser/driver.js';
import { runSenderOnce } from '../../src/worker/sender.js';

let repos: Repos; let driver: FakeDriver;
beforeEach(() => {
  repos = new Repos(openDatabase(':memory:'));
  driver = new FakeDriver();
  repos.appState.setLogin({ loggedIn: true, cookieExpiry: null }, '2026-06-29T00:00:00.000Z');
});

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

test('already-connected -> already_connected status + event, not counted as sent', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  seedScheduled('https://www.linkedin.com/in/a', '2026-06-29T09:00:00.000Z', c.id);
  driver.scripted.set('https://www.linkedin.com/in/a', 'already');
  await runSenderOnce(repos, driver, new Date('2026-06-29T10:00:00Z'));
  expect(repos.profiles.byStatus('already_connected')).toHaveLength(1);
  expect(repos.profiles.byStatus('skipped')).toHaveLength(0);
  expect(repos.events.countSentSince('1970-01-01T00:00:00Z')).toBe(0);
});

test('checkpoint -> trips guardrail and flags needs_attention', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  seedScheduled('https://www.linkedin.com/in/a', '2026-06-29T09:00:00.000Z', c.id);
  driver.scripted.set('https://www.linkedin.com/in/a', 'checkpoint');
  await runSenderOnce(repos, driver, new Date('2026-06-29T10:00:00Z'));
  expect(repos.appState.get().guardrail_tripped).toBe(1);
  expect(repos.appState.get().guardrail_reason).toBe('checkpoint');
  expect(repos.profiles.byStatus('needs_attention')).toHaveLength(1);
  expect(repos.settings.get().paused).toBe(0); // manual pause untouched
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

test('outside working hours: due profiles are not sent (window guard)', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  seedScheduled('https://www.linkedin.com/in/a', '2026-06-29T09:00:00.000Z', c.id);
  // local 10pm Monday — after the default 8-20 window
  await runSenderOnce(repos, driver, new Date('2026-06-29T22:00:00'));
  expect(driver.sentLog).toHaveLength(0);
  expect(driver.open).toBe(false); // never opened the browser
});

test('weekend with weekdays_only: due profiles are not sent', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  seedScheduled('https://www.linkedin.com/in/a', '2026-06-27T09:00:00.000Z', c.id);
  await runSenderOnce(repos, driver, new Date('2026-06-28T10:00:00')); // local Sunday
  expect(driver.sentLog).toHaveLength(0);
});

test('force bypasses the window guard (Run batch now)', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  seedScheduled('https://www.linkedin.com/in/a', '2026-06-29T09:00:00.000Z', c.id);
  await runSenderOnce(repos, driver, new Date('2026-06-29T22:00:00'), { force: true });
  expect(driver.sentLog).toHaveLength(1);
  expect(repos.profiles.byStatus('sent')).toHaveLength(1);
});

test('does nothing when paused', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  seedScheduled('https://www.linkedin.com/in/a', '2026-06-29T09:00:00.000Z', c.id);
  repos.settings.update({ paused: 1 });
  await runSenderOnce(repos, driver, new Date('2026-06-29T10:00:00Z'));
  expect(driver.sentLog).toHaveLength(0);
});

test('not logged in (cache): skips without sending and without tripping', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  seedScheduled('https://www.linkedin.com/in/a', '2026-06-29T09:00:00.000Z', c.id);
  repos.appState.setLogin({ loggedIn: false, cookieExpiry: null }, '2026-06-29T00:00:00.000Z');
  await runSenderOnce(repos, driver, new Date('2026-06-29T10:00:00Z'));
  expect(driver.sentLog).toHaveLength(0);
  expect(repos.appState.get().guardrail_tripped).toBe(0);
  expect(repos.settings.get().paused).toBe(0);
});

test('does nothing and never opens the browser when no profile is due', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  // scheduled in the future -> not due yet
  seedScheduled('https://www.linkedin.com/in/a', '2026-06-29T23:00:00.000Z', c.id);
  await runSenderOnce(repos, driver, new Date('2026-06-29T10:00:00Z'));
  expect(driver.sentLog).toHaveLength(0);
  expect(driver.open).toBe(false); // lazy: browser never opened
});

test('skips and trips login_lost when the live check fails despite a stale cache', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  seedScheduled('https://www.linkedin.com/in/a', '2026-06-29T09:00:00.000Z', c.id);
  driver.loggedIn = false; // cache says logged-in (from beforeEach), live read disagrees
  await runSenderOnce(repos, driver, new Date('2026-06-29T10:00:00Z'));
  expect(driver.sentLog).toHaveLength(0);
  expect(repos.appState.get().guardrail_tripped).toBe(1);
  expect(repos.appState.get().guardrail_reason).toBe('login_lost');
  expect(repos.appState.get().login_logged_in).toBe(0); // cache corrected
});

test('does nothing when guardrail is already tripped', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  seedScheduled('https://www.linkedin.com/in/a', '2026-06-29T09:00:00.000Z', c.id);
  repos.appState.trip('checkpoint', 'x', '2026-06-29T00:00:00.000Z');
  await runSenderOnce(repos, driver, new Date('2026-06-29T10:00:00Z'));
  expect(driver.sentLog).toHaveLength(0);
});

test('three consecutive errors trip repeated_failures and stop the batch', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  for (const slug of ['a', 'b', 'c', 'd']) {
    seedScheduled(`https://www.linkedin.com/in/${slug}`, '2026-06-29T09:00:00.000Z', c.id);
    driver.scripted.set(`https://www.linkedin.com/in/${slug}`, 'error');
  }
  await runSenderOnce(repos, driver, new Date('2026-06-29T10:00:00Z'));
  expect(repos.appState.get().guardrail_tripped).toBe(1);
  expect(repos.appState.get().guardrail_reason).toBe('repeated_failures');
  // tripped on the 3rd error -> 4th profile never attempted
  expect(driver.sentLog).toHaveLength(3);
});

test('a success between failures resets the streak (no trip)', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  seedScheduled('https://www.linkedin.com/in/a', '2026-06-29T09:00:00.000Z', c.id);
  seedScheduled('https://www.linkedin.com/in/b', '2026-06-29T09:00:00.000Z', c.id);
  seedScheduled('https://www.linkedin.com/in/c', '2026-06-29T09:00:00.000Z', c.id);
  driver.scripted.set('https://www.linkedin.com/in/a', 'error');
  driver.scripted.set('https://www.linkedin.com/in/b', 'sent');
  driver.scripted.set('https://www.linkedin.com/in/c', 'error');
  await runSenderOnce(repos, driver, new Date('2026-06-29T10:00:00Z'));
  expect(repos.appState.get().guardrail_tripped).toBe(0);
  expect(repos.appState.get().failure_streak).toBe(1);
});
