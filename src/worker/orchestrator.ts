import type { Repos } from '../db/repositories.js';
import type { BrowserDriver } from '../types.js';
import { Mutex } from '../core/mutex.js';
import { type ApifyClient, HttpApifyClient } from '../core/apify-client.js';
import { type ApifyPostsClient, HttpApifyPostsClient } from '../core/apify-posts-client.js';
import { runEnrichment, isEnrichmentRunning } from './enrichment.js';
import {
  planAndAssignToday, requeueOverdue, resortSchedule, recoverOrphanedSending,
  recoverOrphanedEngagements,
} from './scheduler-service.js';
import { runSenderOnce, type SenderOptions } from './sender.js';
import { runAcceptanceCheck } from './acceptance-checker.js';
import { runReplyCheck } from './reply-checker.js';
import { runRosterSync } from './roster-sync.js';
import { dueEventRun, ensureEventReservation } from './event-campaign.js';
import { runEventCampaign } from './event-runner.js';
import { runPostsSweep, isPostsSweepRunning } from './posts-sweep.js';
import { log } from '../core/log.js';

/**
 * True if a browser launch failed because the persistent profile is already open in
 * another Chromium (cloakbrowser/Playwright report "Opening in existing browser session"
 * / "already in use"). Only ONE process can use `.linkedin-profile` at a time.
 */
export function isProfileInUse(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /already in use|existing browser session/i.test(msg);
}

const PROFILE_IN_USE_REASON =
  'Another browser is using the LinkedIn profile. Close that Chromium window, then press Resume.';

/**
 * Refresh the cached login flag from the live li_at cookie — but ONLY when the
 * browser is already open, so this never opens a window just to poll. A no-op
 * while the browser is closed (the cache holds last-known state).
 */
export async function refreshLoginCache(repos: Repos, driver: BrowserDriver, now: Date): Promise<void> {
  if (!driver.browserOpen()) return;
  const snap = await driver.readLoginState();
  repos.appState.setLogin(snap, now.toISOString());
}

/**
 * Identify which slot of the day a moment falls in. The day is divided into `perDay` equal
 * slots and at most one successful pass runs per slot, so passes spread across the day
 * (2/day = morning + afternoon) instead of bunching into consecutive ticks. Computed in
 * LOCAL time — the operator thinks in local days. A nonsensical setting degrades to one
 * pass per day.
 *
 * Generic: used by the reply check and the roster sync. (It was named acceptanceSlot until
 * the acceptance pass stopped being slot-gated — it is now a free DB read that runs every
 * tick, so it no longer has a slot at all.)
 */
export function daySlot(when: Date, perDay: number): string {
  const n = Math.min(24, Math.max(1, Math.floor(perDay) || 1));
  const slot = Math.floor((when.getHours() * n) / 24);
  return `${when.getFullYear()}-${when.getMonth()}-${when.getDate()}#${slot}`;
}

export class Orchestrator {
  private timers: ReturnType<typeof setInterval>[] = [];

  /**
   * `browserLock` is shared with the API server (run-now) so that the sender, the
   * acceptance reader, the reply reader and the manual trigger never drive the single
   * browser page concurrently — concurrent navigations abort each other (net::ERR_ABORTED).
   *
   * `senderOptions` forwards only the delay primitives (`sleep`/`rng`) into every
   * periodic sender tick — production leaves this empty so runSenderOnce falls back to
   * the real timer-based sleep; tests inject a no-op so a multi-profile batch in a
   * periodic tick never performs a real 20-90s wait.
   */
  constructor(
    private repos: Repos,
    private driver: BrowserDriver,
    private browserLock: Mutex = new Mutex(),
    private senderOptions: Pick<SenderOptions, 'sleep' | 'rng'> = {},
    /** Injected so no test ever spends money. Built per run from the key currently in
     *  settings — same shape and reason as buildServer's — so re-keying takes effect on the
     *  next tick rather than needing a restart. */
    private apifyClientFactory: (token: string) => ApifyClient = (t: string) => new HttpApifyClient(t),
    /** Injected so no test ever spends money. Built per run from the key currently in
     *  settings — same shape and reason as apifyClientFactory above. */
    private apifyPostsClientFactory: (token: string) => ApifyPostsClient =
      (t: string) => new HttpApifyPostsClient(t),
  ) {}

  /**
   * Turn a browser error from a periodic tick into a logged, non-fatal event. A tick
   * fires as `void this.runSenderTick()`, so an uncaught rejection here would crash the
   * whole process — never let that happen. If the failure is "profile in use", pause the
   * engine with an actionable reason so we stop retrying (each retry pokes the other
   * browser into opening a blank tab) and the dashboard tells the operator what to do.
   */
  private handleTickError(component: string, err: unknown): void {
    const error = err instanceof Error ? err.message : String(err);
    log.error(component, 'tick failed', { error });
    if (isProfileInUse(err) && this.repos.settings.get().paused !== 1) {
      this.repos.settings.update({ paused: 1, pause_reason: PROFILE_IN_USE_REASON });
      log.warn(component, 'paused: LinkedIn profile is in use by another browser');
    }
  }

  /** One sender pass, guarded so an overlapping tick is dropped rather than run in parallel. */
  async runSenderTick(now: Date = new Date()): Promise<void> {
    try {
      await this.browserLock.tryRun(() => {
        // Self-heal stale slots first (inside the lock so a running batch is never
        // yanked out from under the sender), then send whatever is due.
        requeueOverdue(this.repos, now);
        // Live clock: a batch runs for minutes, so per-profile timestamps (sent_at,
        // guardrail trips) must not all be stamped with the batch-start `now`.
        return runSenderOnce(this.repos, this.driver, now, { clock: () => new Date(), ...this.senderOptions });
      });
    } catch (err) {
      this.handleTickError('sender', err);
    }
  }

  /**
   * Acceptance pass. Since the phase-3 cutover this is a pure DB read against the roster —
   * no browser, no network, no cost — so the old once-per-slot gate is gone and it runs on
   * every tick. Detection latency is now bounded solely by `roster_sync_per_day`, which is
   * what actually determines when a new connection becomes visible.
   *
   * The old `acceptance_checks_per_day` setting is gone — nothing paced this any more.
   */
  async runAcceptanceTick(now: Date = new Date()): Promise<void> {
    const app = this.repos.appState.get();
    if (this.repos.settings.get().paused || app.guardrail_tripped === 1) return;
    try {
      await runAcceptanceCheck(this.repos, now);
    } catch (err) {
      this.handleTickError('acceptance', err);
    }
  }

  /**
   * Reply pass, at most once per slot (slot math shared with acceptance checks via
   * daySlot — it is a generic day-slicer). The gate reads the PERSISTED
   * replies_checked_at, which runReplyCheck stamps only on a clean, non-empty read — a
   * bailed-out pass leaves the stamp untouched so the next 30-minute tick retries
   * (acceptance-checker lesson). Queues behind in-flight browser work rather than being
   * dropped, for the same reason the acceptance tick does.
   */
  async runReplyTick(now: Date = new Date()): Promise<void> {
    const s = this.repos.settings.get();
    const app = this.repos.appState.get();
    if (s.paused || app.guardrail_tripped === 1) return;
    const slot = daySlot(now, s.reply_checks_per_day);
    if (app.replies_checked_at
      && daySlot(new Date(app.replies_checked_at), s.reply_checks_per_day) === slot) return;
    try {
      await this.browserLock.run(() => runReplyCheck(this.repos, this.driver, now));
    } catch (err) {
      this.handleTickError('replies', err);
    }
  }

  /**
   * Roster pass, at most once per slot (slot math shared with acceptance/reply checks via
   * daySlot — it is a generic day-slicer). The gate reads the PERSISTED
   * `roster_synced_at`, which runRosterSync stamps only on a clean, non-empty read, so a
   * bailed-out pass leaves the stamp untouched and the next 30-minute tick retries.
   * Queues behind in-flight browser work rather than being dropped, for the same reason
   * the acceptance tick does.
   */
  async runRosterSyncTick(now: Date = new Date()): Promise<void> {
    const s = this.repos.settings.get();
    const app = this.repos.appState.get();
    if (s.paused || app.guardrail_tripped === 1) return;
    const slot = daySlot(now, s.roster_sync_per_day);
    if (app.roster_synced_at
      && daySlot(new Date(app.roster_synced_at), s.roster_sync_per_day) === slot) return;
    try {
      await this.browserLock.run(() => runRosterSync(this.repos, this.driver, now));
    } catch (err) {
      this.handleTickError('roster', err);
    }
  }

  /**
   * Return TTL-stale enriched rows to the queue so the next enrichment run refreshes them.
   * Job titles and locations decay; `enrich_ttl_days` (default 180) decides how stale is too
   * stale. Only `enriched` rows are re-armed — parked `failed`/`empty` rows are left alone,
   * because each retry bills and a restricted profile will not have become scrapeable.
   *
   * Requeue only: this never starts a run or spends anything on its own.
   */
  runEnrichRefreshTick(now: Date = new Date()): void {
    const s = this.repos.settings.get();
    if (!s.apify_api_key) return; // nothing can drain the queue without a key
    const n = this.repos.connections.requeueForRefresh(s.enrich_ttl_days, now);
    if (n > 0) log.info('enrich', 'requeued stale profiles for refresh', { count: n, ttlDays: s.enrich_ttl_days });
  }

  /**
   * Drain the pending enrichment queue. THE consumer — the piece whose absence meant a
   * connection discovered by roster sync stayed un-enriched forever, invisible to search.
   *
   * Source-agnostic on purpose. It asks the database "is there work?" and never "where did
   * the work come from?", so import, roster discovery, the TTL sweep and crash recovery are
   * all served by one trigger, and a future path that inserts connections is drained for
   * free. Reasoning per-source is what let this fall through the cracks the first time.
   *
   * `guardrail_tripped` is deliberately NOT a gate: the guardrail means the LinkedIn session
   * is in trouble, and Apify never touches that session. Please do not "fix" this.
   */
  async runEnrichDrainTick(now: Date = new Date()): Promise<void> {
    const s = this.repos.settings.get();
    // Pause is the operator's "stop doing things" switch, so it also stops unattended
    // spending. Manual Start still works while paused — that is the override.
    if (s.paused) return;
    // A latched halt is a problem already reported on the dashboard. Retrying it every 60s
    // would hammer Apify 1,440 times a day and bury the alert in noise.
    if (this.repos.appState.get().enrich_halted === 1) return;
    if (isEnrichmentRunning()) return;

    // The steady state, so it must be the cheap path: one indexed COUNT and nothing else.
    const pending = this.repos.connections.countsByEnrichStatus().pending;
    if (pending === 0) return;

    // There is work but no credential. Say so where the operator will see it, rather than
    // logging into the void — but only once there is actually something to enrich, so a
    // fresh install with an empty roster never nags about a key it does not need.
    if (!s.apify_api_key) {
      this.repos.appState.haltEnrichment('no_api_key', 'No Apify API key is configured.', now.toISOString());
      log.error('enrich', 'halted', { reason: 'no_api_key', pending });
      return;
    }

    log.info('enrich', 'auto-drain starting', { pending, concurrency: s.enrich_concurrency });
    // Fire and forget, exactly as the Start endpoint does: a backfill can run for hours, and
    // the next tick's isEnrichmentRunning() check is what keeps it to one run at a time.
    void runEnrichment(this.repos, {
      client: this.apifyClientFactory(s.apify_api_key),
      concurrency: s.enrich_concurrency,
    }).catch((e: Error) => log.error('enrich', 'auto-drain failed', { error: e.message }));
  }

  /**
   * Sweep the tracked profiles' recent posts, at most once per slot.
   *
   * The gate reads the PERSISTED `posts_swept_at`, which runPostsSweep stamps only on a
   * clean pass — so a failed sweep leaves the stamp untouched and the next 30-minute tick
   * retries it inside the same slot. Same reasoning as the roster sync.
   *
   * `guardrail_tripped` is deliberately NOT a gate: the guardrail means the LinkedIn session
   * is in trouble, and Apify never touches that session. This mirrors runEnrichDrainTick.
   * Please do not "fix" this.
   */
  async runPostsSweepTick(now: Date = new Date()): Promise<void> {
    const s = this.repos.settings.get();
    // Pause is the operator's "stop doing things" switch, so it also stops unattended
    // spending. The manual Sweep now endpoint is the override.
    if (s.paused) return;
    // A latched halt is a problem already reported on the dashboard. Retrying it every 30
    // minutes would hammer Apify and bury the alert in noise.
    if (this.repos.appState.get().posts_halted === 1) return;
    // A sweep can outlast the tick interval, so overlap is prevented explicitly rather than
    // relying on the slot gate (which an unstamped failed pass does not close).
    if (isPostsSweepRunning()) return;

    const app = this.repos.appState.get();
    const slot = daySlot(now, s.posts_sweep_per_day);
    if (app.posts_swept_at
      && daySlot(new Date(app.posts_swept_at), s.posts_sweep_per_day) === slot) return;

    // The steady state must be cheap: one indexed COUNT and nothing else.
    if (this.repos.trackedProfiles.countActive() === 0) return;

    // There is work but no credential. Say so where the operator will see it — but only once
    // something is actually tracked, so a fresh install never nags about a key it needs.
    if (!s.apify_api_key) {
      this.repos.appState.haltPosts('no_api_key', 'No Apify API key is configured.',
        now.toISOString());
      log.error('posts', 'halted', { reason: 'no_api_key' });
      return;
    }

    try {
      await runPostsSweep(this.repos, {
        client: this.apifyPostsClientFactory(s.apify_api_key),
        now,
        maxPosts: s.posts_max_per_sweep,
        batchSize: s.posts_sweep_batch_size,
        retentionDays: s.posts_retention_days,
      });
    } catch (err) {
      this.handleTickError('posts', err);
    }
  }

  /**
   * Run an event campaign whose reserved window is open.
   *
   * Uses the blocking `run` rather than `tryRun`: the window was reserved precisely so
   * this could have the browser, and dropping the run would waste the whole window and
   * push the campaign to tomorrow. A sender tick that collides is the one that gets
   * dropped — which is the trade the reservation exists to make.
   */
  async runEventTick(now: Date = new Date()): Promise<void> {
    const s = this.repos.settings.get();
    if (s.paused || this.repos.appState.get().guardrail_tripped === 1) return;
    if (this.repos.appState.get().login_logged_in !== 1) return;
    const due = dueEventRun(this.repos, now);
    if (due === null) return;
    try {
      await this.browserLock.run(() => runEventCampaign(this.repos, this.driver, due.event, {
        mode: 'live',
        reserved: { from: due.from, to: due.to },
        deadline: new Date(due.to),
        clock: () => new Date(),
      }));
    } catch (err) {
      this.handleTickError('events', err);
    }
  }

  start(): void {
    // Recover rows stranded in 'sending' by a mid-send crash BEFORE re-sorting: a fresh
    // process has nothing genuinely in flight (the browser is in-process), so any 'sending'
    // row is orphaned. Returning it to 'queued' first lets the re-sort re-flow it into a slot.
    recoverOrphanedSending(this.repos);
    // Same reasoning for engagements — but a three-way split, because a task that already
    // reacted must not react again and a task that may have commented must not comment again.
    recoverOrphanedEngagements(this.repos);
    // Same reasoning for enrichment: the worker is in-process, so a fresh process has
    // nothing genuinely in flight. Any row still marked `enriching` was stranded by a hard
    // kill, and without this it would never be claimed again — silently missing from search
    // forever. runEnrichment's own finally-block covers the graceful paths; this covers the
    // ones that never reach a finally.
    const stranded = this.repos.connections.requeueEnriching();
    if (stranded > 0) log.info('enrich', 'recovered stranded rows from a previous run', { count: stranded });
    // Startup re-sort: rebuild the whole backlog to policy so a pile of past-due slots
    // (after downtime) is re-flowed into correctly-sized batches, not fired as a burst.
    // An event run interrupted by a hard kill left a run row open forever. Close it —
    // the campaign itself is restartable from its cursor, which is the durable state.
    for (const r of this.repos.eventRuns.unfinished()) {
      this.repos.eventRuns.finish(r.id, 'failed', r.invited_count, new Date().toISOString(),
        'interrupted by a restart');
      if (this.repos.eventCampaigns.findById(r.event_id)?.status === 'running') {
        this.repos.eventCampaigns.update(r.event_id, { status: 'armed' });
      }
    }
    resortSchedule(this.repos, new Date());
    // Reserve BEFORE planning, on every planning pass: planKind reads reservations to
    // route around them, so a window claimed after the plan would be claimed too late.
    this.timers.push(setInterval(() => {
      const now = new Date();
      ensureEventReservation(this.repos, now);
      planAndAssignToday(this.repos, now);
    }, 60 * 60 * 1000));
    // Fire the event run when its window opens.
    this.timers.push(setInterval(() => { void this.runEventTick(); }, 60 * 1000));
    this.timers.push(setInterval(() => { void this.runSenderTick(); }, 60 * 1000));

    // Keep the dashboard login indicator fresh without ever opening the browser.
    this.timers.push(setInterval(() => {
      void refreshLoginCache(this.repos, this.driver, new Date()).catch((err) => this.handleTickError('login-refresh', err));
    }, 10 * 1000));

    // Every minute: a pure DB read costs nothing, so an accepted invite is reflected within
    // a minute of the roster learning about it.
    this.timers.push(setInterval(() => { void this.runAcceptanceTick(); }, 60 * 1000));
    // Same cadence and the same slot-gate reasoning for the messaging inbox scan.
    this.timers.push(setInterval(() => { void this.runReplyTick(); }, 30 * 60 * 1000));
    // Roster discovery of newly-added connections — same cadence, same slot-gate reasoning.
    this.timers.push(setInterval(() => { void this.runRosterSyncTick(); }, 30 * 60 * 1000));
    // Enrichment staleness sweep. Six-hourly is plenty for a 180-day TTL. Also run once now:
    // on the interval alone, an instance restarted more often than every 6 hours would never
    // sweep at all.
    this.runEnrichRefreshTick();
    this.timers.push(setInterval(() => this.runEnrichRefreshTick(), 6 * 60 * 60 * 1000));
    // The consumer for everything the sweep and the roster sync enqueue. A minute's latency
    // on a newly-discovered connection is invisible, and an idle tick is one indexed COUNT.
    this.timers.push(setInterval(() => { void this.runEnrichDrainTick(); }, 60 * 1000));
    // Posts sweep. 30 minutes for the same reason the roster sync uses it: the slot gate
    // decides how often a sweep actually happens, and a frequent tick is what lets a failed
    // pass retry inside the same slot instead of waiting a whole day.
    this.timers.push(setInterval(() => { void this.runPostsSweepTick(); }, 30 * 60 * 1000));
  }

  stop(): void { this.timers.forEach(clearInterval); this.timers = []; }
}
