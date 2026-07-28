/**
 * Canonicalize a person's display name so two different renderings of the same
 * identity — e.g. a LinkedIn profile-page title ("Keren (Yosef) Tevet") vs. the
 * messaging-inbox conversation list ("Keren Tevet") — compare equal. Deliberately
 * conservative: it strips only reliably-decorative pieces (parentheticals, trailing
 * credential suffixes, exotic whitespace) and never reorders, abbreviates, or fuzzes
 * tokens. Pure function, no I/O — easy to unit test in isolation from the checker.
 */
export function canonicalName(raw: string): string {
  let s = raw.normalize('NFKC');
  s = s.replace(/\([^)]*\)/g, ' ');   // strip parenthetical nicknames/middle names
  s = s.split(',')[0];                 // drop post-comma credential suffixes (", CISSP")
  // Collapse all whitespace-like characters — including NBSP, zero-width space/
  // joiners, and a stray BOM — down to single ASCII spaces before trim/lowercase.
  s = s.replace(/[\s ​‌‍﻿]+/g, ' ');
  return s.trim().toLowerCase();
}

/**
 * The loosest fallback key: first + last token of an already-canonicalized name.
 * Collapses middle names/initials (e.g. "keren yosef tevet" -> "keren tevet") but
 * never fuzzes spelling. Names with 0-2 tokens are returned unchanged.
 */
export function firstLastKey(canonical: string): string {
  const tokens = canonical.split(' ').filter(Boolean);
  if (tokens.length <= 2) return canonical;
  return `${tokens[0]} ${tokens[tokens.length - 1]}`;
}
