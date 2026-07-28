import { test, expect } from 'vitest';
import { canonicalName, firstLastKey } from '../../src/core/name-match.js';

test('canonicalizes a parenthetical nickname/middle-name away', () => {
  expect(canonicalName('Keren (Yosef) Tevet')).toBe('keren tevet');
  expect(canonicalName('Keren Tevet')).toBe('keren tevet');
  expect(canonicalName('Keren (Yosef) Tevet')).toBe(canonicalName('Keren Tevet'));
});

test('drops post-comma credential suffixes', () => {
  expect(canonicalName('Keren Tevet, CISSP')).toBe('keren tevet');
  expect(canonicalName('Keren Tevet, CISSP, CISM')).toBe('keren tevet');
});

test('collapses NBSP and zero-width characters to plain spaces', () => {
  expect(canonicalName('Keren Tevet')).toBe('keren tevet'); // NBSP
  expect(canonicalName('Keren​Tevet')).toBe('keren tevet'); // zero-width space
  expect(canonicalName('Keren‌‍Tevet')).toBe('keren tevet'); // ZWNJ + ZWJ
  expect(canonicalName('﻿Keren Tevet')).toBe('keren tevet'); // leading BOM
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

test('firstLastKey collapses a middle name/token but leaves short names untouched', () => {
  expect(firstLastKey(canonicalName('Keren Yosef Tevet'))).toBe('keren tevet');
  expect(firstLastKey(canonicalName('Keren Tevet'))).toBe('keren tevet');
  expect(firstLastKey(canonicalName('Madonna'))).toBe('madonna');
});
