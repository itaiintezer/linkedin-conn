import type { Repos } from '../db/repositories.js';
import type { BrowserDriver, InboxRow, Profile } from '../types.js';
import { isTripped, tripLoginLost, recordReadError, recordSuccess } from './guardrail.js';
import { canonicalName, nameTokens, tokensContained } from '../core/name-match.js';
import { log } from '../core/log.js';

/** Outcome of a reply pass — mirrors AcceptanceRunResult so the UI can reuse its wording. */
export interface ReplyRunResult {
  ran: boolean;
  reason?: 'paused' | 'guardrail' | 'no_pending' | 'logged_out' | 'login_lost' | 'read_error' | 'empty_read';
  replied: number;
  /** Pending PROFILES left alone because the evidence was ambiguous (not rows). */
  ambiguous?: number;
  /** Pending profiles that NO inbox row matched in any tier — the "we may be blind to
   *  this contact" signal. A contact whose row is merely still You-prefixed is matched,
   *  not unmatched. */
  unmatched?: number;
  checkedAt?: string;
}

/**
 * Reduce a thread href to its conversation id — the only stable part. Handles
 * relative vs. absolute (`getAttribute('href')` yields '/messaging/thread/2-abc/' while
 * the sender stores an absolute URL), query strings, hashes and trailing slashes.
 * Returns null when there is no thread id to key on, in which case the caller must fall
 * back to name matching rather than inventing a key.
 *
 * The id itself is compared verbatim, NOT case-folded: LinkedIn thread ids are
 * base64-ish and both sides come from LinkedIn's own hrefs, so folding case could only
 * ever merge two genuinely different conversations — and this key is the one signal
 * strong enough to override a name match.
 */
function threadKey(u: string): string | null {
  const m = /\/thread\/([^/?#]+)/.exec(u.trim());
  return m ? m[1] : null;
}

type MatchVia = 'thread' | 'canonical' | 'containment';
interface RowMatch { row: InboxRow; profile: Profile; via: MatchVia; }
interface PendingName { profile: Profile; canon: string; tokens: string[]; }

/**
 * One reply pass: a single navigation to the messaging inbox, then match conversation
 * rows to pending (status 'sent', kind 'message') profiles. A row whose last message
 * was NOT ours ("You:" prefix absent) is a candidate reply. Upgrade-only: nothing here
 * can ever un-reply or expire anything (acceptance-checker lesson).
 *
 * Matching is layered, most to least reliable:
 *   1) thread id — exact, name-independent, and unique per conversation. Preferred
 *      because the display name captured at send time (from the profile-page title) can
 *      differ from what the inbox renders for the same person (live discovery:
 *      "Keren (Yosef) Tevet" vs. "Keren Tevet") — name matching alone would silently
 *      miss a real reply. A thread hit therefore also OUTRANKS any name hit.
 *   2) canonical full name — Unicode-normalized, parentheticals/credential suffixes/
 *      exotic whitespace stripped (see core/name-match.ts).
 *   3) token containment — the row's canonical tokens are an order-preserving
 *      subsequence of the profile's, or vice versa. Matches a dropped middle name
 *      without merging "Jon A Smith" into "Jon B Smith".
 *
 * The name tiers (2)+(3) are resolved as a UNION, not as fallbacks: a row that hits one
 * profile exactly and another by containment is ambiguous and upgrades nobody. False
 * "replied" is irreversible and permanently strands the real contact, so every
 * uncertainty resolves to "leave it pending".
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
  // Keys are only ever indexed when they are non-empty: an empty canonical name ('(Bot)',
  // ' ', ', CISSP' all canonicalize to '') would otherwise act as a wildcard.
  const byThreadKey = new Map<string, Profile[]>();
  const byCanonical = new Map<string, Profile[]>();
  const pendingNames: PendingName[] = [];
  for (const p of pending) {
    const tkey = p.thread_url ? threadKey(p.thread_url) : null;
    if (tkey) byThreadKey.set(tkey, [...(byThreadKey.get(tkey) ?? []), p]);
    const canon = p.full_name ? canonicalName(p.full_name) : '';
    if (canon) {
      byCanonical.set(canon, [...(byCanonical.get(canon) ?? []), p]);
      pendingNames.push({ profile: p, canon, tokens: nameTokens(canon) });
    }
    if (!tkey && !canon) {
      // Currently unmatchable by any key — logged once (this function runs once per
      // pass) so a silently-stuck contact shows up somewhere instead of nowhere.
      log.debug('replies', 'pending profile has no usable thread id or name — unmatchable', {
        profile: p.id, url: p.profile_url, full_name: p.full_name,
      });
    }
  }

  // --- Resolve each inbox row to at most one profile, or flag it ambiguous ------------
  const clean: RowMatch[] = [];
  // Profiles some row pointed at (even a You-prefixed or ambiguous one): the complement
  // of this set is the real "no inbox row matched this contact" signal.
  const seenIds = new Set<number>();
  const ambiguousIds = new Set<number>();
  for (const row of rows) {
    const tkey = row.threadUrl ? threadKey(row.threadUrl) : null;
    const threadHits = tkey ? byThreadKey.get(tkey) ?? [] : [];
    if (threadHits.length > 0) {
      for (const p of threadHits) seenIds.add(p.id);
      if (threadHits.length > 1) {
        // Two pending profiles recorded the same conversation — one of them is wrong and
        // we cannot tell which, so neither is upgraded.
        for (const p of threadHits) ambiguousIds.add(p.id);
        log.warn('replies', 'ambiguous — two pending profiles share a thread id', {
          thread: tkey, profiles: threadHits.map((p) => p.id),
        });
        continue;
      }
      if (!row.youSentLast) clean.push({ row, profile: threadHits[0], via: 'thread' });
      continue;
    }
    // No pending profile has this thread id captured — fall through to name matching
    // rather than giving up (thread_url may simply not have been recorded at send time).

    const canon = canonicalName(row.name);
    if (!canon) continue; // an unnamed row is not a key — never match on ''

    const rowTokens = nameTokens(canon);
    const exact = byCanonical.get(canon) ?? [];
    const contained = pendingNames.filter((pn) => pn.canon !== canon && tokensContained(rowTokens, pn.tokens));
    // Union of both name tiers: a looser hit on a DIFFERENT profile is a genuine
    // ambiguity, not something the exact tier is allowed to short-circuit past.
    const candidates = [...exact, ...contained.map((pn) => pn.profile)];
    if (candidates.length === 0) continue; // no match at all
    for (const p of candidates) seenIds.add(p.id);
    if (candidates.length > 1) {
      for (const p of candidates) ambiguousIds.add(p.id);
      log.warn('replies', 'ambiguous display name — leaving pending', {
        name: row.name, canonical: canon, profiles: candidates.map((c) => c.id),
      });
      continue;
    }
    if (row.youSentLast) continue; // matched, but the last word is still ours
    clean.push({ row, profile: candidates[0], via: exact.length === 1 ? 'canonical' : 'containment' });
  }

  // --- Double-counting guard: 2+ rows resolving to the same profile is ambiguous —
  // multiple rows are not multiple confirmations. Exception: if ANY of them is an exact
  // thread-id hit, that one wins and the name-tier members are discarded — thread ids
  // are unique per conversation, so the thread hit IS the conversation and the name
  // matches can only be same-name strangers (or the same row re-listed). Without this,
  // a real reply next to a same-name stranger would be dropped every single pass. ----
  const byProfileId = new Map<number, RowMatch[]>();
  for (const m of clean) byProfileId.set(m.profile.id, [...(byProfileId.get(m.profile.id) ?? []), m]);

  const iso = now.toISOString();
  let replied = 0;
  const appliedIds = new Set<number>();
  for (const [profileId, matches] of byProfileId) {
    const decisive = matches.find((m) => m.via === 'thread');
    if (!decisive && matches.length > 1) {
      ambiguousIds.add(profileId);
      log.warn('replies', 'ambiguous — multiple inbox rows resolved to the same pending profile', {
        profile: profileId, url: matches[0].profile.profile_url, rows: matches.length,
      });
      continue;
    }
    const winner = decisive ?? matches[0];
    if (decisive && matches.length > 1) {
      log.debug('replies', 'thread-id hit outranks same-profile name matches', {
        profile: profileId, discarded: matches.length - 1,
      });
    }
    const p = winner.profile;
    repos.profiles.setStatus(p.id, 'replied', { replied_at: iso, resolved_at: iso });
    repos.events.recordEvent(p.id, 'replied');
    log.info('replies', 'verdict', { profile: p.id, url: p.profile_url, verdict: 'replied', via: winner.via });
    appliedIds.add(profileId);
    replied++;
  }

  repos.appState.setRepliesChecked(iso);
  recordSuccess(repos); // a clean read clears any accumulated streak
  // Units: both counts are PROFILES, not rows. `unmatchedPending` = pending contacts no
  // row matched in any tier (a matching-health signal, not "hasn't replied yet").
  const ambiguousProfiles = [...ambiguousIds].filter((id) => !appliedIds.has(id)).length;
  const unmatchedPending = pending.filter((p) => !seenIds.has(p.id)).length;
  log.info('replies', 'checked', {
    replied, ambiguousProfiles, unmatchedPending, rows: rows.length, pending: pending.length,
  });
  return { ran: true, replied, ambiguous: ambiguousProfiles, unmatched: unmatchedPending, checkedAt: iso };
}
