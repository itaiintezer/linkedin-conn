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

/** Zero-width and invisible-formatting characters: deleted outright. Replacing them with
 *  a space would split a token ("Ke<ZWSP>ren Tevet" -> "ke ren tevet") and lose the
 *  match. All of these survive NFKC and turn up in scraped names. NBSP is excluded on
 *  purpose — it IS a real space and is handled by the whitespace collapse below. */
const ZERO_WIDTH = /[​‌‍⁠­﻿]/g;

/** Post-nominal letters: decorations that are never part of the person's name. Compared
 *  after stripping dots/spaces and lowercasing, so "Ph.D." -> "phd". This is an explicit
 *  allow-list on purpose. An earlier "short ASCII all-caps acronym" heuristic looked
 *  harmless but could only ever fire on a single-token head — i.e. exactly the
 *  "Surname, GIVEN" shape — so it silently merged "Cohen, DAVID" with "Cohen, RACHEL". */
const POST_NOMINALS = new Set([
  'phd', 'md', 'do', 'dds', 'dvm', 'jd', 'esq', 'mba', 'emba', 'msc', 'ms', 'ma',
  'mph', 'mfa', 'llm', 'bsc', 'bs', 'ba', 'bcom', 'edd', 'psyd', 'rn', 'pe', 'cpa',
  'cfa', 'pmp', 'cissp', 'cism', 'cisa', 'crisc', 'cgeit', 'ccsp', 'oscp', 'ceh',
  'gcih', 'cka', 'ccna', 'ccnp', 'mcse', 'itil', 'prince2', 'mcp', 'sscp', 'cipp',
  'cipm', 'fca', 'aca',
]);

/** Generational suffixes. These are KEPT as ordinary tokens: they distinguish a father
 *  from a son, and both sides of every comparison come from LinkedIn — the inbox renders
 *  the suffix just like the profile title does — so dropping one is pure downside. */
const GENERATIONAL = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);

export function canonicalName(raw: string): string {
  let s = raw.normalize('NFKC');
  s = s.replace(ZERO_WIDTH, '');       // delete (never split a token)
  s = s.replace(/\([^)]*\)/g, ' ');    // strip parenthetical nicknames/middle names
  // An unbalanced paren (truncated title, e.g. "Keren (Yosef Tevet") is left as a bare
  // token break: stripping to end-of-string would throw away the surname and leave a
  // one-token name that loosely matches far too much.
  s = s.replace(/[()]/g, ' ');

  // Post-comma pieces are judged one at a time. Dropping the whole tail unconditionally
  // (the original `split(',')[0]`) collapsed every "Surname, Given" display name onto the
  // surname and merged different people.
  const [head, ...tail] = s.split(',');
  const headTokens = head.trim().split(/\s+/).filter(Boolean).length;
  const kept = [head];
  for (const piece of tail) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    const word = trimmed.replace(/[.\s]/g, '').toLowerCase();
    if (GENERATIONAL.has(word)) { kept.push(word); continue; }  // keep, normalized
    if (POST_NOMINALS.has(word)) continue;                      // decoration: drop
    // Anything else is a name unless the head is already a full name, in which case the
    // tail is a role/headline ("Keren Tevet, Head of Security").
    if (headTokens < 2) kept.push(trimmed);
  }
  s = kept.join(' ');

  // Collapse remaining whitespace (JS \s covers NBSP and the other exotic spaces) and
  // lowercase. Note the zero-widths are already gone, so nothing here can split a token.
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Comparable tokens of an already-canonicalized name. */
export function nameTokens(canonical: string): string[] {
  return canonical.split(' ').filter(Boolean);
}

/**
 * The loose tier, scoped to exactly one thing: ONE INTERIOR TOKEN WAS OMITTED. That is
 * the whole observed failure mode ("Keren (Yosef) Tevet" in the profile title vs.
 * "Keren Tevet" in the inbox), so the test is deliberately no wider than it:
 *   - both sides need >= 2 tokens — "Keren" alone is contained in every pending Keren;
 *   - the token-count gap is at most 1 — rejects "Ana Lopez" vs "Ana Maria Garcia Lopez";
 *   - the first AND last tokens must be equal — rejects an appended surname or word
 *     ("David Cohen" vs "David Cohen Levi", "Acme Recruiting" vs "Acme Recruiting Team");
 *   - and the shorter list must still be an order-preserving subsequence of the longer —
 *     rejects "Jon A Smith" vs "Jon B Smith" and reordered tokens.
 * Everything this rejects is at worst a missed reply, which the thread-id tier recovers
 * and the next pass retries. A false accept is irreversible.
 */
export function tokensContained(a: string[], b: string[]): boolean {
  if (a.length < 2 || b.length < 2) return false;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (longer.length - shorter.length > 1) return false;
  if (shorter[0] !== longer[0]) return false;
  if (shorter[shorter.length - 1] !== longer[longer.length - 1]) return false;
  let i = 0;
  for (const token of longer) {
    if (i < shorter.length && shorter[i] === token) i++;
  }
  return i === shorter.length;
}
