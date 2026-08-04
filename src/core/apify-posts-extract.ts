/**
 * Raw posts-actor item -> a `posts` row. Pure, and the ONLY place actor field names are
 * read — the same containment `apify-extract.ts` provides for the profile actor, so a
 * harvestapi rename is one file and one test rather than a hunt.
 */
import type { ApifyPost } from '../types.js';
import type { PostInput } from '../db/posts-repos.js';
import { normalizePostUrl, normalizeProfileUrl } from './url.js';

/** Trim to a non-empty string, or null. Everything downstream expects null, not ''. */
const str = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s === '' ? null : s;
};

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/**
 * Best-effort parse of an actor post date into the fixed-width ISO shape the `posted_at`
 * CHECK demands.
 *
 * Ported from `apify_linkedin.py::_parse_post_date`, which exists because `postedAt` arrives
 * as `{date, timestamp, relative}`, a bare ISO string, `YYYY-MM-DD HH:MM:SS`, a bare date,
 * or a unix number depending on the payload. Returns null rather than guessing — a NULL
 * posted_at is handled everywhere via COALESCE(posted_at, first_seen_at).
 */
export function parsePostedAt(value: unknown): string | null {
  if (value === null || value === undefined) return null;

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    // Apify returns ms. A value small enough to be seconds is scaled up, matching the
    // reference implementation — 10^12 ms is the year 2001, so the threshold is unambiguous.
    const ms = value > 1e12 ? value : value * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
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

  // ISO 8601, including a trailing Z or an offset.
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  // "YYYY-MM-DD HH:MM[:SS]" with no zone. Read as UTC — the suite pins TZ=UTC, and
  // guessing a local zone for an upstream timestamp would shift every date.
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ ](\d{2}:\d{2}(?::\d{2})?)$/);
  if (m) {
    const d = new Date(`${m[1]}T${m[2].length === 5 ? `${m[2]}:00` : m[2]}Z`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  // A bare date.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
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
 * Is this a reshare? The discriminator is the `type` field or a nested original-post object.
 *
 * Defaults to 0 when indeterminate, so an unrecognized payload shape UNDER-labels rather
 * than mislabels. Reposts are engageable (one container, all selectors resolve), but comment
 * attribution on them is already broken upstream — so the label matters to the operator.
 */
function isRepost(raw: ApifyPost): number {
  const type = (str(raw.type) ?? '').toLowerCase();
  if (type === 'repost' || type === 'reshare') return 1;
  if (raw.resharedPost != null || raw.repost != null) return 1;
  return 0;
}

/** One item -> one row, or null when it is unusable. */
export function extractPost(raw: ApifyPost, trackedProfileId: number): PostInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const content = str(raw.content);
  if (content === null) return null;       // nothing to judge, nothing to engage with
  const ref = identify(raw);
  if (ref === null) return null;

  const author = raw.author ?? null;
  const eng = raw.engagement ?? null;
  return {
    post_urn: ref.urn,
    post_url: ref.url,
    tracked_profile_id: trackedProfileId,
    author_name: author ? str(author.name) : null,
    author_headline: author ? str(author.position) ?? str(author.headline) : null,
    content,
    posted_at: parsePostedAt(raw.postedAt),
    is_repost: isRepost(raw),
    reaction_count: eng ? num(eng.likes) ?? num(eng.reactions) : null,
    comment_count: eng ? num(eng.comments) : null,
    raw_json: JSON.stringify(raw),
  };
}

/**
 * Split a batched run's flat dataset back into per-profile rows.
 *
 * `query.targetUrl` echoes the exact input URL and is the primary key; `author.linkedinUrl`
 * is the fallback. Both are normalized before lookup, so a trailing slash or different case
 * still matches. An item matching NEITHER is counted and dropped — never assigned to
 * whichever profile happens to be nearby, which would attribute a post to the wrong person.
 */
export function attribute(
  items: ApifyPost[],
  profileIdByUrl: Map<string, number>,
): { rows: PostInput[]; unattributed: number } {
  const rows: PostInput[] = [];
  let unattributed = 0;
  for (const raw of items) {
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
    if (row === null) { unattributed++; continue; }
    rows.push(row);
  }
  return { rows, unattributed };
}
