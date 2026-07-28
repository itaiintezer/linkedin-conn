import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { INCIDENTS_DIR } from '../config.js';
import { listIncidents } from '../browser/evidence.js';
import type { Repos } from '../db/repositories.js';
import type { BrowserDriver, CampaignKind } from '../types.js';
import { normalizeProfileUrl, extractProfileUrls } from '../core/url.js';
import { computeCohortMetrics, type MetricRow } from '../core/metrics.js';
import { estimateQueueCompletion, nextBatchForecast, orderUpcoming } from '../core/forecast.js';
import { windowStartIso, remainingCapacity } from '../core/rate-limit.js';
import { dailyRemainingFor } from '../core/daily-budget.js';
import { Mutex } from '../core/mutex.js';
import { runSenderOnce, type SenderOptions } from '../worker/sender.js';
import { runAcceptanceCheck } from '../worker/acceptance-checker.js';
import { runReplyCheck } from '../worker/reply-checker.js';
import { planAndAssignToday } from '../worker/scheduler-service.js';
import { defaultCohortName } from '../core/cohort-name.js';
import { deriveAllowNoNote, MAX_NOTE, MAX_MESSAGE } from '../core/message.js';
import { capsFor } from '../core/caps.js';
import type { Logger } from '../core/logger.js';
import { log as defaultLog } from '../core/log.js';
import { listDocs, readDoc } from '../core/docs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ALLOWED_SETTINGS_KEYS = new Set([
  'workday_start_hour', 'workday_end_hour', 'weekdays_only', 'weekly_cap',
  'batch_size', 'batches_per_day', 'acceptance_checks_per_day',
  'note_quota_exhausted', 'min_delay_ms', 'max_delay_ms', 'paused', 'pause_reason',
  'onboarded', 'expiry_days',
  'msg_weekly_cap', 'msg_batch_size', 'msg_batches_per_day', 'reply_checks_per_day',
]);

export function buildServer(
  repos: Repos, driver: BrowserDriver, browserLock: Mutex = new Mutex(), logger: Logger = defaultLog,
  opts: { incidentsDir?: string; senderOptions?: Pick<SenderOptions, 'sleep' | 'rng'> } = {},
): FastifyInstance {
  const app = Fastify({ logger: false });
  const incidentsDir = opts.incidentsDir ?? INCIDENTS_DIR;
  // Forwarded into every /api/run-now sender call — production leaves this empty so
  // runSenderOnce falls back to the real timer-based sleep; tests inject a no-op so a
  // multi-profile run-now batch never performs a real 20-90s wait, regardless of batch size.
  const senderOptions = opts.senderOptions ?? {};
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

  app.post('/api/lists', async (req, reply) => {
    const { cohort, text, message_template, kind: kindRaw } =
      req.body as { cohort?: string; text: string; message_template?: string; kind?: string };
    const kind: CampaignKind = kindRaw === 'message' ? 'message' : 'invite';
    const template = message_template?.trim() || undefined;
    // A message campaign has nothing to send without a body: an invite can go note-less,
    // a DM cannot.
    if (kind === 'message' && !template) {
      return reply.code(400).send({ error: 'message campaigns require a message template' });
    }
    const max = kind === 'message' ? MAX_MESSAGE : MAX_NOTE;
    if (template && template.length > max) {
      return reply.code(400).send({ error: `template too long (max ${max} characters)` });
    }
    const cohortName = (cohort && cohort.trim()) || defaultCohortName(new Date());
    const allowNoNote = deriveAllowNoNote(template);
    // A cohort's kind is fixed at creation: the schedulers, caps, and metrics all read it,
    // so silently mixing kinds inside one cohort would mis-pace both engines.
    const existing = repos.cohorts.findByName(cohortName);
    if (existing && existing.kind !== kind) {
      return reply.code(409).send({ error: `cohort "${cohortName}" is a ${existing.kind} cohort` });
    }
    const c = repos.cohorts.getOrCreate(cohortName, template ?? null, allowNoNote, kind);
    repos.db.prepare('UPDATE cohorts SET message_template = ?, allow_no_note = ? WHERE id = ?')
      .run(template ?? c.message_template, allowNoNote ? 1 : 0, c.id);
    const urls = extractProfileUrls(text ?? '');
    const before = repos.profiles.countAll();
    for (const u of urls) repos.profiles.add(c.id, u, null, kind);
    const added = repos.profiles.countAll() - before;
    return { added, found: urls.length };
  });

  app.get('/api/status', async () => {
    // Two conveyors, two count buckets. `counts` stays invite-only so every existing
    // invite-side number (and the forecast built from it) keeps meaning what it did
    // before messages existed; message rows land in msg_counts.
    const counts: Record<string, number> = {};
    const msg_counts: Record<string, number> = {};
    for (const p of repos.profiles.all()) {
      const bucket = p.kind === 'message' ? msg_counts : counts;
      bucket[p.status] = (bucket[p.status] ?? 0) + 1;
    }
    const s = repos.settings.get();
    const a = repos.appState.get();
    const now = new Date();
    const queueRemaining = (counts.queued ?? 0) + (counts.scheduled ?? 0);
    const scheduledRows = repos.profiles.byStatusKind('scheduled', 'invite');
    const weekly_sent = repos.events.countSentSince(windowStartIso(now), 'invite');
    const weeklyRemaining = remainingCapacity(s.weekly_cap, weekly_sent);
    const msgWeeklySent = repos.events.countSentSince(windowStartIso(now), 'message');
    const msgBacklog = (msg_counts.queued ?? 0) + (msg_counts.scheduled ?? 0);
    return {
      paused: s.paused,
      pause_reason: s.pause_reason,
      weekly_sent,
      weekly_cap: s.weekly_cap,
      counts,
      msg_counts,
      msg_weekly_sent: msgWeeklySent,
      msg_weekly_cap: s.msg_weekly_cap,
      loggedIn: a.login_logged_in === 1,
      login_as_of: a.login_confirmed_at,
      acceptance_checked_at: a.acceptance_checked_at,
      replies_checked_at: a.replies_checked_at,
      forecast: {
        queue_remaining: queueRemaining,
        eta: estimateQueueCompletion(queueRemaining, s, now),
        next_batch: nextBatchForecast(scheduledRows, {
          backlog: queueRemaining,
          weeklyRemaining,
          dailyRemaining: dailyRemainingFor(repos, s, now, 'invite'),
          guardrailTripped: a.guardrail_tripped === 1,
          paused: s.paused === 1,
          settings: s,
        }, now),
        // nextBatchForecast reads weekly_cap/batch_size/batches_per_day straight off the
        // settings object, so the message side gets a remapped copy rather than a second
        // forecast implementation.
        msg_next_batch: nextBatchForecast(repos.profiles.byStatusKind('scheduled', 'message'), {
          backlog: msgBacklog,
          weeklyRemaining: remainingCapacity(s.msg_weekly_cap, msgWeeklySent),
          dailyRemaining: dailyRemainingFor(repos, s, now, 'message'),
          guardrailTripped: a.guardrail_tripped === 1,
          paused: s.paused === 1,
          settings: { ...s, weekly_cap: s.msg_weekly_cap, batch_size: s.msg_batch_size, batches_per_day: s.msg_batches_per_day },
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

  app.post('/api/cohorts', async (req, reply) => {
    const { name, message_template, kind: kindRaw } =
      req.body as { name: string; message_template?: string; kind?: string };
    const kind: CampaignKind = kindRaw === 'message' ? 'message' : 'invite';
    // Only a caller that explicitly asked for a kind can be told it conflicts; an
    // existing-cohort edit that omits `kind` must not be rejected by the 'invite' default.
    const existing = repos.cohorts.findByName(name);
    if (existing && existing.kind !== kind && kindRaw !== undefined) {
      return reply.code(409).send({ error: `cohort "${name}" is a ${existing.kind} cohort` });
    }
    // Same template rules as /api/lists — a message cohort with no text would queue
    // profiles the sender can only route to needs_attention, and the UI's client-side
    // guard doesn't protect direct API callers (agents, scripts).
    const effectiveKind = existing && kindRaw === undefined ? existing.kind : kind;
    const template = message_template?.trim() || undefined;
    if (effectiveKind === 'message' && !template) {
      return reply.code(400).send({ error: 'message cohorts require a message template' });
    }
    const max = effectiveKind === 'message' ? MAX_MESSAGE : MAX_NOTE;
    if (template && template.length > max) {
      return reply.code(400).send({ error: `template too long (max ${max} characters)` });
    }
    const allowNoNote = deriveAllowNoNote(template);
    const c = repos.cohorts.getOrCreate(name, template ?? null, allowNoNote, kind);
    repos.db.prepare('UPDATE cohorts SET message_template = ?, allow_no_note = ? WHERE id = ?')
      .run(template ?? null, allowNoNote ? 1 : 0, c.id);
    return repos.cohorts.findById(c.id);
  });

  app.get('/api/metrics', async () => {
    const rows = repos.db.prepare(`
      SELECT p.cohort_id, c.name AS cohort_name, p.kind, p.status, p.sent_at, p.accepted_at, p.replied_at
      FROM profiles p JOIN cohorts c ON c.id = p.cohort_id
      WHERE c.archived = 0
    `).all() as unknown as MetricRow[];
    return computeCohortMetrics(rows);
  });

  app.get('/api/profiles', async (req): Promise<unknown[]> => {
    const { status, kind } = req.query as { status?: string; kind?: string };
    // string[] (not unknown[]): both filters bind text, and node:sqlite's SQLInputValue
    // won't accept unknown.
    const conds: string[] = []; const args: string[] = [];
    if (status) { conds.push('p.status = ?'); args.push(status); }
    if (kind === 'invite' || kind === 'message') { conds.push('p.kind = ?'); args.push(kind); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const stmt = repos.db.prepare(`
      SELECT p.id, p.profile_url, p.kind, p.status, p.skip_reason, p.scheduled_for, p.sent_at,
             p.accepted_at, p.replied_at, p.last_error, c.name AS cohort_name
      FROM profiles p JOIN cohorts c ON c.id = p.cohort_id
      ${where}
      ORDER BY p.id DESC LIMIT 500
    `);
    return stmt.all(...args) as unknown[];
  });

  app.get('/api/queue', async (req) => {
    const limitRaw = Number((req.query as { limit?: string }).limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 10;
    const rows = repos.db.prepare(`
      SELECT p.id, p.profile_url, p.kind, p.status, p.scheduled_for, p.priority, c.name AS cohort_name,
             COALESCE(NULLIF(p.custom_message, ''), NULLIF(c.message_template, '')) AS note
      FROM profiles p JOIN cohorts c ON c.id = p.cohort_id
      WHERE p.status IN ('queued','scheduled')
    `).all() as unknown as { id: number; profile_url: string; kind: string; status: string; scheduled_for: string | null; cohort_name: string; note: string | null }[];
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
    const s = repos.settings.get();
    // Make the next batch due immediately, pulling from queued first, then already-
    // scheduled (future) profiles, so "Run now" always sends something if work exists.
    // Promoted per kind, each against its own batch size, so one conveyor's backlog can't
    // starve the other out of a manual run.
    const promote = (kind: CampaignKind) =>
      [...repos.profiles.queuedByPriorityKind(kind), ...repos.profiles.byStatusKind('scheduled', kind)]
        .slice(0, capsFor(s, kind).batchSize);
    const candidates = [...promote('invite'), ...promote('message')];
    defaultLog.info('api', 'run-now', { promoted: candidates.length });
    for (const p of candidates) repos.profiles.setScheduled(p.id, dueIso);
    // force: a manual trigger may run outside working hours by design.
    // Deliberately NOT skipping the inter-send delay here: this hits the same LinkedIn
    // account through the same automation, so a "Run batch now" that fires several sends
    // back-to-back is exactly the burst pattern min_delay_ms/max_delay_ms exist to prevent.
    // The endpoint already awaits the whole batch today, so a slower manual trigger
    // (safety over responsiveness) is an acceptable trade — no separate "fast" path.
    await browserLock.tryRun(() => runSenderOnce(repos, driver, now, { force: true, clock: () => new Date(), ...senderOptions }));
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

  // Manual, on-demand reply reconciliation. Same contract as recheck-acceptance: read-only
  // against LinkedIn so it runs even while paused (force: true), while still respecting the
  // guardrail, login, and empty-read fail-safes inside runReplyCheck. run (not tryRun) so it
  // queues behind an in-flight batch instead of being silently dropped.
  app.post('/api/recheck-replies', async () => {
    defaultLog.info('api', 'recheck-replies');
    return browserLock.run(() => runReplyCheck(repos, driver, new Date(), { force: true }));
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
    const q = req.query as { limit?: string; since?: string };
    const limitRaw = Number(q.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 100) : 20;
    // since=ISO: only evidence captured at/after the cutoff — lets the halt banner
    // ask for "this trip's" incident instead of whatever happens to be newest.
    const since = q.since ? Date.parse(q.since) : NaN;
    return listIncidents(incidentsDir, limit)
      .filter((m) => !Number.isFinite(since)
        || (typeof m.capturedAt === 'string' && Date.parse(m.capturedAt) >= since))
      .map((m) => ({
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
      SELECT p.id, p.profile_url, p.kind, p.status, p.scheduled_for, p.priority, p.cohort_id,
             c.name AS cohort_name,
             COALESCE(NULLIF(p.custom_message, ''), NULLIF(c.message_template, '')) AS note
      FROM profiles p JOIN cohorts c ON c.id = p.cohort_id
      WHERE p.status IN ('queued','scheduled')
    `).all() as unknown as {
      id: number; profile_url: string; kind: string; status: string; scheduled_for: string | null;
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
          id: p.id, profile_url: p.profile_url, kind: p.kind, status: p.status,
          scheduled_for: p.scheduled_for, note: p.note,
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
