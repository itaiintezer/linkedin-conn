import type { Repos } from '../db/repositories.js';
import type { BrowserDriver, InboxRow, Profile } from '../types.js';
import { isTripped, tripLoginLost, recordReadError, recordSuccess } from './guardrail.js';
import { canonicalName, nameTokens, tokensContained } from '../core/name-match.js';
import { firstNameFrom } from '../core/first-name.js';
import { selectNoteSource, applyFirstName, MAX_MESSAGE } from '../core/message.js';
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
 *
 * 'new' is rejected: /messaging/thread/new/?recipient=... is the compose placeholder, so
 * every profile whose send happened in a fresh composer would otherwise share one key.
 */
export function threadKey(u: string): string | null {
  const id = /\/thread\/([^/?#]+)/.exec(u.trim())?.[1];
  if (!id || id.toLowerCase() === 'new') return null;
  return id;
}

type MatchVia = 'thread' | 'canonical' | 'containment';
interface RowMatch { row: InboxRow; profile: Profile; via: MatchVia; }
interface PendingName { profile: Profile; canon: string; tokens: string[]; }
/** A tier hit. `via` travels WITH the candidate — inferring it from bucket sizes breaks
 *  the moment candidates are filtered (e.g. by the thread veto below). */
interface Candidate { profile: Profile; via: MatchVia; }

/** Matching keys over the pending set. Built once per pass; pure, so the row-resolution
 *  policy can be unit-tested without a database or a browser. */
export interface PendingIndex {
  byThreadKey: Map<string, Profile[]>;
  byCanonical: Map<string, Profile[]>;
  names: PendingName[];
  /** Own thread key per profile id — present only when the profile has a usable one.
   *  This is the evidence behind the veto: it says which conversation IS this contact. */
  threadKeyOf: Map<number, string>;
  /** Pending profiles with no usable key at all — reported by the caller. */
  unmatchable: Profile[];
}

/**
 * Index the pending set. Keys are only ever stored when non-empty: an empty canonical
 * name ('(Bot)', ' ', ', CISSP' all canonicalize to '') would act as a wildcard.
 */
export function buildPendingIndex(pending: Profile[]): PendingIndex {
  const index: PendingIndex = {
    byThreadKey: new Map(), byCanonical: new Map(), names: [],
    threadKeyOf: new Map(), unmatchable: [],
  };
  for (const p of pending) {
    const tkey = p.thread_url ? threadKey(p.thread_url) : null;
    if (tkey) {
      index.byThreadKey.set(tkey, [...(index.byThreadKey.get(tkey) ?? []), p]);
      index.threadKeyOf.set(p.id, tkey);
    }
    const canon = p.full_name ? canonicalName(p.full_name) : '';
    if (canon) {
      index.byCanonical.set(canon, [...(index.byCanonical.get(canon) ?? []), p]);
      index.names.push({ profile: p, canon, tokens: nameTokens(canon) });
    }
    if (!tkey && !canon) index.unmatchable.push(p);
  }
  return index;
}

/**
 * What one inbox row means, as a pure decision over the index:
 *   'match'       — exactly one pending profile, safe to upgrade.
 *   'ambiguous'   — several pending profiles fit; upgrade nobody.
 *   'not_a_reply' — the row matched, but the last message is still ours ("You:").
 *   'none'        — no pending profile fits this row.
 * `candidates` are the profiles this row pointed at (used for the "no row matched this
 * contact at all" health signal), `vetoed` the ones ruled OUT by thread evidence.
 */
export interface RowResolution {
  outcome: 'match' | 'ambiguous' | 'not_a_reply' | 'none';
  candidates: Profile[];
  vetoed: Profile[];
  profile?: Profile;
  via?: MatchVia;
}

export function resolveRow(
  row: InboxRow,
  index: PendingIndex,
  outreachFor?: (p: Profile) => string | null,
): RowResolution {
  const rowThread = row.threadUrl ? threadKey(row.threadUrl) : null;

  // Tier 1 — thread id: exact, name-independent, unique per conversation.
  const threadHits = rowThread ? index.byThreadKey.get(rowThread) ?? [] : [];
  if (threadHits.length > 0) {
    return verdict(row, threadHits.map((p) => ({ profile: p, via: 'thread' as const })), [], outreachFor);
  }
  // No pending profile has this thread id — fall through to name matching rather than
  // giving up (thread_url may simply not have been recorded at send time).

  const canon = canonicalName(row.name);
  if (!canon) return { outcome: 'none', candidates: [], vetoed: [] }; // '' is not a key

  // Tiers 2+3 — exact canonical name and one-omitted-token containment, resolved as a
  // UNION: a looser hit on a DIFFERENT profile is a real ambiguity, not something the
  // exact tier may short-circuit past.
  const rowTokens = nameTokens(canon);
  const hits: Candidate[] = [
    ...(index.byCanonical.get(canon) ?? []).map((p) => ({ profile: p, via: 'canonical' as const })),
    ...index.names
      .filter((pn) => pn.canon !== canon && tokensContained(rowTokens, pn.tokens))
      .map((pn) => ({ profile: pn.profile, via: 'containment' as const })),
  ];

  // Negative evidence: if we know which conversation a candidate IS, and this row is a
  // different conversation, the row is definitively not them — however well the names
  // match. Without this, a same-name stranger's thread reads as the contact's reply, and
  // it becomes the dominant false-upgrade path once every row carries an href.
  const kept: Candidate[] = [];
  const vetoed: Profile[] = [];
  for (const c of hits) {
    const own = index.threadKeyOf.get(c.profile.id);
    if (rowThread && own && own !== rowThread) vetoed.push(c.profile);
    else kept.push(c);
  }
  return verdict(row, kept, vetoed, outreachFor);
}

const normalize = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();
/** Drop the "You:" marker and LinkedIn's truncation ellipsis to leave the message text. */
const snippetBody = (s: string): string =>
  s.replace(/^\s*you:\s*/i, '').replace(/(?:…|\.{3,})\s*$/, '').trim();

/**
 * Is this "You:"-prefixed snippet still OUR outreach, rather than something a human typed?
 *
 * `youSentLast` alone cannot answer "did they reply" — it says only that the newest message
 * is ours, which stays true forever once the operator answers a reply. That is how a genuine
 * reply stayed invisible on 2026-07-29: the contact replied, the operator answered, and every
 * later pass read the operator's own words as "still waiting".
 *
 * The snippet shows the head of the last message, so comparing it against what we sent
 * separates the two cases with no extra page load. Every uncertain case returns true ("still
 * ours"), because the cost of guessing wrong in the other direction is crediting a reply that
 * never happened.
 */
export function snippetIsOurOutreach(snippet: string, outreach?: string | null): boolean {
  if (!outreach || !outreach.trim()) return true; // nothing to compare against
  const s = normalize(snippetBody(snippet));
  const o = normalize(outreach);
  if (s.length < 12) return true;   // too short to carry a real signal
  if (o.startsWith(s)) return true; // the snippet is the head of what we sent
  // The first name is reconstructed and can differ from whatever the page showed at send
  // time, so a greeting mismatch alone must not read as human activity: retry past it.
  const afterComma = (t: string): string => {
    const i = t.indexOf(',');
    return i >= 0 ? t.slice(i + 1).trim() : t;
  };
  const st = afterComma(s);
  return st.length >= 12 && afterComma(o).startsWith(st);
}

/** Shared tail of both tiers, so `youSentLast` is applied in exactly ONE place — and
 *  before the ambiguity verdict, since a row that cannot upgrade anyone should not be
 *  reported as an ambiguity risk either. */
function verdict(
  row: InboxRow,
  candidates: Candidate[],
  vetoed: Profile[],
  outreachFor?: (p: Profile) => string | null,
): RowResolution {
  const profiles = candidates.map((c) => c.profile);
  if (candidates.length === 0) return { outcome: 'none', candidates: [], vetoed };
  // Our outreach still being the last word means no reply. Anything else in that slot means
  // the thread moved on, which takes a reply. With no outreach text to compare (no resolver
  // supplied), this collapses to the old "You: means not a reply" behaviour.
  if (row.youSentLast
    && candidates.some((c) => snippetIsOurOutreach(row.snippet, outreachFor?.(c.profile)))) {
    return { outcome: 'not_a_reply', candidates: profiles, vetoed };
  }
  if (candidates.length > 1) return { outcome: 'ambiguous', candidates: profiles, vetoed };
  return { outcome: 'match', candidates: profiles, vetoed, profile: candidates[0].profile, via: candidates[0].via };
}

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
 *   3) token containment — one omitted interior token, nothing looser (see
 *      core/name-match.ts). Matches a dropped middle name without merging
 *      "Jon A Smith" into "Jon B Smith".
 *
 * The name tiers (2)+(3) are resolved as a UNION, not as fallbacks: a row that hits one
 * profile exactly and another by containment is ambiguous and upgrades nobody. They are
 * also subject to a VETO — a known-but-different thread id proves the row is somebody
 * else, whatever the names say. False "replied" is irreversible and permanently strands
 * the real contact, so every uncertainty resolves to "leave it pending".
 *
 * The row -> profile decision itself lives in `resolveRow` (pure, unit-tested directly);
 * this function only does I/O, grouping and reporting.
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
    await recordReadError(repos, (e as Error).message ?? 'inbox read failed', now);
    return { ran: false, reason: 'read_error', replied: 0 };
  }

  // Fail-safe: an empty inbox read means the page didn't render (a real inbox that has
  // pending outbound messages is never empty) — no state change, no slot stamp, retry later.
  if (rows.length === 0) {
    log.warn('replies', 'inbox read returned nothing — skipping (no state change)');
    return { ran: false, reason: 'empty_read', replied: 0 };
  }

  // --- Build the matching index over pending profiles ---------------------------------
  const index = buildPendingIndex(pending);
  for (const p of index.unmatchable) {
    // Logged once per pass so a silently-stuck contact shows up somewhere, not nowhere.
    log.debug('replies', 'pending profile has no usable thread id or name — unmatchable', {
      profile: p.id, url: p.profile_url, full_name: p.full_name,
    });
  }

  // The roster of what the read actually returned. Names only, never snippets: this is enough
  // to tell "the contact's conversation was never captured" apart from "it was captured but
  // didn't resolve or looked like we spoke last", which are different bugs with different
  // fixes, and the aggregate counts cannot distinguish them.
  log.debug('replies', 'inbox roster', {
    rows: rows.length,
    names: rows.map((r) => `${r.name}${r.youSentLast ? ' [you]' : ''}`),
  });

  // What we actually sent each pending contact, rebuilt with the same helpers the sender
  // used (selectNoteSource + applyFirstName), so a "You:" snippet can be told apart from
  // the operator's own words. Cohorts are looked up once, not per row.
  const templateByCohort = new Map<number, string | null>();
  const outreachFor = (p: Profile): string | null => {
    if (!templateByCohort.has(p.cohort_id)) {
      templateByCohort.set(p.cohort_id, repos.cohorts.findById(p.cohort_id)?.message_template ?? null);
    }
    const source = selectNoteSource(p.custom_message, templateByCohort.get(p.cohort_id) ?? null);
    if (!source) return null;
    // Must match the sender exactly — see rosterFirstName in sender.ts. A divergence here
    // does not fail loudly; it silently mis-detects replies.
    const firstName = firstNameFrom(p.full_name);
    return applyFirstName(source, firstName, MAX_MESSAGE);
  };

  // --- Resolve each inbox row to at most one profile, or flag it ambiguous ------------
  const clean: RowMatch[] = [];
  // Profiles some row pointed at (even a You-prefixed or ambiguous one): the complement
  // of this set is the real "no inbox row matched this contact" signal.
  const seenIds = new Set<number>();
  // REPORTING set, not a veto: a profile flagged ambiguous by row B can still be upgraded
  // by a clean exact row A. That is deliberate — better evidence should win.
  const ambiguousIds = new Set<number>();
  for (const row of rows) {
    const res = resolveRow(row, index, outreachFor);
    for (const p of res.candidates) seenIds.add(p.id);
    if (res.vetoed.length > 0) {
      log.debug('replies', 'name match vetoed — row is a different conversation', {
        name: row.name, thread: row.threadUrl, profiles: res.vetoed.map((p) => p.id),
      });
    }
    if (res.outcome === 'ambiguous') {
      for (const p of res.candidates) ambiguousIds.add(p.id);
      log.warn('replies', 'ambiguous inbox row — leaving pending', {
        name: row.name, thread: row.threadUrl, profiles: res.candidates.map((p) => p.id),
      });
      continue;
    }
    if (res.outcome === 'match') clean.push({ row, profile: res.profile!, via: res.via! });
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
  // A pending contact with no inbox row was not examined at all, so a reply from them cannot
  // have been seen. Warn rather than leave it at info: this number climbed 20 -> 21 -> 22 on
  // 2026-07-29 while the pass reported success each time, and a real reply was missed under it.
  // The slot IS still stamped above — a contact can be legitimately absent from the inbox
  // (no thread was ever created), and refusing to stamp would re-run the read every 30 minutes
  // forever. Visibility is the fix here, not a retry.
  if (unmatchedPending > 0) {
    log.warn('replies', 'pending contacts had no inbox row — a reply from them cannot be seen', {
      unmatchedPending, pending: pending.length, rows: rows.length,
      // Identities, not just a count: a bare number can't tell you whether the read is short
      // or a specific contact's name never resolves, and those need opposite fixes.
      who: pending.filter((p) => !seenIds.has(p.id)).map((p) => `${p.id}:${p.full_name ?? '?'}`),
    });
  }
  return { ran: true, replied, ambiguous: ambiguousProfiles, unmatched: unmatchedPending, checkedAt: iso };
}
