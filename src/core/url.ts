export function normalizeProfileUrl(raw: string): string | null {
  const m = raw.match(/linkedin\.com\/in\/([A-Za-z0-9\-_%]+)/i);
  if (!m) return null;
  const slug = m[1].replace(/\/+$/, '').toLowerCase();
  if (!slug) return null;
  return `https://www.linkedin.com/in/${slug}`;
}

export function extractProfileUrls(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /https?:\/\/[^\s,"'<>]*linkedin\.com\/in\/[A-Za-z0-9\-_%]+\/?/gi;
  for (const match of text.matchAll(re)) {
    const n = normalizeProfileUrl(match[0]);
    if (n && !seen.has(n)) { seen.add(n); out.push(n); }
  }
  return out;
}

/** A post identified by both what we show and what we key on. */
export interface NormalizedPost {
  /** Canonical https://www.linkedin.com/feed/update/<urn>/ — display and navigation. */
  url: string;
  /** THE identity. See normalizePostUrl for why the URL cannot be. */
  urn: string;
}

/**
 * The post URN types we accept, keyed by their lowercased spelling and valued with
 * LinkedIn's own casing — it writes ugcPost with a capital P and the other two lowercase.
 * Canonicalizing is what makes two spellings of the same URN dedupe against each other.
 *
 * Single source of truth, in the spirit of CAMPAIGN_KINDS: the regexes below build their
 * alternation from the keys and buildPost reads the casing from the values, so adding a
 * type is one edit here. Splitting the two would let a new camel-cased type match and then
 * be emitted lowercased — a URN that looks right, dedupes against nothing, and fails no test.
 */
const POST_URN_TYPES = {
  activity: 'activity',
  ugcpost: 'ugcPost',
  share: 'share',
} as const;

type PostUrnType = typeof POST_URN_TYPES[keyof typeof POST_URN_TYPES];

const POST_URN_TYPE_ALT = Object.keys(POST_URN_TYPES).join('|');

const POST_URN_RE = new RegExp(`urn:li:(${POST_URN_TYPE_ALT}):(\\d+)`, 'i');

/** The same URN standing alone, with nothing around it. */
const BARE_POST_URN_RE = new RegExp(`^urn:li:(${POST_URN_TYPE_ALT}):(\\d+)$`, 'i');

/** Decode percent-escapes, tolerating a malformed escape rather than throwing. */
function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/**
 * The lowercased host a reference names, or null if it names no http(s) host.
 *
 * The scheme is optional because people quote links without it ("linkedin.com/posts/…"),
 * the same leniency `normalizeProfileUrl` above already grants.
 */
function hostOf(s: string): string | null {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
  let u: URL;
  try { u = new URL(withScheme); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return u.hostname.toLowerCase();
}

function buildPost(type: PostUrnType, id: string): NormalizedPost {
  const urn = `urn:li:${type}:${id}`;
  return { url: `https://www.linkedin.com/feed/update/${urn}/`, urn };
}

/**
 * Build from a `(type, id)` match of either URN regex.
 *
 * A type outside POST_URN_TYPES yields null — unreachable while the alternation is built
 * from the same map, but the honest answer either way is "not a post reference", never a
 * guessed spelling.
 */
function postFromUrnMatch(m: RegExpMatchArray): NormalizedPost | null {
  const canonical = (POST_URN_TYPES as Record<string, PostUrnType>)[m[1].toLowerCase()];
  return canonical ? buildPost(canonical, m[2]) : null;
}

/**
 * Resolve any LinkedIn post reference to its canonical URL and its URN.
 *
 * The URN — not the URL — is the identity. The same post is reachable as
 * /feed/update/urn:li:activity:…, /posts/<slug>-activity-…-<hash> and ?updateId=…, so
 * deduping on the URL would dedupe nothing.
 *
 * Pure string parsing: no network, no browser. That is why a shortened lnkd.in link is
 * REJECTED rather than followed — resolving one needs an HTTP redirect, and the enqueue
 * path must not make network calls. The caller is told to expand the link first. There is
 * no branch for it: lnkd.in is simply not linkedin.com, and anyone adding redirect-following
 * is editing the host gate anyway.
 *
 * A reference is one of exactly two things: a bare URN, or a URL on linkedin.com. A URN
 * embedded in some other site's URL is NOT a LinkedIn post reference, so the host is
 * checked before the string is scanned — the alternative accepts anything that happens to
 * contain the right-shaped text.
 *
 * WHEN A URL OFFERS TWO CANDIDATES, THE PATH WINS. A /posts/ link can carry an unrelated
 * URN in a fragment or a tracking parameter, and answering with that one would hand back a
 * well-formed key naming a DIFFERENT post than the one that was pasted — with a canonical
 * URL rebuilt around it, so nothing would look wrong. Over-accepting is survivable;
 * confidently mis-identifying is not.
 *
 * Within linkedin.com the scan itself stays loose: a URN sitting in a redirect parameter
 * resolves to that post rather than being rejected. That is a considered trade, and it is
 * why the host gate above carries the weight — Task 13 exposes this to arbitrary input.
 */
export function normalizePostUrl(raw: unknown): NormalizedPost | null {
  // Typed `unknown` because this sits behind an HTTP boundary: a non-string is not a
  // reference we failed to parse, it is not a reference at all. Never defaulted into one.
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (s === '') return null;

  // A URN pasted on its own: no URL to validate, the identity is already in hand. Anchored,
  // because free text that merely mentions a URN is not a reference to one post.
  const bare = s.match(BARE_POST_URN_RE);
  if (bare) return postFromUrnMatch(bare);

  const host = hostOf(s);
  if (host === null) return null;
  if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) return null;

  const decoded = safeDecode(s);

  // The share-link form, tried first so the path outranks anything else in the URL. The
  // numeric id trails the slug after "-activity-"; the character class stops at ? and #, so
  // a stray URN in the query or fragment cannot be mistaken for the slug's own id.
  const posts = decoded.match(/\/posts\/[^/?#]*-activity-(\d+)/i);
  if (posts) return buildPost('activity', posts[1]);

  // Otherwise a URN written out anywhere in the URL: the /feed/update/ path, or the
  // ?updateId= parameter once decoded.
  const direct = decoded.match(POST_URN_RE);
  if (direct) return postFromUrnMatch(direct);

  return null;
}
