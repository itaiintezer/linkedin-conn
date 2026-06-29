import type { Repos } from '../db/repositories.js';
import type { BrowserDriver } from '../types.js';
import { planAndAssignToday } from './scheduler-service.js';
import { runSenderOnce } from './sender.js';
import { runAcceptanceCheck } from './acceptance-checker.js';

export class Orchestrator {
  private timers: ReturnType<typeof setInterval>[] = [];
  private lastAcceptanceDay = '';

  constructor(private repos: Repos, private driver: BrowserDriver) {}

  start(): void {
    planAndAssignToday(this.repos, new Date());
    this.timers.push(setInterval(() => planAndAssignToday(this.repos, new Date()), 60 * 60 * 1000));
    this.timers.push(setInterval(() => { void runSenderOnce(this.repos, this.driver, new Date()); }, 60 * 1000));
    this.timers.push(setInterval(() => {
      const day = new Date().toDateString();
      const s = this.repos.settings.get();
      if (day !== this.lastAcceptanceDay && !s.paused) {
        this.lastAcceptanceDay = day;
        void runAcceptanceCheck(this.repos, this.driver, new Date());
      }
    }, 30 * 60 * 1000));
  }

  stop(): void { this.timers.forEach(clearInterval); this.timers = []; }
}
