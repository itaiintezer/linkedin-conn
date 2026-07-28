import type { Repos } from '../db/repositories.js';
import { log } from '../core/log.js';

const CHECKPOINT_RE = /captcha|checkpoint|verify you|unusual activity|security check/i;

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
 * Returns true if the guardrail is now tripped.
 */
export function recordFailure(repos: Repos, detail: string, now: Date): boolean {
  const streak = repos.appState.incFailureStreak();
  const threshold = repos.settings.get().failure_threshold;
  if (streak >= threshold) {
    log.warn('guardrail', 'tripped repeated_failures', { detail, streak });
    repos.appState.trip('repeated_failures', detail, now.toISOString());
    return true;
  }
  return false;
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
 * error counts toward the streak (so a one-off blip doesn't halt everything).
 */
export function recordReadError(repos: Repos, message: string, now: Date): void {
  if (CHECKPOINT_RE.test(message)) {
    tripCheckpoint(repos, now);
    return;
  }
  recordFailure(repos, message, now);
}
