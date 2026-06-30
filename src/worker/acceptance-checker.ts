import type { Repos } from '../db/repositories.js';
import type { BrowserDriver } from '../types.js';
import { computeAcceptanceTransitions } from '../core/acceptance.js';
import { isTripped, tripLoginLost, recordReadError, recordSuccess } from './guardrail.js';

export async function runAcceptanceCheck(repos: Repos, driver: BrowserDriver, now: Date): Promise<void> {
  if (repos.settings.get().paused) return;
  if (isTripped(repos)) return;

  // Nothing to verify -> stay dark (DB only, no browser).
  const sent = repos.profiles.byStatus('sent').map((p) => ({ id: p.id, profile_url: p.profile_url }));
  if (sent.length === 0) return;

  if (repos.appState.get().login_logged_in !== 1) return;

  // Committing to act: confirm login live (opens the browser) and refresh the cache.
  const snap = await driver.readLoginState();
  repos.appState.setLogin(snap, now.toISOString());
  if (!snap.loggedIn) { tripLoginLost(repos, now); return; }

  let pending: Set<string>;
  let connections: Set<string>;
  try {
    pending = new Set(await driver.readPendingInvites());
    connections = new Set(await driver.readRecentConnections());
  } catch (e) {
    // Checkpoint text trips immediately; other read failures count toward the streak.
    recordReadError(repos, (e as Error).message ?? 'acceptance read failed', now);
    return;
  }

  const { accepted, expired } = computeAcceptanceTransitions(sent, pending, connections);
  const iso = now.toISOString();
  for (const id of accepted) {
    repos.profiles.setStatus(id, 'accepted', { accepted_at: iso, resolved_at: iso });
    repos.events.recordEvent(id, 'accepted');
  }
  for (const id of expired) {
    repos.profiles.setStatus(id, 'expired', { resolved_at: iso });
    repos.events.recordEvent(id, 'expired');
  }
  recordSuccess(repos); // a clean read clears any accumulated streak
}
