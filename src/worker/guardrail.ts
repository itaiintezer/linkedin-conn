import type { Repos } from '../db/repositories.js';

const CHECKPOINT_RE = /captcha|checkpoint|verify you|unusual activity|security check/i;

export function isTripped(repos: Repos): boolean {
  return repos.appState.get().guardrail_tripped === 1;
}

export function tripCheckpoint(repos: Repos, now: Date): void {
  repos.appState.trip('checkpoint', 'Captcha/checkpoint detected', now.toISOString());
}

export function tripLoginLost(repos: Repos, now: Date): void {
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
    repos.appState.trip('repeated_failures', detail, now.toISOString());
    return true;
  }
  return false;
}

/** A clean send resets the failure streak. */
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
