/**
 * A minimal async mutex for serializing browser-driving work.
 *
 * The sender, the acceptance reader and the "run now" trigger all drive a single
 * shared browser page. Running two of them at once makes their concurrent
 * `page.goto` calls abort each other (net::ERR_ABORTED). This mutex ensures only
 * one such operation touches the page at a time.
 *
 * - `run(fn)` waits its turn, then runs fn exclusively (use for must-not-skip work).
 * - `tryRun(fn)` runs fn only if the lock is free right now, else skips (use for the
 *   periodic sender tick, where an overlapping tick should simply be dropped).
 */
export class Mutex {
  private locked = false;
  private waiters: Array<() => void> = [];

  get isLocked(): boolean {
    return this.locked;
  }

  private acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next(); // hand the lock directly to the next waiter; `locked` stays true
    } else {
      this.locked = false;
    }
  }

  /** Acquire the lock (waiting if held), run fn to completion, then release. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /** Run fn only if the lock is free right now; otherwise skip and return undefined. */
  async tryRun<T>(fn: () => Promise<T>): Promise<T | undefined> {
    if (this.locked) return undefined;
    return this.run(fn);
  }
}
