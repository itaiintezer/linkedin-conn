import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { FakeDriver } from '../../src/browser/driver.js';
import { buildServer } from '../../src/api/server.js';
import { defaultCohortName } from '../../src/core/cohort-name.js';
import { Mutex } from '../../src/core/mutex.js';

let app: ReturnType<typeof buildServer>;
let repos: Repos;
beforeEach(() => {
  repos = new Repos(openDatabase(':memory:'));
  app = buildServer(repos, new FakeDriver());
  repos.appState.setLogin({ loggedIn: true, cookieExpiry: null }, '2026-06-29T00:00:00.000Z');
});

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

test('POST /api/run-now is skipped (no send) while the shared browser lock is held', async () => {
  const driver = new FakeDriver();
  const lock = new Mutex();
  const app2 = buildServer(repos, driver, lock);
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

test('POST /api/profiles/:id/retry requeues a single profile', async () => {
  const c = repos.cohorts.create('R1', null, true);
  const a = repos.profiles.add(c.id, 'https://www.linkedin.com/in/r1', null);
  repos.profiles.setStatus(a.id, 'failed', { last_error: 'boom' });
  const res = await app.inject({ method: 'POST', url: `/api/profiles/${a.id}/retry` });
  expect(res.statusCode).toBe(200);
  expect(repos.profiles.findById(a.id)!.status).toBe('queued');
  expect(repos.profiles.findById(a.id)!.last_error).toBeNull();
});

test('POST /api/profiles/:id/dismiss marks it skipped', async () => {
  const c = repos.cohorts.create('D1', null, true);
  const a = repos.profiles.add(c.id, 'https://www.linkedin.com/in/d1', null);
  repos.profiles.setStatus(a.id, 'needs_attention', { last_error: 'x' });
  const res = await app.inject({ method: 'POST', url: `/api/profiles/${a.id}/dismiss` });
  expect(res.statusCode).toBe(200);
  expect(repos.profiles.findById(a.id)!.status).toBe('skipped');
});

test('POST /api/profiles/:id/retry 404s for an unknown id', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/profiles/99999/retry' });
  expect(res.statusCode).toBe(404);
});

test('GET /api/status: next_batch predicts a window when queued but unscheduled', async () => {
  const c = repos.cohorts.create('Pred', null, true);
  for (let i = 0; i < 5; i++) repos.profiles.add(c.id, `https://www.linkedin.com/in/p${i}`, null);
  const res = await app.inject({ method: 'GET', url: '/api/status' });
  expect(res.statusCode).toBe(200);
  const nb = JSON.parse(res.body).forecast.next_batch;
  expect(nb.estimated).toBe(true);
  expect(typeof nb.at).toBe('string');
  expect(nb.count).toBeGreaterThan(0);
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
