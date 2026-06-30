import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { FakeDriver } from '../../src/browser/driver.js';
import { buildServer } from '../../src/api/server.js';
import { planAndAssignToday } from '../../src/worker/scheduler-service.js';
import { runSenderOnce } from '../../src/worker/sender.js';
import { runAcceptanceCheck } from '../../src/worker/acceptance-checker.js';

// Full data-flow integration test exercising every layer together:
// HTTP API -> scheduler -> sender -> acceptance-checker -> metrics/status API.
// Uses the FakeDriver (no real browser) so it is deterministic and side-effect free.

let repos: Repos;
let driver: FakeDriver;
let app: ReturnType<typeof buildServer>;

beforeEach(() => {
  repos = new Repos(openDatabase(':memory:'));
  driver = new FakeDriver();
  app = buildServer(repos, driver);
  repos.appState.setLogin({ loggedIn: true, cookieExpiry: null }, '2026-06-29T00:00:00.000Z');
});

test('happy path: list -> schedule -> send -> accept -> metrics', async () => {
  // 1. Add a cohort + 3 profiles via the bulk-list API.
  const text = [
    'https://linkedin.com/in/qa-alice',
    'https://www.linkedin.com/in/qa-bob?trk=x',
    'https://linkedin.com/in/qa-carol/',
  ].join('\n');
  const addRes = await app.inject({
    method: 'POST',
    url: '/api/lists',
    payload: { cohort: 'QA', text, message_template: 'Hi {firstName}', allow_no_note: true },
  });
  expect(addRes.statusCode).toBe(200);
  expect(JSON.parse(addRes.body)).toEqual({ added: 3, found: 3 });
  expect(repos.profiles.byStatus('queued')).toHaveLength(3);

  // 2. Schedule them. rng=()=>0 forces the fallback "now+60s" slot so they become due quickly.
  const planNow = new Date('2026-06-29T09:00:00'); // Monday, local
  planAndAssignToday(repos, planNow, () => 0);
  expect(repos.profiles.byStatus('scheduled')).toHaveLength(3);
  expect(repos.profiles.byStatus('queued')).toHaveLength(0);

  // 3. Run the sender once, after the scheduled time. All 3 fit in one batch (batch_size 5).
  const sendNow = new Date(planNow.getTime() + 2 * 60_000);
  await runSenderOnce(repos, driver, sendNow);
  expect(driver.sentLog).toHaveLength(3);
  // driver substitutes {firstName} with the live name it reads (FakeDriver uses 'Test')
  expect(driver.sentLog.every((s) => s.message === 'Hi Test')).toBe(true);
  expect(repos.profiles.byStatus('sent')).toHaveLength(3);

  // 4. Acceptance check: 2 became connections, the third never resolves (expired).
  driver.connections = [
    'https://www.linkedin.com/in/qa-alice',
    'https://www.linkedin.com/in/qa-bob',
  ];
  driver.pending = []; // none still outstanding
  await runAcceptanceCheck(repos, driver, new Date('2026-06-30T09:00:00Z'));
  expect(repos.profiles.byStatus('accepted')).toHaveLength(2);
  expect(repos.profiles.byStatus('expired')).toHaveLength(1);

  // 5. Metrics API reflects the funnel.
  const metricsRes = await app.inject({ method: 'GET', url: '/api/metrics' });
  const metrics = JSON.parse(metricsRes.body);
  expect(metrics).toHaveLength(1);
  expect(metrics[0]).toMatchObject({
    cohort_name: 'QA',
    sent: 3, // attempted = accepted + pending + expired
    accepted: 2,
    pending: 0,
    expired: 1,
  });
  expect(metrics[0].acceptance_rate).toBeCloseTo(2 / 3);

  // 6. Status API reflects the same counts and weekly usage.
  const statusRes = await app.inject({ method: 'GET', url: '/api/status' });
  const status = JSON.parse(statusRes.body);
  expect(status.counts.accepted).toBe(2);
  expect(status.counts.expired).toBe(1);
  expect(status.weekly_sent).toBe(3); // 3 sends recorded in send_log within the rolling window
});

test('per-contact custom message overrides the cohort template', async () => {
  await app.inject({
    method: 'POST',
    url: '/api/lists',
    payload: { cohort: 'QA', text: 'placeholder', message_template: 'Hi {firstName}', allow_no_note: true },
  });
  // enqueue one profile with an ultra-personalized per-contact message (the AI-agent path)
  const res = await app.inject({
    method: 'POST',
    url: '/api/profiles',
    payload: { url: 'https://linkedin.com/in/qa-dave', cohort: 'QA', message: 'Loved your talk, {firstName}!' },
  });
  expect(res.statusCode).toBe(200);

  const planNow = new Date('2026-06-29T09:00:00');
  planAndAssignToday(repos, planNow, () => 0);
  await runSenderOnce(repos, driver, new Date(planNow.getTime() + 2 * 60_000));

  const dave = driver.sentLog.find((s) => s.url === 'https://www.linkedin.com/in/qa-dave');
  expect(dave?.message).toBe('Loved your talk, Test!'); // custom msg used, {firstName}->live name
});
