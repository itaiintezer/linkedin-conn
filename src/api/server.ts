import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Repos } from '../db/repositories.js';
import type { BrowserDriver } from '../types.js';
import { normalizeProfileUrl, extractProfileUrls } from '../core/url.js';
import { computeCohortMetrics, type MetricRow } from '../core/metrics.js';
import { windowStartIso } from '../core/rate-limit.js';
import { runSenderOnce } from '../worker/sender.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ALLOWED_SETTINGS_KEYS = new Set([
  'workday_start_hour', 'workday_end_hour', 'weekdays_only', 'weekly_cap',
  'batch_size', 'batches_per_day', 'acceptance_checks_per_day', 'account_type',
  'note_quota_exhausted', 'min_delay_ms', 'max_delay_ms', 'paused', 'pause_reason',
]);

export function buildServer(repos: Repos, driver: BrowserDriver): FastifyInstance {
  const app = Fastify({ logger: false });

  app.setErrorHandler((err, _req, reply) => {
    const e = err as any;
    const status = e.statusCode && e.statusCode < 500 ? e.statusCode : 400;
    reply.code(status).send({ error: e.message });
  });

  app.register(fastifyStatic, { root: join(__dirname, '..', 'web'), prefix: '/' });

  app.post('/api/profiles', async (req, reply) => {
    const { url, cohort, message } = req.body as { url: string; cohort: string; message?: string };
    const normalized = normalizeProfileUrl(url ?? '');
    if (!normalized) return reply.code(400).send({ error: 'invalid linkedin profile url' });
    const c = repos.cohorts.getOrCreate(cohort, null, false);
    const p = repos.profiles.add(c.id, normalized, message ?? null);
    return { id: p.id, profile_url: p.profile_url };
  });

  app.post('/api/lists', async (req) => {
    const { cohort, text, message_template, allow_no_note } =
      req.body as { cohort: string; text: string; message_template?: string; allow_no_note?: boolean };
    const c = repos.cohorts.getOrCreate(cohort, message_template ?? null, !!allow_no_note);
    if (message_template !== undefined || allow_no_note !== undefined) {
      repos.db.prepare('UPDATE cohorts SET message_template = ?, allow_no_note = ? WHERE id = ?')
        .run(message_template ?? c.message_template, allow_no_note ? 1 : c.allow_no_note, c.id);
    }
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
    return {
      paused: s.paused,
      pause_reason: s.pause_reason,
      weekly_sent: repos.events.countSentSince(windowStartIso(new Date())),
      weekly_cap: s.weekly_cap,
      counts,
    };
  });

  app.get('/api/cohorts', async () => repos.cohorts.list());

  app.post('/api/cohorts', async (req) => {
    const { name, message_template, allow_no_note } =
      req.body as { name: string; message_template?: string; allow_no_note?: boolean };
    const c = repos.cohorts.getOrCreate(name, message_template ?? null, !!allow_no_note);
    repos.db.prepare('UPDATE cohorts SET message_template = ?, allow_no_note = ? WHERE id = ?')
      .run(message_template ?? null, allow_no_note ? 1 : 0, c.id);
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
  // sender batch immediately. Respects pause/login (runSenderOnce returns early if paused
  // or not logged in). Useful for testing and for sending on demand.
  app.post('/api/run-now', async () => {
    const now = new Date();
    const dueIso = new Date(now.getTime() - 1000).toISOString();
    const batch = repos.settings.get().batch_size;
    // Make the next batch due immediately, pulling from queued first, then already-
    // scheduled (future) profiles, so "Run now" always sends something if work exists.
    const candidates = [...repos.profiles.byStatus('queued'), ...repos.profiles.byStatus('scheduled')].slice(0, batch);
    for (const p of candidates) repos.profiles.setScheduled(p.id, dueIso);
    await runSenderOnce(repos, driver, now);
    return { ok: true, promoted: candidates.length };
  });

  // Reset failed / needs-attention profiles back to queued so they get retried.
  app.post('/api/retry', async () => {
    const targets = [...repos.profiles.byStatus('failed'), ...repos.profiles.byStatus('needs_attention')];
    for (const p of targets) repos.profiles.setStatus(p.id, 'queued', { scheduled_for: null, last_error: null });
    return { ok: true, retried: targets.length };
  });

  app.post('/api/login', async () => { void driver.openLoginWindow(); return { ok: true }; });
  app.get('/api/login-status', async () => ({ loggedIn: await driver.isLoggedIn() }));

  return app;
}
