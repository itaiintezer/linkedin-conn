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

const POST_URN_RE = /urn:li:(activity|ugcPost|share):(\d+)/i;

/** The same URN standing alone, with nothing around it. */
const BARE_POST_URN_RE = /^urn:li:(activity|ugcPost|share):(\d+)$/i;

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

function buildPost(type: string, id: string): NormalizedPost {
  // LinkedIn writes ugcPost with a capital P; the other two are lowercase. Canonicalizing
  // here is what makes two spellings of the same URN dedupe against each other.
  const lower = type.toLowerCase();
  const canonical = lower === 'ugcpost' ? 'ugcPost' : lower;
  const urn = `urn:li:${canonical}:${id}`;
  return { url: `https://www.linkedin.com/feed/update/${urn}/`, urn };
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
 * path must not make network calls. The caller is told to expand the link first.
 *
 * A reference is one of exactly two things: a bare URN, or a URL on linkedin.com. A URN
 * embedded in some other site's URL is NOT a LinkedIn post reference, so the host is
 * checked before the string is scanned — the alternative accepts anything that happens to
 * contain the right-shaped text.
 */
export function normalizePostUrl(raw: string): NormalizedPost | null {
  const s = (raw ?? '').trim();
  if (s === '') return null;

  // A URN pasted on its own: no URL to validate, the identity is already in hand. Anchored,
  // because free text that merely mentions a URN is not a reference to one post.
  const bare = s.match(BARE_POST_URN_RE);
  if (bare) return buildPost(bare[1], bare[2]);

  const host = hostOf(s);
  if (host === null) return null;

  // Stated explicitly, not left to fall out of the linkedin.com check below: refusing to
  // resolve a shortlink is a deliberate no-network decision, not an accident of the host
  // allowlist, and should survive any future loosening of it.
  if (host === 'lnkd.in') return null;

  if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) return null;

  const decoded = safeDecode(s);

  // A URN written out anywhere in the URL: the /feed/update/ path, or the ?updateId=
  // parameter once decoded.
  const direct = decoded.match(POST_URN_RE);
  if (direct) return buildPost(direct[1], direct[2]);

  // The share-link form. The numeric id trails the slug after "-activity-".
  const posts = decoded.match(/\/posts\/[^/?#]*-activity-(\d+)/i);
  if (posts) return buildPost('activity', posts[1]);

  return null;
}
