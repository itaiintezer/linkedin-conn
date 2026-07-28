import type { Repos } from '../db/repositories.js';
import type { BrowserDriver, InboxRow, Profile } from '../types.js';
import { isTripped, tripLoginLost, recordReadError, recordSuccess } from './guardrail.js';
import { canonicalName, firstLastKey } from '../core/name-match.js';
import { log } from '../core/log.js';

/** Outcome of a reply pass — mirrors AcceptanceRunResult so the UI can reuse its wording. */
export interface ReplyRunResult {
  ran: boolean;
  reason?: 'paused' | 'guardrail' | 'no_pending' | 'logged_out' | 'login_lost' | 'read_error' | 'empty_read';
  replied: number;
  checkedAt?: string;
}

/** Normalize a thread URL for comparison: ignore query/hash, drop a trailing slash,
 *  lowercase. Two hrefs pointing at the same conversation can differ in exactly these
 *  ways (LinkedIn appends a `?convo=`-style query param inconsistently). */
function normalizeThreadUrl(u: string): string {
  let s = u.trim().replace(/[?#].*$/, '');
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return s.toLowerCase();
}

type MatchVia = 'thread' | 'canonical' | 'firstlast';
interface RowMatch { row: InboxRow; profile: Profile; via: MatchVia; }

/**
 * One reply pass: a single navigation to the messaging inbox, then match conversation
 * rows to pending (status 'sent', kind 'message') profiles. A row whose last message
 * was NOT ours ("You:" prefix absent) is a candidate reply. Upgrade-only: nothing here
 * can ever un-reply or expire anything (acceptance-checker lesson).
 *
 * Matching is layered, most to least reliable:
 *   1) thread_url — exact, name-independent. Preferred because the display name
 *      captured at send time (from the profile-page title) can differ from what the
 *      inbox renders for the same person (live discovery: "Keren (Yosef) Tevet" vs.
 *      "Keren Tevet") — name matching alone would silently miss a real reply.
 *   2) canonical full name — Unicode-normalized, parentheticals/credential suffixes/
 *      exotic whitespace stripped (see core/name-match.ts).
 *   3) first+last token of the canonical name — the loosest fallback, still an exact
 *      token comparison (no fuzzing).
 * The ambiguity guard for (2)/(3) is keyed off the canonical name so the looser (3)
 * comparison can never hide a collision that (2) would have caught.
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

  let rows: InboxRow[];
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

  // --- Build the matching index over pending profiles ---------------------------------
  const byThreadUrl = new Map<string, Profile>();
  const byCanonical = new Map<string, Profile[]>();
  const byFirstLast = new Map<string, Profile[]>();
  for (const p of pending) {
    if (p.thread_url) byThreadUrl.set(normalizeThreadUrl(p.thread_url), p);
    if (p.full_name) {
      const canon = canonicalName(p.full_name);
      byCanonical.set(canon, [...(byCanonical.get(canon) ?? []), p]);
      const fl = firstLastKey(canon);
      byFirstLast.set(fl, [...(byFirstLast.get(fl) ?? []), p]);
    }
    if (!p.thread_url && !p.full_name) {
      // Currently unmatchable by any key — logged once (this function runs once per
      // pass) so a silently-stuck contact shows up somewhere instead of nowhere.
      log.debug('replies', 'pending profile has neither full_name nor thread_url — unmatchable', {
        profile: p.id, url: p.profile_url,
      });
    }
  }

  // --- Resolve each inbox row to at most one profile, or flag it ambiguous ------------
  const clean: RowMatch[] = [];
  let ambiguous = 0;
  for (const row of rows) {
    if (row.youSentLast) continue;

    if (row.threadUrl) {
      const p = byThreadUrl.get(normalizeThreadUrl(row.threadUrl));
      if (p) { clean.push({ row, profile: p, via: 'thread' }); continue; }
      // No pending profile has this thread_url captured — fall through to name matching
      // rather than giving up (thread_url may simply not have been recorded at send time).
    }

    const canon = canonicalName(row.name);
    let candidates = byCanonical.get(canon);
    let via: MatchVia = 'canonical';
    if (!candidates) {
      candidates = byFirstLast.get(firstLastKey(canon));
      via = 'firstlast';
    }
    if (!candidates || candidates.length === 0) continue; // no match at all
    if (candidates.length > 1) {
      ambiguous++;
      log.warn('replies', 'ambiguous display name — leaving pending', {
        name: row.name, via, profiles: candidates.map((c) => c.id),
      });
      continue;
    }
    clean.push({ row, profile: candidates[0], via });
  }

  // --- Double-counting guard: 2+ rows resolving to the same profile is ambiguous —
  // multiple rows are not multiple confirmations — UNLESS every one of them is an
  // exact thread_url hit (unique per conversation, so a repeat can only be the same
  // conversation re-listed: safe to apply once, not a sign of a matching problem). ----
  const byProfileId = new Map<number, RowMatch[]>();
  for (const m of clean) byProfileId.set(m.profile.id, [...(byProfileId.get(m.profile.id) ?? []), m]);

  const iso = now.toISOString();
  let replied = 0;
  const appliedIds = new Set<number>();
  for (const [profileId, matches] of byProfileId) {
    if (matches.length > 1 && !matches.every((m) => m.via === 'thread')) {
      ambiguous++;
      log.warn('replies', 'ambiguous — multiple inbox rows resolved to the same pending profile', {
        profile: profileId, url: matches[0].profile.profile_url, rows: matches.length,
      });
      continue;
    }
    const p = matches[0].profile;
    repos.profiles.setStatus(p.id, 'replied', { replied_at: iso, resolved_at: iso });
    repos.events.recordEvent(p.id, 'replied');
    log.info('replies', 'verdict', { profile: p.id, url: p.profile_url, verdict: 'replied', via: matches[0].via });
    appliedIds.add(profileId);
    replied++;
  }

  repos.appState.setRepliesChecked(iso);
  recordSuccess(repos); // a clean read clears any accumulated streak
  const unmatchedPending = pending.length - appliedIds.size;
  log.info('replies', 'checked', { replied, ambiguous, unmatchedPending, rows: rows.length, pending: pending.length });
  return { ran: true, replied, checkedAt: iso };
}
