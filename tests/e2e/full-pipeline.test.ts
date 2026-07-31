import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { FakeDriver } from '../../src/browser/driver.js';
import { buildServer } from '../../src/api/server.js';
import { resortSchedule } from '../../src/worker/scheduler-service.js';
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
  expect(repos.profiles.countAll()).toBe(3);

  // 2. Re-flow the whole backlog at a pinned time. /api/lists already scheduled these rows
  // against the real wall clock, so resortSchedule (requeue everything, then re-plan) is what
  // hands slot placement back to this test; rng=()=>0 forces the fallback slot at `planNow`
  // so they become due immediately.
  const planNow = new Date('2026-06-29T09:00:00'); // Monday, local
  resortSchedule(repos, planNow, () => 0);
  expect(repos.profiles.byStatus('scheduled')).toHaveLength(3);
  expect(repos.profiles.byStatus('queued')).toHaveLength(0);

  // 3. Run the sender once, after the scheduled time. All 3 fit in one batch (batch_size 5).
  // No-op sleep: this batch has 3 profiles (2 inter-send gaps), and this suite must not
  // actually wait the real min_delay_ms/max_delay_ms (20-90s by default).
  const sendNow = new Date(planNow.getTime() + 2 * 60_000);
  await runSenderOnce(repos, driver, sendNow, { sleep: async () => {} });
  expect(driver.sentLog).toHaveLength(3);
  // driver substitutes {firstName} with the live name it reads (FakeDriver uses 'Test')
  expect(driver.sentLog.every((s) => s.message === 'Hi Test')).toBe(true);
  expect(repos.profiles.byStatus('sent')).toHaveLength(3);

  // 4. Acceptance check: 2 became connections; the third simply isn't a connection yet,
  //    so it stays pending. Absence from the roster is NEVER treated as expiry.
  //    Post-cutover the roster is the source of truth — roster-sync puts people there.
  for (const u of ['https://www.linkedin.com/in/qa-alice', 'https://www.linkedin.com/in/qa-bob']) {
    repos.connections.upsert({ profile_url: u }, 'scrape', '2026-06-30T09:00:00.000Z');
  }
  await runAcceptanceCheck(repos, new Date('2026-06-30T09:00:00Z'));
  expect(repos.profiles.byStatus('accepted')).toHaveLength(2);
  expect(repos.profiles.byStatus('sent')).toHaveLength(1);   // qa-carol still pending
  expect(repos.profiles.byStatus('expired')).toHaveLength(0); // never false-expired

  // 5. Metrics API reflects the funnel.
  const metricsRes = await app.inject({ method: 'GET', url: '/api/metrics' });
  const metrics = JSON.parse(metricsRes.body);
  expect(metrics).toHaveLength(1);
  expect(metrics[0]).toMatchObject({
    cohort_name: 'QA',
    sent: 3, // attempted = accepted + pending + expired
    accepted: 2,
    pending: 1,
    expired: 0,
  });
  expect(metrics[0].acceptance_rate).toBeCloseTo(2 / 3);

  // 6. Status API reflects the same counts and weekly usage.
  const statusRes = await app.inject({ method: 'GET', url: '/api/status' });
  const status = JSON.parse(statusRes.body);
  expect(status.counts.accepted).toBe(2);
  expect(status.counts.sent).toBe(1);       // qa-carol pending
  expect(status.counts.expired ?? 0).toBe(0);
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
  resortSchedule(repos, planNow, () => 0);
  await runSenderOnce(repos, driver, new Date(planNow.getTime() + 2 * 60_000), { sleep: async () => {} });

  const dave = driver.sentLog.find((s) => s.url === 'https://www.linkedin.com/in/qa-dave');
  expect(dave?.message).toBe('Loved your talk, Test!'); // custom msg used, {firstName}->live name
});

test('message campaign: list -> schedule -> send -> reply -> metrics/status', async () => {
  // The message funnel end to end, mirroring the invite happy path above. The real
  // browser path is verified separately against a consented profile
  // (scripts/verify-message-send.ts); this pins the WIRING deterministically.
  const text = [
    'https://linkedin.com/in/msg-erin',
    'https://linkedin.com/in/msg-frank',
  ].join('\n');
  const addRes = await app.inject({
    method: 'POST',
    url: '/api/lists',
    payload: { cohort: 'Connected', kind: 'message', text, message_template: 'Hey {firstName}, quick one —' },
  });
  expect(addRes.statusCode).toBe(200);
  expect(repos.profiles.all().filter((p) => p.kind === 'message')).toHaveLength(2);
  // A message campaign must never leak into the invite funnel.
  expect(repos.profiles.all().filter((p) => p.kind === 'invite')).toHaveLength(0);

  const planNow = new Date('2026-06-29T09:00:00'); // Monday, local
  resortSchedule(repos, planNow, () => 0);
  expect(repos.profiles.byStatusKind('scheduled', 'message')).toHaveLength(2);

  await runSenderOnce(repos, driver, new Date(planNow.getTime() + 2 * 60_000), { sleep: async () => {} });
  expect(driver.msgLog).toHaveLength(2);
  expect(driver.sentLog).toHaveLength(0); // no connection requests were sent
  expect(driver.msgLog.every((m) => m.message === 'Hey Test, quick one —')).toBe(true);
  const sent = repos.profiles.byStatusKind('sent', 'message');
  expect(sent).toHaveLength(2);
  expect(sent.every((p) => p.full_name === 'Test Person')).toBe(true);

  // Erin answered; Frank's last message is still ours, so he stays pending.
  driver.inboxRows = [
    { name: 'Test Person', snippet: 'Test: sounds good!', youSentLast: false },
  ];
  // Both pending contacts share the FakeDriver's display name, so this is deliberately
  // ambiguous: the checker must refuse to guess rather than credit the wrong contact.
  const ambiguous = await app.inject({ method: 'POST', url: '/api/recheck-replies' });
  expect(JSON.parse(ambiguous.body).replied).toBe(0);
  expect(repos.profiles.byStatusKind('sent', 'message')).toHaveLength(2);

  // Disambiguate by giving Erin a distinct captured name, then re-check.
  const erin = sent.find((p) => p.profile_url.endsWith('msg-erin'))!;
  repos.profiles.setStatus(erin.id, 'sent', { full_name: 'Erin Example' });
  driver.inboxRows = [{ name: 'Erin Example', snippet: 'Erin: sounds good!', youSentLast: false }];
  const replyRes = await app.inject({ method: 'POST', url: '/api/recheck-replies' });
  expect(JSON.parse(replyRes.body).replied).toBe(1);
  expect(repos.profiles.findById(erin.id)!.status).toBe('replied');

  const status = JSON.parse((await app.inject({ method: 'GET', url: '/api/status' })).body);
  expect(status.msg_counts.replied).toBe(1);
  expect(status.msg_counts.sent).toBe(1);       // Frank still pending
  expect(status.counts.replied ?? 0).toBe(0);   // invite funnel untouched
  expect(status.msg_weekly_sent).toBe(2);
  expect(status.weekly_sent).toBe(0);
  expect(status.replies_checked_at).not.toBeNull();

  const metrics = JSON.parse((await app.inject({ method: 'GET', url: '/api/metrics' })).body);
  const m = metrics.find((r: { cohort_name: string }) => r.cohort_name === 'Connected');
  expect(m.kind).toBe('message');
  expect(m.replied).toBe(1);
  expect(m.reply_rate).toBeCloseTo(0.5);
});
