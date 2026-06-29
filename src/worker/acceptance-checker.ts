import type { Repos } from '../db/repositories.js';
import type { BrowserDriver } from '../types.js';
import { computeAcceptanceTransitions } from '../core/acceptance.js';

export async function runAcceptanceCheck(repos: Repos, driver: BrowserDriver, now: Date): Promise<void> {
  if (repos.settings.get().paused) return;
  if (!(await driver.isLoggedIn())) return;

  const sent = repos.profiles.byStatus('sent').map((p) => ({ id: p.id, profile_url: p.profile_url }));
  if (sent.length === 0) return;

  const pending = new Set(await driver.readPendingInvites());
  const connections = new Set(await driver.readRecentConnections());
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
}
