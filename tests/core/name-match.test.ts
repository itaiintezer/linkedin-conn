import { test, expect } from 'vitest';
import { canonicalName, nameTokens, tokensContained } from '../../src/core/name-match.js';

test('canonicalizes a parenthetical nickname/middle-name away', () => {
  expect(canonicalName('Keren (Yosef) Tevet')).toBe('keren tevet');
  expect(canonicalName('Keren Tevet')).toBe('keren tevet');
  expect(canonicalName('Keren (Yosef) Tevet')).toBe(canonicalName('Keren Tevet'));
});

test('an unbalanced open paren drops the paren, not the rest of the name', () => {
  // A truncated title ("Keren (Yosef Tevet") must keep the surname: stripping to the end
  // of the string would leave the single token "keren", which then loosely matches every
  // pending Keren — exactly the false positive this module exists to prevent.
  expect(canonicalName('Keren (Yosef Tevet')).toBe('keren yosef tevet');
  expect(canonicalName('Keren Tevet)')).toBe('keren tevet');
});

test('drops post-comma post-nominal credentials', () => {
  expect(canonicalName('Keren Tevet, CISSP')).toBe('keren tevet');
  expect(canonicalName('Keren Tevet, CISSP, CISM')).toBe('keren tevet');
  expect(canonicalName('Nguyen, Ph.D.')).toBe('nguyen');
  // A role/headline after a full name is noise too.
  expect(canonicalName('Keren Tevet, Head of Security')).toBe('keren tevet');
});

test('keeps generational suffixes as tokens — Jr. and Sr. are different people', () => {
  // IMPORTANT 4: both sides of the comparison come from LinkedIn, which renders the
  // suffix in the inbox as well as the profile title, so stripping it only merges
  // a father and son.
  expect(canonicalName('John Smith, Jr.')).toBe('john smith jr');
  expect(canonicalName('John Smith, Sr.')).toBe('john smith sr');
  expect(canonicalName('John Smith, Jr.')).not.toBe(canonicalName('John Smith, Sr.'));
  expect(canonicalName('John Smith Jr')).toBe(canonicalName('John Smith, Jr.'));
  expect(canonicalName('Smith, Jr.')).toBe('smith jr');
  expect(canonicalName('John Smith, III')).toBe('john smith iii');
  // A generational suffix survives even alongside a dropped credential.
  expect(canonicalName('John Smith, Jr., CISSP')).toBe('john smith jr');
});

test('an all-caps given name after a comma is not a credential', () => {
  // CRITICAL 2: the generic "short ASCII all-caps" heuristic only ever fired on a
  // single-token head — i.e. exactly the "Surname, Given" shape — so it re-merged the
  // very people the bounded comma rule protects.
  expect(canonicalName('Cohen, DAVID')).toBe('cohen david');
  expect(canonicalName('Cohen, RACHEL')).toBe('cohen rachel');
  expect(canonicalName('Cohen, DAVID')).not.toBe(canonicalName('Cohen, RACHEL'));
  expect(canonicalName('Kim, MIN')).not.toBe(canonicalName('Kim, JUN'));
  expect(canonicalName('Ng, WEI')).not.toBe(canonicalName('Ng, LI'));
  expect(canonicalName("O'Brien, SEAN")).not.toBe(canonicalName("O'Brien, MARY"));
});

test('keeps a post-comma tail that is a real name — surname-first display names', () => {
  // CRITICAL B: unbounded `split(',')[0]` collapsed every "Surname, Given" display name
  // onto the surname alone, so two different Cohens became the same person.
  expect(canonicalName('Cohen, David')).toBe('cohen david');
  expect(canonicalName('Cohen, Rachel')).toBe('cohen rachel');
  expect(canonicalName('Cohen, David')).not.toBe(canonicalName('Cohen, Rachel'));
  // A bare initial is not a credential either ("Cohen, D" vs "Cohen, R" must differ).
  expect(canonicalName('Cohen, D')).toBe('cohen d');
  expect(canonicalName('Cohen, D')).not.toBe(canonicalName('Cohen, R'));
  // Non-Latin scripts have no case, so the "uppercase acronym" heuristic must not fire.
  expect(canonicalName('כהן, דוד')).not.toBe(canonicalName('כהן, רחל'));
});

test('names made only of decorations canonicalize to empty (callers must skip empty keys)', () => {
  expect(canonicalName('(Bot)')).toBe('');
  expect(canonicalName('   ')).toBe('');
  expect(canonicalName(', CISSP')).toBe('');
});

test('zero-width characters are deleted, not turned into a token break', () => {
  expect(canonicalName('Keren⁠Tevet')).toBe('kerentevet'); // U+2060 word joiner
  expect(canonicalName('Ke­ren Tevet')).toBe('keren tevet'); // U+00AD soft hyphen
  expect(canonicalName('Keren​Tevet')).toBe('kerentevet'); // ZWSP inside one word
  expect(canonicalName('Ke​ren Tevet')).toBe('keren tevet'); // ZWSP mid-token
  expect(canonicalName('Keren‌‍Tevet')).toBe('kerentevet'); // ZWNJ + ZWJ
  expect(canonicalName('﻿Keren Tevet')).toBe('keren tevet'); // leading BOM
  expect(canonicalName('Keren Tevet')).toBe('keren tevet'); // NBSP is a real space
});

test('collapses repeated/mixed whitespace and trims', () => {
  expect(canonicalName('  Keren   Tevet  ')).toBe('keren tevet');
  expect(canonicalName('Keren\t\nTevet')).toBe('keren tevet');
});

test('is case-insensitive and Unicode-normalizing', () => {
  expect(canonicalName('KEREN TEVET')).toBe('keren tevet');
  // Fullwidth Unicode forms NFKC-normalize to their ASCII equivalents.
  expect(canonicalName('Ｋｅｒｅｎ')).toBe('keren');
});

test('nameTokens splits a canonical name into comparable tokens', () => {
  expect(nameTokens('keren yosef tevet')).toEqual(['keren', 'yosef', 'tevet']);
  expect(nameTokens('')).toEqual([]);
});

test('tokensContained accepts a dropped middle token in either direction', () => {
  const short = nameTokens(canonicalName('Keren Tevet'));
  const long = nameTokens(canonicalName('Keren (Yosef) Tevet, CISSP'));
  const longer = nameTokens(canonicalName('Keren Yosef Tevet'));
  expect(tokensContained(short, longer)).toBe(true);
  expect(tokensContained(longer, short)).toBe(true);
  expect(tokensContained(short, long)).toBe(true); // parenthetical stripped -> identical
  expect(tokensContained(short, short)).toBe(true);
});

test('tokensContained rejects same-first-and-last strangers', () => {
  // IMPORTANT C: the old first+last key made these equal.
  expect(tokensContained(nameTokens('jon a smith'), nameTokens('jon b smith'))).toBe(false);
  expect(tokensContained(
    nameTokens('ana maria garcia lopez'),
    nameTokens('ana sofia perez lopez'),
  )).toBe(false);
});

test('tokensContained rejects an extra surname or a longer org-style name', () => {
  // IMPORTANT 3: containment must mean "a middle token was omitted", not "one name is
  // a prefix of a longer, different name".
  expect(tokensContained(nameTokens('ana lopez'), nameTokens('ana maria garcia lopez'))).toBe(false);
  expect(tokensContained(nameTokens('david cohen'), nameTokens('david cohen levi'))).toBe(false);
  expect(tokensContained(nameTokens('acme recruiting'), nameTokens('acme recruiting team'))).toBe(false);
  expect(tokensContained(nameTokens('keren tevet'), nameTokens('keren tevet cohen'))).toBe(false);
});

test('tokensContained requires two tokens on both sides and preserves order', () => {
  // A one-token row name would otherwise contain-match every pending contact who
  // happens to share that token.
  expect(tokensContained(nameTokens('keren'), nameTokens('keren tevet'))).toBe(false);
  expect(tokensContained(nameTokens('tevet'), nameTokens('keren tevet'))).toBe(false);
  // Reordered tokens are a different person as far as this matcher is concerned.
  expect(tokensContained(nameTokens('tevet keren'), nameTokens('keren yosef tevet'))).toBe(false);
  expect(tokensContained([], nameTokens('keren tevet'))).toBe(false);
});
