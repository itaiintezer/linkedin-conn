import type { Repos } from '../db/repositories.js';
import type { BrowserDriver } from '../types.js';
import { isTripped, tripLoginLost, recordReadError, recordSuccess } from './guardrail.js';
import { log } from '../core/log.js';

/** Outcome of a reply pass — mirrors AcceptanceRunResult so the UI can reuse its wording. */
export interface ReplyRunResult {
  ran: boolean;
  reason?: 'paused' | 'guardrail' | 'no_pending' | 'logged_out' | 'login_lost' | 'read_error' | 'empty_read';
  replied: number;
  checkedAt?: string;
}

/**
 * One reply pass: a single navigation to the messaging inbox, then match conversation
 * rows to pending (status 'sent', kind 'message') profiles by the display name captured
 * at send time. A row whose last message was NOT ours ("You:" prefix absent) is a reply.
 * Upgrade-only: nothing here can ever un-reply or expire anything (acceptance lesson).
 */
export async function runReplyCheck(
  repos: Repos,
  driver: BrowserDriver,
  now: Date,
  opts: { force?: boolean } = {},
): Promise<ReplyRunResult> {
  if (!opts.force && repos.settings.get().paused) return { ran: false, reason: 'paused', replied: 0 };
  if (isTripped(repos)) return { ran: false, reason: 'guardrail', replied: 0 };

  const pending = repos.profiles.byStatusKind('sent', 'message');
  if (pending.length === 0) return { ran: false, reason: 'no_pending', replied: 0 };

  if (repos.appState.get().login_logged_in !== 1) return { ran: false, reason: 'logged_out', replied: 0 };
  const snap = await driver.readLoginState();
  repos.appState.setLogin(snap, now.toISOString());
  if (!snap.loggedIn) { tripLoginLost(repos, now); return { ran: false, reason: 'login_lost', replied: 0 }; }

  let rows;
  try {
    rows = await driver.readInboxSnapshot();
  } catch (e) {
    recordReadError(repos, (e as Error).message ?? 'inbox read failed', now);
    return { ran: false, reason: 'read_error', replied: 0 };
  }

  // Fail-safe: an empty inbox read means the page didn't render (a real inbox that has
  // pending outbound messages is never empty) — no state change, no slot stamp, retry later.
  if (rows.length === 0) {
    log.warn('replies', 'inbox read returned nothing — skipping (no state change)');
    return { ran: false, reason: 'empty_read', replied: 0 };
  }

  // Group pending by display name; a name shared by 2+ pending contacts is ambiguous and
  // is left pending (fail-safe — thread_url is stored if a per-thread check is ever needed).
  const norm = (s: string) => s.trim().toLowerCase();
  const byName = new Map<string, typeof pending>();
  for (const p of pending) {
    if (!p.full_name) continue; // no name captured at send time — cannot match
    const k = norm(p.full_name);
    byName.set(k, [...(byName.get(k) ?? []), p]);
  }

  const iso = now.toISOString();
  let replied = 0;
  for (const row of rows) {
    if (row.youSentLast) continue;
    const matches = byName.get(norm(row.name));
    if (!matches) continue;
    if (matches.length > 1) {
      log.warn('replies', 'ambiguous display name — leaving pending', { name: row.name, count: matches.length });
      continue;
    }
    const p = matches[0];
    repos.profiles.setStatus(p.id, 'replied', { replied_at: iso, resolved_at: iso });
    repos.events.recordEvent(p.id, 'replied');
    log.info('replies', 'verdict', { profile: p.id, url: p.profile_url, verdict: 'replied' });
    replied++;
  }

  repos.appState.setRepliesChecked(iso);
  recordSuccess(repos); // a clean read clears any accumulated streak
  log.info('replies', 'checked', { replied, rows: rows.length, pending: pending.length });
  return { ran: true, replied, checkedAt: iso };
}
