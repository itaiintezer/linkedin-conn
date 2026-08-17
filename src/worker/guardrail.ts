import type { Repos } from '../db/repositories.js';
import { isOfflineError, isAmbiguousNetworkError, probeOnline } from '../core/offline.js';
import { log } from '../core/log.js';

const CHECKPOINT_RE = /captcha|checkpoint|verify you|unusual activity|security check/i;

/** What recordFailure decided about one failure:
 *  'offline' — the machine had no working network, so the failure says nothing about
 *              LinkedIn; the streak was left untouched and the caller should retry later.
 *  'counted' — a real failure, streak incremented, still below the threshold.
 *  'tripped' — the streak reached the threshold and the guardrail latched. */
export type FailureVerdict = 'offline' | 'counted' | 'tripped';

export function isTripped(repos: Repos): boolean {
  return repos.appState.get().guardrail_tripped === 1;
}

export function tripCheckpoint(repos: Repos, now: Date, detail = 'Captcha/checkpoint detected'): void {
  log.warn('guardrail', 'tripped checkpoint', { detail });
  repos.appState.trip('checkpoint', detail, now.toISOString());
}

export function tripLoginLost(repos: Repos, now: Date): void {
  log.warn('guardrail', 'tripped login_lost');
  repos.appState.trip('login_lost', 'LinkedIn session lost (li_at cookie missing)', now.toISOString());
}

/**
 * Count one failed send/read toward the consecutive-failure streak and trip
 * 'repeated_failures' once it reaches settings.failure_threshold.
 *
 * EXCEPT when the machine itself is offline: a sleeping laptop or a dropped connection
 * produces browser errors of the same shape as real breakage, and counting them latched
 * six false halts between 2026-08-07 and 2026-08-16 (the reply checker retries every 30
 * minutes, so ~90 minutes of closed lid reached the threshold of 3). Errors that can
 * ONLY mean "we are offline" are forgiven outright; network-shaped errors that could be
 * either side (timeouts, resets) are settled by `probe` — a DNS lookup at failure time.
 * A forgiven failure leaves the streak untouched and relies on the caller's existing
 * retry loop to recover once the machine is back online.
 *
 * `probe` is injectable for tests only; production always uses the real DNS probe.
 */
export async function recordFailure(
  repos: Repos, detail: string, now: Date,
  probe: () => Promise<boolean> = probeOnline,
): Promise<FailureVerdict> {
  if (isOfflineError(detail)) {
    log.warn('guardrail', 'offline failure — not counted toward the streak', { detail });
    return 'offline';
  }
  if (isAmbiguousNetworkError(detail) && !(await probe())) {
    log.warn('guardrail', 'failure while the machine is offline — not counted toward the streak', { detail });
    return 'offline';
  }
  const streak = repos.appState.incFailureStreak();
  const threshold = repos.settings.get().failure_threshold;
  if (streak >= threshold) {
    log.warn('guardrail', 'tripped repeated_failures', { detail, streak });
    repos.appState.trip('repeated_failures', detail, now.toISOString());
    return 'tripped';
  }
  return 'counted';
}

/**
 * Resets the consecutive-failure streak. Called by every clean LinkedIn interaction —
 * not just sends: the acceptance and reply readers call it too, so a successful READ
 * clears a streak that failing SENDS accumulated.
 *
 * Tradeoff (pre-existing, deliberate for now): that makes the guardrail forgiving, since
 * a twice-daily read can keep resetting a send path that is quietly failing below the
 * threshold — but it also stops a transient send blip from halting the whole engine while
 * LinkedIn is demonstrably still reachable.
 */
export function recordSuccess(repos: Repos): void {
  repos.appState.resetFailureStreak();
}

/**
 * A read-path failure: checkpoint/captcha text trips immediately; any other
 * error counts toward the streak (so a one-off blip doesn't halt everything) —
 * subject to recordFailure's offline forgiveness, which is what keeps the reply
 * checker's 30-minute retry loop from halting the engine over a sleeping machine.
 */
export async function recordReadError(
  repos: Repos, message: string, now: Date,
  probe?: () => Promise<boolean>,
): Promise<void> {
  if (CHECKPOINT_RE.test(message)) {
    tripCheckpoint(repos, now);
    return;
  }
  await recordFailure(repos, message, now, probe);
}
