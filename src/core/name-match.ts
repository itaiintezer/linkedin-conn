/**
 * Canonicalize a person's display name so two different renderings of the same
 * identity — e.g. a LinkedIn profile-page title ("Keren (Yosef) Tevet") vs. the
 * messaging-inbox conversation list ("Keren Tevet") — compare equal. Deliberately
 * conservative: it strips only reliably-decorative pieces (parentheticals, trailing
 * credential suffixes, exotic whitespace) and never reorders, abbreviates, or fuzzes
 * tokens. Pure functions, no I/O — easy to unit test in isolation from the checker.
 *
 * Two hard rules, both learned from real false positives:
 *   - The empty string is NOT a name. '(Bot)', ' ' and ', CISSP' all canonicalize to ''
 *     and callers MUST refuse to use '' as a matching key (it would match everything).
 *   - Dropping the post-comma tail is bounded: "Surname, Given" is a common LinkedIn
 *     display order, and collapsing it onto the surname merges different people.
 */

/** Zero-width characters: deleted outright. Replacing them with a space would split a
 *  token ("Ke<ZWSP>ren Tevet" -> "ke ren tevet") and lose the match. NBSP is excluded
 *  on purpose — it IS a real space and is handled by the whitespace collapse below. */
const ZERO_WIDTH = /[​‌‍﻿]/g;

/** Post-comma tails that are honorifics/credentials rather than a given name. Compared
 *  after stripping dots and lowercasing, so "Ph.D." -> "phd". */
const CREDENTIAL_WORDS = new Set([
  'jr', 'sr', 'ii', 'iii', 'iv', 'v', 'phd', 'md', 'do', 'dds', 'dvm', 'jd', 'esq',
  'mba', 'emba', 'msc', 'ms', 'ma', 'mph', 'mfa', 'llm', 'bsc', 'bs', 'ba', 'bcom',
  'edd', 'psyd', 'rn', 'pe', 'cpa', 'cfa', 'pmp', 'cissp', 'cism', 'cisa', 'crisc',
  'cgeit', 'ccsp', 'oscp', 'ceh', 'gcih', 'cka', 'ccna', 'ccnp', 'mcse', 'itil',
  'prince2', 'six sigma', 'lion', 'mcp', 'sscp', 'cipp', 'cipm', 'fca', 'aca',
]);

/** Does a post-comma tail look like credentials rather than part of the person's name?
 *  Every comma-separated piece must qualify, either by being a known credential word or
 *  by being a short ASCII all-caps acronym ("CISSP", "MBA"). Deliberately narrow:
 *   - a bare initial ("Cohen, D") is NOT a credential — 'D' and 'R' would collide;
 *   - the all-caps test is restricted to ASCII letters because caseless scripts
 *     (Hebrew, Arabic, CJK) trivially satisfy `x === x.toUpperCase()` and a Hebrew
 *     "Surname, Given" would otherwise lose the given name. */
function looksLikeCredentialTail(tail: string): boolean {
  const parts = tail.split(',').map((t) => t.trim()).filter(Boolean);
  if (parts.length === 0) return false;
  return parts.every((part) => {
    const word = part.replace(/[.\s]/g, '').toLowerCase();
    if (!word) return false;
    if (CREDENTIAL_WORDS.has(word)) return true;
    const letters = part.replace(/[^A-Za-z0-9]/g, '');
    return letters.length >= 2 && letters.length <= 6
      && /[A-Z]/.test(letters) && letters === letters.toUpperCase();
  });
}

export function canonicalName(raw: string): string {
  let s = raw.normalize('NFKC');
  s = s.replace(ZERO_WIDTH, '');       // delete (never split a token)
  s = s.replace(/\([^)]*\)/g, ' ');    // strip parenthetical nicknames/middle names
  // An unbalanced paren (truncated title, e.g. "Keren (Yosef Tevet") is left as a bare
  // token break: stripping to end-of-string would throw away the surname and leave a
  // one-token name that loosely matches far too much.
  s = s.replace(/[()]/g, ' ');

  const comma = s.indexOf(',');
  if (comma >= 0) {
    const head = s.slice(0, comma);
    const tail = s.slice(comma + 1);
    // Only drop the tail when the head is already a full name (>= 2 tokens) or the tail
    // is clearly a credential. Otherwise keep both halves — "Cohen, David" is a person.
    if (head.trim().split(/\s+/).filter(Boolean).length >= 2 || looksLikeCredentialTail(tail)) {
      s = head;
    } else {
      s = s.replace(/,/g, ' ');
    }
  }

  // Collapse remaining whitespace (JS \s covers NBSP and the other exotic spaces) and
  // lowercase. Note the zero-widths are already gone, so nothing here can split a token.
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Comparable tokens of an already-canonicalized name. */
export function nameTokens(canonical: string): string[] {
  return canonical.split(' ').filter(Boolean);
}

/**
 * The loose tier: is one token list an order-preserving subsequence of the other?
 * Matches "Keren Tevet" against "Keren Yosef Tevet" (dropped middle name — the live
 * rendering-drift case) while rejecting "Jon A Smith" vs "Jon B Smith" and
 * "Ana Maria Garcia Lopez" vs "Ana Sofia Perez Lopez", which a first+last key merged.
 *
 * Both sides need at least two tokens: a single-token name ("Keren") would otherwise be
 * contained in every pending contact who shares that token.
 */
export function tokensContained(a: string[], b: string[]): boolean {
  if (a.length < 2 || b.length < 2) return false;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  let i = 0;
  for (const token of longer) {
    if (i < shorter.length && shorter[i] === token) i++;
  }
  return i === shorter.length;
}
