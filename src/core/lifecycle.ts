/**
 * How the app hands its own lifecycle to the supervisor.
 *
 * The app cannot restart or update itself — a process cannot respawn itself, and `npm install`
 * cannot rewrite node_modules while tsx and esbuild hold their binaries open. So instead it
 * chooses HOW IT DIES, and scripts/supervisor.mjs reads the exit code and does the rest.
 *
 * The codes are duplicated in scripts/supervisor.mjs, which cannot import TypeScript. The test
 * suite asserts the two agree, because a silent divergence would turn "Update" into "quietly
 * stop The Machine until the operator next logs in".
 */
import { readControl, isPending, markFailed, writeControl } from '../../scripts/control-file.mjs';
import type { Mutex } from './mutex.js';

export const EXIT_STOP = 0;
export const EXIT_RESTART = 42;
export const EXIT_UPDATE = 43;

/**
 * How long to wait for in-flight browser work before exiting anyway.
 *
 * Generous on purpose. A single send is a page load, a click and a confirmation read; a
 * "run now" batch spaces its sends 20–90s apart and can legitimately hold the lock for minutes.
 * Cutting it short is the failure this whole mechanism exists to avoid — see drainBrowserLock.
 */
export const DRAIN_TIMEOUT_MS = 5 * 60_000;

/**
 * Waits until no browser work is in flight, or until the timeout.
 *
 * THIS IS THE LOAD-BEARING SAFETY STEP of the update button. Exiting between "clicked Connect on
 * LinkedIn" and "wrote the send to the database" means LinkedIn has an invite we have no record
 * of — so the profile stays queued and that person gets a second, identical request days later.
 * Everything else about an interrupted update is recoverable; that is not.
 *
 * Queues an empty job on the same mutex every other browser task uses, so it resolves only once
 * the task ahead of it has finished. Returns false if the timeout won, which the caller logs —
 * we still exit, because refusing to ever update is its own failure, but the operator's log
 * says the exit was not clean.
 */
export async function drainBrowserLock(lock: Mutex, timeoutMs: number = DRAIN_TIMEOUT_MS): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  // If the timeout wins, this queued no-op still runs later and releases immediately. Harmless.
  const drained = lock.run(async () => true as const);
  try {
    return (await Promise.race([drained, timedOut])) === true;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Called once at boot. A control file still marked requested/running means nobody is going to
 * finish it — either there is no supervisor (someone ran the app directly), or the supervisor
 * died mid-update. Either way the dashboard must not sit forever showing "Updating…".
 */
export function reconcileControlOnBoot(
  dataDir: string,
  { supervised, now = new Date() }: { supervised: boolean; now?: Date },
): 'none' | 'abandoned' {
  const control = readControl(dataDir);
  if (!isPending(control) || !control) return 'none';
  writeControl(dataDir, markFailed(
    control,
    supervised
      ? 'The update stopped partway through. The Machine is running the version it had before.'
      : 'The Machine was started by hand, so there was nothing to carry the update out. Nothing was changed.',
    now.toISOString(),
  ));
  return 'abandoned';
}
