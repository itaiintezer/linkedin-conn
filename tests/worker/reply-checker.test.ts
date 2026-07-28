import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { FakeDriver } from '../../src/browser/driver.js';
import { runReplyCheck } from '../../src/worker/reply-checker.js';

let repos: Repos; let driver: FakeDriver;
const NOW = new Date('2026-07-28T12:00:00Z');

beforeEach(() => {
  repos = new Repos(openDatabase(':memory:'));
  driver = new FakeDriver();
  repos.appState.setLogin({ loggedIn: true, cookieExpiry: null }, '2026-07-28T00:00:00.000Z');
});

function seedSentMsg(url: string, fullName: string) {
  const c = repos.cohorts.getOrCreate('M', 'hi', true, 'message');
  const p = repos.profiles.add(c.id, url, null, 'message');
  repos.profiles.setStatus(p.id, 'sent', { sent_at: '2026-07-27T10:00:00.000Z', full_name: fullName });
  return p;
}

test('marks replied when the inbox row for a messaged contact is not You-prefixed', async () => {
  const p = seedSentMsg('https://www.linkedin.com/in/k', 'Keren Tevet');
  driver.inboxRows = [{ name: 'Keren Tevet', snippet: 'Keren: sounds good!', youSentLast: false }];
  const res = await runReplyCheck(repos, driver, NOW);
  expect(res.ran).toBe(true);
  expect(res.replied).toBe(1);
  const row = repos.profiles.findById(p.id)!;
  expect(row.status).toBe('replied');
  expect(row.replied_at).toBe(NOW.toISOString());
  expect(repos.appState.get().replies_checked_at).toBe(NOW.toISOString());
});

test('You-prefixed rows and unmatched names change nothing', async () => {
  const p = seedSentMsg('https://www.linkedin.com/in/k', 'Keren Tevet');
  driver.inboxRows = [
    { name: 'Keren Tevet', snippet: 'You: Hi Keren', youSentLast: true },
    { name: 'Somebody Else', snippet: 'Somebody: hello', youSentLast: false },
  ];
  const res = await runReplyCheck(repos, driver, NOW);
  expect(res.ran).toBe(true);
  expect(res.replied).toBe(0);
  expect(repos.profiles.findById(p.id)!.status).toBe('sent');
});

test('ambiguous display names are left pending (fail-safe)', async () => {
  const a = seedSentMsg('https://www.linkedin.com/in/k1', 'Keren Tevet');
  const b = seedSentMsg('https://www.linkedin.com/in/k2', 'Keren Tevet');
  driver.inboxRows = [{ name: 'Keren Tevet', snippet: 'Keren: hi!', youSentLast: false }];
  const res = await runReplyCheck(repos, driver, NOW);
  expect(res.replied).toBe(0);
  expect(repos.profiles.findById(a.id)!.status).toBe('sent');
  expect(repos.profiles.findById(b.id)!.status).toBe('sent');
});

test('empty inbox read is a no-op that does NOT stamp replies_checked_at', async () => {
  seedSentMsg('https://www.linkedin.com/in/k', 'Keren Tevet');
  driver.inboxRows = [];
  const res = await runReplyCheck(repos, driver, NOW);
  expect(res.ran).toBe(false);
  expect(res.reason).toBe('empty_read');
  expect(repos.appState.get().replies_checked_at).toBeNull();
});

test('no pending messages -> stays dark; paused -> skipped unless forced', async () => {
  expect((await runReplyCheck(repos, driver, NOW)).reason).toBe('no_pending');
  seedSentMsg('https://www.linkedin.com/in/k', 'Keren Tevet');
  repos.settings.update({ paused: 1 });
  expect((await runReplyCheck(repos, driver, NOW)).reason).toBe('paused');
  driver.inboxRows = [{ name: 'Keren Tevet', snippet: 'Keren: yo', youSentLast: false }];
  expect((await runReplyCheck(repos, driver, NOW, { force: true })).replied).toBe(1);
});

test('read error feeds the failure streak via recordReadError', async () => {
  seedSentMsg('https://www.linkedin.com/in/k', 'Keren Tevet');
  driver.inboxError = 'boom';
  const res = await runReplyCheck(repos, driver, NOW);
  expect(res.reason).toBe('read_error');
  expect(repos.appState.get().failure_streak).toBe(1);
});
