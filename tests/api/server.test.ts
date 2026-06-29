import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { FakeDriver } from '../../src/browser/driver.js';
import { buildServer } from '../../src/api/server.js';

let app: ReturnType<typeof buildServer>;
let repos: Repos;
beforeEach(() => {
  repos = new Repos(openDatabase(':memory:'));
  app = buildServer(repos, new FakeDriver());
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
