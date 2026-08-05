/**
 * Raw posts-actor item -> a `posts` row. Pure, and the ONLY place actor field names are
 * read — the same containment `apify-extract.ts` provides for the profile actor, so a
 * harvestapi rename is one file and one test rather than a hunt.
 *
 * Field-shape claims below are measured against a 13,128-item corpus of real actor output
 * at `C:\Projects\prospecting\icp_cache_posts` (2026-08-04), not guessed from the profile
 * actor's shape — see the ApifyPost JSDoc in types.ts for what that overrode.
 */
import type { ApifyPost, PostInput } from '../types.js';
import { normalizePostUrl, normalizeProfileUrl } from './url.js';

/** Trim to a non-empty string, or null. Everything downstream expects null, not ''. */
const str = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s === '' ? null : s;
};

/** A non-negative integer, or null. `posts.reaction_count`/`comment_count` are counts —
 *  never negative, never fractional — so anything else is untrusted input, not a value. */
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;

/** The fixed-width shape the `posted_at` CHECK demands: always a 4-digit year, always
 *  `.sss` milliseconds. `toISOString()` on a Date outside year 0000-9999 uses the
 *  expanded-year form ("+033658-09-27T…"), which this rejects rather than lets through. */
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * True when a Y-M-D triple names a real calendar day. `Date` silently ROLLS an invalid one
 * instead of rejecting it — `Date.UTC(2026, 1, 30)` (Feb 30) becomes March 2 — and that
 * rolled instant still serializes to a value `ISO_MS` accepts, so the shape check alone
 * cannot catch it. Round-tripping the components is what does.
 *
 * Also rejects any two-digit year (0-99): `Date.UTC` maps those into 1900-1999 (legacy
 * JS Date behaviour), so the round-trip can never succeed and this always returns false for
 * them. That is the right direction to fail in — a LinkedIn post cannot be dated year 0-99 —
 * but it is a side effect of the round-trip, not a decision this function makes on purpose.
 */
function isValidYmd(y: number, mo: number, d: number): boolean {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** The single exit for every `parsePostedAt` branch: a Date that doesn't round-trip to the
 *  exact `ISO_MS` shape is a null, same as one that never parsed at all — never a value the
 *  posts.posted_at CHECK would go on to silently reject downstream (upsertMany does count
 *  and log a CHECK rejection, but a lost post is a lost post either way). */
function iso(d: Date): string | null {
  if (Number.isNaN(d.getTime())) return null;
  const s = d.toISOString();
  return ISO_MS.test(s) ? s : null;
}

/**
 * Best-effort parse of an actor post date into the fixed-width ISO shape the `posted_at`
 * CHECK demands.
 *
 * Ported from `apify_linkedin.py::_parse_post_date`, which exists because `postedAt` can
 * arrive as a dict, a bare string, or a unix number depending on the payload. Returns null
 * rather than guessing — a NULL posted_at is handled everywhere via
 * COALESCE(posted_at, first_seen_at).
 *
 * The real actor shape, per the corpus, is `{timestamp, date, postedAgoShort,
 * postedAgoText}`, where `date` already arrives as a full `...Z`-suffixed ISO string and
 * `timestamp` the same instant in epoch ms — the two never disagree in 13,128 samples. The
 * bare-string, space-separated, and bare-date branches below are NOT reachable from that
 * shape; they are defensive-only, kept for an older cache format or a differently-shaped
 * upstream and covered because the reference Python handles them.
 */
export function parsePostedAt(value: unknown): string | null {
  if (value === null || value === undefined) return null;

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    // Apify returns ms. A value small enough to be seconds is scaled up, matching the
    // reference implementation — 10^12 ms is the year 2001, so the threshold is unambiguous.
    const ms = value > 1e12 ? value : value * 1000;
    return iso(new Date(ms));
  }

  if (typeof value === 'object') {
    const o = value as { timestamp?: unknown; date?: unknown; iso?: unknown; isoDate?: unknown };
    // Prefer the timestamp: numeric and unambiguous.
    const fromTs = parsePostedAt(o.timestamp);
    if (fromTs !== null) return fromTs;
    for (const k of ['date', 'iso', 'isoDate'] as const) {
      const s = str(o[k]);
      if (s !== null) return parsePostedAt(s);
    }
    return null;
  }

  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (s === '') return null;

  // Zone-less "YYYY-MM-DD[ T]HH:MM[:SS][.sss]" — read as UTC, and tried BEFORE the
  // zone-aware branch below on purpose. `new Date('2026-08-03T14:23:00')` (a `T` separator
  // but no `Z` and no offset) is LOCAL time per the ECMA-262 Date Time String Format, so on
  // any machine that isn't already UTC this silently shifts the instant by the local
  // offset. That is a real, previously-shipped bug here: the old regex used `[ ]` only, so
  // a `T`-separated zone-less string fell through to the zone-aware branch and got the
  // wrong instant on anything but a UTC box. `vitest.config.ts` pinning TZ=UTC for the
  // suite is what let it ship unnoticed — under that pin, local time IS UTC, so the bug
  // produced the right answer in every test and only the wrong one in production. Fixed by
  // testing this shape first and explicitly appending `Z`; the reference
  // `apify_linkedin.py::_parse_post_date` does the same with its own `[ T]` separator.
  const zoneless = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/);
  if (zoneless) {
    const [, y, mo, d, h, mi, se, frac] = zoneless;
    if (!isValidYmd(+y, +mo, +d)) return null;
    const millis = (frac ?? '000').padEnd(3, '0').slice(0, 3);
    return iso(new Date(`${y}-${mo}-${d}T${h}:${mi}:${se ?? '00'}.${millis}Z`));
  }

  // ISO 8601 carrying its own zone (a trailing Z or a numeric offset) — unambiguous for
  // `new Date` to parse directly. THIS is the branch real data actually reaches:
  // `postedAt.date` is a `Z`-suffixed ISO string on every corpus item, so it is the one
  // that must not skip the day round-trip check. Validating the wall-clock date as WRITTEN
  // is correct regardless of the offset that follows — a rolled `Feb 30` is a defect in the
  // source string no matter what zone it claims to be in.
  const zoned = s.match(/^(\d{4})-(\d{2})-(\d{2})T/);
  if (zoned) {
    if (!isValidYmd(+zoned[1], +zoned[2], +zoned[3])) return null;
    return iso(new Date(s));
  }

  // A bare date, defensive-only for the same reason noted above.
  const bareDate = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (bareDate) {
    const [, y, mo, d] = bareDate;
    if (!isValidYmd(+y, +mo, +d)) return null;
    return iso(new Date(`${y}-${mo}-${d}T00:00:00Z`));
  }

  // "2 days ago" and friends: relative text carries no absolute instant. Refused.
  return null;
}

/**
 * The post's identity, reusing the existing normalizer rather than re-deriving URN rules.
 *
 * `linkedinUrl` first, because normalizePostUrl already knows that a path outranks anything
 * else in a URL. `id` is the fallback, accepted as a bare URN or promoted from a digits-only
 * value. Anything else yields null and the item is dropped — a post we cannot name is one we
 * could later navigate to the wrong page for.
 */
function identify(raw: ApifyPost): { url: string; urn: string } | null {
  const fromUrl = normalizePostUrl(raw.linkedinUrl);
  if (fromUrl !== null) return fromUrl;
  const fromId = normalizePostUrl(raw.id);
  if (fromId !== null) return fromId;
  const id = str(raw.id);
  if (id !== null && /^\d+$/.test(id)) return normalizePostUrl(`urn:li:activity:${id}`);
  return null;
}

/**
 * Is this a reshare? `type` is `'post'` on every one of 13,128 real items, including actual
 * reshares — it is NOT a usable discriminator despite being one in other Apify actors'
 * output, and is kept below only as a harmless forward-compat check. The real signal is a
 * nested/attribution object: `repost` (reshare with the resharer's own added commentary) or
 * `repostedBy`/`repostedAt` (a bare reshare, no commentary added). `resharedPost` never
 * occurs in the corpus; kept because the original spec named it.
 *
 * In practice only the `repost` branch can fire: `extractPost` drops bare reshares before it
 * gets here, so the `repostedBy` check labels nothing. It stays because this function answers
 * "is this a reshare", not "did we keep it" — and if the drop is ever narrowed to admit some
 * reshares, the label needs to already be right.
 *
 * Defaults to 0 when indeterminate, so an unrecognized payload shape UNDER-labels rather
 * than mislabels. Reposts are engageable (one container, all selectors resolve), but comment
 * attribution on them is already broken upstream — so the label matters to the operator.
 */
function isRepost(raw: ApifyPost): number {
  const type = (str(raw.type) ?? '').toLowerCase();
  if (type === 'repost' || type === 'reshare') return 1;
  if (raw.repost != null || raw.repostedBy != null || raw.resharedPost != null) return 1;
  return 0;
}

/** `JSON.stringify` throws on a circular reference or a BigInt. Neither is expected from
 *  actor JSON, but the sibling `apify-extract.ts` module's contract is that a malformed
 *  payload yields nulls, never a throw — and inside a batch (`attribute` below), an
 *  uncaught throw here would take down every other item in the run, not just this one. */
function safeStringify(raw: unknown): string | null {
  try { return JSON.stringify(raw); } catch { return null; }
}

/**
 * Is this a BARE reshare — the tracked profile passing on someone else's post with no words
 * of their own? `repostedBy` is the signal, and the ONLY reliable one.
 *
 * Do not test `content` for this. A bare reshare's top-level `content` holds the ORIGINAL
 * author's words, and `author` is that original author, with `repostedBy` the only field
 * naming the tracked profile. Measured over the 13,128 unique items in the corpus:
 *
 *   - 4,182 items (31.9%) are bare reshares
 *   - 4,120 of them (98.5%) carry non-empty top-level `content`
 *   - on 4,170 of them `author` is a stranger — neither the resharer nor the sweep target
 *
 * A `content`-based rule therefore catches 1.5% of them, which is exactly the bug this
 * function was extracted to fix (production, 2026-08-04): 31% of the feed was stranger-written
 * posts, displayed under the tracked connection's name because `author_display` prefers the
 * connections join over `posts.author_name`. One reached the point of an operator sending a
 * Like — which landed on the original author's post, not the tracked profile's reshare, since
 * `linkedinUrl` on these items is the original and the reshare's own activity URN appears
 * only in `header.linkedinUrl`.
 *
 * Cost of the rule: on 12 of 13,128 items the author IS the sweep target — self-reshares
 * ("Reposting for visibility") of the person's own earlier post, 11 of which have a sibling
 * item carrying the same `shareUrn` that survives. 0.09%, and mostly duplicates.
 */
export function isBareReshare(raw: ApifyPost): boolean {
  return !!raw && typeof raw === 'object' && raw.repostedBy != null;
}

/**
 * One item -> one row, or null when it is out of scope or unusable.
 *
 * Two rules drop an item, and they are NOT the same rule:
 *
 * 1. A BARE reshare is out of scope (decided 2026-08-04) — see `isBareReshare` for the
 *    measurements, and note that this is checked BEFORE content precisely because those items
 *    do carry content.
 * 2. TOP-LEVEL `content` is required. A reshare *with* commentary carries the tracked person's
 *    own words there and flows through as an ordinary post; one where they added no words of
 *    their own has nothing at the top level and is dropped here, as are caption-less image,
 *    video and document posts.
 *
 * Do not "fix" rule 2 by recovering text from the nested `repost.content`. Measured directly
 * on the fallback this replaced, 662 of 704 such rows had the tracked profile as the row's
 * author, but 401 of THOSE had recovered content belonging to a different person than the
 * byline — a real example being author "Aaron Fenimore / IT Security Manager" over a hiring
 * post actually written by Stuart Wolstenholme. Same stranger's-words-under-someone-else's-name
 * hazard as a bare reshare, just carried by `repost.content` instead of by `author`.
 *
 * Presenting reshares honestly instead of dropping them needs an author-display override and
 * an "X reshared this" affordance, and it walks the operator into the pre-existing reshare
 * defect where comment `data-id`s key on the ugcPost URN and silently lose attribution.
 * Deliberately not in scope.
 */
export function extractPost(raw: ApifyPost, trackedProfileId: number): PostInput | null {
  if (!raw || typeof raw !== 'object') return null;
  if (isBareReshare(raw)) return null;     // not their words at all — see above
  const content = str(raw.content);
  if (content === null) return null;       // no words of their own — see above
  const ref = identify(raw);
  if (ref === null) return null;

  const author = raw.author ?? null;
  const eng = raw.engagement ?? null;
  const rawJson = safeStringify(raw);
  if (rawJson === null) return null;
  return {
    post_urn: ref.urn,
    post_url: ref.url,
    tracked_profile_id: trackedProfileId,
    author_name: author ? str(author.name) : null,
    // `info` is the real headline field (100% of 13,128 real items; `position`/`headline`
    // never occur) — see the ApifyPost JSDoc in types.ts. Kept as fallbacks only.
    author_headline: author ? str(author.info) ?? str(author.position) ?? str(author.headline) : null,
    content,
    posted_at: parsePostedAt(raw.postedAt),
    is_repost: isRepost(raw),
    // `reactions` is an array of `{type, count}` on every real item (verified: `likes` is
    // its sum, e.g. 51 = 41+5+5 in a sampled item) — `num()` on an array is always null, so
    // the `reactions` fallback below is unreachable against real payloads and exists only
    // for a hypothetical shape where `likes` is dropped but a bare numeric total survives.
    reaction_count: eng ? num(eng.likes) ?? num(eng.reactions) : null,
    comment_count: eng ? num(eng.comments) : null,
    raw_json: rawJson,
  };
}

/**
 * Split a batched run's flat dataset back into per-profile rows.
 *
 * `query.targetUrl` echoes the exact input URL and is the primary key; `author.linkedinUrl`
 * is the fallback. Both are normalized before lookup, so a trailing slash or different case
 * still matches. An item matching NEITHER is counted as `unattributed` and dropped — never
 * assigned to whichever profile happens to be nearby, which would attribute a post to the
 * wrong person.
 *
 * Three counters because there are three unrelated causes, and only one of them is a fault:
 *
 *   - `reshares` — a bare reshare, out of scope by decision. ~31% of real items.
 *   - `unusable` — nothing at the top level to judge or engage with. ~9% of real items:
 *     caption-less media posts and reshares-with-commentary that added no commentary.
 *   - `unattributed` — matched no tracked profile. The only one worth investigating.
 *
 * Folding any of these together makes a caller's single "dropped items" log line blame URL
 * normalization for a scope decision on every sweep, forever — exactly the misleading
 * telemetry that would send someone hunting in the wrong file. It is not hypothetical: while
 * bare reshares were silently reaching the feed, the sweep's log line claimed they were being
 * skipped, which is a large part of why the bug went unnoticed.
 *
 * Reshares are detected BEFORE attribution on purpose. `author.linkedinUrl` — the fallback
 * attribution key — is the ORIGINAL author on these items, so resolving attribution first
 * would file the post under that person whenever they happen to be tracked too.
 */
export function attribute(
  items: ApifyPost[],
  profileIdByUrl: Map<string, number>,
): { rows: PostInput[]; unattributed: number; unusable: number; reshares: number } {
  const rows: PostInput[] = [];
  let unattributed = 0;
  let unusable = 0;
  let reshares = 0;
  for (const raw of items) {
    if (isBareReshare(raw)) { reshares++; continue; }
    const candidates = [
      raw?.query?.targetUrl,
      raw?.author?.linkedinUrl,
    ];
    let id: number | undefined;
    for (const c of candidates) {
      const key = typeof c === 'string' ? normalizeProfileUrl(c) : null;
      if (key !== null) { id = profileIdByUrl.get(key); if (id !== undefined) break; }
    }
    if (id === undefined) { unattributed++; continue; }
    const row = extractPost(raw, id);
    if (row === null) { unusable++; continue; }
    rows.push(row);
  }
  return { rows, unattributed, unusable, reshares };
}
