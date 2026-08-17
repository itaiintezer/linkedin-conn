import type { Repos } from '../db/repositories.js';
import type { BrowserDriver } from '../types.js';
import { isTripped, tripLoginLost, recordReadError, recordSuccess } from './guardrail.js';
import { log } from '../core/log.js';

/**
 * Outcome of one roster pass. `ran` is true only when we actually read the connections
 * page and upserted; every early return sets `ran: false` with a `reason` so callers
 * (e.g. the manual "Sync now" endpoint) can report what happened.
 */
export interface RosterSyncResult {
  ran: boolean;
  reason?: 'paused' | 'guardrail' | 'logged_out' | 'login_lost' | 'read_error' | 'empty_read';
  /** Cards read off the page. */
  seen: number;
  /** Cards that were not already in the roster. */
  discovered: number;
  syncedAt?: string;
}

/**
 * Read the connections page and upsert everyone found into the roster.
 *
 * Deliberately mirrors acceptance-checker.ts's safety structure — same gates, same
 * empty-read fail-safe, same "stamp only on a clean pass so a failure retries next tick"
 * contract — with two differences:
 *
 *  1. There is NO "nothing pending" early return. The roster must stay fresh whether or
 *     not any invite is awaiting acceptance; breaking that coupling is why this worker
 *     exists.
 *  2. It only ever ADDS. Absence from the page never removes anyone (see the 2026-07-31
 *     design doc — removals are not tracked), so a partial read can under-discover but
 *     can never destroy data.
 *
 * Phase 1 note: the acceptance checker still performs its own independent read of the
 * same page. That duplication is intentional and temporary — it keeps a live pipeline off
 * unproven code — and is removed by the phase-3 cutover.
 */
export async function runRosterSync(
  repos: Repos,
  driver: BrowserDriver,
  now: Date,
  opts: { force?: boolean } = {},
): Promise<RosterSyncResult> {
  // `force` (manual sync) bypasses ONLY the paused gate — this pass is read-only against
  // LinkedIn. Every other safety gate below is unconditional.
  if (!opts.force && repos.settings.get().paused) return { ran: false, reason: 'paused', seen: 0, discovered: 0 };
  if (isTripped(repos)) return { ran: false, reason: 'guardrail', seen: 0, discovered: 0 };
  if (repos.appState.get().login_logged_in !== 1) return { ran: false, reason: 'logged_out', seen: 0, discovered: 0 };

  // Committing to act: confirm login live (opens the browser) and refresh the cache.
  const snap = await driver.readLoginState();
  repos.appState.setLogin(snap, now.toISOString());
  if (!snap.loggedIn) {
    tripLoginLost(repos, now);
    return { ran: false, reason: 'login_lost', seen: 0, discovered: 0 };
  }

  let cards;
  try {
    cards = await driver.readConnectionCards();
  } catch (e) {
    // Checkpoint text trips immediately; other read failures count toward the streak
    // (offline failures are forgiven — see recordFailure).
    await recordReadError(repos, (e as Error).message ?? 'roster read failed', now);
    return { ran: false, reason: 'read_error', seen: 0, discovered: 0 };
  }

  // Fail-safe: a suspiciously empty read (page didn't render, UI changed, rate-limited)
  // must never be treated as a successful pass. Skip it so the next tick retries.
  if (cards.length === 0) {
    log.warn('roster', 'connections read returned nothing — skipping (no state change)');
    return { ran: false, reason: 'empty_read', seen: 0, discovered: 0 };
  }

  const iso = now.toISOString();
  let discovered = 0;
  for (const card of cards) {
    const outcome = repos.connections.upsert({ profile_url: card.url, full_name: card.name }, 'scrape', iso);
    if (outcome === 'inserted') discovered++;
  }

  repos.appState.setRosterSynced(iso);
  recordSuccess(repos); // a clean read clears any accumulated streak
  log.info('roster', 'synced', { seen: cards.length, discovered });
  return { ran: true, seen: cards.length, discovered, syncedAt: iso };
}
