import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Repos } from '../db/repositories.js';
import type { BrowserDriver } from '../types.js';
import { normalizeProfileUrl, extractProfileUrls } from '../core/url.js';
import { computeCohortMetrics, type MetricRow } from '../core/metrics.js';
import { estimateQueueCompletion, nextBatchForecast, orderUpcoming } from '../core/forecast.js';
import { windowStartIso, remainingCapacity } from '../core/rate-limit.js';
import { dailyRemainingFor } from '../core/daily-budget.js';
import { Mutex } from '../core/mutex.js';
import { runSenderOnce } from '../worker/sender.js';
import { defaultCohortName } from '../core/cohort-name.js';
import { deriveAllowNoNote } from '../core/message.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ALLOWED_SETTINGS_KEYS = new Set([
  'workday_start_hour', 'workday_end_hour', 'weekdays_only', 'weekly_cap',
  'batch_size', 'batches_per_day', 'acceptance_checks_per_day', 'account_type',
  'note_quota_exhausted', 'min_delay_ms', 'max_delay_ms', 'paused', 'pause_reason',
  'onboarded',
]);

export function buildServer(repos: Repos, driver: BrowserDriver, browserLock: Mutex = new Mutex()): FastifyInstance {
  const app = Fastify({ logger: false });

  app.setErrorHandler((err, _req, reply) => {
    const e = err as any;
    const status = e.statusCode && e.statusCode < 500 ? e.statusCode : 400;
    reply.code(status).send({ error: e.message });
  });

  app.register(fastifyStatic, { root: join(__dirname, '..', 'web'), prefix: '/' });

  app.post('/api/profiles', async (req, reply) => {
    const { url, cohort, message } = req.body as { url: string; cohort?: string; message?: string };
    const normalized = normalizeProfileUrl(url ?? '');
    if (!normalized) return reply.code(400).send({ error: 'invalid linkedin profile url' });
    const cohortName = (cohort && cohort.trim()) || defaultCohortName(new Date());
    const c = repos.cohorts.getOrCreate(cohortName, null, true);
    const p = repos.profiles.add(c.id, normalized, message ?? null);
    return { id: p.id, profile_url: p.profile_url };
  });

  app.post('/api/lists', async (req) => {
    const { cohort, text, message_template } =
      req.body as { cohort?: string; text: string; message_template?: string };
    const cohortName = (cohort && cohort.trim()) || defaultCohortName(new Date());
    const allowNoNote = deriveAllowNoNote(message_template);
    const c = repos.cohorts.getOrCreate(cohortName, message_template ?? null, allowNoNote);
    repos.db.prepare('UPDATE cohorts SET message_template = ?, allow_no_note = ? WHERE id = ?')
      .run(message_template ?? c.message_template, allowNoNote ? 1 : 0, c.id);
    const urls = extractProfileUrls(text ?? '');
    const before = repos.profiles.countAll();
    for (const u of urls) repos.profiles.add(c.id, u, null);
    const added = repos.profiles.countAll() - before;
    return { added, found: urls.length };
  });

  app.get('/api/status', async () => {
    const counts: Record<string, number> = {};
    for (const p of repos.profiles.all()) counts[p.status] = (counts[p.status] ?? 0) + 1;
    const s = repos.settings.get();
    const a = repos.appState.get();
    const now = new Date();
    const queueRemaining = (counts.queued ?? 0) + (counts.scheduled ?? 0);
    const scheduledRows = repos.profiles.byStatus('scheduled');
    const weekly_sent = repos.events.countSentSince(windowStartIso(now));
    const weeklyRemaining = remainingCapacity(s.weekly_cap, weekly_sent);
    return {
      paused: s.paused,
      pause_reason: s.pause_reason,
      weekly_sent,
      weekly_cap: s.weekly_cap,
      counts,
      loggedIn: a.login_logged_in === 1,
      login_as_of: a.login_confirmed_at,
      acceptance_checked_at: a.acceptance_checked_at,
      forecast: {
        queue_remaining: queueRemaining,
        eta: estimateQueueCompletion(queueRemaining, s, now),
        next_batch: nextBatchForecast(scheduledRows, {
          backlog: queueRemaining,
          weeklyRemaining,
          dailyRemaining: dailyRemainingFor(repos, s, now),
          guardrailTripped: a.guardrail_tripped === 1,
          paused: s.paused === 1,
          settings: s,
        }, now),
      },
      guardrail: {
        tripped: a.guardrail_tripped,
        reason: a.guardrail_reason,
        detail: a.guardrail_detail,
        trippedAt: a.guardrail_tripped_at,
      },
    };
  });

  app.get('/api/cohorts', async () => repos.cohorts.list());

  app.post('/api/cohorts', async (req) => {
    const { name, message_template } = req.body as { name: string; message_template?: string };
    const allowNoNote = deriveAllowNoNote(message_template);
    const c = repos.cohorts.getOrCreate(name, message_template ?? null, allowNoNote);
    repos.db.prepare('UPDATE cohorts SET message_template = ?, allow_no_note = ? WHERE id = ?')
      .run(message_template ?? null, allowNoNote ? 1 : 0, c.id);
    return repos.cohorts.findById(c.id);
  });

  app.get('/api/metrics', async () => {
    const rows = repos.db.prepare(`
      SELECT p.cohort_id, c.name AS cohort_name, p.status, p.sent_at, p.accepted_at
      FROM profiles p JOIN cohorts c ON c.id = p.cohort_id
    `).all() as unknown as MetricRow[];
    return computeCohortMetrics(rows);
  });

  app.get('/api/profiles', async (): Promise<unknown[]> =>
    repos.db.prepare(`
      SELECT p.id, p.profile_url, p.status, p.scheduled_for, p.sent_at, p.accepted_at,
             p.last_error, c.name AS cohort_name
      FROM profiles p JOIN cohorts c ON c.id = p.cohort_id
      ORDER BY p.id DESC LIMIT 500
    `).all());

  app.get('/api/queue', async (req) => {
    const limitRaw = Number((req.query as { limit?: string }).limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 10;
    const rows = repos.db.prepare(`
      SELECT p.id, p.profile_url, p.status, p.scheduled_for, c.name AS cohort_name
      FROM profiles p JOIN cohorts c ON c.id = p.cohort_id
      WHERE p.status IN ('queued','scheduled')
    `).all() as unknown as { id: number; profile_url: string; status: string; scheduled_for: string | null; cohort_name: string }[];
    const ordered = orderUpcoming(rows);
    return { upcoming: ordered.slice(0, limit), total_remaining: ordered.length };
  });

  app.get('/api/settings', async () => repos.settings.get());
  app.post('/api/settings', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const k of Object.keys(body)) {
      if (ALLOWED_SETTINGS_KEYS.has(k)) patch[k] = body[k];
    }
    repos.settings.update(patch as any);
    return repos.settings.get();
  });

  app.post('/api/pause', async () => { repos.settings.update({ paused: 1, pause_reason: 'Manual pause' }); return { ok: true }; });
  app.post('/api/resume', async () => { repos.settings.update({ paused: 0, pause_reason: null }); return { ok: true }; });

  // Manual trigger: promote up to batch_size queued profiles to due-now and run one
  // sender batch immediately. Respects pause/login/guardrail (runSenderOnce returns early).
  // Guarded by the shared browser lock so it can't drive the page while the periodic
  // sender or the acceptance reader is already running. Useful for sending on demand.
  app.post('/api/run-now', async () => {
    const now = new Date();
    const dueIso = new Date(now.getTime() - 1000).toISOString();
    const batch = repos.settings.get().batch_size;
    // Make the next batch due immediately, pulling from queued first, then already-
    // scheduled (future) profiles, so "Run now" always sends something if work exists.
    const candidates = [...repos.profiles.byStatus('queued'), ...repos.profiles.byStatus('scheduled')].slice(0, batch);
    for (const p of candidates) repos.profiles.setScheduled(p.id, dueIso);
    await browserLock.tryRun(() => runSenderOnce(repos, driver, now));
    return { ok: true, promoted: candidates.length };
  });

  // Reset failed / needs-attention profiles back to queued so they get retried.
  app.post('/api/retry', async () => {
    const targets = [...repos.profiles.byStatus('failed'), ...repos.profiles.byStatus('needs_attention')];
    for (const p of targets) repos.profiles.setStatus(p.id, 'queued', { scheduled_for: null, last_error: null });
    return { ok: true, retried: targets.length };
  });

  // Problem profiles for the Attention tab: failed + needs_attention with their errors.
  app.get('/api/attention', async () =>
    repos.db.prepare(`
      SELECT p.id, p.profile_url, p.status, p.last_error, p.attempts,
             p.sent_at, p.scheduled_for, c.name AS cohort_name
      FROM profiles p JOIN cohorts c ON c.id = p.cohort_id
      WHERE p.status IN ('failed','needs_attention')
      ORDER BY p.id DESC
    `).all());

  app.post('/api/profiles/:id/retry', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!repos.profiles.findById(id)) return reply.code(404).send({ error: 'profile not found' });
    repos.profiles.setStatus(id, 'queued', { scheduled_for: null, last_error: null });
    return { ok: true };
  });

  app.post('/api/profiles/:id/dismiss', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!repos.profiles.findById(id)) return reply.code(404).send({ error: 'profile not found' });
    repos.profiles.setStatus(id, 'skipped', { last_error: null });
    return { ok: true };
  });

  // Opening the login window navigates the shared browser page, so it must queue behind
  // any in-flight sender/acceptance batch (login must not be silently dropped → run, not tryRun).
  app.post('/api/login', async () => { void browserLock.run(() => driver.openLoginWindow()); return { ok: true }; });
  app.get('/api/login-status', async () => {
    const a = repos.appState.get();
    return { loggedIn: a.login_logged_in === 1, asOf: a.login_confirmed_at };
  });

  // Re-verify the live session before clearing a tripped guardrail; only resume if the
  // session is back AND the current page isn't a checkpoint.
  app.post('/api/guardrail/acknowledge', async () => {
    const now = new Date();
    const snap = await driver.readLoginState();
    repos.appState.setLogin(snap, now.toISOString());
    const checkpoint = await driver.checkpointPresent();
    if (snap.loggedIn && !checkpoint) {
      repos.appState.clearGuardrail();
      repos.appState.resetFailureStreak();
      return { ok: true, resumed: true };
    }
    const reason = !snap.loggedIn ? 'login_lost' : 'checkpoint';
    const detail = !snap.loggedIn ? 'Still not logged in' : 'Checkpoint still present';
    repos.appState.trip(reason, detail, now.toISOString());
    return { ok: true, resumed: false, reason };
  });

  return app;
}
