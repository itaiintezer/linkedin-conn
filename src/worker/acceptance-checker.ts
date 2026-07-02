import type { Repos } from '../db/repositories.js';
import type { BrowserDriver } from '../types.js';
import { computeAccepted, computeExpiredByAge } from '../core/acceptance.js';
import { isTripped, tripLoginLost, recordReadError, recordSuccess } from './guardrail.js';
import { log } from '../core/log.js';

export async function runAcceptanceCheck(repos: Repos, driver: BrowserDriver, now: Date): Promise<void> {
  if (repos.settings.get().paused) return;
  if (isTripped(repos)) return;

  // Nothing to verify -> stay dark (DB only, no browser).
  const sent = repos.profiles.byStatus('sent').map((p) => ({ id: p.id, profile_url: p.profile_url, sent_at: p.sent_at }));
  if (sent.length === 0) return;

  if (repos.appState.get().login_logged_in !== 1) return;

  // Committing to act: confirm login live (opens the browser) and refresh the cache.
  const snap = await driver.readLoginState();
  repos.appState.setLogin(snap, now.toISOString());
  if (!snap.loggedIn) { tripLoginLost(repos, now); return; }

  // We only READ the connections list — a new acceptance surfaces at the top of
  // "recently added", so the top slice is the right place to look. We intentionally
  // do NOT read the sent-invitations list to infer expiry: it is huge and only its
  // newest page loads, so absence there is not evidence an invite is gone
  // (see core/acceptance.ts).
  let connections: Set<string>;
  try {
    connections = new Set(await driver.readRecentConnections());
  } catch (e) {
    // Checkpoint text trips immediately; other read failures count toward the streak.
    recordReadError(repos, (e as Error).message ?? 'acceptance read failed', now);
    return;
  }

  // Fail-safe: a suspiciously empty read (page didn't render, UI changed, rate-limited)
  // must never drive state changes. Skip the run rather than mark anything.
  if (connections.size === 0) {
    log.warn('acceptance', 'connections read returned nothing — skipping (no state change)');
    return;
  }

  const iso = now.toISOString();
  const urlById = new Map(sent.map((r) => [r.id, r.profile_url]));
  const accepted = computeAccepted(sent, connections);
  for (const id of accepted) {
    repos.profiles.setStatus(id, 'accepted', { accepted_at: iso, resolved_at: iso });
    repos.events.recordEvent(id, 'accepted');
    log.info('acceptance', 'verdict', { profile: id, url: urlById.get(id) ?? '', verdict: 'accepted' });
  }

  // Deterministic, scrape-free expiry backstop (disabled by default via expiry_days=0),
  // excluding anyone we just accepted.
  const acceptedSet = new Set(accepted);
  const stillPending = sent.filter((r) => !acceptedSet.has(r.id));
  const expired = computeExpiredByAge(stillPending, now, repos.settings.get().expiry_days);
  for (const id of expired) {
    repos.profiles.setStatus(id, 'expired', { resolved_at: iso });
    repos.events.recordEvent(id, 'expired');
    log.info('acceptance', 'verdict', { profile: id, url: urlById.get(id) ?? '', verdict: 'expired (age backstop)' });
  }

  repos.appState.setAcceptanceChecked(iso);
  recordSuccess(repos); // a clean read clears any accumulated streak
  log.info('acceptance', 'checked', { accepted: accepted.length, expired: expired.length, connections: connections.size });
}
