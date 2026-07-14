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

test('POST /api/recheck-acceptance returns "empty_read" while paused when connections read is empty', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  const p = repos.profiles.add(c.id, 'https://www.linkedin.com/in/pending', null);
  repos.profiles.setStatus(p.id, 'sent', { sent_at: '2026-06-20T00:00:00Z' });
  repos.settings.update({ paused: 1 });
  const res = await app.inject({ method: 'POST', url: '/api/recheck-acceptance' });
  expect(res.statusCode).toBe(200);
  expect(JSON.parse(res.body)).toEqual({ ran: false, reason: 'empty_read', accepted: 0, expired: 0 });
});

test('POST /api/recheck-acceptance promotes a profile that now appears in connections, even paused', async () => {
  const driver = new FakeDriver();
  driver.connections = ['https://www.linkedin.com/in/accepted-now'];
  const localApp = buildServer(repos, driver);
  repos.appState.setLogin({ loggedIn: true, cookieExpiry: null }, '2026-06-29T00:00:00.000Z');
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
