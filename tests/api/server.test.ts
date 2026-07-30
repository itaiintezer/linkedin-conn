import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { FakeDriver } from '../../src/browser/driver.js';
import { buildServer } from '../../src/api/server.js';
import { defaultCohortName } from '../../src/core/cohort-name.js';
import { Mutex } from '../../src/core/mutex.js';
import { createLogger } from '../../src/core/logger.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';

let app: ReturnType<typeof buildServer>;
let repos: Repos;
// Hoisted so tests that need to stage driver reads (connections, inbox rows) can reach
// the same FakeDriver instance the shared `app` was built with.
let driver: FakeDriver;
beforeEach(() => {
  repos = new Repos(openDatabase(':memory:'));
  driver = new FakeDriver();
  // No-op sleep: safe by construction regardless of run-now's batch size, so this suite
  // never actually waits the real min_delay_ms/max_delay_ms (20-90s by default).
  app = buildServer(repos, driver, undefined, undefined, { senderOptions: { sleep: async () => {} } });
  repos.appState.setLogin({ loggedIn: true, cookieExpiry: null }, '2026-06-29T00:00:00.000Z');
});

// Rows of one kind regardless of status. POST /api/lists and POST /api/profiles schedule
// their new backlog immediately, so counting via a specific status would make these
// assertions depend on whether the suite happens to run inside working hours.
function ofKind(kind: 'invite' | 'message') {
  return repos.profiles.all().filter((p) => p.kind === kind);
}

test('POST /api/run-now promotes queued profiles and sends a batch immediately', async () => {
  await app.inject({
    method: 'POST', url: '/api/lists',
    payload: { cohort: 'Now', text: 'https://linkedin.com/in/run-now-1', message_template: 'Hi', allow_no_note: true },
  });
  const res = await app.inject({ method: 'POST', url: '/api/run-now' });
  expect(res.statusCode).toBe(200);
  expect(JSON.parse(res.body).promoted).toBe(1);
  expect(repos.profiles.byStatus('sent')).toHaveLength(1);
});

test('POST /api/retry resets failed/needs_attention profiles to queued', async () => {
  const c = repos.cohorts.create('R', null, true);
  const a = repos.profiles.add(c.id, 'https://www.linkedin.com/in/fail-a', null);
  const b = repos.profiles.add(c.id, 'https://www.linkedin.com/in/attn-b', null);
  repos.profiles.setStatus(a.id, 'failed', { last_error: 'boom' });
  repos.profiles.setStatus(b.id, 'needs_attention', { last_error: 'checkpoint' });
  const res = await app.inject({ method: 'POST', url: '/api/retry' });
  expect(res.statusCode).toBe(200);
  expect(JSON.parse(res.body).retried).toBe(2);
  expect(repos.profiles.byStatus('queued')).toHaveLength(2);
  expect(repos.profiles.byStatus('failed')).toHaveLength(0);
  expect(repos.profiles.byStatus('needs_attention')).toHaveLength(0);
});

test('POST /api/profiles enqueues a normalized profile and creates the cohort', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/profiles',
    payload: { url: 'https://linkedin.com/in/Jane/', cohort: 'Founders', message: 'Hi!' },
  });
  expect(res.statusCode).toBe(200);
  expect(repos.cohorts.findByName('Founders')).toBeDefined();
  const p = repos.profiles.all();
  expect(p[0].profile_url).toBe('https://www.linkedin.com/in/jane');
  expect(p[0].custom_message).toBe('Hi!');
});

test('POST /api/lists bulk-adds from pasted text, deduping', async () => {
  const text = 'https://linkedin.com/in/a\nhttps://linkedin.com/in/b\nhttps://linkedin.com/in/a';
  const res = await app.inject({
    method: 'POST', url: '/api/lists',
    payload: { cohort: 'C', text, message_template: 'Hi {firstName}', allow_no_note: true },
  });
  expect(res.statusCode).toBe(200);
  expect(JSON.parse(res.body).added).toBe(2);
  expect(repos.profiles.countAll()).toBe(2);
});

test('GET /api/status reports counts and paused flag', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/status' });
  expect(res.statusCode).toBe(200);
  const body = JSON.parse(res.body);
  expect(body).toHaveProperty('paused');
  expect(body).toHaveProperty('weekly_sent');
  expect(body).toHaveProperty('counts');
});

test('POST /api/pause and /api/resume toggle paused', async () => {
  await app.inject({ method: 'POST', url: '/api/pause' });
  expect(repos.settings.get().paused).toBe(1);
  await app.inject({ method: 'POST', url: '/api/resume' });
  expect(repos.settings.get().paused).toBe(0);
});

test('POST /api/settings ignores unknown keys and applies known ones', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/settings',
    payload: { weekly_cap: 42, bogus_column: 999 },
  });
  expect(res.statusCode).toBe(200);
  expect(repos.settings.get().weekly_cap).toBe(42);
});

test('POST /api/lists defaults the cohort to the date when none is given', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/lists',
    payload: { text: 'https://linkedin.com/in/no-cohort-1', message_template: 'Hi {firstName}' },
  });
  expect(res.statusCode).toBe(200);
  expect(repos.cohorts.findByName(defaultCohortName(new Date()))).toBeDefined();
});

test('POST /api/lists derives allow_no_note from template presence', async () => {
  await app.inject({ method: 'POST', url: '/api/lists', payload: { cohort: 'WithNote', text: 'https://linkedin.com/in/n1', message_template: 'Hi' } });
  await app.inject({ method: 'POST', url: '/api/lists', payload: { cohort: 'NoNote', text: 'https://linkedin.com/in/n2' } });
  expect(repos.cohorts.findByName('WithNote')!.allow_no_note).toBe(0);
  expect(repos.cohorts.findByName('NoNote')!.allow_no_note).toBe(1);
});

test('POST /api/profiles defaults the cohort to the date when none is given', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/profiles',
    payload: { url: 'https://linkedin.com/in/solo-1', message: 'Hey {firstName}' },
  });
  expect(res.statusCode).toBe(200);
  expect(repos.cohorts.findByName(defaultCohortName(new Date()))).toBeDefined();
  expect(repos.profiles.all()[0].custom_message).toBe('Hey {firstName}');
});

test('POST /api/settings accepts onboarded', async () => {
  await app.inject({ method: 'POST', url: '/api/settings', payload: { onboarded: 1 } });
  expect(repos.settings.get().onboarded).toBe(1);
});

// account_type was removed entirely; an old client still sending it must not error or
// resurrect the field.
test('POST /api/settings ignores the removed account_type key', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/settings',
    payload: { account_type: 'premium', weekly_cap: 33 },
  });
  expect(res.statusCode).toBe(200);
  expect(repos.settings.get().weekly_cap).toBe(33);
  expect(repos.settings.get()).not.toHaveProperty('account_type');
});

test('GET /api/login-status reads the cache without touching the browser', async () => {
  repos.appState.setLogin({ loggedIn: true, cookieExpiry: null }, '2026-06-30T08:00:00.000Z');
  const res = await app.inject({ method: 'GET', url: '/api/login-status' });
  const body = JSON.parse(res.body);
  expect(body.loggedIn).toBe(true);
  expect(body.asOf).toBe('2026-06-30T08:00:00.000Z');
});

test('GET /api/status includes guardrail state', async () => {
  repos.appState.trip('checkpoint', 'captcha', '2026-06-30T09:00:00.000Z');
  const res = await app.inject({ method: 'GET', url: '/api/status' });
  const body = JSON.parse(res.body);
  expect(body.guardrail).toMatchObject({
    tripped: 1, reason: 'checkpoint', detail: 'captcha', trippedAt: '2026-06-30T09:00:00.000Z',
  });
});

test('POST /api/guardrail/acknowledge clears the guardrail when healthy', async () => {
  const driver = new FakeDriver();
  driver.loggedIn = true; driver.checkpoint = false;
  const a = buildServer(repos, driver);
  repos.appState.trip('checkpoint', 'captcha', '2026-06-30T09:00:00.000Z');
  const res = await a.inject({ method: 'POST', url: '/api/guardrail/acknowledge' });
  expect(JSON.parse(res.body).resumed).toBe(true);
  expect(repos.appState.get().guardrail_tripped).toBe(0);
  expect(repos.appState.get().failure_streak).toBe(0);
});

test('POST /api/guardrail/acknowledge stays tripped when still unhealthy', async () => {
  const driver = new FakeDriver();
  driver.loggedIn = false; // still logged out
  const a = buildServer(repos, driver);
  repos.appState.trip('login_lost', 'gone', '2026-06-30T09:00:00.000Z');
  const res = await a.inject({ method: 'POST', url: '/api/guardrail/acknowledge' });
  const body = JSON.parse(res.body);
  expect(body.resumed).toBe(false);
  expect(body.reason).toBe('login_lost');
  expect(repos.appState.get().guardrail_tripped).toBe(1);
});

test('acknowledge blocked by a live checkpoint reports where and what matched', async () => {
  const driver = new FakeDriver();
  driver.checkpoint = true;
  const a = buildServer(repos, driver);
  repos.appState.trip('checkpoint', 'x', '2026-06-30T09:00:00.000Z');
  const res = await a.inject({ method: 'POST', url: '/api/guardrail/acknowledge' });
  const body = JSON.parse(res.body);
  expect(body.resumed).toBe(false);
  expect(body.detail).toContain('linkedin.com/checkpoint');
  expect(repos.appState.get().guardrail_detail).toContain('linkedin.com/checkpoint');
});

test('GET /api/incidents lists captured evidence newest first with screenshot urls', async () => {
  const dir = mkdtempSync(pathJoin(tmpdir(), 'incidents-api-'));
  const { captureEvidence } = await import('../../src/browser/evidence.js');
  const page = {
    url: () => 'https://www.linkedin.com/checkpoint/challenge/x',
    title: async () => 'Security Verification | LinkedIn',
    content: async () => '<html></html>',
    screenshot: async () => Buffer.from('png'),
  };
  await captureEvidence(page, 'checkpoint', { matched: 'x' }, dir, new Date('2026-07-02T10:00:00Z'));
  await captureEvidence(page, 'send-failed', {}, dir, new Date('2026-07-02T12:00:00Z'));
  const a = buildServer(repos, new FakeDriver(), new Mutex(), undefined, { incidentsDir: dir });
  const res = await a.inject({ method: 'GET', url: '/api/incidents?limit=5' });
  const rows = JSON.parse(res.body);
  expect(rows).toHaveLength(2);
  expect(rows[0].tag).toBe('send-failed');
  expect(rows[0].screenshot).toBe('/incidents/2026-07-02T12-00-00-send-failed.png');
  // the screenshot itself is served
  const img = await a.inject({ method: 'GET', url: rows[0].screenshot });
  expect(img.statusCode).toBe(200);
  expect(img.body).toBe('png');
});

test('GET /api/incidents?since= excludes evidence captured before the cutoff', async () => {
  const dir = mkdtempSync(pathJoin(tmpdir(), 'incidents-api-'));
  const { captureEvidence } = await import('../../src/browser/evidence.js');
  const page = {
    url: () => 'https://www.linkedin.com/x',
    title: async () => 'x',
    content: async () => '<html></html>',
    screenshot: async () => Buffer.from('png'),
  };
  // A stale incident from days earlier must not be offered for a fresh halt.
  await captureEvidence(page, 'email-required', {}, dir, new Date('2026-07-22T11:12:13Z'));
  await captureEvidence(page, 'composer-unavailable', {}, dir, new Date('2026-07-27T15:15:05Z'));
  const a = buildServer(repos, new FakeDriver(), new Mutex(), undefined, { incidentsDir: dir });

  const fresh = JSON.parse(
    (await a.inject({ method: 'GET', url: '/api/incidents?since=2026-07-27T15:05:08Z' })).body,
  );
  expect(fresh).toHaveLength(1);
  expect(fresh[0].tag).toBe('composer-unavailable');

  // A cutoff later than every capture -> nothing (the banner shows no stale link).
  const none = JSON.parse(
    (await a.inject({ method: 'GET', url: '/api/incidents?since=2026-07-28T00:00:00Z' })).body,
  );
  expect(none).toHaveLength(0);
});

test('POST /api/run-now is skipped (no send) while the shared browser lock is held', async () => {
  const driver = new FakeDriver();
  const lock = new Mutex();
  const app2 = buildServer(repos, driver, lock, undefined, { senderOptions: { sleep: async () => {} } });
  await app2.inject({
    method: 'POST', url: '/api/lists',
    payload: { cohort: 'Locked', text: 'https://linkedin.com/in/locked-1', message_template: 'Hi' },
  });
  repos.appState.setLogin({ loggedIn: true, cookieExpiry: null }, '2026-06-29T00:00:00.000Z');

  // Hold the lock as if a sender batch were already running.
  let release!: () => void;
  const held = lock.run(() => new Promise<void>((r) => { release = r; }));

  const res = await app2.inject({ method: 'POST', url: '/api/run-now' });
  expect(res.statusCode).toBe(200);
  expect(driver.sentLog).toHaveLength(0); // skipped because the lock was held

  release();
  await held;
});

test('POST /api/login waits for the browser lock before navigating (no concurrent goto)', async () => {
  const driver = new FakeDriver();
  driver.loggedIn = false;
  driver.open = false;
  const lock = new Mutex();
  const app2 = buildServer(repos, driver, lock);

  // Simulate a sender/acceptance batch holding the lock (mid-navigation).
  let release!: () => void;
  const held = lock.run(() => new Promise<void>((r) => { release = r; }));

  await app2.inject({ method: 'POST', url: '/api/login' });
  expect(driver.open).toBe(false); // login navigation queued, not run while the lock is held

  release();
  await held;
  await new Promise((r) => setTimeout(r, 0)); // let the queued login run
  expect(driver.open).toBe(true); // login window opened once the lock was free
});

test('GET /api/status includes forecast and acceptance_checked_at', async () => {
  const c = repos.cohorts.create('F', 'hi', true);
  repos.profiles.add(c.id, 'https://www.linkedin.com/in/q1', null);
  const p2 = repos.profiles.add(c.id, 'https://www.linkedin.com/in/q2', null);
  repos.profiles.setScheduled(p2.id, '2099-01-01T10:00:00.000Z');
  repos.appState.setAcceptanceChecked('2026-06-30T07:00:00.000Z');
  const res = await app.inject({ method: 'GET', url: '/api/status' });
  const body = JSON.parse(res.body);
  expect(body.acceptance_checked_at).toBe('2026-06-30T07:00:00.000Z');
  expect(body.forecast.queue_remaining).toBe(2); // 1 queued + 1 scheduled
  expect(body.forecast).toHaveProperty('eta');
  expect(body.forecast.next_batch).toEqual({ estimated: false, at: '2099-01-01T10:00:00.000Z', count: 1 });
});

test('GET /api/queue returns ordered upcoming work and total', async () => {
  const c = repos.cohorts.create('Q', 'hi', true);
  const a = repos.profiles.add(c.id, 'https://www.linkedin.com/in/sched-late', null);
  const b = repos.profiles.add(c.id, 'https://www.linkedin.com/in/sched-early', null);
  repos.profiles.add(c.id, 'https://www.linkedin.com/in/queued', null);
  repos.profiles.setScheduled(a.id, '2099-01-02T10:00:00.000Z');
  repos.profiles.setScheduled(b.id, '2099-01-01T10:00:00.000Z');
  const res = await app.inject({ method: 'GET', url: '/api/queue?limit=2' });
  const body = JSON.parse(res.body);
  expect(body.total_remaining).toBe(3);
  expect(body.upcoming).toHaveLength(2);
  expect(body.upcoming[0].profile_url).toBe('https://www.linkedin.com/in/sched-early');
  expect(body.upcoming[1].profile_url).toBe('https://www.linkedin.com/in/sched-late');
});

test('GET /api/queue resolves note: profile override, else cohort template, else null', async () => {
  const withTpl = repos.cohorts.create('Tpl', 'Hi {firstName}', false);
  const bare = repos.cohorts.create('Bare', null, true);
  repos.profiles.add(withTpl.id, 'https://www.linkedin.com/in/inherits', null);     // inherits template
  repos.profiles.add(withTpl.id, 'https://www.linkedin.com/in/override', 'Custom hello'); // own message
  repos.profiles.add(bare.id, 'https://www.linkedin.com/in/nonote', null);          // bare request
  const res = await app.inject({ method: 'GET', url: '/api/queue?limit=10' });
  const byUrl = Object.fromEntries(JSON.parse(res.body).upcoming.map((r: { profile_url: string; note: string | null }) => [r.profile_url, r.note]));
  expect(byUrl['https://www.linkedin.com/in/inherits']).toBe('Hi {firstName}');
  expect(byUrl['https://www.linkedin.com/in/override']).toBe('Custom hello');
  expect(byUrl['https://www.linkedin.com/in/nonote']).toBeNull();
});

test('GET /api/attention lists failed and needs_attention with errors', async () => {
  const c = repos.cohorts.create('At', null, true);
  const a = repos.profiles.add(c.id, 'https://www.linkedin.com/in/fail', null);
  const b = repos.profiles.add(c.id, 'https://www.linkedin.com/in/attn', null);
  repos.profiles.add(c.id, 'https://www.linkedin.com/in/ok', null);
  repos.profiles.setStatus(a.id, 'failed', { last_error: 'boom' });
  repos.profiles.setStatus(b.id, 'needs_attention', { last_error: 'note quota' });
  const res = await app.inject({ method: 'GET', url: '/api/attention' });
  const body = JSON.parse(res.body);
  expect(body).toHaveLength(2);
  expect(body.map((r: { last_error: string }) => r.last_error).sort()).toEqual(['boom', 'note quota']);
});

test('POST /api/profiles/:id/retry requeues a single profile and clears skip_reason', async () => {
  const c = repos.cohorts.create('R1', null, true);
  const a = repos.profiles.add(c.id, 'https://www.linkedin.com/in/r1', null);
  repos.profiles.setStatus(a.id, 'skipped', { last_error: null, skip_reason: 'email_required' });
  const res = await app.inject({ method: 'POST', url: `/api/profiles/${a.id}/retry` });
  expect(res.statusCode).toBe(200);
  const row = repos.profiles.findById(a.id)!;
  expect(row.status).toBe('queued');
  expect(row.last_error).toBeNull();
  expect(row.skip_reason).toBeNull();
});

test('POST /api/profiles/:id/dismiss marks it skipped with reason dismissed', async () => {
  const c = repos.cohorts.create('D1', null, true);
  const a = repos.profiles.add(c.id, 'https://www.linkedin.com/in/d1', null);
  repos.profiles.setStatus(a.id, 'needs_attention', { last_error: 'x' });
  const res = await app.inject({ method: 'POST', url: `/api/profiles/${a.id}/dismiss` });
  expect(res.statusCode).toBe(200);
  const row = repos.profiles.findById(a.id)!;
  expect(row.status).toBe('skipped');
  expect(row.skip_reason).toBe('dismissed');
});

test('GET /api/profiles?status=skipped returns skip_reason', async () => {
  const c = repos.cohorts.create('SK', null, true);
  const a = repos.profiles.add(c.id, 'https://www.linkedin.com/in/sk1', null);
  repos.profiles.setStatus(a.id, 'skipped', { skip_reason: 'email_required' });
  const res = await app.inject({ method: 'GET', url: '/api/profiles?status=skipped' });
  const body = JSON.parse(res.body);
  expect(body).toHaveLength(1);
  expect(body[0].skip_reason).toBe('email_required');
});

test('POST /api/profiles/:id/retry 404s for an unknown id', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/profiles/99999/retry' });
  expect(res.statusCode).toBe(404);
});

test('GET /api/status: next_batch reports pending when queued but unscheduled', async () => {
  // `pending` only applies while today's window is still open, and /api/status reads the real
  // clock — so without this the test passes during working hours and fails in the evening.
  alwaysSending();
  const c = repos.cohorts.create('Pred', null, true);
  // Added straight through the repo, so no planning pass has run: these rows have no slots.
  for (let i = 0; i < 5; i++) repos.profiles.add(c.id, `https://www.linkedin.com/in/p${i}`, null);
  const res = await app.inject({ method: 'GET', url: '/api/status' });
  expect(res.statusCode).toBe(200);
  const nb = JSON.parse(res.body).forecast.next_batch;
  expect(nb.estimated).toBe(true);
  expect(nb.pending).toBe(true);
  expect(nb.count).toBeGreaterThan(0);
  // No slot exists, so the payload must not carry a time the UI could render as one.
  expect(nb.at).toBeUndefined();
});

test('GET /api/status: next_batch is blocked when paused with a backlog', async () => {
  const c = repos.cohorts.create('Blk', null, true);
  repos.profiles.add(c.id, 'https://www.linkedin.com/in/blocked', null);
  repos.settings.update({ paused: 1, pause_reason: 'Manual pause' });
  const res = await app.inject({ method: 'GET', url: '/api/status' });
  const nb = JSON.parse(res.body).forecast.next_batch;
  expect(nb).toEqual({ blocked: true, reason: 'Paused' });
});

test('GET /api/status: next_batch is null when nothing is queued', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/status' });
  expect(JSON.parse(res.body).forecast.next_batch).toBeNull();
});

test('GET /api/logs returns the last N lines', async () => {
  const path = pathJoin(mkdtempSync(pathJoin(tmpdir(), 'srvlog-')), 'relay.log');
  const logger = createLogger(path, { echo: false });
  logger.info('test', 'alpha');
  logger.info('test', 'bravo');
  const a = buildServer(repos, new FakeDriver(), new Mutex(), logger);
  const res = await a.inject({ method: 'GET', url: '/api/logs?tail=1' });
  expect(res.statusCode).toBe(200);
  const body = JSON.parse(res.body);
  expect(body.lines).toHaveLength(1);
  expect(body.lines[0]).toContain('bravo');
});

test('GET /api/logs/download streams the log as an attachment', async () => {
  const path = pathJoin(mkdtempSync(pathJoin(tmpdir(), 'srvlog-')), 'relay.log');
  const logger = createLogger(path, { echo: false });
  logger.info('test', 'downloadable');
  const a = buildServer(repos, new FakeDriver(), new Mutex(), logger);
  const res = await a.inject({ method: 'GET', url: '/api/logs/download' });
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-disposition']).toContain('relay.log');
  expect(res.body).toContain('downloadable');
});

test('GET /api/docs lists the api doc', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/docs' });
  expect(res.statusCode).toBe(200);
  const body = JSON.parse(res.body);
  expect(body.some((d: { slug: string }) => d.slug === 'api')).toBe(true);
});

test('GET /api/docs/api returns markdown', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/docs/api' });
  expect(res.statusCode).toBe(200);
  expect(JSON.parse(res.body).markdown).toContain('# The Machine API');
});

test('GET /api/docs/unknown 404s', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/docs/unknown' });
  expect(res.statusCode).toBe(404);
});

test('GET /api/queue/grouped groups queued+scheduled by cohort', async () => {
  const c1 = repos.cohorts.create('G1', null, true);
  const c2 = repos.cohorts.create('G2', null, true);
  repos.profiles.add(c1.id, 'https://www.linkedin.com/in/g1a', null);
  repos.profiles.add(c2.id, 'https://www.linkedin.com/in/g2a', null);
  const res = await app.inject({ method: 'GET', url: '/api/queue/grouped' });
  expect(res.statusCode).toBe(200);
  const body = JSON.parse(res.body);
  const names = body.cohorts.map((c: { name: string }) => c.name).sort();
  expect(names).toEqual(['G1', 'G2']);
  expect(body.cohorts[0].profiles.length).toBeGreaterThan(0);
});

test('POST /api/queue/profile/:id/move top reprioritizes', async () => {
  const c = repos.cohorts.create('Mv', null, true);
  repos.profiles.add(c.id, 'https://www.linkedin.com/in/first', null);
  const b = repos.profiles.add(c.id, 'https://www.linkedin.com/in/second', null);
  const res = await app.inject({ method: 'POST', url: `/api/queue/profile/${b.id}/move`, payload: { to: 'top' } });
  expect(res.statusCode).toBe(200);
  expect(repos.profiles.queuedByPriority()[0].id).toBe(b.id);
});

test('POST /api/queue/profile/:id/remove soft-removes (skipped)', async () => {
  const c = repos.cohorts.create('Rm', null, true);
  const a = repos.profiles.add(c.id, 'https://www.linkedin.com/in/rm', null);
  const res = await app.inject({ method: 'POST', url: `/api/queue/profile/${a.id}/remove` });
  expect(res.statusCode).toBe(200);
  expect(repos.profiles.findById(a.id)!.status).toBe('skipped');
});

test('POST /api/queue/cohort/:id/remove skips the whole cohort queue', async () => {
  const c = repos.cohorts.create('CR', null, true);
  const a = repos.profiles.add(c.id, 'https://www.linkedin.com/in/cr1', null);
  const b = repos.profiles.add(c.id, 'https://www.linkedin.com/in/cr2', null);
  const res = await app.inject({ method: 'POST', url: `/api/queue/cohort/${c.id}/remove` });
  expect(res.statusCode).toBe(200);
  expect(repos.profiles.findById(a.id)!.status).toBe('skipped');
  expect(repos.profiles.findById(b.id)!.status).toBe('skipped');
});

test('POST /api/queue/cohorts/reorder applies the given order', async () => {
  const c1 = repos.cohorts.create('O1', null, true);
  const c2 = repos.cohorts.create('O2', null, true);
  const a = repos.profiles.add(c1.id, 'https://www.linkedin.com/in/o1', null);
  const b = repos.profiles.add(c2.id, 'https://www.linkedin.com/in/o2', null);
  const res = await app.inject({ method: 'POST', url: '/api/queue/cohorts/reorder', payload: { order: [c2.id, c1.id] } });
  expect(res.statusCode).toBe(200);
  expect(repos.profiles.queuedByPriority().map((p) => p.id)).toEqual([b.id, a.id]);
});

test('POST /api/queue/profile/:id/move 404s for unknown id', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/queue/profile/99999/move', payload: { to: 'top' } });
  expect(res.statusCode).toBe(404);
});

/* ---------- UX batch fixes: archive, status filter, sending, resume-replan ---------- */

test('POST /api/cohorts/:id/archive hides the cohort and skips its queue', async () => {
  const c = repos.cohorts.create('Arch', null, true);
  const a = repos.profiles.add(c.id, 'https://www.linkedin.com/in/arch-1', null);
  const b = repos.profiles.add(c.id, 'https://www.linkedin.com/in/arch-2', null);
  repos.profiles.setScheduled(b.id, '2099-01-01T00:00:00.000Z');
  const res = await app.inject({ method: 'POST', url: `/api/cohorts/${c.id}/archive` });
  expect(res.statusCode).toBe(200);
  expect(repos.cohorts.list().find((x) => x.id === c.id)).toBeUndefined();
  expect(repos.cohorts.listArchived().find((x) => x.id === c.id)).toBeDefined();
  expect(repos.profiles.findById(a.id)!.status).toBe('skipped');
  expect(repos.profiles.findById(b.id)!.status).toBe('skipped');
});

test('POST /api/cohorts/:id/unarchive restores the cohort', async () => {
  const c = repos.cohorts.create('Back', null, true);
  repos.cohorts.setArchived(c.id, true);
  const res = await app.inject({ method: 'POST', url: `/api/cohorts/${c.id}/unarchive` });
  expect(res.statusCode).toBe(200);
  expect(repos.cohorts.list().find((x) => x.id === c.id)).toBeDefined();
});

test('GET /api/cohorts/archived lists only archived cohorts', async () => {
  const live = repos.cohorts.create('Live', null, true);
  const dead = repos.cohorts.create('Dead', null, true);
  repos.cohorts.setArchived(dead.id, true);
  const res = await app.inject({ method: 'GET', url: '/api/cohorts/archived' });
  const names = (JSON.parse(res.body) as { name: string }[]).map((c) => c.name);
  expect(names).toContain('Dead');
  expect(names).not.toContain('Live');
  expect(live.id).toBeGreaterThan(0);
});

test('GET /api/metrics excludes archived cohorts', async () => {
  const c = repos.cohorts.create('MDead', null, true);
  const p = repos.profiles.add(c.id, 'https://www.linkedin.com/in/mdead', null);
  repos.profiles.setStatus(p.id, 'sent', { sent_at: '2026-06-29T09:00:00.000Z' });
  repos.cohorts.setArchived(c.id, true);
  const res = await app.inject({ method: 'GET', url: '/api/metrics' });
  const rows = JSON.parse(res.body) as { cohort_name: string }[];
  expect(rows.find((r) => r.cohort_name === 'MDead')).toBeUndefined();
});

test('GET /api/profiles?status=accepted filters by status', async () => {
  const c = repos.cohorts.create('F', null, true);
  const a = repos.profiles.add(c.id, 'https://www.linkedin.com/in/f-acc', null);
  repos.profiles.add(c.id, 'https://www.linkedin.com/in/f-queued', null);
  repos.profiles.setStatus(a.id, 'accepted', { accepted_at: '2026-06-29T09:00:00.000Z' });
  const res = await app.inject({ method: 'GET', url: '/api/profiles?status=accepted' });
  const rows = JSON.parse(res.body) as { profile_url: string; status: string }[];
  expect(rows).toHaveLength(1);
  expect(rows[0].status).toBe('accepted');
});

test('GET /api/status includes the profiles currently sending', async () => {
  const c = repos.cohorts.create('Snd', null, true);
  const p = repos.profiles.add(c.id, 'https://www.linkedin.com/in/now-sending', null);
  repos.profiles.setStatus(p.id, 'sending');
  const res = await app.inject({ method: 'GET', url: '/api/status' });
  const body = JSON.parse(res.body);
  expect(body.sending).toEqual([{ id: p.id, profile_url: 'https://www.linkedin.com/in/now-sending' }]);
});

test('POST /api/resume re-plans the day so queued profiles get slots again', async () => {
  const c = repos.cohorts.create('Rpl', null, true);
  repos.profiles.add(c.id, 'https://www.linkedin.com/in/rpl', null);
  repos.settings.update({ paused: 1, pause_reason: 'test' });
  const res = await app.inject({ method: 'POST', url: '/api/resume' });
  expect(res.statusCode).toBe(200);
  // If we're inside working hours right now the profile gets a slot; either way
  // it must no longer be blocked by pause and the endpoint must not throw.
  expect(repos.settings.get().paused).toBe(0);
});

test('POST /api/recheck-acceptance reports "no_pending" when nothing is sent', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/recheck-acceptance' });
  expect(res.statusCode).toBe(200);
  expect(JSON.parse(res.body)).toEqual({ ran: false, reason: 'no_pending', accepted: 0, expired: 0 });
});

test('POST /api/recheck-acceptance returns "empty_roster" while paused when the roster is empty', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  const p = repos.profiles.add(c.id, 'https://www.linkedin.com/in/pending', null);
  repos.profiles.setStatus(p.id, 'sent', { sent_at: '2026-06-20T00:00:00Z' });
  repos.settings.update({ paused: 1 });
  const res = await app.inject({ method: 'POST', url: '/api/recheck-acceptance' });
  expect(res.statusCode).toBe(200);
  expect(JSON.parse(res.body)).toEqual({ ran: false, reason: 'empty_roster', accepted: 0, expired: 0 });
});

test('POST /api/recheck-acceptance promotes a profile that is now in the roster, even paused', async () => {
  const localApp = buildServer(repos, new FakeDriver());
  repos.appState.setLogin({ loggedIn: true, cookieExpiry: null }, '2026-06-29T00:00:00.000Z');
  // Post-cutover the roster is the source of truth, not a live scrape.
  repos.connections.upsert({ profile_url: 'https://www.linkedin.com/in/accepted-now' }, 'scrape', '2026-06-29T00:00:00.000Z');
  const c = repos.cohorts.create('A', 'hi', true);
  const p = repos.profiles.add(c.id, 'https://www.linkedin.com/in/accepted-now', null);
  repos.profiles.setStatus(p.id, 'sent', { sent_at: '2026-06-20T00:00:00Z' });
  repos.settings.update({ paused: 1 });

  const res = await localApp.inject({ method: 'POST', url: '/api/recheck-acceptance' });
  expect(res.statusCode).toBe(200);
  const body = JSON.parse(res.body);
  expect(body.ran).toBe(true);
  expect(body.accepted).toBe(1);
  expect(repos.profiles.findById(p.id)!.status).toBe('accepted');
});

test('POST /api/lists with kind=message requires a template and creates a message cohort', async () => {
  const bad = await app.inject({ method: 'POST', url: '/api/lists', payload: {
    cohort: 'Msgs', kind: 'message', text: 'https://www.linkedin.com/in/a',
  } });
  expect(bad.statusCode).toBe(400);

  const ok = await app.inject({ method: 'POST', url: '/api/lists', payload: {
    cohort: 'Msgs', kind: 'message', text: 'https://www.linkedin.com/in/a', message_template: 'Hey {firstName}',
  } });
  expect(ok.statusCode).toBe(200);
  expect(ok.json().added).toBe(1);
  const cohort = repos.cohorts.findByName('Msgs')!;
  expect(cohort.kind).toBe('message');
  expect(ofKind('message')).toHaveLength(1);
});

test('POST /api/lists rejects adding to a cohort of the other kind', async () => {
  await app.inject({ method: 'POST', url: '/api/lists', payload: { cohort: 'InvC', text: 'https://www.linkedin.com/in/z' } });
  const res = await app.inject({ method: 'POST', url: '/api/lists', payload: {
    cohort: 'InvC', kind: 'message', text: 'https://www.linkedin.com/in/y', message_template: 'hi',
  } });
  expect(res.statusCode).toBe(409);
});

test('GET /api/status exposes per-kind counts, caps, and replies_checked_at', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/status' });
  const body = res.json();
  expect(body.counts).toBeDefined();
  expect(body.msg_counts).toBeDefined();
  expect(body.msg_weekly_cap).toBe(250);
  expect(body).toHaveProperty('replies_checked_at');
  expect(body.forecast.msg_next_batch !== undefined).toBe(true);
});

test('GET /api/profiles?status=sent&kind=message filters by kind', async () => {
  const m = repos.cohorts.create('MM', 'hi', true, 'message');
  const p = repos.profiles.add(m.id, 'https://www.linkedin.com/in/mk', null, 'message');
  repos.profiles.setStatus(p.id, 'sent', { sent_at: '2026-07-28T00:00:00.000Z' });
  const res = await app.inject({ method: 'GET', url: '/api/profiles?status=sent&kind=message' });
  expect(res.json()).toHaveLength(1);
  const inv = await app.inject({ method: 'GET', url: '/api/profiles?status=sent&kind=invite' });
  expect(inv.json()).toHaveLength(0);
});

test('POST /api/recheck-replies runs a forced reply pass', async () => {
  const m = repos.cohorts.create('MR', 'hi', true, 'message');
  const p = repos.profiles.add(m.id, 'https://www.linkedin.com/in/kr', null, 'message');
  repos.profiles.setStatus(p.id, 'sent', { sent_at: '2026-07-27T00:00:00.000Z', full_name: 'K R' });
  driver.inboxRows = [{ name: 'K R', snippet: 'K: hi', youSentLast: false }];
  const res = await app.inject({ method: 'POST', url: '/api/recheck-replies' });
  expect(res.json().replied).toBe(1);
});

test('POST /api/settings accepts the message pacing keys', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/settings', payload: { msg_weekly_cap: 150, reply_checks_per_day: 1 } });
  expect(res.json().msg_weekly_cap).toBe(150);
  expect(res.json().reply_checks_per_day).toBe(1);
});

test('POST /api/cohorts enforces the same template rules as /api/lists', async () => {
  // A direct API caller (agent/script) must not be able to create a message cohort with
  // no text — the UI guards this client-side, which doesn't protect the API.
  const blank = await app.inject({ method: 'POST', url: '/api/cohorts', payload: { name: 'MsgNoTpl', kind: 'message' } });
  expect(blank.statusCode).toBe(400);
  expect(repos.cohorts.findByName('MsgNoTpl')).toBeUndefined();

  const tooLong = await app.inject({
    method: 'POST', url: '/api/cohorts',
    payload: { name: 'MsgLong', kind: 'message', message_template: 'x'.repeat(2001) },
  });
  expect(tooLong.statusCode).toBe(400);

  const ok = await app.inject({
    method: 'POST', url: '/api/cohorts',
    payload: { name: 'MsgOk', kind: 'message', message_template: 'Hey {firstName}' },
  });
  expect(ok.statusCode).toBe(200);
  expect(repos.cohorts.findByName('MsgOk')!.kind).toBe('message');

  // Invite cohorts keep their 300-char limit and may still have no template at all.
  const bareInvite = await app.inject({ method: 'POST', url: '/api/cohorts', payload: { name: 'InvBare' } });
  expect(bareInvite.statusCode).toBe(200);
  const inviteLong = await app.inject({
    method: 'POST', url: '/api/cohorts',
    payload: { name: 'InvLong', message_template: 'x'.repeat(301) },
  });
  expect(inviteLong.statusCode).toBe(400);
});

test('editing an existing message cohort without restating kind still enforces its template', async () => {
  await app.inject({
    method: 'POST', url: '/api/cohorts',
    payload: { name: 'MsgEdit', kind: 'message', message_template: 'Hey {firstName}' },
  });
  // The UI's edit form omits `kind` (it's frozen); blanking the template must still 400
  // rather than silently leaving a message cohort unsendable.
  const blanked = await app.inject({
    method: 'POST', url: '/api/cohorts', payload: { name: 'MsgEdit', message_template: '   ' },
  });
  expect(blanked.statusCode).toBe(400);
  expect(repos.cohorts.findByName('MsgEdit')!.message_template).toBe('Hey {firstName}');
});

/* ---------- POST /api/profiles: kind safety ----------
   The single-URL path defaulted every row to 'invite'. Adding to a message cohort that
   way produced an INVITE row whose text came from the DM template, which the invite
   sender then truncated to a 300-char connection note — a real message to a real person.
   These lock the cross-kind guard, the new `kind` parameter, and the text rules. */

test('POST /api/profiles rejects adding to a cohort of the other kind', async () => {
  await app.inject({
    method: 'POST', url: '/api/lists',
    payload: {
      cohort: 'DMs', kind: 'message', text: 'https://www.linkedin.com/in/seed-dm',
      message_template: 'Hey {firstName}, '.repeat(50),
    },
  });
  // No `kind` in the body defaults to 'invite', which used to silently mis-kind the row.
  const res = await app.inject({
    method: 'POST', url: '/api/profiles',
    payload: { url: 'https://www.linkedin.com/in/cross-kind', cohort: 'DMs' },
  });
  expect(res.statusCode).toBe(409);
  expect(res.json().error).toContain('is a message cohort');
  expect(repos.profiles.byStatusKind('queued', 'invite')).toHaveLength(0);
});

test('POST /api/profiles rejects a message add to an invite cohort', async () => {
  await app.inject({
    method: 'POST', url: '/api/lists',
    payload: { cohort: 'InvOnly', text: 'https://www.linkedin.com/in/seed-inv' },
  });
  const res = await app.inject({
    method: 'POST', url: '/api/profiles',
    payload: { url: 'https://www.linkedin.com/in/wrong-way', cohort: 'InvOnly', kind: 'message', message: 'hi' },
  });
  expect(res.statusCode).toBe(409);
  // Deliberately the same message shape /api/lists and /api/cohorts emit, article wart included.
  expect(res.json().error).toContain('invite cohort');
});

test('POST /api/profiles with kind=message adds a message row to a message cohort', async () => {
  await app.inject({
    method: 'POST', url: '/api/lists',
    payload: {
      cohort: 'DMs', kind: 'message', text: 'https://www.linkedin.com/in/seed-dm',
      message_template: 'Hey {firstName}',
    },
  });
  const res = await app.inject({
    method: 'POST', url: '/api/profiles',
    payload: { url: 'https://www.linkedin.com/in/dm-one', cohort: 'DMs', kind: 'message' },
  });
  expect(res.statusCode).toBe(200);
  const p = repos.profiles.all().find((x) => x.profile_url.endsWith('dm-one'))!;
  expect(p.kind).toBe('message');
  expect(ofKind('message')).toHaveLength(2);
});

test('POST /api/profiles kind=message takes a per-contact message instead of a cohort template', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/profiles',
    payload: {
      url: 'https://www.linkedin.com/in/per-contact', cohort: 'FreshDMs', kind: 'message',
      message: 'Hey {firstName}',
    },
  });
  expect(res.statusCode).toBe(200);
  expect(repos.cohorts.findByName('FreshDMs')!.kind).toBe('message');
  const p = repos.profiles.all()[0];
  expect(p.kind).toBe('message');
  expect(p.custom_message).toBe('Hey {firstName}');
});

test('POST /api/profiles kind=message 400s when there is no text to send at all', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/profiles',
    payload: { url: 'https://www.linkedin.com/in/no-text', cohort: 'EmptyDMs', kind: 'message' },
  });
  expect(res.statusCode).toBe(400);
  // Nothing partially created: no cohort, and no row that would drain into needs_attention.
  expect(repos.cohorts.findByName('EmptyDMs')).toBeUndefined();
  expect(repos.profiles.all()).toHaveLength(0);
});

test('POST /api/profiles caps the per-contact message at the limit for its kind', async () => {
  const longDm = await app.inject({
    method: 'POST', url: '/api/profiles',
    payload: {
      url: 'https://www.linkedin.com/in/long-dm', cohort: 'LongDMs', kind: 'message',
      message: 'x'.repeat(2001),
    },
  });
  expect(longDm.statusCode).toBe(400);
  // Invite notes cap at 300 — over-long text was silently truncated mid-sentence at send time.
  const longNote = await app.inject({
    method: 'POST', url: '/api/profiles',
    payload: { url: 'https://www.linkedin.com/in/long-note', cohort: 'LongNotes', message: 'x'.repeat(301) },
  });
  expect(longNote.statusCode).toBe(400);
  expect(repos.profiles.all()).toHaveLength(0);
});

test('POST /api/profiles still defaults to an invite row in an invite cohort', async () => {
  await app.inject({
    method: 'POST', url: '/api/lists',
    payload: { cohort: 'Inv', text: 'https://www.linkedin.com/in/seed-i' },
  });
  const res = await app.inject({
    method: 'POST', url: '/api/profiles',
    payload: { url: 'https://www.linkedin.com/in/inv-one', cohort: 'Inv', message: 'Hi there' },
  });
  expect(res.statusCode).toBe(200);
  expect(repos.cohorts.findByName('Inv')!.kind).toBe('invite');
  expect(ofKind('invite')).toHaveLength(2);
  expect(ofKind('message')).toHaveLength(0);
});

/* ---------- the message forecast's settings remap ----------
   core/forecast is kind-agnostic: the message side gets its pacing by handing
   nextBatchForecast a Settings whose invite fields carry the msg_* values. That remap is
   now the ONLY mechanism (forecast.dailySendRate has no `kind` parameter), so lock it. */

test('GET /api/status paces msg_next_batch from the msg_* settings, not the invite ones', async () => {
  await app.inject({
    method: 'POST', url: '/api/settings',
    payload: {
      weekly_cap: 100, batch_size: 5, batches_per_day: 4,
      msg_weekly_cap: 200, msg_batch_size: 2, msg_batches_per_day: 4,
    },
  });
  const inv = repos.cohorts.create('FInv', null, true);
  const msg = repos.cohorts.create('FMsg', 'hi', false, 'message');
  for (let i = 0; i < 20; i++) {
    repos.profiles.add(inv.id, `https://www.linkedin.com/in/fi-${i}`, null);
    repos.profiles.add(msg.id, `https://www.linkedin.com/in/fm-${i}`, null, 'message');
  }
  const body = (await app.inject({ method: 'GET', url: '/api/status' })).json();
  // batch_size 5 vs msg_batch_size 2 — a shared invite-only rate would report 5 for both.
  expect(body.forecast.next_batch.count).toBe(5);
  expect(body.forecast.msg_next_batch.count).toBe(2);

  // The weekly clamp is remapped too: zeroing only the message cap must stop only the
  // message conveyor, leaving the invite forecast running.
  await app.inject({ method: 'POST', url: '/api/settings', payload: { msg_weekly_cap: 0 } });
  const capped = (await app.inject({ method: 'GET', url: '/api/status' })).json();
  expect(capped.forecast.msg_next_batch.blocked).toBe(true);
  expect(capped.forecast.next_batch.blocked).toBeUndefined();
});

/* ---------- GET /api/attention ---------- */

test('GET /api/attention tags each row with its campaign kind', async () => {
  const inv = repos.cohorts.create('AttnInv', null, true);
  const msg = repos.cohorts.create('AttnMsg', 'hi', false, 'message');
  const a = repos.profiles.add(inv.id, 'https://www.linkedin.com/in/attn-inv', null);
  const b = repos.profiles.add(msg.id, 'https://www.linkedin.com/in/attn-msg', null, 'message');
  repos.profiles.setStatus(a.id, 'failed', { last_error: 'boom' });
  repos.profiles.setStatus(b.id, 'needs_attention', { last_error: 'no text' });
  const rows = (await app.inject({ method: 'GET', url: '/api/attention' })).json() as { kind: string }[];
  expect(rows).toHaveLength(2);
  expect(rows.map((r) => r.kind).sort()).toEqual(['invite', 'message']);
});

/* ---------- POST /api/profiles/:id/retry: status allow-list ----------
   Retry re-queues the profile for a fresh send. Without an allow-list, retrying an
   already-`replied` or `accepted` profile sends the same DM/invite a second time. */

test('POST /api/profiles/:id/retry refuses statuses that would re-send', async () => {
  const m = repos.cohorts.create('NoRetry', 'hi', false, 'message');
  for (const status of ['replied', 'accepted', 'sent', 'sending', 'expired', 'queued', 'scheduled'] as const) {
    const p = repos.profiles.add(m.id, `https://www.linkedin.com/in/nr-${status}`, null, 'message');
    repos.profiles.setStatus(p.id, status);
    const res = await app.inject({ method: 'POST', url: `/api/profiles/${p.id}/retry` });
    expect(res.statusCode, `status ${status}`).toBe(409);
    expect(res.json().error).toContain(status);
    expect(repos.profiles.findById(p.id)!.status).toBe(status);
  }
});

test('POST /api/profiles/:id/retry allows exactly the statuses the UI offers', async () => {
  const c = repos.cohorts.create('CanRetry', null, true);
  for (const status of ['failed', 'needs_attention', 'skipped'] as const) {
    const p = repos.profiles.add(c.id, `https://www.linkedin.com/in/cr-${status}`, null);
    repos.profiles.setStatus(p.id, status, { last_error: 'boom', skip_reason: 'dismissed' });
    const res = await app.inject({ method: 'POST', url: `/api/profiles/${p.id}/retry` });
    expect(res.statusCode, `status ${status}`).toBe(200);
    expect(repos.profiles.findById(p.id)!.status).toBe('queued');
  }
});

test('cross-kind 409 messages use the right article', async () => {
  await app.inject({ method: 'POST', url: '/api/lists', payload: { cohort: 'ArtI', text: 'https://www.linkedin.com/in/art1' } });
  const toMsg = await app.inject({
    method: 'POST', url: '/api/lists',
    payload: { cohort: 'ArtI', kind: 'message', text: 'https://www.linkedin.com/in/art2', message_template: 'hi' },
  });
  expect(toMsg.statusCode).toBe(409);
  expect(toMsg.json().error).toContain('is an invite cohort'); // not "is a invite"
});

// An always-open sending window, so these assertions don't depend on when the suite runs:
// planAndAssignToday refuses to materialize slots on weekends or outside working hours.
function alwaysSending(): void {
  repos.settings.update({ weekdays_only: 0, workday_start_hour: 0, workday_end_hour: 24 });
}

test('POST /api/lists schedules the new backlog immediately', async () => {
  // Without this, a fresh cohort sat entirely unscheduled until the hourly planning tick
  // (up to 60 minutes) while the dashboard's next-batch pill implied an imminent send.
  alwaysSending();
  const res = await app.inject({
    method: 'POST', url: '/api/lists',
    payload: {
      cohort: 'PlanNow', kind: 'message', message_template: 'Hi {{first_name}}',
      text: ['a', 'b', 'c'].map((s) => `https://www.linkedin.com/in/plan-now-${s}`).join('\n'),
    },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().added).toBe(3);

  const scheduled = repos.profiles.byStatusKind('scheduled', 'message');
  expect(scheduled.length).toBeGreaterThan(0);
  // Every materialized slot is a real future time, not a placeholder.
  for (const p of scheduled) expect(new Date(p.scheduled_for!).getTime()).toBeGreaterThan(Date.now());
});

test('POST /api/profiles schedules the added profile immediately', async () => {
  alwaysSending();
  const res = await app.inject({
    method: 'POST', url: '/api/profiles',
    payload: { url: 'https://www.linkedin.com/in/plan-one', cohort: 'PlanOne' },
  });
  expect(res.statusCode).toBe(200);
  expect(repos.profiles.findById(res.json().id)!.status).toBe('scheduled');
});

test('a paused engine still leaves an added list unscheduled', async () => {
  // planAndAssignToday declines while paused (slots would only go stale). Adding work must
  // not quietly resurrect a paused engine.
  alwaysSending();
  repos.settings.update({ paused: 1, pause_reason: 'Manual pause' });
  await app.inject({
    method: 'POST', url: '/api/lists',
    payload: { cohort: 'PausedAdd', text: 'https://www.linkedin.com/in/paused-add' },
  });
  expect(repos.profiles.byStatus('scheduled')).toHaveLength(0);
  expect(repos.profiles.byStatus('queued')).toHaveLength(1);
});
