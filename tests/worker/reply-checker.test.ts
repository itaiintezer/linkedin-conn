import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { FakeDriver } from '../../src/browser/driver.js';
import { runReplyCheck } from '../../src/worker/reply-checker.js';
import type { Profile } from '../../src/types.js';

let repos: Repos; let driver: FakeDriver;
const NOW = new Date('2026-07-28T12:00:00Z');

beforeEach(() => {
  repos = new Repos(openDatabase(':memory:'));
  driver = new FakeDriver();
  repos.appState.setLogin({ loggedIn: true, cookieExpiry: null }, '2026-07-28T00:00:00.000Z');
});

function seedSentMsg(url: string, fullName: string | null, extra: Partial<Profile> = {}) {
  const c = repos.cohorts.getOrCreate('M', 'hi', true, 'message');
  const p = repos.profiles.add(c.id, url, null, 'message');
  repos.profiles.setStatus(p.id, 'sent', { sent_at: '2026-07-27T10:00:00.000Z', full_name: fullName, ...extra });
  return p;
}

function eventCount(profileId: number): number {
  return (repos.db.prepare('SELECT COUNT(*) c FROM profile_events WHERE profile_id = ?')
    .get(profileId) as { c: number }).c;
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

test('ambiguous display names shared by two DISTINCT pending contacts are left pending (fail-safe)', async () => {
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

// --- CRITICAL 1: layered matching (thread_url first, canonical name fallback) --------

test('thread_url match finds a reply even when the inbox display name differs from full_name', async () => {
  // Regression for the live discovery bug: full_name is captured from the profile-page
  // title ("Keren (Yosef) Tevet") while the inbox renders a different string entirely
  // ("K. Tevet") — name matching alone would miss this. thread_url is name-independent.
  const p = seedSentMsg('https://www.linkedin.com/in/k', 'Keren (Yosef) Tevet', {
    thread_url: 'https://www.linkedin.com/messaging/thread/abc123/',
  });
  driver.inboxRows = [{
    name: 'K. Tevet', snippet: 'hi', youSentLast: false,
    // Same thread, different query string and no trailing slash — must normalize-match.
    threadUrl: 'https://www.linkedin.com/messaging/thread/abc123?convo=1',
  }];
  const res = await runReplyCheck(repos, driver, NOW);
  expect(res.replied).toBe(1);
  expect(repos.profiles.findById(p.id)!.status).toBe('replied');
});

test('canonical-name fallback matches despite a parenthetical nickname/middle name', async () => {
  const p = seedSentMsg('https://www.linkedin.com/in/k', 'Keren (Yosef) Tevet');
  driver.inboxRows = [{ name: 'Keren Tevet', snippet: 'Keren: hi', youSentLast: false }];
  const res = await runReplyCheck(repos, driver, NOW);
  expect(res.replied).toBe(1);
  expect(repos.profiles.findById(p.id)!.status).toBe('replied');
});

test('first+last token fallback matches when canonical full names differ only by a middle token', async () => {
  const p = seedSentMsg('https://www.linkedin.com/in/k', 'Keren Yosef Tevet');
  driver.inboxRows = [{ name: 'Keren Tevet', snippet: 'Keren: hi', youSentLast: false }];
  const res = await runReplyCheck(repos, driver, NOW);
  expect(res.replied).toBe(1);
  expect(repos.profiles.findById(p.id)!.status).toBe('replied');
});

test('duplicate thread_url rows for the same profile apply once and are not flagged ambiguous', async () => {
  const p = seedSentMsg('https://www.linkedin.com/in/k', 'Keren Tevet', {
    thread_url: 'https://www.linkedin.com/messaging/thread/abc/',
  });
  driver.inboxRows = [
    { name: 'Keren Tevet', snippet: 'hi', youSentLast: false, threadUrl: 'https://www.linkedin.com/messaging/thread/abc/' },
    { name: 'Keren Tevet', snippet: 'hi', youSentLast: false, threadUrl: 'https://www.linkedin.com/messaging/thread/abc/' },
  ];
  const res = await runReplyCheck(repos, driver, NOW);
  expect(res.replied).toBe(1);
  expect(repos.profiles.findById(p.id)!.status).toBe('replied');
  expect(eventCount(p.id)).toBe(1);
});

// --- CRITICAL 2: no false upgrades, no double counting -------------------------------

test('two different inbox rows resolving by name to the same pending profile are ambiguous — no reply, no double event', async () => {
  const p = seedSentMsg('https://www.linkedin.com/in/k', 'Keren Tevet');
  driver.inboxRows = [
    { name: 'Keren Tevet', snippet: 'Keren: hi', youSentLast: false },
    { name: 'Keren Tevet', snippet: 'Keren: hi again', youSentLast: false },
  ];
  const res = await runReplyCheck(repos, driver, NOW);
  expect(res.replied).toBe(0);
  expect(repos.profiles.findById(p.id)!.status).toBe('sent');
  expect(eventCount(p.id)).toBe(0);
});

test('a pending profile with neither full_name nor thread_url is left pending (unmatchable, fail-safe)', async () => {
  const c = repos.cohorts.getOrCreate('M', 'hi', true, 'message');
  const p = repos.profiles.add(c.id, 'https://www.linkedin.com/in/nofn', null, 'message');
  repos.profiles.setStatus(p.id, 'sent', { sent_at: '2026-07-27T10:00:00.000Z' });
  driver.inboxRows = [{ name: 'Whoever', snippet: 'hi', youSentLast: false }];
  const res = await runReplyCheck(repos, driver, NOW);
  expect(res.ran).toBe(true);
  expect(repos.profiles.findById(p.id)!.status).toBe('sent');
});

// --- Cheap regression coverage (mirrors acceptance-checker.test.ts) -------------------

test('guardrail blocks even with force', async () => {
  const p = seedSentMsg('https://www.linkedin.com/in/k', 'Keren Tevet');
  repos.appState.trip('checkpoint', 'x', '2026-07-28T00:00:00.000Z');
  driver.inboxRows = [{ name: 'Keren Tevet', snippet: 'hi', youSentLast: false }];
  const res = await runReplyCheck(repos, driver, NOW, { force: true });
  expect(res.reason).toBe('guardrail');
  expect(repos.profiles.findById(p.id)!.status).toBe('sent');
});

test('logged_out (cached) skips without opening the browser', async () => {
  seedSentMsg('https://www.linkedin.com/in/k', 'Keren Tevet');
  repos.appState.setLogin({ loggedIn: false, cookieExpiry: null }, '2026-07-28T00:00:00.000Z');
  const res = await runReplyCheck(repos, driver, NOW);
  expect(res.reason).toBe('logged_out');
  expect(driver.open).toBe(false);
});

test('login lost on the live check trips login_lost and reads nothing', async () => {
  seedSentMsg('https://www.linkedin.com/in/k', 'Keren Tevet');
  driver.loggedIn = false;
  driver.inboxRows = [{ name: 'Keren Tevet', snippet: 'hi', youSentLast: false }];
  const res = await runReplyCheck(repos, driver, NOW);
  expect(res.reason).toBe('login_lost');
  expect(repos.appState.get().guardrail_reason).toBe('login_lost');
  expect(repos.profiles.byStatusKind('replied', 'message')).toHaveLength(0);
});

test('checkpoint text during the inbox read trips the guardrail', async () => {
  seedSentMsg('https://www.linkedin.com/in/k', 'Keren Tevet');
  driver.readInboxSnapshot = async () => { throw new Error('checkpoint detected during inbox read'); };
  const res = await runReplyCheck(repos, driver, NOW);
  expect(res.reason).toBe('read_error');
  expect(repos.appState.get().guardrail_tripped).toBe(1);
  expect(repos.appState.get().guardrail_reason).toBe('checkpoint');
});

test('read_error leaves replies_checked_at null', async () => {
  seedSentMsg('https://www.linkedin.com/in/k', 'Keren Tevet');
  driver.inboxError = 'boom';
  await runReplyCheck(repos, driver, NOW);
  expect(repos.appState.get().replies_checked_at).toBeNull();
});

test('invite-kind sent rows are ignored; no message pending means the browser never opens', async () => {
  const c = repos.cohorts.create('A', 'hi', true, 'invite');
  const p = repos.profiles.add(c.id, 'https://www.linkedin.com/in/inv', null, 'invite');
  repos.profiles.setStatus(p.id, 'sent', { sent_at: '2026-07-27T10:00:00.000Z', full_name: 'Someone Invite' });
  const res = await runReplyCheck(repos, driver, NOW);
  expect(res.reason).toBe('no_pending');
  expect(driver.open).toBe(false);
});

test('a clean, non-empty read resets the failure streak', async () => {
  seedSentMsg('https://www.linkedin.com/in/k', 'Keren Tevet');
  repos.appState.incFailureStreak();
  repos.appState.incFailureStreak();
  driver.inboxRows = [{ name: 'Keren Tevet', snippet: 'hi', youSentLast: false }];
  await runReplyCheck(repos, driver, NOW);
  expect(repos.appState.get().failure_streak).toBe(0);
});
