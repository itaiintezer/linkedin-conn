import { ZERO_WIDTH, POST_NOMINALS } from './name-match.js';

/**
 * Everything invisible that turns up in a scraped name. ZERO_WIDTH from name-match.ts covers
 * the zero-width family (U+200B/C/D, U+2060, U+00AD, U+FEFF) but NOT the bidi controls —
 * verified. U+200F is the character that shipped as "Hi \u200FErik," to two real people, so the
 * bidi marks, embeddings and isolates are added here rather than widening the shared
 * constant, which reply matching depends on.
 */
const INVISIBLE = new RegExp(`${ZERO_WIDTH.source}|[\u200E\u200F\u202A-\u202E\u2066-\u2069]`, 'gu');

/**
 * Titles that precede a name. Explicit list, never a heuristic — the same reasoning
 * name-match.ts records for POST_NOMINALS: a "short token" rule would eat real names.
 * "Er." is Engineer, common in South Asia and present in the live roster.
 */
const HONORIFICS = new Set([
  'dr', 'mr', 'mrs', 'ms', 'miss', 'mx', 'prof', 'professor', 'sir', 'dame', 'lord', 'lady',
  'rabbi', 'fr', 'rev', 'pastor', 'imam', 'sheikh',
  'ts',   // Malaysian "Ts." (Technologist); two in the live roster, both greeted "Ts" without it
  'capt', 'col', 'maj', 'sgt', 'lt', 'cmdr', 'gen',
  'er', 'eng', 'ing', 'arch', 'adv', 'hon',
]);

/** Emoji, pictographs, skin-tone modifiers and the ZWJ that binds them. */
const PICTOGRAPHIC =
  /\p{Extended_Pictographic}|\p{Emoji_Presentation}|[\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}]/gu;

/** A name people genuinely go by: two or more letter-dot pairs. "K.C." / "J.R." / "K.V.N." */
const INITIALISM = /^(?:\p{L}\.){2,}$/u;

/**
 * The display-safe first name for greeting someone, or null when nothing in the input can
 * be trusted as a name (the caller then sends "there" — see applyFirstName).
 *
 * Pure and total: hostile input yields null, never a throw. Case-preserving, so it cannot
 * reuse canonicalName() from name-match.ts, which lowercases for comparison.
 */
export function firstNameFrom(raw: string | null | undefined): string | null {
  if (!raw) return null;

  let s = String(raw).normalize('NFKC');
  s = s.replace(INVISIBLE, '');           // delete, never replace: a space would split a token
  s = s.replace(PICTOGRAPHIC, ' ');
  s = s.replace(/\([^)]*\)/g, ' ');       // "Xinyu (Jade) Fan"
  s = s.replace(/[()]/g, ' ');            // unbalanced remnant
  s = s.replace(/["“”„«»]/g, ' ');        // 'Akyl "Ambition" Phillips'
  // An apostrophe BETWEEN two letters belongs to the name — Ze'ev, Ra'anan, De'Onn, O'Brien.
  // Only a dangling one is a quote mark ("' John R."). Stripping both cost five real people
  // their name in the roster audit.
  s = s.replace(/(?<!\p{L})['’](?!\p{L})/gu, ' ');

  // Comma handling, following the bounded rule in name-match.ts: a SINGLE-token head means
  // "Surname, Given" and the given name is the tail. A multi-token head means the tail is a
  // role or credential ("Keren Tevet, Head of Security").
  const parts = s.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1) {
    const headTokens = parts[0].split(/\s+/).filter(Boolean).length;
    const tailWord = parts[1].replace(/[.\s]/g, '').toLowerCase();
    s = headTokens === 1 && !POST_NOMINALS.has(tailWord) ? parts[1] : parts[0];
  } else {
    s = parts[0] ?? '';
  }

  const tokens = s
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}]+/u, '').replace(/[^\p{L}.'’-]+$/u, ''))
    .filter(Boolean);

  // Whether every token examined so far was a bare initial. Once that is true, a token that
  // is also the LAST one is the surname ("M. K. Palmore", "S Kumar") — greeting someone by
  // their surname is worse than "there". Two tokens remaining means the first is the given
  // name ("M. Naveed Mukadam"), which is why this tracks position rather than counting dots.
  let onlyInitialsSoFar = true;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const bare = token.replace(/[.'’\-]/g, '').toLowerCase();
    if (!bare) continue;

    // In FIRST position an initialism is the person's name and outranks the post-nominal
    // list: "jd" is Juris Doctor as a trailing credential, but "J.D. Miller" is what he
    // is called. Later positions keep the post-nominal reading.
    if (i === 0 && INITIALISM.test(token)) return token;

    // A title is not an initial: "Dr. Chase" should still yield Chase, so these clear the
    // flag rather than carrying it. Only bare initials set it.
    if (HONORIFICS.has(bare)) { onlyInitialsSoFar = false; continue; }
    if (POST_NOMINALS.has(bare)) { onlyInitialsSoFar = false; continue; }

    // "K.C." is a name; keep its dots. Checked before the dot-splitting below.
    if (INITIALISM.test(token)) return token;

    // A dotted fragment like "N.Nitin" (malformed input): take the last real segment.
    if (token.includes('.')) {
      const seg = token.split('.').map((x) => x.trim()).filter((x) => x.length >= 2).pop();
      if (seg) return seg;
      onlyInitialsSoFar = true;            // "J." — a lone initial is not a name
      continue;
    }

    if (bare.length < 2) { onlyInitialsSoFar = true; continue; }   // "B", "K"
    if (!/^\p{L}/u.test(token)) continue;
    if (onlyInitialsSoFar && i > 0 && i === tokens.length - 1) return null;
    return token;
  }
  return null;
}
