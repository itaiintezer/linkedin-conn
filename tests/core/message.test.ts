import { test, expect } from 'vitest';
import { resolveMessage } from '../../src/core/message.js';

test('custom message takes precedence and substitutes {firstName}', () => {
  expect(resolveMessage('Hey {firstName}, loved your post', 'template', 'Jane'))
    .toBe('Hey Jane, loved your post');
});

test('falls back to template when no custom message', () => {
  expect(resolveMessage(null, 'Hi {firstName}!', 'Bob')).toBe('Hi Bob!');
});

test("missing first name becomes 'there'", () => {
  expect(resolveMessage(null, 'Hi {firstName}!', null)).toBe('Hi there!');
});

test('returns null when no custom message and no template (bare request)', () => {
  expect(resolveMessage(null, null, 'Jane')).toBeNull();
  expect(resolveMessage('', '   ', 'Jane')).toBeNull();
});

test('truncates to 300 characters (LinkedIn note limit)', () => {
  const long = 'x'.repeat(400);
  expect(resolveMessage(long, null, 'Jane')!.length).toBe(300);
});
