import { test, expect } from 'vitest';
import {
  REACTIONS, DEFAULT_REACTION, isReaction, parseReaction,
} from '../../src/core/engagement-action.js';

test('the six LinkedIn reactions, and nothing else', () => {
  expect([...REACTIONS]).toEqual(['like', 'celebrate', 'support', 'love', 'insightful', 'funny']);
});

test('isReaction is a case-sensitive membership test — the DB stores lowercase', () => {
  expect(isReaction('insightful')).toBe(true);
  expect(isReaction('Insightful')).toBe(false);
  expect(isReaction('dislike')).toBe(false);
  expect(isReaction(7)).toBe(false);
  expect(isReaction(null)).toBe(false);
});

test('a valid reaction parses to itself', () => {
  expect(parseReaction('celebrate')).toEqual({ ok: true, reaction: 'celebrate' });
});

test('absent reports undefined and leaves the default to the call site', () => {
  expect(parseReaction(undefined)).toEqual({ ok: true, reaction: undefined });
  expect(DEFAULT_REACTION).toBe('like');
});

test('null is invalid, not absent — the caller chose to send it', () => {
  const r = parseReaction(null);
  expect(r.ok).toBe(false);
});

test('an unknown reaction is rejected by name', () => {
  const r = parseReaction('thumbsup');
  expect(r).toEqual({ ok: false, error: 'unknown reaction: thumbsup' });
});

/* `undefined` is the ONLY thing that means absent. An empty string and a padded string are
   both values the caller sent, so both are rejected rather than quietly repaired.

   This matters more here than in parseKind, because this module already grants absent a
   default. If '' were treated as absent it would silently become a 'like' — the one
   coercion the whole boundary-validation rule exists to prevent, smuggled in through a
   blank <select>. A form that means "unspecified" must send no key, or map '' to undefined
   itself; that normalization belongs to the boundary that knows the form, not here.

   Nor do we trim. Free text is trimmed at the call site in server.ts (`cohort.trim()`,
   `message_template?.trim()`); a fixed vocabulary is matched exactly, so what validates is
   byte-for-byte what the DB stores. */
test('empty and padded strings are rejected, not read as absent or trimmed', () => {
  expect(parseReaction('').ok).toBe(false);
  expect(parseReaction('  like  ')).toEqual({ ok: false, error: 'unknown reaction:   like  ' });
});
