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

// --- CRITICAL A: an empty canonical name is never a matching key ----------------------

test('a blank full_name does not wildcard-match a blank inbox row name', async () => {
  const p = seedSentMsg('https://www.linkedin.com/in/blank', ' ');
  driver.inboxRows = [{ name: '', snippet: 'hello?', youSentLast: false }];
  const res = await runReplyCheck(repos, driver, NOW);
  expect(res.replied).toBe(0);
  expect(repos.profiles.findById(p.id)!.status).toBe('sent');
  expect(eventCount(p.id)).toBe(0);
});

test('decoration-only names ("(Recruiter)" vs "(Hiring Bot)") do not cross-match', async () => {
  const p = seedSentMsg('https://www.linkedin.com/in/rec', '(Recruiter)');
  driver.inboxRows = [{ name: '(Hiring Bot)', snippet: 'we are hiring', youSentLast: false }];
  const res = await runReplyCheck(repos, driver, NOW);
  expect(res.replied).toBe(0);
  expect(repos.profiles.findById(p.id)!.status).toBe('sent');
});

// --- CRITICAL B: surname-first display names stay distinct ----------------------------

test('"Cohen, David" is not credited when "Cohen, Rachel" replies', async () => {
  const p = seedSentMsg('https://www.linkedin.com/in/dcohen', 'Cohen, David');
  driver.inboxRows = [{ name: 'Cohen, Rachel', snippet: 'Rachel: hi', youSentLast: false }];
  const res = await runReplyCheck(repos, driver, NOW);
  expect(res.replied).toBe(0);
  expect(repos.profiles.findById(p.id)!.status).toBe('sent');
});

// --- IMPORTANT C: loose tier is containment, not first+last --------------------------

test('a same-first-and-last stranger ("Jon B Smith") never credits "Jon A Smith"', async () => {
  const p = seedSentMsg('https://www.linkedin.com/in/jas', 'Jon A Smith');
  driver.inboxRows = [{ name: 'Jon B Smith', snippet: 'Jon: hey', youSentLast: false }];
  const res = await runReplyCheck(repos, driver, NOW);
  expect(res.replied).toBe(0);
  expect(repos.profiles.findById(p.id)!.status).toBe('sent');
  expect(res.unmatched).toBe(1); // and we can see we are blind to this contact
});

test('two four-token Hispanic names sharing first+last do not cross-match', async () => {
  const p = seedSentMsg('https://www.linkedin.com/in/amgl', 'Ana Maria Garcia Lopez');
  driver.inboxRows = [{ name: 'Ana Sofia Perez Lopez', snippet: 'Ana: hola', youSentLast: false }];
  const res = await runReplyCheck(repos, driver, NOW);
  expect(res.replied).toBe(0);
  expect(repos.profiles.findById(p.id)!.status).toBe('sent');
});

// --- IMPORTANT D: cross-tier ambiguity ----------------------------------------------

test('a row matching one profile exactly and another by containment is ambiguous', async () => {
  const short = seedSentMsg('https://www.linkedin.com/in/k1', 'Keren Tevet');
  const long = seedSentMsg('https://www.linkedin.com/in/k2', 'Keren Yosef Tevet');
  driver.inboxRows = [{ name: 'Keren Tevet', snippet: 'Keren: hi', youSentLast: false }];
  const res = await runReplyCheck(repos, driver, NOW);
  expect(res.replied).toBe(0);
  expect(res.ambiguous).toBe(2);
  expect(repos.profiles.findById(short.id)!.status).toBe('sent');
  expect(repos.profiles.findById(long.id)!.status).toBe('sent');
});

// --- IMPORTANT E: an exact thread hit outranks a name hit on the same profile --------

test('a thread_url hit still applies when a same-name stranger row also resolves to it', async () => {
  const p = seedSentMsg('https://www.linkedin.com/in/k', 'Keren Tevet', {
    thread_url: 'https://www.linkedin.com/messaging/thread/2-real/',
  });
  driver.inboxRows = [
    // The real conversation — name rendered differently, but the thread id is definitive.
    { name: 'K. Tevet', snippet: 'sounds good', youSentLast: false, threadUrl: 'https://www.linkedin.com/messaging/thread/2-real/' },
    // A different person who merely shares the display name captured at send time.
    { name: 'Keren Tevet', snippet: 'who is this?', youSentLast: false, threadUrl: 'https://www.linkedin.com/messaging/thread/2-stranger/' },
  ];
  const res = await runReplyCheck(repos, driver, NOW);
  expect(res.replied).toBe(1);
  expect(repos.profiles.findById(p.id)!.status).toBe('replied');
  expect(eventCount(p.id)).toBe(1);
});

// --- MINOR F: two pending profiles sharing a thread_url -----------------------------

test('two pending profiles sharing a thread_url are ambiguous, not last-wins', async () => {
  const a = seedSentMsg('https://www.linkedin.com/in/a', 'Aaa One', {
    thread_url: 'https://www.linkedin.com/messaging/thread/2-dup/',
  });
  const b = seedSentMsg('https://www.linkedin.com/in/b', 'Bbb Two', {
    thread_url: 'https://www.linkedin.com/messaging/thread/2-dup/',
  });
  driver.inboxRows = [{ name: 'Whoever', snippet: 'hi', youSentLast: false, threadUrl: 'https://www.linkedin.com/messaging/thread/2-dup/' }];
  const res = await runReplyCheck(repos, driver, NOW);
  expect(res.replied).toBe(0);
  expect(res.ambiguous).toBe(2);
  expect(repos.profiles.findById(a.id)!.status).toBe('sent');
  expect(repos.profiles.findById(b.id)!.status).toBe('sent');
});

// --- MINOR G: `unmatched` means "no inbox row matched at all" ------------------------

test('unmatched counts only contacts no row matched — a You-prefixed row still counts as seen', async () => {
  seedSentMsg('https://www.linkedin.com/in/seen', 'Seen Person');
  seedSentMsg('https://www.linkedin.com/in/blind', 'Blind Person');
  driver.inboxRows = [
    { name: 'Seen Person', snippet: 'You: hi', youSentLast: true },
    { name: 'Nobody Relevant', snippet: 'x', youSentLast: false },
  ];
  const res = await runReplyCheck(repos, driver, NOW);
  expect(res.replied).toBe(0);
  expect(res.unmatched).toBe(1); // Blind Person only; "Seen Person" simply hasn't replied
});

// --- TASK-10: thread matching keys off the thread id, not the whole URL --------------

test('a relative thread href from the row anchor matches the absolute stored thread_url', async () => {
  const p = seedSentMsg('https://www.linkedin.com/in/k', 'Keren (Yosef) Tevet', {
    thread_url: 'https://www.linkedin.com/messaging/thread/2-AbC=/',
  });
  driver.inboxRows = [{
    name: 'Totally Different Rendering', snippet: 'hi', youSentLast: false,
    threadUrl: '/messaging/thread/2-AbC=/?filter=unread',
  }];
  const res = await runReplyCheck(repos, driver, NOW);
  expect(res.replied).toBe(1);
  expect(repos.profiles.findById(p.id)!.status).toBe('replied');
});

test('thread ids are compared verbatim — a case-different id is a different conversation', async () => {
  // Thread ids are base64-ish and both sides come from LinkedIn hrefs, so case-folding
  // could only merge two real conversations. Missing is safe; a false upgrade is not.
  const p = seedSentMsg('https://www.linkedin.com/in/k', 'Alpha Beta', {
    thread_url: 'https://www.linkedin.com/messaging/thread/2-AbC/',
  });
  driver.inboxRows = [{ name: 'Someone Unrelated', snippet: 'hi', youSentLast: false, threadUrl: '/messaging/thread/2-abc/' }];
  const res = await runReplyCheck(repos, driver, NOW);
  expect(res.replied).toBe(0);
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
