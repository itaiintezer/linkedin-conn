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
  s = s.replace(/["“”„«»']/g, ' ');       // 'Akyl "Ambition" Phillips'

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

  for (const token of tokens) {
    const bare = token.replace(/[.'’\-]/g, '').toLowerCase();
    if (!bare) continue;
    if (HONORIFICS.has(bare)) continue;
    if (POST_NOMINALS.has(bare)) continue;

    // "K.C." is a name; keep its dots. Checked before the dot-splitting below.
    if (INITIALISM.test(token)) return token;

    // A dotted fragment like "N.Nitin" (malformed input): take the last real segment.
    if (token.includes('.')) {
      const seg = token.split('.').map((x) => x.trim()).filter((x) => x.length >= 2).pop();
      if (seg) return seg;
      continue;                            // "J." — a lone initial is not a name
    }

    if (bare.length < 2) continue;         // "B", "K"
    if (!/^\p{L}/u.test(token)) continue;
    return token;
  }
  return null;
}
