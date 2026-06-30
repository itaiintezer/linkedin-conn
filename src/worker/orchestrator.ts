import type { Repos } from '../db/repositories.js';
import type { BrowserDriver } from '../types.js';
import { planAndAssignToday } from './scheduler-service.js';
import { runSenderOnce } from './sender.js';
import { runAcceptanceCheck } from './acceptance-checker.js';

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

  constructor(private repos: Repos, private driver: BrowserDriver) {}

  start(): void {
    planAndAssignToday(this.repos, new Date());
    this.timers.push(setInterval(() => planAndAssignToday(this.repos, new Date()), 60 * 60 * 1000));
    this.timers.push(setInterval(() => { void runSenderOnce(this.repos, this.driver, new Date()); }, 60 * 1000));

    // Keep the dashboard login indicator fresh without ever opening the browser.
    this.timers.push(setInterval(() => { void refreshLoginCache(this.repos, this.driver, new Date()); }, 10 * 1000));

    this.timers.push(setInterval(() => {
      const day = new Date().toDateString();
      const s = this.repos.settings.get();
      const tripped = this.repos.appState.get().guardrail_tripped === 1;
      if (day !== this.lastAcceptanceDay && !s.paused && !tripped) {
        this.lastAcceptanceDay = day;
        void runAcceptanceCheck(this.repos, this.driver, new Date());
      }
    }, 30 * 60 * 1000));
  }

  stop(): void { this.timers.forEach(clearInterval); this.timers = []; }
}
