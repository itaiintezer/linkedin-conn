import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { DATA_DIR, INCIDENTS_DIR, ROOT } from '../config.js';
import { isPending, newRequest, readControl, summarizeControl, writeControl } from '../../scripts/control-file.mjs';
import { DRAIN_TIMEOUT_MS, EXIT_RESTART, EXIT_UPDATE, drainBrowserLock } from '../core/lifecycle.js';
import { checkForUpdates } from '../core/update-check.js';
import { listIncidents } from '../browser/evidence.js';
import type { Repos } from '../db/repositories.js';
import type {
  BrowserDriver, CampaignKind, Engagement, EngagementStatus, PostFilter, ProfileStatus, Reaction,
  Settings, TrackReject,
} from '../types.js';
import { isCampaignKind, parseKind } from '../core/campaign-kind.js';
import { parseReaction, DEFAULT_REACTION } from '../core/engagement-action.js';
import {
  normalizeProfileUrl, extractProfileUrls, normalizePostUrl, isShortlink, resolveShortlink,
} from '../core/url.js';
import { computeCohortMetrics, type MetricRow } from '../core/metrics.js';
import { estimateQueueCompletion, nextBatchForecast, orderUpcoming } from '../core/forecast.js';
import { windowStartIso, remainingCapacity, dayStartIso } from '../core/rate-limit.js';
import { dailyRemainingFor } from '../core/daily-budget.js';
import { Mutex } from '../core/mutex.js';
import { runSenderOnce, type SenderOptions } from '../worker/sender.js';
import { runAcceptanceCheck } from '../worker/acceptance-checker.js';
import { runReplyCheck } from '../worker/reply-checker.js';
import { runRosterSync } from '../worker/roster-sync.js';
import { parseRosterInput } from '../core/roster-input.js';
import { HttpApifyClient, COST_PER_PROFILE_USD, type ApifyClient } from '../core/apify-client.js';
import {
  type ApifyPostsClient, HttpApifyPostsClient, COST_PER_POST_USD,
} from '../core/apify-posts-client.js';
import { runPostsSweep, isPostsSweepRunning } from '../worker/posts-sweep.js';
import { isRetryableEngagement } from '../db/posts-repos.js';
import { runEnrichment, enrichmentProgress, isEnrichmentRunning, pauseEnrichment } from '../worker/enrichment.js';
import { extractProfile, isEmptyProfile } from '../core/apify-extract.js';
import { searchConnections } from '../core/connection-search.js';
import { planAndAssignToday } from '../worker/scheduler-service.js';
import {
  addEventInvitees, armEventCampaign, createEventCampaign, ensureEventReservation,
  eventPipelineSummary, nextEventRun,
} from '../worker/event-campaign.js';
import { runEventCampaign } from '../worker/event-runner.js';
import { defaultCohortName } from '../core/cohort-name.js';
import { deriveAllowNoNote, MAX_NOTE, MAX_MESSAGE, MAX_COMMENT } from '../core/message.js';
import { engagementCaps } from '../core/caps.js';
import { SETTING_RULES, validateSettingsPatch } from '../core/settings-rules.js';
import type { Logger } from '../core/logger.js';
import { log as defaultLog } from '../core/log.js';
import { listDocs, readDoc } from '../core/docs.js';
import {
  moveEventWindow, parseBelt, preflight, promote, SENDER_BELTS,
} from '../worker/run-now.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ALLOWED_SETTINGS_KEYS = new Set([
  'workday_start_hour', 'workday_end_hour', 'weekdays_only', 'weekly_cap',
  'batch_size', 'batches_per_day',
  'note_quota_exhausted', 'min_delay_ms', 'max_delay_ms', 'paused', 'pause_reason',
  'onboarded', 'expiry_days',
  'msg_weekly_cap', 'msg_batch_size', 'msg_batches_per_day', 'reply_checks_per_day',
  'roster_sync_per_day',
  'apify_api_key', 'enrich_ttl_days', 'enrich_concurrency',
  'events_per_day', 'event_invite_cap', 'event_bucket_ceiling',
  'event_run_budget_minutes', 'event_shard_threshold',
  'engage_weekly_cap', 'engage_batch_size', 'engage_batches_per_day',
  'engage_comment_daily_cap',
  'posts_sweep_per_day', 'posts_max_per_sweep', 'posts_sweep_batch_size',
  'posts_retention_days', 'tracked_profile_cap',
]);

/**
 * Strip the Apify credential from anything leaving over HTTP, replacing it with a boolean.
 *
 * Applied to EVERY settings read path, not just GET: the POST handler echoes the row back,
 * so sanitizing one and not the other still leaks the key to any local process that can
 * reach the port — and into the browser devtools of whoever is looking at Settings.
 */
/**
 * A maskable stand-in for a stored secret: visible head, masked body, visible last four.
 *
 * The last four are what make a rotation verifiable — "did my new key actually save?" is
 * unanswerable against a row of identical dots, and that is the whole reason Settings shows
 * anything. The head is the vendor prefix, which is constant across every Apify key and so
 * identifies the key TYPE without narrowing the secret.
 *
 * Below 20 characters the head and tail would together be most of the value, so nothing is
 * revealed at all. Never widen this: the raw key must not become derivable from the hint.
 */
function maskSecret(key: string): string {
  if (key.length < 20) return '•'.repeat(12);
  return `${key.slice(0, 10)}${'•'.repeat(12)}${key.slice(-4)}`;
}

function publicSettings(s: Settings): Omit<Settings, 'apify_api_key'>
  & { apify_key_set: boolean; apify_key_hint: string | null } {
  const { apify_api_key, ...rest } = s;
  return {
    ...rest,
    apify_key_set: !!apify_api_key,
    apify_key_hint: apify_api_key ? maskSecret(apify_api_key) : null,
  };
}

export function buildServer(
  repos: Repos, driver: BrowserDriver, browserLock: Mutex = new Mutex(), logger: Logger = defaultLog,
  opts: {
    incidentsDir?: string;
    senderOptions?: Pick<SenderOptions, 'sleep' | 'rng'>;
    /** Injected so tests never reach Apify. Production builds a real HTTP client per run
     *  from the key currently in settings, so a re-keyed operator takes effect immediately. */
    apifyClientFactory?: (token: string) => ApifyClient;
    /** Injected so tests never reach Apify. Production builds a real client per sweep from
     *  the key currently in settings. */
    apifyPostsClientFactory?: (token: string) => ApifyPostsClient;
    /** Injected so tests never reach the network. Used only to expand a lnkd.in shortlink
     *  on the engagement enqueue path; production falls through to globalThis.fetch. */
    fetchImpl?: typeof fetch;
    /** Where control.json lives. Overridden by tests so they never touch the real data dir. */
    dataDir?: string;
    /**
     * How the process ends. Production passes the graceful shutdown from src/index.ts; tests
     * pass a spy, which is the seam that lets /api/update be tested without killing vitest.
     */
    requestExit?: (code: number) => void;
    /** Whether a supervisor is watching. Without one, restart/update must refuse. */
    supervised?: boolean;
    /** Injected so tests never shell out to git or reach the network. */
    updateCheck?: () => Promise<unknown>;
    /** Shortened by tests so a drain assertion does not wait five minutes. */
    drainTimeoutMs?: number;
  } = {},
): FastifyInstance {
  const app = Fastify({ logger: false });
  const incidentsDir = opts.incidentsDir ?? INCIDENTS_DIR;
  const dataDir = opts.dataDir ?? DATA_DIR;
  const supervised = opts.supervised ?? process.env.THEMACHINE_SUPERVISED === '1';
  const requestExit = opts.requestExit ?? ((code: number) => process.exit(code));
  const drainTimeoutMs = opts.drainTimeoutMs ?? DRAIN_TIMEOUT_MS;
  const updateCheck = opts.updateCheck ?? (() => checkForUpdates(ROOT));
  // Forwarded into every /api/run-now sender call — production leaves this empty so
  // runSenderOnce falls back to the real timer-based sleep; tests inject a no-op so a
  // multi-profile run-now batch never performs a real 20-90s wait, regardless of batch size.
  const senderOptions = opts.senderOptions ?? {};
  const postsClientFactory = opts.apifyPostsClientFactory
    ?? ((t: string) => new HttpApifyPostsClient(t));
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
    const { url, cohort, message, kind: kindRaw } =
      req.body as { url: string; cohort?: string; message?: string; kind?: string };
    const normalized = normalizeProfileUrl(url ?? '');
    if (!normalized) return reply.code(400).send({ error: 'invalid linkedin profile url' });
    const parsedKind = parseKind(kindRaw);
    if (!parsedKind.ok) return reply.code(400).send({ error: parsedKind.error });
    const kind: CampaignKind = parsedKind.kind ?? 'invite';
    const cohortName = (cohort && cohort.trim()) || defaultCohortName(new Date());
    // Same fixed-kind rule as /api/lists, and for the same reason: an invite row inside a
    // message cohort would be picked up by the INVITE sender, which resolves its text from
    // the DM template and truncates it to a 300-char connection note. Mis-kinding here
    // sends a mangled DM to a real person, so it must fail loudly rather than default.
    const existing = repos.cohorts.findByName(cohortName);
    if (existing && existing.kind !== kind) {
      return reply.code(409).send({ error: `cohort "${cohortName}" is ${existing.kind === 'invite' ? 'an invite' : 'a message'} cohort` });
    }
    const note = message?.trim() || undefined;
    const max = kind === 'message' ? MAX_MESSAGE : MAX_NOTE;
    if (note && note.length > max) {
      return reply.code(400).send({ error: `message too long (max ${max} characters)` });
    }
    // A DM has nothing to send without a body. Unlike /api/lists (which only has the
    // cohort template to work with), a single-profile add may carry its own text, so
    // either source satisfies the rule — see selectNoteSource for the precedence.
    if (kind === 'message' && !note && !existing?.message_template?.trim()) {
      return reply.code(400).send({ error: 'message campaigns require a message template or a per-contact message' });
    }
    const c = repos.cohorts.getOrCreate(cohortName, null, true, kind);
    const p = repos.profiles.add(c.id, normalized, note ?? null, kind);
    planAndAssignToday(repos, new Date()); // schedule it now — see the note in /api/lists
    return { id: p.id, profile_url: p.profile_url, kind: p.kind };
  });

  app.post('/api/lists', async (req, reply) => {
    const { cohort, text, message_template, kind: kindRaw } =
      req.body as { cohort?: string; text: string; message_template?: string; kind?: string };
    const parsedKind = parseKind(kindRaw);
    if (!parsedKind.ok) return reply.code(400).send({ error: parsedKind.error });
    const kind: CampaignKind = parsedKind.kind ?? 'invite';
    const template = message_template?.trim() || undefined;
    const cohortName = (cohort && cohort.trim()) || defaultCohortName(new Date());
    const existing = repos.cohorts.findByName(cohortName);

    // Kind first. A cohort's kind is fixed at creation: the schedulers, caps and metrics all
    // read it, so silently mixing kinds inside one cohort would mis-pace both engines.
    // Checked BEFORE the template rule so a kind mismatch reports itself as one, rather than
    // surfacing as a confusing "requires a template" 400.
    if (existing && existing.kind !== kind) {
      return reply.code(409).send({ error: `cohort "${cohortName}" is ${existing.kind === 'invite' ? 'an invite' : 'a message'} cohort` });
    }
    // A message campaign has nothing to send without a body: an invite can go note-less, a DM
    // cannot. But the body may come from the cohort that already exists — that is the whole
    // "add people to an existing campaign without rewriting its message" path, and rejecting
    // it here made that impossible. Matches the rule /api/profiles has always applied.
    if (kind === 'message' && !template && !existing?.message_template?.trim()) {
      return reply.code(400).send({ error: 'message campaigns require a message template' });
    }
    const max = kind === 'message' ? MAX_MESSAGE : MAX_NOTE;
    if (template && template.length > max) {
      return reply.code(400).send({ error: `template too long (max ${max} characters)` });
    }
    const allowNoNote = deriveAllowNoNote(template);
    const c = repos.cohorts.getOrCreate(cohortName, template ?? null, allowNoNote, kind);
    // Only touch the cohort's template when one was actually supplied. This used to run
    // unconditionally, and deriveAllowNoNote(undefined) is `true` — so merely ADDING people
    // to an existing templated invite cohort flipped allow_no_note 0 -> 1, which tells the
    // sender to re-send with NO note once LinkedIn's note quota is exhausted (sender.ts).
    // A personalized campaign silently degraded into bare connection requests.
    if (template !== undefined) {
      repos.db.prepare('UPDATE cohorts SET message_template = ?, allow_no_note = ? WHERE id = ?')
        .run(template, allowNoNote ? 1 : 0, c.id);
    }
    const urls = extractProfileUrls(text ?? '');
    const before = repos.profiles.countAll();
    for (const u of urls) repos.profiles.add(c.id, u, null, kind);
    const added = repos.profiles.countAll() - before;
    // Give the new backlog real slots now instead of leaving it untouched until the hourly
    // planning tick — a cohort added at 09:05 would otherwise sit unscheduled for nearly an
    // hour while the dashboard's next-batch pill implied an imminent send. planAndAssignToday
    // declines on its own while paused, halted, off-hours or on a non-sending day, so this
    // adds no way to slip a send past those gates; it only stops the operator from staring
    // at an empty queue wondering what broke.
    planAndAssignToday(repos, new Date());
    return { added, found: urls.length };
  });

  /**
   * The engagement pipeline's line on the dashboard poll.
   *
   * `next_scheduled` is the earliest REAL `scheduled_for` among scheduled rows, or null when
   * nothing is scheduled. Deliberately NOT nextBatchForecast: an estimated forecast pins
   * `at = now`, so an unplanned queue would advertise an imminent batch. The card has to be
   * able to say "not scheduled", and only a genuine timestamp-or-null lets it.
   *
   * MIN() over these values is chronological because every one is the same fixed-width UTC
   * ISO-8601 string the planner writes — the same property countReactedSince relies on.
   */
  const engagementSummary = (now: Date, s: Settings) => {
    const caps = engagementCaps(s);
    const weeklyUsed = repos.engagements.countReactedSince(windowStartIso(now));
    const nextScheduled = (repos.db.prepare(
      "SELECT MIN(scheduled_for) AS at FROM engagements WHERE status = 'scheduled' AND scheduled_for IS NOT NULL",
    ).get() as unknown as { at: string | null }).at ?? null;
    return {
      counts: repos.engagements.countsByStatus(),
      weekly_used: weeklyUsed,
      weekly_cap: caps.weeklyCap,
      weekly_remaining: remainingCapacity(caps.weeklyCap, weeklyUsed),
      comments_today: repos.engagements.countCommentedSince(dayStartIso(now)),
      comment_daily_cap: s.engage_comment_daily_cap,
      next_scheduled: nextScheduled,
    };
  };

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
      // The fourth conveyor. Counts, both caps and the next real instant — everything the
      // engagements card needs, on the same poll as the other three.
      engagements: engagementSummary(now, s),
      // The third conveyor. Everything the Events engine on the dashboard draws, on the
      // same poll as the other two — it is a handful of indexed counts over a table that
      // holds one row per campaign.
      event: eventPipelineSummary(repos, now),
      // Automatic enrichment stopped itself. Carried on the dashboard poll so the banner
      // renders without a second request, and null (not a half-filled object) when fine.
      enrich_halt: a.enrich_halted === 1
        ? { reason: a.enrich_halt_reason, detail: a.enrich_halt_detail, at: a.enrich_halted_at }
        : null,
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
    const parsedKind = parseKind(kindRaw);
    if (!parsedKind.ok) return reply.code(400).send({ error: parsedKind.error });
    const kind: CampaignKind = parsedKind.kind ?? 'invite';
    // Only a caller that explicitly asked for a kind can be told it conflicts; an
    // existing-cohort edit that omits `kind` must not be rejected by the 'invite' default.
    // `parsedKind.kind === undefined` is exactly "the caller omitted it" — parseKind
    // reports absence rather than defaulting, precisely to keep this distinction.
    const existing = repos.cohorts.findByName(name);
    if (existing && existing.kind !== kind && parsedKind.kind !== undefined) {
      return reply.code(409).send({ error: `cohort "${name}" is ${existing.kind === 'invite' ? 'an invite' : 'a message'} cohort` });
    }
    // Same template rules as /api/lists — a message cohort with no text would queue
    // profiles the sender can only route to needs_attention, and the UI's client-side
    // guard doesn't protect direct API callers (agents, scripts).
    const effectiveKind = existing && parsedKind.kind === undefined ? existing.kind : kind;
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

  /**
   * Ingest a roster. Accepts either a LinkedIn Connections.csv export (preamble and all)
   * or a bare list of profile URLs — the body is the same either way and the format is
   * sniffed. Idempotent: re-importing the same file updates rather than duplicates.
   */
  // bodyLimit: a real Connections.csv is far bigger than Fastify's 1 MiB default — 8k
  // connections is ~1.15 MiB, and LinkedIn allows up to 30k (~4 MiB). The default rejects
  // a normal export with a bare 413. 32 MiB leaves headroom for the largest plausible one.
  app.post('/api/connections/import', { bodyLimit: 32 * 1024 * 1024 }, async (req, reply) => {
    const { text } = (req.body ?? {}) as { text?: string };
    if (typeof text !== 'string' || text.trim() === '') {
      return reply.code(400).send({ error: 'No LinkedIn profile URLs found in the input' });
    }
    // parseRosterInput throws on a CSV whose header we cannot recognize; the global error
    // handler turns that into a 400 carrying the message.
    const { format, rows, skipped } = parseRosterInput(text);
    if (rows.length === 0) {
      return reply.code(400).send({ error: 'No LinkedIn profile URLs found in the input' });
    }
    const nowIso = new Date().toISOString();
    const { inserted, updated } = repos.connections.upsertMany(rows, format === 'csv' ? 'csv' : 'urls', nowIso);
    logger.info('roster', 'import', { format, parsed: rows.length, inserted, updated, skipped });
    return { format, parsed: rows.length, inserted, updated, skipped };
  });

  /**
   * Structured search over the enriched roster. OR within a field, AND across fields — the
   * shape an AI agent needs to fan one concept ("security practitioner") into many keywords
   * in a single round trip. Every response carries a coverage block so a thin result set can
   * be told apart from an incomplete corpus.
   */
  app.post('/api/connections/search', async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const arr = (v: unknown): string[] | undefined =>
      Array.isArray(v) ? v.filter((x) => typeof x === 'string') as string[]
        : typeof v === 'string' && v.trim() !== '' ? [v] : undefined;
    return searchConnections(repos.db, {
      name_any: arr(b.name_any),
      title_any: arr(b.title_any),
      location_any: arr(b.location_any),
      company_any: arr(b.company_any),
      exclude_any: arr(b.exclude_any),
      q: typeof b.q === 'string' ? b.q : undefined,
      include_past_roles: b.include_past_roles === true,
      limit: typeof b.limit === 'number' ? b.limit : undefined,
      offset: typeof b.offset === 'number' ? b.offset : undefined,
    });
  });

  /** Everything known about one person, including the full stored Apify payload. */
  app.get('/api/connections/:slug', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const url = normalizeProfileUrl(`https://www.linkedin.com/in/${slug}`);
    let row = url ? repos.connections.findByUrl(url) : undefined;
    if (!row && url) {
      // Follow a slug-change alias so an old link still resolves to the merged person.
      const alias = repos.db.prepare('SELECT connection_id FROM connection_aliases WHERE profile_url = ?')
        .get(url) as unknown as { connection_id: number } | undefined;
      if (alias) {
        row = repos.db.prepare('SELECT * FROM connections WHERE id = ?')
          .get(alias.connection_id) as unknown as typeof row;
      }
    }
    if (!row) return reply.code(404).send({ error: 'No such connection' });
    const { raw_json, ...rest } = row;
    return { ...rest, profile: raw_json ? JSON.parse(raw_json) : null };
  });

  app.get('/api/connections/stats', async () => ({
    total: repos.connections.count(),
    by_enrich_status: repos.connections.countsByEnrichStatus(),
    last_synced_at: repos.appState.get().roster_synced_at,
  }));

  /** Browse the roster (newest first). NOT the search API — that lands in phase 3. */
  app.get('/api/connections', async (req) => {
    const q = req.query as { limit?: string; offset?: string };
    const limit = Math.min(200, Math.max(1, Number(q.limit ?? 50) || 50));
    const offset = Math.max(0, Number(q.offset ?? 0) || 0);
    return { total: repos.connections.count(), limit, offset, results: repos.connections.list(limit, offset) };
  });

  /* ---------- enrichment ---------- */

  /** Build a client from the key currently in settings, or explain what is missing. */
  const apifyClient = (): ApifyClient => {
    const token = repos.settings.get().apify_api_key;
    if (!token) throw Object.assign(new Error('No Apify API key configured — add one under Settings → Connections'), { statusCode: 400 });
    return (opts.apifyClientFactory ?? ((t: string) => new HttpApifyClient(t)))(token);
  };

  app.post('/api/enrichment/start', async (reqm, reply) => {
    if (isEnrichmentRunning()) return reply.code(409).send({ error: 'Enrichment is already running' });
    const client = apifyClient(); // throws 400 when unconfigured
    // Clicking Start IS the operator saying "I fixed it", so it clears any halt latch. Done
    // after the key check, so a Start with no key still leaves the no_api_key alert standing.
    repos.appState.clearEnrichHalt();
    const queued = repos.connections.countsByEnrichStatus().pending;
    const concurrency = repos.settings.get().enrich_concurrency;
    logger.info('enrich', 'start', { queued, concurrency });
    // Fire and forget: a 7k backfill runs for over an hour, so the request returns
    // immediately and the operator polls /status. Errors are logged by the worker.
    void runEnrichment(repos, { client, concurrency })
      .catch((e: Error) => logger.error('enrich', 'run failed', { error: e.message }));
    return { started: true, queued, estimated_cost_usd: Number((queued * COST_PER_PROFILE_USD).toFixed(2)) };
  });

  app.get('/api/enrichment/status', async () => enrichmentProgress(repos));

  app.post('/api/enrichment/pause', async () => {
    const paused = pauseEnrichment();
    if (paused) logger.info('enrich', 'pause requested');
    return { paused };
  });

  /**
   * "I've fixed it" for the enrichment halt — the banner's button. Clears the latch and
   * starts a run immediately rather than leaving the operator to wonder whether the next
   * 60-second tick picked it up.
   */
  app.post('/api/enrichment/resume', async (reqm, reply) => {
    const client = apifyClient(); // throws 400 when still unconfigured
    repos.appState.clearEnrichHalt();
    const queued = repos.connections.countsByEnrichStatus().pending;
    logger.info('enrich', 'resume', { queued });
    if (queued > 0 && !isEnrichmentRunning()) {
      const concurrency = repos.settings.get().enrich_concurrency;
      void runEnrichment(repos, { client, concurrency })
        .catch((e: Error) => logger.error('enrich', 'run failed', { error: e.message }));
    }
    return reply.send({ resumed: true, queued });
  });

  app.post('/api/enrichment/retry-failed', async () => {
    const requeued = repos.connections.resetFailed();
    logger.info('enrich', 'retry failed', { requeued });
    return { requeued };
  });

  /** Enrich one person right now — the detail-view "Refresh" action. */
  app.post('/api/connections/:slug/refresh', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const url = normalizeProfileUrl(`https://www.linkedin.com/in/${slug}`);
    const existing = url ? repos.connections.findByUrl(url) : undefined;
    if (!existing) return reply.code(404).send({ error: 'No such connection' });

    const client = apifyClient();
    try {
      const raw = await client.fetchProfile(existing.profile_url);
      if (isEmptyProfile(raw)) {
        repos.connections.markEnrichEmpty(existing.id);
        return { status: 'empty' };
      }
      repos.connections.applyEnrichment(existing.id, extractProfile(raw), new Date().toISOString());
      return { status: 'enriched' };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      repos.connections.markEnrichFailure(existing.id, error, repos.settings.get().enrich_ttl_days > 0 ? 3 : 3);
      return reply.code(502).send({ error });
    }
  });

  app.post('/api/roster/sync-now', async () => {
    logger.info('api', 'roster sync now');
    return browserLock.run(() => runRosterSync(repos, driver, new Date(), { force: true }));
  });

  // --- Event invites -----------------------------------------------------------------

  /** Everything the Events tab needs for one campaign. */
  const eventDetail = (id: number) => {
    const event = repos.eventCampaigns.findById(id);
    if (!event) return null;
    const runs = repos.eventRuns.listForEvent(id);
    const held = repos.db.prepare(
      'SELECT from_ts, to_ts FROM reservations WHERE purpose = ? AND ref_id = ? ORDER BY from_ts LIMIT 1',
    ).get('event_invite', id) as unknown as { from_ts: string; to_ts: string } | undefined;
    return {
      event,
      counts: repos.eventInvitees.countsByStatus(id),
      buckets: repos.eventBuckets.list(id),
      reservation: held ?? null,
      runs: runs.slice(0, 10).map((r) => ({ ...r, buckets: repos.eventRuns.bucketProgress(r.id) })),
    };
  };

  app.get('/api/events', async () => repos.eventCampaigns.list().map((e) => ({
    ...e, counts: repos.eventInvitees.countsByStatus(e.id),
  })));

  app.get('/api/events/:id', async (req, reply) => {
    const detail = eventDetail(Number((req.params as { id: string }).id));
    if (detail === null) return reply.code(404).send({ error: 'no such event' });
    return detail;
  });

  app.get('/api/events/:id/invitees', async (req) =>
    repos.eventInvitees.list(Number((req.params as { id: string }).id)));

  /**
   * Create a campaign. Accepts `profile_urls` (an array — the API path) or `text` (a
   * paste blob). Returns the rejected URLs by name: a URL with no roster row cannot be
   * invited or even bucketed, and finding that out mid-run would be far too late.
   *
   * If the event already has a DRAFT campaign, the list is folded into it instead —
   * `200` with `merged: true` rather than `201` — so "add more people to the same event"
   * is just creating it again. A frozen or closed campaign still gets a `400` that says why.
   */
  app.post('/api/events', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const eventUrl = typeof b.event_url === 'string' ? b.event_url : '';
    const urls = Array.isArray(b.profile_urls)
      ? (b.profile_urls.filter((x) => typeof x === 'string') as string[])
      : typeof b.text === 'string' ? extractProfileUrls(b.text) : [];
    if (eventUrl.trim() === '') return reply.code(400).send({ error: 'event_url is required' });
    if (urls.length === 0) return reply.code(400).send({ error: 'no profile URLs supplied' });

    const result = createEventCampaign(repos, eventUrl, urls);
    if ('error' in result) return reply.code(400).send({ error: result.error });
    defaultLog.info('api',
      result.merged ? 'event campaign re-create merged into draft' : 'event campaign created', {
        event: result.event.id, added: result.added, rejected: result.rejected.length,
      });
    return reply.code(result.merged ? 200 : 201).send({ ...result, ...eventDetail(result.event.id) });
  });

  /**
   * Add more people to a draft. The Connections screen's "Invite to event" sends here
   * when the operator picks an existing draft, so a list can be assembled from several
   * searches instead of one paste.
   */
  app.post('/api/events/:id/invitees', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const urls = Array.isArray(b.profile_urls)
      ? (b.profile_urls.filter((x) => typeof x === 'string') as string[])
      : typeof b.text === 'string' ? extractProfileUrls(b.text) : [];
    if (urls.length === 0) return reply.code(400).send({ error: 'no profile URLs supplied' });

    const result = addEventInvitees(repos, id, urls);
    if ('error' in result) {
      return reply.code(result.error === 'no such event' ? 404 : 409).send({ error: result.error });
    }
    defaultLog.info('api', 'event invitees added', { event: id, added: result.added });
    return { ...result, ...eventDetail(id) };
  });

  /** Drop buckets before arming — the operator's edit of the plan. */
  app.post('/api/events/:id/buckets/remove', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const event = repos.eventCampaigns.findById(id);
    if (!event) return reply.code(404).send({ error: 'no such event' });
    // The cursor indexes into this list once armed, so rewriting it later would silently
    // re-point the cursor at different work.
    if (event.status !== 'draft') return reply.code(409).send({ error: 'buckets are frozen once armed' });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const ranks = Array.isArray(b.ranks)
      ? b.ranks.filter((x): x is number => typeof x === 'number') : [];
    repos.eventBuckets.removeRanks(id, ranks);
    return eventDetail(id);
  });

  app.post('/api/events/:id/arm', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const now = new Date();
    const r = armEventCampaign(repos, id, now);
    if (!r.ok) return reply.code(400).send({ error: r.error });
    // Claim a window immediately so the dashboard can show it, rather than waiting for
    // the hourly tick.
    ensureEventReservation(repos, now);
    planAndAssignToday(repos, now);
    defaultLog.info('api', 'event campaign armed', { event: id });
    return eventDetail(id);
  });

  app.post('/api/events/:id/stop', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const event = repos.eventCampaigns.findById(id);
    if (!event) return reply.code(404).send({ error: 'no such event' });
    repos.eventCampaigns.close(id, 'stopped', 'stopped by the operator', new Date().toISOString());
    repos.reservations.clearFor('event_invite', id);
    defaultLog.info('api', 'event campaign stopped', { event: id });
    return eventDetail(id);
  });

  /**
   * Dry run: everything except the irreversible submit. Runs immediately rather than
   * waiting for a reservation — it dispatches nothing, so it needs no window, only the
   * browser lock.
   */
  app.post('/api/events/:id/dry-run', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const event = repos.eventCampaigns.findById(id);
    if (!event) return reply.code(404).send({ error: 'no such event' });
    if (repos.appState.get().login_logged_in !== 1) {
      return reply.code(409).send({ error: 'not logged in' });
    }
    defaultLog.info('api', 'event dry run requested', { event: id });
    void browserLock.run(() => runEventCampaign(repos, driver, event, {
      mode: 'dry',
      deadline: new Date(Date.now() + 60 * 60 * 1000),
    })).catch((e: Error) => defaultLog.error('api', 'dry run failed', { error: e.message }));
    return { ok: true, started: true };
  });

  /** Run the live campaign now, ignoring the reserved window. */
  app.post('/api/events/:id/run-now', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const event = repos.eventCampaigns.findById(id);
    if (!event) return reply.code(404).send({ error: 'no such event' });
    if (event.status !== 'armed') return reply.code(409).send({ error: `campaign is ${event.status}` });
    if (repos.appState.get().login_logged_in !== 1) {
      return reply.code(409).send({ error: 'not logged in' });
    }
    const s = repos.settings.get();
    defaultLog.info('api', 'event run-now requested', { event: id });
    void browserLock.run(() => runEventCampaign(repos, driver, event, {
      mode: 'live',
      deadline: new Date(Date.now() + Math.max(1, s.event_run_budget_minutes) * 60 * 1000),
    })).catch((e: Error) => defaultLog.error('api', 'event run failed', { error: e.message }));
    return { ok: true, started: true };
  });

  // --- Post engagements ---------------------------------------------------------------

  /**
   * Why one item failed, in a form both callers can use: the single-item path sends
   * `message` verbatim as its `error`, and the bulk path collects the whole list.
   *
   * `reason` is the machine-readable name — the dashboard switches on it — while `message`
   * is the sentence a human reads. Keeping both means the bulk path never has to
   * reconstruct prose from an enum, which is where "rejected: invalid_url" (with no clue
   * WHICH url) came from in earlier pipelines.
   */
  type EngagementReject = {
    post_url: string;
    reason: 'invalid_url' | 'shortlink_unresolvable' | 'duplicate' | 'unknown_reaction'
      | 'comment_too_long';
    message: string;
  };

  /** Only a duplicate is a conflict; everything else is malformed input. */
  const REJECT_STATUS: Record<EngagementReject['reason'], number> = {
    invalid_url: 400, shortlink_unresolvable: 400, unknown_reaction: 400,
    comment_too_long: 400, duplicate: 409,
  };

  /**
   * Every status the engagement pipeline knows, as a runtime allow-list for `?status=`.
   *
   * A `Record<EngagementStatus, true>` rather than an array: TypeScript demands every member
   * of the union be present, so adding a status to EngagementStatus without listing it here
   * fails to compile. An array would silently drift, and the drift would surface as a filter
   * that returns an empty list for a status rows genuinely have.
   */
  const ENGAGEMENT_STATUSES: Record<EngagementStatus, true> = {
    queued: true, scheduled: true, sending: true, sent: true,
    skipped: true, failed: true, needs_attention: true,
  };

  /** How many shortlinks may be expanded at once, and the wall-clock budget for the lot. */
  const SHORTLINK_CONCURRENCY = 4;
  const SHORTLINK_BUDGET_MS = 15_000;

  /**
   * Expand every lnkd.in shortlink in one request. Returns a slot per input: the expanded
   * URL, or null for "could not expand" — and also null for an input that is not a shortlink
   * at all, which callers must not consult (they gate on isShortlink themselves).
   *
   * BOUNDED ON PURPOSE. Expanding N shortlinks one after another would cost N sequential
   * round trips at up to 5s each, so a paste of fifty would hold the handler for minutes and
   * outlive any client timeout. Two bounds instead: a small concurrency window, and a total
   * budget after which the remaining links are not called out for at all. Whatever the budget
   * cuts off degrades into a named `shortlink_unresolvable` reject telling the operator to
   * paste the full URL — the same answer a dead link gets, which is the honest one.
   *
   * Concurrency is deliberately small: this is a request to lnkd.in on the operator's behalf,
   * and four in flight is plenty to make a paste feel instant without looking like a scraper.
   */
  const expandShortlinks = async (raws: string[]): Promise<(string | null)[]> => {
    const out: (string | null)[] = raws.map(() => null);
    const pending = raws.map((raw, i) => ({ raw, i })).filter(({ raw }) => isShortlink(raw));
    if (pending.length === 0) return out; // the common case: not one network call
    const deadline = Date.now() + SHORTLINK_BUDGET_MS;
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < pending.length) {
        const { raw, i } = pending[cursor++];
        if (Date.now() >= deadline) continue; // out of budget: leave it null
        out[i] = await resolveShortlink(raw, { fetchImpl: opts.fetchImpl });
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(SHORTLINK_CONCURRENCY, pending.length) }, worker));
    return out;
  };

  /**
   * Validate one item and insert it, or say why not. SYNCHRONOUS BY CONTRACT.
   *
   * The duplicate check and the insert must be one uninterrupted unit, which is why every
   * network call (shortlink expansion) happens before this runs. EngagementRepo.add is
   * idempotent — it RETURNS the existing row rather than throwing on UNIQUE(post_urn) — so an
   * await between the check and the insert would let a concurrent request slip in and this one
   * answer 201 with somebody else's row: a different reaction, a different comment, and no
   * hint that nothing was created. No await here means that window does not exist. It is also
   * what makes two items naming the same post inside ONE bulk request resolve correctly: the
   * second one's check sees the first one's insert.
   */
  const createEngagement = (
    item: Record<string, unknown>, raw: string, expanded: string | null,
  ): Engagement | EngagementReject => {
    const reject = (reason: EngagementReject['reason'], message: string): EngagementReject =>
      ({ post_url: raw, reason, message });

    // A shortlink is resolved to its destination first; anything else is judged as pasted.
    // isShortlink is NOT redundant with resolveShortlink's own guard here: resolveShortlink
    // answers null both for "not a shortlink" and for "shortlink I could not follow", so
    // without this test an ordinary post URL would be reported as an unresolvable shortlink.
    // The guard makes it safe; this makes the error message true.
    let reference = raw;
    if (isShortlink(raw)) {
      if (expanded === null) {
        return reject('shortlink_unresolvable',
          `could not expand the shortlink ${raw} — open it and paste the full post URL`);
      }
      reference = expanded;
    }
    const post = normalizePostUrl(reference);
    if (post === null) {
      return reject('invalid_url', `not a LinkedIn post URL: ${raw === '' ? '(empty)' : raw}`);
    }

    const parsed = parseReaction(item.reaction);
    if (!parsed.ok) return reject('unknown_reaction', parsed.error);
    // Absent means `like`. The one place this pipeline defaults where parseKind refuses to:
    // a mis-defaulted campaign kind sends an unsendable request, a mis-defaulted reaction is
    // cosmetic and retractable.
    const reaction: Reaction = parsed.reaction ?? DEFAULT_REACTION;

    // An all-whitespace comment is NO comment, not an empty one: stored as '' it would claim
    // a slot against the daily comment cap and then try to publish nothing.
    const trimmed = typeof item.comment === 'string' ? item.comment.trim() : '';
    const comment = trimmed === '' ? null : trimmed;
    if (comment !== null && comment.length > MAX_COMMENT) {
      return reject('comment_too_long', `comment too long (max ${MAX_COMMENT} characters)`);
    }

    // Checked here so the answer names the row that already holds this post, rather than
    // letting add()'s idempotence hand back a stranger's row as if it were new.
    const existing = repos.engagements.findByUrn(post.urn);
    if (existing) {
      return reject('duplicate',
        `already queued as engagement ${existing.id} (${existing.status})`);
    }
    return repos.engagements.add(post.url, post.urn, reaction, comment);
  };

  /**
   * Enqueue one post (`{ post_url, reaction?, comment? }`) or many (`{ items: [...] }`).
   *
   * The only endpoint that puts work INTO the pipeline, so it is where validation earns its
   * keep: a bad URN here becomes a browser opening the wrong page later.
   */
  app.post('/api/engagements', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const bulk = Array.isArray(b.items);
    // A non-object entry is mapped to {} rather than dropped, so it comes back as a named
    // invalid_url reject instead of silently vanishing from the count.
    const items: Record<string, unknown>[] = bulk
      ? (b.items as unknown[]).map((x) =>
        (typeof x === 'object' && x !== null ? x as Record<string, unknown> : {}))
      : [b];
    if (items.length === 0) return reply.code(400).send({ error: 'no items supplied' });

    const raws = items.map((it) => (typeof it.post_url === 'string' ? it.post_url.trim() : ''));
    // Expand a lnkd.in shortlink BEFORE validating. This is the one network call on the
    // enqueue path, and it is deliberate: lnkd.in is a plain single-hop 301 with no JS
    // interstitial, and shortlinks are the common real-world paste form (a mobile share sheet
    // produces one). resolveShortlink is bounded and returns null rather than throwing, so a
    // dead or slow link degrades to a named reject.
    const expanded = await expandShortlinks(raws);

    const created: Engagement[] = [];
    const rejected: EngagementReject[] = [];
    for (let i = 0; i < items.length; i++) {
      const outcome = createEngagement(items[i], raws[i], expanded[i]);
      if ('reason' in outcome) rejected.push(outcome); else created.push(outcome);
    }

    if (created.length > 0) {
      // Same reasoning as /api/lists: give the new backlog real slots now instead of leaving
      // it untouched until the hourly tick. planAndAssignToday declines on its own while
      // paused, halted, off-hours or on a non-sending day, so this adds no way to slip work
      // past those gates.
      planAndAssignToday(repos, new Date());
      defaultLog.info('api', 'engagements enqueued', {
        added: created.length, rejected: rejected.length,
      });
    }
    // Re-read so the response reports the status planning just assigned, not the pre-plan one.
    const rows = created.map((e) => repos.engagements.findById(e.id) ?? e);

    if (!bulk) {
      const bad = rejected[0];
      if (bad) return reply.code(REJECT_STATUS[bad.reason]).send({ error: bad.message });
      return reply.code(201).send(rows[0]);
    }
    return reply.code(201).send({ added: rows.length, engagements: rows, rejected });
  });

  app.get('/api/engagements', async (req, reply): Promise<unknown> => {
    const q = req.query as { status?: string; limit?: string };
    // An unknown status is a 400, not a silently-dropped filter — the same rule (and the same
    // reason) as ?kind= on /api/profiles: an empty list looks like "no such rows".
    //
    // Object.hasOwn, NOT `in`: `'toString' in ENGAGEMENT_STATUSES` is true, so `in` would
    // accept every inherited Object member as a status and answer with an empty list — the
    // exact silent-empty-filter failure this check exists to prevent.
    if (q.status !== undefined && !Object.hasOwn(ENGAGEMENT_STATUSES, q.status)) {
      return reply.code(400).send({ error: `unknown status: ${q.status}` });
    }
    const raw = Number(q.limit);
    // Anything non-finite, zero or negative falls back to the default; the ceiling caps both
    // an absurd number and Infinity (Number('1e9999')), which SQLite could not bind anyway.
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 500) : 200;
    // DESC so a limit keeps the NEWEST rows. Ascending + LIMIT would hand back the oldest
    // ones, which for a queue view is precisely backwards.
    return repos.db.prepare(`
      SELECT * FROM engagements
      ${q.status !== undefined ? 'WHERE status = ?' : ''}
      ORDER BY id DESC LIMIT ${limit}
    `).all(...(q.status !== undefined ? [q.status] : [])) as unknown[];
  });

  app.get('/api/engagements/:id', async (req, reply) => {
    const e = repos.engagements.findById(Number((req.params as { id: string }).id));
    if (!e) return reply.code(404).send({ error: 'engagement not found' });
    return e;
  });

  /**
   * Retry re-runs the task, so it is only ever valid where nothing may have landed twice.
   *
   * `needs_attention` IS retryable, deliberately: parking an unverified comment exists so a
   * human can open the post and decide, and retry is how they say "I checked, it did not
   * post". The sender's comment step is guarded on commented_at, so a retry after a landed
   * reaction re-drives only what is missing.
   *
   * Which is why this CLEARS commented_at and not reacted_at. The sender stamps
   * commented_at on an unverified comment too — the submit click already happened, so it
   * must cost a slot of engage_comment_daily_cap. "I checked, it did not post" is exactly
   * the statement that unwinds that: it refunds the budget slot AND re-opens the comment
   * guard so the retry re-posts. reacted_at survives on purpose — the reaction is confirmed
   * and re-driving it is the one thing retry must never do.
   */
  const RETRYABLE_ENGAGEMENT_STATUSES = new Set<EngagementStatus>([
    'failed', 'needs_attention', 'skipped',
  ]);

  app.post('/api/engagements/:id/retry', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const e = repos.engagements.findById(id);
    if (!e) return reply.code(404).send({ error: 'engagement not found' });
    if (!RETRYABLE_ENGAGEMENT_STATUSES.has(e.status)) {
      return reply.code(409).send({
        error: `cannot retry a ${e.status} engagement — retry only applies to failed, needs_attention or skipped`,
      });
    }
    repos.engagements.setStatus(id, 'queued', {
      scheduled_for: null, last_error: null, skip_reason: null, commented_at: null,
    });
    return { ok: true };
  });

  /** Terminal skip. Also the cancel path for a row that has not run yet. */
  app.post('/api/engagements/:id/dismiss', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!repos.engagements.findById(id)) {
      return reply.code(404).send({ error: 'engagement not found' });
    }
    // scheduled_for is cleared, not just superseded: a dismissed row holding a future slot
    // would keep answering /api/status's "next scheduled" question.
    repos.engagements.setStatus(id, 'skipped', {
      last_error: null, skip_reason: 'dismissed', scheduled_for: null,
    });
    return { ok: true };
  });

  // --- Posts feed ---------------------------------------------------------------------
  //
  // Registered after createEngagement (above) on purpose: the engage routes below delegate
  // every validation judgement to it, so it has to be in scope.

  /**
   * The tracked set: who gets swept.
   *
   * Accepts `{ profile_urls: [...] }` (the Connections "Track posts" button) or
   * `{ text: "..." }` (the paste box), because a pasted blob is the other real-world input
   * shape and making the browser parse it would duplicate extractProfileUrls.
   *
   * Bulk-shaped with rejects reported BY URL AND REASON, like POST /api/events: finding out
   * later that a URL was junk is far too late.
   */
  app.post('/api/tracked-profiles', async (req, reply) => {
    const b = (req.body ?? {}) as { profile_urls?: unknown; text?: unknown };
    const raws: string[] = Array.isArray(b.profile_urls)
      ? b.profile_urls.map((u) => (typeof u === 'string' ? u.trim() : ''))
      : typeof b.text === 'string' ? extractProfileUrls(b.text) : [];
    if (raws.length === 0) return reply.code(400).send({ error: 'no profile urls supplied' });

    const s = repos.settings.get();
    const rejected: TrackReject[] = [];
    const added: number[] = [];
    // Recomputed per item rather than once: each successful add consumes a slot, so a batch
    // straddling the cap must stop exactly at it.
    for (const raw of raws) {
      const url = normalizeProfileUrl(raw);
      if (url === null) {
        rejected.push({ profile_url: raw, reason: 'invalid_url',
          message: `not a LinkedIn profile URL: ${raw === '' ? '(empty)' : raw}` });
        continue;
      }
      const existing = repos.trackedProfiles.findByUrl(url);
      if (existing && existing.active === 1) {
        rejected.push({ profile_url: url, reason: 'already_tracked',
          message: `already tracked (id ${existing.id})` });
        continue;
      }
      // A reactivation consumes a slot too, so it is counted here rather than exempted.
      if (repos.trackedProfiles.countActive() >= s.tracked_profile_cap) {
        rejected.push({ profile_url: url, reason: 'cap_reached',
          message: `tracking cap of ${s.tracked_profile_cap} reached — remove some profiles first` });
        continue;
      }
      const conn = repos.connections.findByUrl(url);
      const row = repos.trackedProfiles.add(url, conn?.id ?? null,
        Array.isArray(b.profile_urls) ? 'search' : 'urls');
      added.push(row.id);
    }

    if (added.length > 0) {
      defaultLog.info('api', 'profiles tracked', { added: added.length, rejected: rejected.length });
    }
    // Always 201, even when everything was rejected: the per-item verdicts are the payload,
    // not the status code. Same contract as POST /api/engagements.
    return reply.code(201).send({ added: added.length, ids: added, rejected });
  });

  app.get('/api/tracked-profiles', async () => ({
    tracked: repos.trackedProfiles.withCounts(),
    cap: repos.settings.get().tracked_profile_cap,
    swept_at: repos.appState.get().posts_swept_at,
  }));

  /** Untrack. Soft (active = 0) so posts keep a valid parent and history survives. */
  app.delete('/api/tracked-profiles/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const row = repos.trackedProfiles.findById(id);
    if (!row) return reply.code(404).send({ error: `no tracked profile ${id}` });
    repos.trackedProfiles.deactivate(id);
    defaultLog.info('api', 'profile untracked', { id, url: row.profile_url });
    return { ok: true, id };
  });

  const POST_FILTERS = new Set<PostFilter>(['new', 'queued', 'engaged']);
  const FEED_LIMIT_DEFAULT = 25;
  const FEED_LIMIT_MAX = 100;

  /**
   * One page of the feed, plus everything the screen's header needs, in ONE round-trip —
   * chip counts, the tracked total, the last sweep and the cost readout. Three separate
   * endpoints for that would mean four requests to render one screen.
   *
   * `before` is the opaque `next_cursor` from the previous page. Keyset rather than offset
   * because the sweep inserts rows between requests, and offset would skip or repeat posts
   * as the set shifts underneath the reader.
   */
  app.get('/api/posts', async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const filter = (q.filter ?? 'new') as PostFilter;
    // Refused rather than defaulted: silently answering the `new` feed for a filter the
    // caller misspelled looks like an empty result, not a mistake.
    if (!POST_FILTERS.has(filter)) {
      return reply.code(400).send({ error: `unknown filter: ${String(q.filter)}` });
    }
    const asked = Number(q.limit);
    const limit = Number.isFinite(asked) && asked > 0
      ? Math.min(Math.floor(asked), FEED_LIMIT_MAX)
      : FEED_LIMIT_DEFAULT;
    const cursor = typeof q.before === 'string' && q.before !== '' ? q.before : null;

    // One extra row is fetched to learn whether another page exists, rather than issuing a
    // second COUNT for the same question.
    //
    // A malformed `before` throws out of feed() — deliberately not caught here. The global
    // error handler maps a status-less throw to 400, which is the right answer for a junk
    // cursor, and catching it would only let it degrade into a silent page one.
    const rows = repos.posts.feed(filter, limit + 1, cursor);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor = rows.length > limit && last
      ? `${last.posted_at ?? last.first_seen_at}|${last.id}`
      : null;

    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const scraped = repos.posts.countSince(since);
    // NOT named `app`: that is the Fastify instance this route is registered on, and shadowing
    // it inside the handler is a trap for whoever edits this next.
    const state = repos.appState.get();
    return {
      posts: page,
      filter,
      counts: repos.posts.counts(),
      next_cursor: nextCursor,
      tracked: repos.trackedProfiles.countActive(),
      swept_at: state.posts_swept_at,
      // The halt latch rides along so the screen renders its banner without a second
      // request. Same treatment as the enrichment halt.
      halt: {
        halted: state.posts_halted,
        reason: state.posts_halt_reason,
        detail: state.posts_halt_detail,
        at: state.posts_halted_at,
      },
      // Informational only. No enforcement — a spend ceiling was explicitly declined; this
      // exists so the cost question is a number the operator can watch.
      cost_30d: { posts: scraped, usd: scraped * COST_PER_POST_USD },
    };
  });

  /**
   * The sentence both engage routes use for an engagement no click may re-drive.
   *
   * A reacted row gets its own wording: "already queued (failed)" reads like a stuck task the
   * operator should re-push, when in fact the reaction is live on LinkedIn and only the comment
   * step is outstanding — which /api/engagements/:id/retry is the tool for.
   */
  const heldEngagementMessage = (held: Engagement): string =>
    held.reacted_at !== null
      ? `already reacted as engagement ${held.id} (${held.status}) — use retry to re-run the comment`
      : `already queued as engagement ${held.id} (${held.status})`;

  /**
   * Re-queue a failed or skipped engagement. What a second engage click MEANS on a post the
   * feed still lists as New.
   *
   * Needed because an engagement is UNIQUE on post_urn: once a post has one, no amount of
   * clicking can create a second, so without this the retry the feed's own filter promises
   * ("not reacted, status failed/skipped -> new, retryable") would be a link that is already
   * there — a click that answers 200 and changes nothing, leaving the post in New forever.
   *
   * Same field set as POST /api/engagements/:id/retry, for the same reasons: commented_at is
   * cleared so the comment step re-runs, and reacted_at deliberately survives, because
   * re-driving a reaction that already landed is the one thing a retry must never do.
   *
   * The row's own reaction and comment are left as they were, exactly as on the adoption path
   * below: this re-drives work that already exists rather than replacing it, and rewriting the
   * text of a queued task from a request that names no new text is how a comment gets published
   * that nobody typed. Changing them is dismiss-then-requeue, not retry.
   */
  const requeueEngagement = (engagementId: number): Engagement => {
    repos.engagements.setStatus(engagementId, 'queued', {
      scheduled_for: null, last_error: null, skip_reason: null, commented_at: null,
    });
    return repos.engagements.findById(engagementId)!;
  };

  /**
   * Queue one post's engagement from the feed.
   *
   * Delegates every judgement to createEngagement: URL and URN normalization, the six valid
   * reactions, the 1250-character comment limit, and whitespace-only comments collapsing to
   * null. A second copy of those rules here is how they drift apart.
   */
  app.post('/api/posts/:id/engage', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const row = repos.posts.findById(id);
    if (!row) return reply.code(404).send({ error: `no post ${id}` });

    if (row.engagement_id !== null) {
      const held = repos.engagements.findById(row.engagement_id);
      if (held && !isRetryableEngagement(held)) {
        return reply.code(409).send({ error: heldEngagementMessage(held) });
      }
    }

    const b = (req.body ?? {}) as Record<string, unknown>;
    // `expanded` is null: a post_url from the sweep is already canonical, and isShortlink
    // is false for it, so the shortlink branch is never taken.
    const outcome = createEngagement({ reaction: b.reaction, comment: b.comment },
      row.post_url, null);

    if ('reason' in outcome) {
      // A duplicate means an engagement for this URN already exists — either queued by hand
      // through /api/engagements before the feed existed, or this post's own earlier attempt.
      if (outcome.reason === 'duplicate') {
        const held = repos.engagements.findByUrn(row.post_urn);
        if (held) {
          // Linked either way. Adopt rather than reporting a conflict the operator cannot
          // resolve: the work is already scheduled, it just was not linked.
          repos.posts.setEngagement(id, held.id);
          // Retryable means the previous attempt is over and did not react, so this click is
          // "try again" and has to put real work back in the queue — see requeueEngagement.
          // 201 rather than the adoption 200 because a task genuinely re-enters the pipeline.
          if (isRetryableEngagement(held)) {
            const requeued = requeueEngagement(held.id);
            planAndAssignToday(repos, new Date());
            defaultLog.info('api', 'post engagement re-queued from feed',
              { post_id: id, engagement: held.id, was: held.status });
            // Flagged, like `adopted` below: nothing was created and the row keeps the reaction
            // and comment it already had, so a caller that assumed "201 means my reaction" would
            // render the wrong badge. See requeueEngagement for why the text is left alone.
            return reply.code(201).send({ post_id: id, engagement: requeued, requeued: true });
          }
          return reply.code(200).send({ post_id: id, engagement: held, adopted: true });
        }
      }
      return reply.code(REJECT_STATUS[outcome.reason]).send({ error: outcome.message });
    }

    repos.posts.setEngagement(id, outcome.id);
    // Same reasoning as /api/engagements: give the new task a real slot now rather than
    // leaving it until the hourly tick. planAndAssignToday declines on its own while paused,
    // halted, off-hours or on a non-sending day.
    planAndAssignToday(repos, new Date());
    defaultLog.info('api', 'post engaged from feed', { post_id: id, engagement: outcome.id });
    return reply.code(201).send({
      post_id: id,
      engagement: repos.engagements.findById(outcome.id) ?? outcome,
    });
  });

  /**
   * Bulk: one reaction across several selected posts.
   *
   * There is NO comment parameter, deliberately. Identical comment text on several posts is a
   * recognizable spam pattern published under the operator's own name, and
   * engage_comment_daily_cap defaults to 10/day — so one click would spend the whole day's
   * allowance looking automated. Comments are per-post only.
   */
  app.post('/api/posts/engage', async (req, reply) => {
    const b = (req.body ?? {}) as { post_ids?: unknown; reaction?: unknown };
    // `n > 0` is not decoration: Number(null), Number(false) and Number('') are all 0, and
    // Number.isInteger(0) is true — so without it every junk entry survived as "post 0" and came
    // back as a `no post 0` reject, burying the real verdicts in noise no id ever produced.
    const ids = Array.isArray(b.post_ids)
      ? b.post_ids.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0)
      : [];
    if (ids.length === 0) return reply.code(400).send({ error: 'no post ids supplied' });

    // Validated ONCE up front: a bad reaction is one mistake for the whole batch, and
    // half-applying it would leave the operator undoing real queued rows.
    const parsed = parseReaction(b.reaction);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const reaction = parsed.reaction ?? DEFAULT_REACTION;

    // Three outcomes, reported under three keys rather than one. Folded together they are
    // indistinguishable — a re-selected `celebrate` row that came back re-queued under the
    // operator's newly chosen `insightful` looked exactly like a fresh create, and only a feed
    // refetch would have shown otherwise. `added` stays the one number to read out loud.
    const created: number[] = [];
    const adopted: number[] = [];
    const requeued: number[] = [];
    const rejected: { post_id: number; reason: string; message: string }[] = [];
    for (const id of ids) {
      const row = repos.posts.findById(id);
      if (!row) {
        rejected.push({ post_id: id, reason: 'not_found', message: `no post ${id}` });
        continue;
      }
      if (row.engagement_id !== null) {
        const held = repos.engagements.findById(row.engagement_id);
        if (held && !isRetryableEngagement(held)) {
          rejected.push({ post_id: id, reason: 'duplicate', message: heldEngagementMessage(held) });
          continue;
        }
      }
      // No comment is passed, so no bulk path can ever publish one.
      const outcome = createEngagement({ reaction }, row.post_url, null);
      if ('reason' in outcome) {
        if (outcome.reason === 'duplicate') {
          const held = repos.engagements.findByUrn(row.post_urn);
          if (held) {
            repos.posts.setEngagement(id, held.id);
            // Same rule as the single-post route: a retryable row is re-queued, so a bulk
            // re-select of failed posts is a real retry rather than a silent relink.
            if (isRetryableEngagement(held)) { requeueEngagement(held.id); requeued.push(id); }
            else adopted.push(id);
            continue;
          }
        }
        rejected.push({ post_id: id, reason: outcome.reason, message: outcome.message });
        continue;
      }
      repos.posts.setEngagement(id, outcome.id);
      created.push(id);
    }

    const added = created.length + adopted.length + requeued.length;
    if (added > 0) {
      planAndAssignToday(repos, new Date());
      defaultLog.info('api', 'posts bulk-engaged', {
        added, adopted: adopted.length, requeued: requeued.length,
        rejected: rejected.length, reaction,
      });
    }
    // Always 201: the per-item verdicts are the payload. Same contract as /api/engagements.
    // `post_ids` is the freshly created set ONLY — an adopted or re-queued post keeps whatever
    // reaction and comment its existing engagement already had, which is not `reaction`.
    return reply.code(201).send({ added, post_ids: created, adopted, requeued, rejected });
  });

  /**
   * Sweep now — the override for the once-per-slot gate and for `paused`.
   *
   * Mirrors the per-belt "Run now": long on purpose, since it returns only after the actor
   * run finishes. Do not retry it.
   */
  app.post('/api/posts/sweep-now', async (req, reply) => {
    const s = repos.settings.get();
    // A sweep already in flight must not be joined by a second one: two concurrent runs
    // double-bill, and the scheduled tick can be mid-sweep when the operator clicks. The
    // worker refuses re-entry itself (it throws), but answering 409 here gives the operator
    // a real explanation instead of a 400 from a thrown error.
    if (isPostsSweepRunning()) {
      return reply.code(409).send({ error: 'a posts sweep is already running — wait for it to finish' });
    }
    if (repos.trackedProfiles.countActive() === 0) {
      return reply.code(400).send({ error: 'no profiles are being tracked' });
    }
    if (!s.apify_api_key) {
      return reply.code(400).send({ error: 'No Apify API key is configured — add one in Settings.' });
    }
    // A manual sweep is the operator saying "try again", so clear a previous latch first.
    repos.appState.clearPostsHalt();
    const result = await runPostsSweep(repos, {
      client: postsClientFactory(s.apify_api_key),
      now: new Date(),
      maxPosts: s.posts_max_per_sweep,
      batchSize: s.posts_sweep_batch_size,
      retentionDays: s.posts_retention_days,
    });
    return result;
  });

  app.get('/api/metrics', async () => {
    const rows = repos.db.prepare(`
      SELECT p.cohort_id, c.name AS cohort_name, p.kind, p.status, p.sent_at, p.accepted_at, p.replied_at
      FROM profiles p JOIN cohorts c ON c.id = p.cohort_id
      WHERE c.archived = 0
    `).all() as unknown as MetricRow[];
    return computeCohortMetrics(rows);
  });

  app.get('/api/profiles', async (req, reply): Promise<unknown> => {
    const { status, kind } = req.query as { status?: string; kind?: string };
    // A kind the engine doesn't know is a 400, not a silently-dropped filter: the old
    // `kind === 'invite' || kind === 'message'` test let a typo'd ?kind= fall through to
    // "no filter", so the drawer showed every kind while looking like a filtered view.
    if (kind !== undefined && !isCampaignKind(kind)) {
      return reply.code(400).send({ error: `unknown kind: ${kind}` });
    }
    // string[] (not unknown[]): both filters bind text, and node:sqlite's SQLInputValue
    // won't accept unknown.
    const conds: string[] = []; const args: string[] = [];
    if (status) { conds.push('p.status = ?'); args.push(status); }
    if (kind !== undefined) { conds.push('p.kind = ?'); args.push(kind); }
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

  // `rules` rides along so the form configures its inputs from this table rather than from
  // limits hardcoded in index.html. A limit written in two places drifts, and the HTML copy
  // is the one nobody remembers to update.
  app.get('/api/settings', async () => ({ ...publicSettings(repos.settings.get()), rules: SETTING_RULES }));
  app.post('/api/settings', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const k of Object.keys(body)) {
      if (ALLOWED_SETTINGS_KEYS.has(k)) patch[k] = body[k];
    }
    // Validated as a whole BEFORE the write. Applying the legal half of a bad patch would
    // leave the engine paced by numbers nobody chose, with nothing on screen to say so.
    // `error` is the one sentence agents relay to the operator (see CLAUDE.md); `fields`
    // is the machine-readable rest, which matters for the API-only keys that have no form.
    const failures = validateSettingsPatch(patch, repos.settings.get());
    if (failures.length) {
      return reply.code(400).send({ error: failures[0].message, fields: failures });
    }
    repos.settings.update(patch as any);
    return publicSettings(repos.settings.get());
  });

  // -------------------------------------------------------------------------
  // Lifecycle: Restart and Update.
  //
  // Neither is done by this process. It writes a request to data/control.json, replies
  // immediately, drains the browser lock, and exits with a code scripts/supervisor.mjs knows how
  // to read (42 restart, 43 update). See src/core/lifecycle.ts for why the drain matters.
  //
  // There is deliberately no Stop: with a login-launched service, "stopped" means "until the
  // next login", and there would be no server left to serve the button that undoes it. Pause
  // already covers what an operator actually wants.
  // -------------------------------------------------------------------------
  const requestLifecycleChange = async (
    action: 'update' | 'restart',
    reply: FastifyReply,
  ): Promise<unknown> => {
    if (!supervised) {
      // Exiting would simply kill it with nothing to bring it back — the opposite of what the
      // button promises. Refuse rather than strand the operator.
      return reply.code(409).send({
        error: 'The Machine was started by hand, so it cannot restart itself. Close it and start it the normal way first.',
      });
    }
    const existing = readControl(dataDir);
    if (isPending(existing)) {
      return reply.code(409).send({
        error: existing?.action === 'update'
          ? 'An update is already in progress. Give it a minute and refresh.'
          : 'A restart is already in progress. Give it a moment and refresh.',
      });
    }

    // Paused first, so that if anything below goes wrong the engines are already quiet rather
    // than mid-send. Resume happens in the normal way after the restart.
    repos.settings.update({
      paused: 1,
      pause_reason: action === 'update' ? 'Updating The Machine' : 'Restarting The Machine',
    });
    const requestedAt = new Date().toISOString();
    writeControl(dataDir, newRequest(action, requestedAt));
    logger.info('api', `${action} requested`);

    // requested_at goes back to the caller so the dashboard can tell ITS request apart from a
    // leftover one. Without it, a poll that lands on the restarted server would read the
    // previous update's "done" and report success for something that never ran.
    void reply.code(202).send({ ok: true, action, requested_at: requestedAt });

    // After the response is on the wire: let in-flight browser work finish, then hand over.
    setImmediate(() => {
      void (async () => {
        const drained = await drainBrowserLock(browserLock, drainTimeoutMs);
        if (!drained) logger.warn('api', 'exiting with browser work still in flight', { action });
        else logger.info('api', 'browser idle, handing over to the supervisor', { action });
        requestExit(action === 'update' ? EXIT_UPDATE : EXIT_RESTART);
      })();
    });
    return reply;
  };

  app.post('/api/update', async (_req, reply) => requestLifecycleChange('update', reply));
  app.post('/api/restart', async (_req, reply) => requestLifecycleChange('restart', reply));

  /** What happened to the last request — the only thing that survives the restart. */
  app.get('/api/update/status', async () => {
    const control = readControl(dataDir);
    return {
      ...summarizeControl(control),
      action: control?.action ?? null,
      changes: control?.changes ?? [],
      requested_at: control?.requested_at ?? null,
      finished_at: control?.finished_at ?? null,
      supervised,
    };
  });

  /** Is there anything to install? Keeps the dashboard silent when there is not. */
  app.get('/api/update/check', async () => updateCheck());

  app.post('/api/pause', async () => { defaultLog.info('api', 'pause'); repos.settings.update({ paused: 1, pause_reason: 'Manual pause' }); return { ok: true }; });
  app.post('/api/resume', async () => {
    defaultLog.info('api', 'resume');
    repos.settings.update({ paused: 0, pause_reason: null });
    // Slots that went stale during the pause were re-queued by the tick; re-plan now
    // so sending resumes without waiting for the hourly scheduler.
    planAndAssignToday(repos, new Date());
    return { ok: true };
  });

  /**
   * Manual trigger, one belt at a time.
   *
   * Two separable steps, and the response reports each honestly: PROMOTE is a durable DB
   * write making that belt's backlog due now, KICK is a best-effort attempt to grab the
   * shared browser. When the lock is held the promotion still stands and the next 60s tick
   * drains it — so `started: false, deferred: 'browser busy'` is the truth, where the old
   * handler answered a flat `{ok:true}`.
   *
   * Refusals are pre-flighted BEFORE promoting: a batch promoted while paused would all fire
   * the instant the operator resumes, outside the planned spread.
   *
   * `belt` omitted means every sender belt (invite + message + engagement). Events are never
   * part of that alias — they are a reserved window, not a queue of due rows.
   *
   * Deliberately NOT skipping the inter-send delay: this hits the same LinkedIn account
   * through the same automation, so a manual batch firing several sends back-to-back is
   * exactly the burst pattern min_delay_ms/max_delay_ms exist to prevent. `force: true` is
   * kept — a manual trigger may run outside working hours by design.
   */
  app.post('/api/run-now', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const belt = parseBelt(body.belt);
    if (belt === null) {
      return reply.code(400).send({ ok: false, error: `unknown belt: ${JSON.stringify(body.belt)}` });
    }

    const now = new Date();
    const refusal = preflight(repos, belt, now);
    if (refusal) {
      defaultLog.info('api', 'run-now refused', { belt, code: refusal.code });
      return reply.code(409).send({ ok: false, belt, ...refusal });
    }

    // The event belt has no due-now queue: move its reserved window and let runEventTick
    // (≤60s) fire it. Nothing to kick here, hence started: false.
    if (belt === 'event') {
      let w;
      try {
        w = moveEventWindow(repos, now);
      } catch (e) {
        // Unreachable while preflight runs immediately above with no await between them —
        // both are synchronous, so no request can interleave and change the state they
        // both read. Caught anyway because the alternative is the global error handler
        // answering 400 with a raw internal assertion string, in a shape no client of
        // this endpoint expects.
        defaultLog.error('api', 'run-now event window move failed', {
          error: e instanceof Error ? e.message : String(e),
        });
        return reply.code(500).send({
          ok: false, belt, code: 'internal_error',
          error: 'Could not open a run window for the next campaign',
        });
      }
      defaultLog.info('api', 'run-now', { belt, event: w.eventId, from: w.from, to: w.to });
      return {
        ok: true, belt, started: false,
        // No `promoted` here on purpose. On the sender belts that field counts rows moved
        // to due-now; there is no equivalent count for an event run, and reporting a
        // hardcoded 1 would put a different unit behind the same name. The window itself
        // is the payload.
        event_id: w.eventId, from: w.from, to: w.to,
      };
    }

    const belts = belt === 'all' ? SENDER_BELTS : [belt];
    let promoted = 0;
    for (const b of belts) promoted += promote(repos, b, now);
    defaultLog.info('api', 'run-now', { belt, promoted });
    if (promoted === 0) {
      return { ok: true, belt, promoted: 0, started: false, deferred: 'nothing queued' };
    }

    // tryRun resolves to undefined when the lock was held. runSenderOnce itself returns
    // void, so the callback returns a sentinel — otherwise "did it run?" is unanswerable.
    const ran = await browserLock.tryRun(async () => {
      await runSenderOnce(repos, driver, now, {
        force: true, clock: () => new Date(), ...senderOptions,
      });
      return true as const;
    });
    return ran === true
      ? { ok: true, belt, promoted, started: true }
      : { ok: true, belt, promoted, started: false, deferred: 'browser busy' };
  });

  // Manual, on-demand acceptance reconciliation. Read-only against LinkedIn, so it runs
  // even while paused (force: true) — but still respects the guardrail, login, and
  // empty-read fail-safes inside runAcceptanceCheck. Uses run (not tryRun) so it queues
  // behind any in-flight sender/acceptance batch rather than being silently dropped.
  app.post('/api/recheck-acceptance', async () => {
    defaultLog.info('api', 'recheck-acceptance');
    // No browser lock: this is a pure DB read since the phase-3 cutover.
    return runAcceptanceCheck(repos, new Date(), { force: true });
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

  /**
   * Everything stuck for the Attention tab: failed + needs_attention, from BOTH pipelines.
   *
   * Two row shapes in one list, so each carries a `source` discriminator. Without it the
   * client cannot tell a post from a person — and would POST an engagement's id to
   * /api/profiles/:id/retry, which is a different table with its own ids: a retry aimed at
   * whatever profile happens to share that number. The tag is on the profile rows too, not
   * only the new ones; a discriminator only one side carries is one every reader has to
   * guess about.
   *
   * Profiles first, then engagements, each newest-first. Ids are per-table, so there is no
   * meaningful single order to interleave them into.
   */
  app.get('/api/attention', async () => {
    const profiles = repos.db.prepare(`
      SELECT p.id, p.profile_url, p.kind, p.status, p.last_error, p.attempts,
             p.sent_at, p.scheduled_for, c.name AS cohort_name
      FROM profiles p JOIN cohorts c ON c.id = p.cohort_id
      WHERE p.status IN ('failed','needs_attention')
      ORDER BY p.id DESC
    `).all() as unknown[];
    const engagements = repos.db.prepare(`
      SELECT id, post_url, post_urn, reaction, comment_text, status, last_error, attempts,
             scheduled_for, reacted_at, commented_at
      FROM engagements
      WHERE status IN ('failed','needs_attention')
      ORDER BY id DESC
    `).all() as unknown[];
    return [
      ...profiles.map((r) => ({ source: 'profile' as const, ...(r as object) })),
      ...engagements.map((r) => ({ source: 'engagement' as const, ...(r as object) })),
    ];
  });

  // Retry re-queues the profile for a FRESH send, so it is only ever valid for a profile
  // that never landed a send. Retrying a `replied`/`accepted`/`sent` row would message the
  // same person a second time; retrying a queued/scheduled/sending row would just fight the
  // scheduler. Mirrors the bulk /api/retry (failed + needs_attention) plus `skipped`, which
  // the Attention modal's Dismiss button produces and the operator may want to undo.
  const RETRYABLE_STATUSES = new Set<ProfileStatus>(['failed', 'needs_attention', 'skipped']);

  app.post('/api/profiles/:id/retry', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const p = repos.profiles.findById(id);
    if (!p) return reply.code(404).send({ error: 'profile not found' });
    if (!RETRYABLE_STATUSES.has(p.status)) {
      return reply.code(409).send({
        error: `cannot retry a ${p.status} profile — retry only applies to failed, needs_attention or skipped`,
      });
    }
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

    // An event run occupies the browser for a reserved 20 minutes and sends invitations
    // to real people — it belongs in "Up next" alongside the cohorts, not only behind the
    // Events tab. Rows are locations rather than profiles, because that is the unit the
    // run actually works through.
    const next = nextEventRun(repos, new Date());
    const events = next === null ? [] : [{
      id: next.event.id,
      title: next.event.title,
      event_url: next.event.event_url,
      status: next.event.status,
      pending: next.pending,
      reserved_from: next.reservation?.from ?? null,
      reserved_to: next.reservation?.to ?? null,
      locations_left: next.locationsLeft,
      buckets: next.buckets,
    }];
    return { cohorts, events };
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
