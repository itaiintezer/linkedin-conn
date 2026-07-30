import type { Repos } from '../db/repositories.js';
import { computeAccepted, computeExpiredByAge } from '../core/acceptance.js';
import { isTripped } from './guardrail.js';
import { log } from '../core/log.js';

/**
 * Outcome of a single acceptance pass. `ran` is true only when we actually read the
 * connections list and applied verdicts; every early return sets `ran: false` with a
 * `reason` so callers (e.g. the manual recheck endpoint) can report what happened.
 */
export interface AcceptanceRunResult {
  ran: boolean;
  reason?: 'paused' | 'guardrail' | 'no_pending' | 'empty_roster';
  accepted: number;
  expired: number;
  checkedAt?: string;
}

/**
 * Resolve pending invites against the connection roster.
 *
 * Since the phase-3 cutover (2026-07-31) this touches NO browser and no network: roster-sync
 * owns the connections-page read, and this pass just asks "is this sent invite's URL in the
 * roster yet?". That is why it takes no driver and is synchronous in spirit.
 */
export async function runAcceptanceCheck(
  repos: Repos,
  now: Date,
  opts: { force?: boolean } = {},
): Promise<AcceptanceRunResult> {
  // `force` (manual on-demand recheck) bypasses ONLY the paused gate.
  if (!opts.force && repos.settings.get().paused) return { ran: false, reason: 'paused', accepted: 0, expired: 0 };
  if (isTripped(repos)) return { ran: false, reason: 'guardrail', accepted: 0, expired: 0 };

  // Nothing to verify -> stay dark (DB only, no browser). Kind-scoped to 'invite':
  // message-kind 'sent' rows belong to the reply funnel (see reply-checker.ts) and
  // must never be promoted to 'accepted'/'expired' by this pass.
  const sent = repos.profiles.byStatusKind('sent', 'invite').map((p) => ({ id: p.id, profile_url: p.profile_url, sent_at: p.sent_at }));
  if (sent.length === 0) return { ran: false, reason: 'no_pending', accepted: 0, expired: 0 };

  // The roster IS the connections list now (phase-3 cutover, 2026-07-31). This pass no
  // longer opens a browser or scrapes anything: roster-sync owns that read, and acceptance
  // just asks "is this sent invite's URL in the roster yet?".
  //
  // The safety properties are unchanged, because the roster is append-only and only ever
  // written from a clean, non-empty scrape:
  //   - A failed or empty roster read writes nothing, so acceptance simply sees no new
  //     rows — an undercount, never a false accept.
  //   - Absence still means nothing. Expiry comes only from the deterministic age backstop.
  // What changes is cost: this is now a pure DB read, so it can run on every tick instead
  // of twice a day, and detection latency is bounded by roster_sync_per_day alone.
  const connections = repos.connections.allUrls();

  // Fail-safe retained in spirit: an empty roster means the roster has never been populated
  // (fresh install, import not yet run), not that nobody accepted. Change nothing.
  if (connections.size === 0) {
    log.warn('acceptance', 'roster is empty — skipping (no state change)');
    return { ran: false, reason: 'empty_roster', accepted: 0, expired: 0 };
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
  // No recordSuccess here any more: this pass performs no network I/O, so it is not evidence
  // that LinkedIn is healthy and must not clear a failure streak the sender accumulated.
  log.info('acceptance', 'checked', { accepted: accepted.length, expired: expired.length, connections: connections.size });
  return { ran: true, accepted: accepted.length, expired: expired.length, checkedAt: iso };
}
