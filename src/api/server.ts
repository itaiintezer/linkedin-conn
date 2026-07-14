import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { INCIDENTS_DIR } from '../config.js';
import { listIncidents } from '../browser/evidence.js';
import type { Repos } from '../db/repositories.js';
import type { BrowserDriver } from '../types.js';
import { normalizeProfileUrl, extractProfileUrls } from '../core/url.js';
import { computeCohortMetrics, type MetricRow } from '../core/metrics.js';
import { estimateQueueCompletion, nextBatchForecast, orderUpcoming } from '../core/forecast.js';
import { windowStartIso, remainingCapacity } from '../core/rate-limit.js';
import { dailyRemainingFor } from '../core/daily-budget.js';
import { Mutex } from '../core/mutex.js';
import { runSenderOnce } from '../worker/sender.js';
import { runAcceptanceCheck } from '../worker/acceptance-checker.js';
import { planAndAssignToday } from '../worker/scheduler-service.js';
import { defaultCohortName } from '../core/cohort-name.js';
import { deriveAllowNoNote } from '../core/message.js';
import type { Logger } from '../core/logger.js';
import { log as defaultLog } from '../core/log.js';
import { listDocs, readDoc } from '../core/docs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ALLOWED_SETTINGS_KEYS = new Set([
  'workday_start_hour', 'workday_end_hour', 'weekdays_only', 'weekly_cap',
  'batch_size', 'batches_per_day', 'acceptance_checks_per_day', 'account_type',
  'note_quota_exhausted', 'min_delay_ms', 'max_delay_ms', 'paused', 'pause_reason',
  'onboarded', 'expiry_days',
]);

export function buildServer(
  repos: Repos, driver: BrowserDriver, browserLock: Mutex = new Mutex(), logger: Logger = defaultLog,
  opts: { incidentsDir?: string } = {},
): FastifyInstance {
  const app = Fastify({ logger: false });
  const incidentsDir = opts.incidentsDir ?? INCIDENTS_DIR;
  mkdirSync(incidentsDir, { recursive: true }); // @fastify/static requires the root to exist

  app.setErrorHandler((err, _req, reply) => {
    const e = err as any;
    const status = e.statusCode && e.statusCode < 500 ? e.statusCode : 400;
    reply.code(status).send({ error: e.message });
  });

  app.register(fastifyStatic, { root: join(__dirname, '..', 'web'), prefix: '/' });
  // Halt/failure evidence (screenshots, page HTML) captured by the sender.
  app.register(fastifyStatic, { root: incidentsDir, prefix: '/incidents/', decorateReply: false });

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
      // Profiles the sender is driving through the browser right now ("Now processing").
      sending: repos.profiles.byStatus('sending').map((p) => ({ id: p.id, profile_url: p.profile_url })),
    };
  });

  app.get('/api/cohorts', async () => repos.cohorts.list());
  app.get('/api/cohorts/archived', async () => repos.cohorts.listArchived());

  // Archiving hides the cohort (metrics, dropdowns) and stops its remaining queue;
  // history stays in the DB and unarchive restores it.
  app.post('/api/cohorts/:id/archive', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!repos.cohorts.findById(id)) return reply.code(404).send({ error: 'cohort not found' });
    repos.cohorts.setArchived(id, true);
    repos.profiles.skipCohortQueue(id);
    defaultLog.info('api', 'cohort archived', { cohort: id });
    return { ok: true };
  });

  app.post('/api/cohorts/:id/unarchive', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!repos.cohorts.findById(id)) return reply.code(404).send({ error: 'cohort not found' });
    repos.cohorts.setArchived(id, false);
    return { ok: true };
  });

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
      WHERE c.archived = 0
    `).all() as unknown as MetricRow[];
    return computeCohortMetrics(rows);
  });

  app.get('/api/profiles', async (req): Promise<unknown[]> => {
    const status = (req.query as { status?: string }).status;
    const where = status ? 'WHERE p.status = ?' : '';
    const stmt = repos.db.prepare(`
      SELECT p.id, p.profile_url, p.status, p.skip_reason, p.scheduled_for, p.sent_at, p.accepted_at,
             p.last_error, c.name AS cohort_name
      FROM profiles p JOIN cohorts c ON c.id = p.cohort_id
      ${where}
      ORDER BY p.id DESC LIMIT 500
    `);
    return (status ? stmt.all(status) : stmt.all()) as unknown[];
  });

  app.get('/api/queue', async (req) => {
    const limitRaw = Number((req.query as { limit?: string }).limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 10;
    const rows = repos.db.prepare(`
      SELECT p.id, p.profile_url, p.status, p.scheduled_for, p.priority, c.name AS cohort_name,
             COALESCE(NULLIF(p.custom_message, ''), NULLIF(c.message_template, '')) AS note
      FROM profiles p JOIN cohorts c ON c.id = p.cohort_id
      WHERE p.status IN ('queued','scheduled')
    `).all() as unknown as { id: number; profile_url: string; status: string; scheduled_for: string | null; cohort_name: string; note: string | null }[];
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

  app.post('/api/pause', async () => { defaultLog.info('api', 'pause'); repos.settings.update({ paused: 1, pause_reason: 'Manual pause' }); return { ok: true }; });
  app.post('/api/resume', async () => {
    defaultLog.info('api', 'resume');
    repos.settings.update({ paused: 0, pause_reason: null });
    // Slots that went stale during the pause were re-queued by the tick; re-plan now
    // so sending resumes without waiting for the hourly scheduler.
    planAndAssignToday(repos, new Date());
    return { ok: true };
  });

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
    defaultLog.info('api', 'run-now', { promoted: candidates.length });
    for (const p of candidates) repos.profiles.setScheduled(p.id, dueIso);
    // force: a manual trigger may run outside working hours by design.
    await browserLock.tryRun(() => runSenderOnce(repos, driver, now, { force: true, clock: () => new Date() }));
    return { ok: true, promoted: candidates.length };
  });

  // Manual, on-demand acceptance reconciliation. Read-only against LinkedIn, so it runs
  // even while paused (force: true) — but still respects the guardrail, login, and
  // empty-read fail-safes inside runAcceptanceCheck. Uses run (not tryRun) so it queues
  // behind any in-flight sender/acceptance batch rather than being silently dropped.
  app.post('/api/recheck-acceptance', async () => {
    defaultLog.info('api', 'recheck-acceptance');
    return browserLock.run(() => runAcceptanceCheck(repos, driver, new Date(), { force: true }));
  });

  // Reset failed / needs-attention profiles back to queued so they get retried.
  app.post('/api/retry', async () => {
    const targets = [...repos.profiles.byStatus('failed'), ...repos.profiles.byStatus('needs_attention')];
    defaultLog.info('api', 'retry', { count: targets.length });
    for (const p of targets) repos.profiles.setStatus(p.id, 'queued', { scheduled_for: null, last_error: null, skip_reason: null });
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
    repos.profiles.setStatus(id, 'queued', { scheduled_for: null, last_error: null, skip_reason: null });
    return { ok: true };
  });

  app.post('/api/profiles/:id/dismiss', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!repos.profiles.findById(id)) return reply.code(404).send({ error: 'profile not found' });
    repos.profiles.setStatus(id, 'skipped', { last_error: null, skip_reason: 'dismissed' });
    return { ok: true };
  });

  // Opening the login window navigates the shared browser page, so it must queue behind
  // any in-flight sender/acceptance batch (login must not be silently dropped → run, not tryRun).
  app.post('/api/login', async () => { defaultLog.info('api', 'open login window'); void browserLock.run(() => driver.openLoginWindow()); return { ok: true }; });
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
    const scan = await driver.checkpointScan();
    defaultLog.info('api', 'guardrail acknowledge', {
      resumed: snap.loggedIn && !scan.hit, url: scan.url, matched: scan.matched ?? '',
    });
    if (snap.loggedIn && !scan.hit) {
      repos.appState.clearGuardrail();
      repos.appState.resetFailureStreak();
      planAndAssignToday(repos, now); // resume scheduling immediately, not at the next hourly tick
      return { ok: true, resumed: true };
    }
    const reason = !snap.loggedIn ? 'login_lost' : 'checkpoint';
    const detail = !snap.loggedIn
      ? 'Still not logged in'
      : `Checkpoint still present at ${scan.url}${scan.matched ? ` (matched "${scan.matched}")` : ''}`;
    repos.appState.trip(reason, detail, now.toISOString());
    return { ok: true, resumed: false, reason, detail };
  });

  // Halt/failure evidence captured by the sender (meta only; files under /incidents/).
  app.get('/api/incidents', async (req) => {
    const limitRaw = Number((req.query as { limit?: string }).limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 100) : 20;
    return listIncidents(incidentsDir, limit).map((m) => ({
      ...m,
      screenshot: m.screenshot ? `/incidents/${m.screenshot}` : null,
      html: m.html ? `/incidents/${m.html}` : null,
    }));
  });

  app.get('/api/logs', async (req) => {
    const tailRaw = Number((req.query as { tail?: string }).tail);
    const tail = Number.isFinite(tailRaw) && tailRaw > 0 ? Math.min(Math.floor(tailRaw), 5000) : 500;
    return { lines: logger.tail(tail) };
  });

  app.get('/api/logs/download', async (_req, reply) => {
    const body = existsSync(logger.path) ? readFileSync(logger.path, 'utf8') : '';
    reply.header('Content-Type', 'text/plain; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="relay.log"');
    return body;
  });

  app.get('/api/docs', async () => listDocs());
  app.get('/api/docs/:slug', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const doc = readDoc(slug);
    if (!doc) return reply.code(404).send({ error: 'doc not found' });
    return doc;
  });

  app.get('/api/queue/grouped', async () => {
    const rows = repos.db.prepare(`
      SELECT p.id, p.profile_url, p.status, p.scheduled_for, p.priority, p.cohort_id,
             c.name AS cohort_name,
             COALESCE(NULLIF(p.custom_message, ''), NULLIF(c.message_template, '')) AS note
      FROM profiles p JOIN cohorts c ON c.id = p.cohort_id
      WHERE p.status IN ('queued','scheduled')
    `).all() as unknown as {
      id: number; profile_url: string; status: string; scheduled_for: string | null;
      priority: number; cohort_id: number; cohort_name: string; note: string | null;
    }[];

    const groups = new Map<number, { id: number; name: string; count: number; minPriority: number; profiles: typeof rows }>();
    for (const r of rows) {
      let g = groups.get(r.cohort_id);
      if (!g) { g = { id: r.cohort_id, name: r.cohort_name, count: 0, minPriority: Infinity, profiles: [] }; groups.set(r.cohort_id, g); }
      g.count++;
      if (r.status === 'queued') g.minPriority = Math.min(g.minPriority, r.priority);
      g.profiles.push(r);
    }
    const cohorts = [...groups.values()]
      .sort((a, b) => a.minPriority - b.minPriority || a.id - b.id)
      .map((g) => ({
        id: g.id, name: g.name, count: g.count,
        profiles: orderUpcoming(g.profiles).map((p) => ({
          id: p.id, profile_url: p.profile_url, status: p.status, scheduled_for: p.scheduled_for, note: p.note,
        })),
      }));
    return { cohorts };
  });

  app.post('/api/queue/profile/:id/move', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const { to } = (req.body ?? {}) as { to?: 'top' | 'bottom' };
    if (!repos.profiles.findById(id)) return reply.code(404).send({ error: 'profile not found' });
    repos.profiles.moveProfile(id, to === 'bottom' ? 'bottom' : 'top');
    return { ok: true };
  });

  app.post('/api/queue/profile/:id/remove', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!repos.profiles.findById(id)) return reply.code(404).send({ error: 'profile not found' });
    repos.profiles.setStatus(id, 'skipped', { last_error: null, skip_reason: 'dismissed' });
    return { ok: true };
  });

  app.post('/api/queue/cohort/:id/move', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const { to } = (req.body ?? {}) as { to?: 'top' | 'bottom' };
    if (!repos.cohorts.findById(id)) return reply.code(404).send({ error: 'cohort not found' });
    repos.profiles.prioritizeCohort(id, to === 'bottom' ? 'bottom' : 'top');
    return { ok: true };
  });

  app.post('/api/queue/cohort/:id/remove', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!repos.cohorts.findById(id)) return reply.code(404).send({ error: 'cohort not found' });
    repos.profiles.skipCohortQueue(id);
    return { ok: true };
  });

  app.post('/api/queue/cohorts/reorder', async (req) => {
    const { order } = (req.body ?? {}) as { order?: number[] };
    repos.profiles.reorderCohorts(Array.isArray(order) ? order.map(Number) : []);
    return { ok: true };
  });

  return app;
}
