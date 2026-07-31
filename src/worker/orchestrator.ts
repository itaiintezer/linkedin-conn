import type { Repos } from '../db/repositories.js';
import type { BrowserDriver } from '../types.js';
import { Mutex } from '../core/mutex.js';
import { planAndAssignToday, requeueOverdue, resortSchedule, recoverOrphanedSending } from './scheduler-service.js';
import { runSenderOnce, type SenderOptions } from './sender.js';
import { runAcceptanceCheck } from './acceptance-checker.js';
import { runReplyCheck } from './reply-checker.js';
import { runRosterSync } from './roster-sync.js';
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
 * Identify which acceptance slot a moment falls in. The day is divided into
 * `checksPerDay` equal slots and at most one successful pass runs per slot, so
 * checks are spread across the day (2/day = morning + afternoon) instead of
 * bunching into consecutive ticks. Computed in LOCAL time — the operator thinks
 * in local days. A nonsensical setting degrades to one check per day.
 */
export function acceptanceSlot(when: Date, checksPerDay: number): string {
  const n = Math.min(24, Math.max(1, Math.floor(checksPerDay) || 1));
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
   * `acceptance_checks_per_day` is retained in settings only for backwards compatibility;
   * nothing reads it any more.
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
   * acceptanceSlot — it is a generic day-slicer). The gate reads the PERSISTED
   * replies_checked_at, which runReplyCheck stamps only on a clean, non-empty read — a
   * bailed-out pass leaves the stamp untouched so the next 30-minute tick retries
   * (acceptance-checker lesson). Queues behind in-flight browser work rather than being
   * dropped, for the same reason the acceptance tick does.
   */
  async runReplyTick(now: Date = new Date()): Promise<void> {
    const s = this.repos.settings.get();
    const app = this.repos.appState.get();
    if (s.paused || app.guardrail_tripped === 1) return;
    const slot = acceptanceSlot(now, s.reply_checks_per_day);
    if (app.replies_checked_at
      && acceptanceSlot(new Date(app.replies_checked_at), s.reply_checks_per_day) === slot) return;
    try {
      await this.browserLock.run(() => runReplyCheck(this.repos, this.driver, now));
    } catch (err) {
      this.handleTickError('replies', err);
    }
  }

  /**
   * Roster pass, at most once per slot (slot math shared with acceptance/reply checks via
   * acceptanceSlot — it is a generic day-slicer). The gate reads the PERSISTED
   * `roster_synced_at`, which runRosterSync stamps only on a clean, non-empty read, so a
   * bailed-out pass leaves the stamp untouched and the next 30-minute tick retries.
   * Queues behind in-flight browser work rather than being dropped, for the same reason
   * the acceptance tick does.
   */
  async runRosterSyncTick(now: Date = new Date()): Promise<void> {
    const s = this.repos.settings.get();
    const app = this.repos.appState.get();
    if (s.paused || app.guardrail_tripped === 1) return;
    const slot = acceptanceSlot(now, s.roster_sync_per_day);
    if (app.roster_synced_at
      && acceptanceSlot(new Date(app.roster_synced_at), s.roster_sync_per_day) === slot) return;
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

  start(): void {
    // Recover rows stranded in 'sending' by a mid-send crash BEFORE re-sorting: a fresh
    // process has nothing genuinely in flight (the browser is in-process), so any 'sending'
    // row is orphaned. Returning it to 'queued' first lets the re-sort re-flow it into a slot.
    recoverOrphanedSending(this.repos);
    // Same reasoning for enrichment: the worker is in-process, so a fresh process has
    // nothing genuinely in flight. Any row still marked `enriching` was stranded by a hard
    // kill, and without this it would never be claimed again — silently missing from search
    // forever. runEnrichment's own finally-block covers the graceful paths; this covers the
    // ones that never reach a finally.
    const stranded = this.repos.connections.requeueEnriching();
    if (stranded > 0) log.info('enrich', 'recovered stranded rows from a previous run', { count: stranded });
    // Startup re-sort: rebuild the whole backlog to policy so a pile of past-due slots
    // (after downtime) is re-flowed into correctly-sized batches, not fired as a burst.
    resortSchedule(this.repos, new Date());
    this.timers.push(setInterval(() => planAndAssignToday(this.repos, new Date()), 60 * 60 * 1000));
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
    // Enrichment staleness sweep. Six-hourly is plenty for a 180-day TTL, and it only moves
    // rows back to `pending` — the operator still decides when to spend.
    this.timers.push(setInterval(() => this.runEnrichRefreshTick(), 6 * 60 * 60 * 1000));
  }

  stop(): void { this.timers.forEach(clearInterval); this.timers = []; }
}
