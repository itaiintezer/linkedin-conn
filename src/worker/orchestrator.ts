import type { Repos } from '../db/repositories.js';
import type { BrowserDriver } from '../types.js';
import { Mutex } from '../core/mutex.js';
import { planAndAssignToday } from './scheduler-service.js';
import { runSenderOnce } from './sender.js';
import { runAcceptanceCheck } from './acceptance-checker.js';
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

export class Orchestrator {
  private timers: ReturnType<typeof setInterval>[] = [];
  private lastAcceptanceDay = '';

  /**
   * `browserLock` is shared with the API server (run-now) so that the sender, the
   * acceptance reader and the manual trigger never drive the single browser page
   * concurrently — concurrent navigations abort each other (net::ERR_ABORTED).
   */
  constructor(
    private repos: Repos,
    private driver: BrowserDriver,
    private browserLock: Mutex = new Mutex(),
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
  async runSenderTick(): Promise<void> {
    try {
      await this.browserLock.tryRun(() => runSenderOnce(this.repos, this.driver, new Date()));
    } catch (err) {
      this.handleTickError('sender', err);
    }
  }

  /** Daily acceptance pass. Queues behind any in-flight browser work (must not be skipped). */
  runAcceptanceTick(): void {
    const day = new Date().toDateString();
    const s = this.repos.settings.get();
    const tripped = this.repos.appState.get().guardrail_tripped === 1;
    if (day !== this.lastAcceptanceDay && !s.paused && !tripped) {
      this.lastAcceptanceDay = day;
      void this.browserLock.run(() => runAcceptanceCheck(this.repos, this.driver, new Date()))
        .catch((err) => this.handleTickError('acceptance', err));
    }
  }

  start(): void {
    planAndAssignToday(this.repos, new Date());
    this.timers.push(setInterval(() => planAndAssignToday(this.repos, new Date()), 60 * 60 * 1000));
    this.timers.push(setInterval(() => { void this.runSenderTick(); }, 60 * 1000));

    // Keep the dashboard login indicator fresh without ever opening the browser.
    this.timers.push(setInterval(() => {
      void refreshLoginCache(this.repos, this.driver, new Date()).catch((err) => this.handleTickError('login-refresh', err));
    }, 10 * 1000));

    this.timers.push(setInterval(() => this.runAcceptanceTick(), 30 * 60 * 1000));
  }

  stop(): void { this.timers.forEach(clearInterval); this.timers = []; }
}
