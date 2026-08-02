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

/**
 * The share-link slug: <author>_<headline-words>-<type>-<id>-<hash>. Real links use
 * "-share-" at least as often as "-activity-", so the infix is driven by the same type map
 * rather than a second hardcoded list — it also picks up "-ugcPost-" for free.
 *
 * The LAST occurrence in the slug wins, which is what the greedy prefix gives: the id is
 * always the trailing component before the hash suffix, while the headline words in front
 * of it can contain anything. A slug like "..._share-2024-recap-activity-<id>-<hash>"
 * resolves to the activity id; leftmost matching would answer "share:2024".
 */
const POSTS_SLUG_RE = new RegExp(`/posts/[^/?#]*-(${POST_URN_TYPE_ALT})-(\\d+)`, 'i');

/** Decode percent-escapes, tolerating a malformed escape rather than throwing. */
function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/**
 * Parse as an http(s) URL, or null if it is not one.
 *
 * The scheme is optional because people quote links without it ("linkedin.com/posts/…",
 * and a mobile share sheet hands over a bare "lnkd.in/p/…"), the same leniency
 * `normalizeProfileUrl` above already grants.
 */
function httpUrlOf(s: string): URL | null {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
  let u: URL;
  try { u = new URL(withScheme); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return u;
}

/** The lowercased host a reference names, or null if it names no http(s) host. */
function hostOf(s: string): string | null {
  return httpUrlOf(s)?.hostname.toLowerCase() ?? null;
}

function isLinkedInHost(host: string): boolean {
  return host === 'linkedin.com' || host.endsWith('.linkedin.com');
}

function isShortlinkHost(host: string): boolean {
  return host === 'lnkd.in' || host.endsWith('.lnkd.in');
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
 * /feed/update/urn:li:activity:…, /posts/<slug>-share-…-<hash> and ?updateId=…, so
 * deduping on the URL would dedupe nothing.
 *
 * BEST-EFFORT IDENTITY, NOT THE FINAL ONE. A share link's slug id routinely differs from
 * the post's canonical URN — observed live: the slug says share:7489401095899770880 while
 * the page's own data-urn on that same post says activity:7489401096851906561. Both the
 * number and the type can differ. The driver reads data-urn when it first opens the post
 * and rewrites the row, so callers must treat what comes out of here as the key to start
 * with, never as one that is settled.
 *
 * Pure and synchronous: no network, no browser. A shortened lnkd.in link therefore comes
 * back null — resolving one needs an HTTP redirect. It is not unsupported, just not this
 * function's job: callers test with isShortlink and expand with resolveShortlink first.
 * There is no branch for it here; lnkd.in is simply not linkedin.com.
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
  if (host === null || !isLinkedInHost(host)) return null;

  const decoded = safeDecode(s);

  // The share-link form, tried first so the path outranks anything else in the URL. The
  // slug's character class stops at ? and #, so a stray URN in the query or fragment cannot
  // be mistaken for the slug's own id.
  const posts = decoded.match(POSTS_SLUG_RE);
  if (posts) return postFromUrnMatch(posts);

  // Otherwise a URN written out anywhere in the URL: the /feed/update/ path, or the
  // ?updateId= parameter once decoded.
  const direct = decoded.match(POST_URN_RE);
  if (direct) return postFromUrnMatch(direct);

  return null;
}

/**
 * Is this a lnkd.in shortlink — a real post reference that normalizePostUrl cannot resolve
 * on its own?
 *
 * Host-based, not prefix-based. A share sheet on mobile hands over a scheme-less
 * "lnkd.in/p/dkTR-yYF", so a regex anchored on https:// would miss the most common way one
 * of these actually arrives.
 */
export function isShortlink(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  const host = hostOf(raw.trim());
  return host !== null && isShortlinkHost(host);
}

/** Give up rather than hang: an enqueue is waiting on this. */
const SHORTLINK_TIMEOUT_MS = 5_000;

/**
 * lnkd.in answers with a single 301, so anything longer is a loop or a trap, not a link.
 */
const SHORTLINK_MAX_HOPS = 3;

/**
 * Expand a lnkd.in shortlink into the LinkedIn URL it points at, or null.
 *
 * This is the one impure function in this file, kept apart from normalizePostUrl rather
 * than folded into it: parsing must stay synchronous and free of I/O, and the caller needs
 * to know it is about to make a network call. Feed the result back through
 * normalizePostUrl.
 *
 * Unauthenticated and browserless — lnkd.in is a plain HTTP redirect, no session and no JS
 * interstitial involved. Redirects are followed by hand (`redirect: 'manual'`) so the chain
 * can be inspected: it is bounded, it is time-boxed, and it may only ever land on
 * linkedin.com. A shortener that tries to send us somewhere else is a dead end, not a
 * destination.
 *
 * Every failure — a timeout, a refused connection, a 200 with no Location, a hop to the
 * wrong host — returns null. The caller decides what to tell the user; there is nothing
 * here worth throwing over.
 *
 * `fetchImpl` exists so tests never touch the network.
 */
export async function resolveShortlink(
  raw: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<string | null> {
  if (!isShortlink(raw)) return null;

  const start = httpUrlOf(raw.trim());
  if (start === null) return null;

  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  let url = start.toString();

  try {
    for (let hop = 0; hop < SHORTLINK_MAX_HOPS; hop++) {
      const res = await doFetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(SHORTLINK_TIMEOUT_MS),
      });
      // Nothing here reads the body; releasing it keeps the connection from being held open.
      void res.body?.cancel().catch(() => {});

      const location = res.headers.get('location');
      if (location === null) return null;

      // Resolved against the current URL: a shortener is free to answer with a relative
      // Location, and that still has to be judged as an absolute host.
      const next = new URL(location, url).toString();
      const host = hostOf(next);
      if (host === null) return null;
      if (isLinkedInHost(host)) return next;
      if (!isShortlinkHost(host)) return null;

      url = next;
    }
  } catch {
    return null;
  }

  return null;
}
