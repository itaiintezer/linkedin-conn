import { test, expect } from 'vitest';
import { resolveMessage, selectNoteSource, applyFirstName, deriveAllowNoNote } from '../../src/core/message.js';

test('deriveAllowNoNote: blank template allows bare requests, non-blank requires a note', () => {
  expect(deriveAllowNoNote(undefined)).toBe(true);
  expect(deriveAllowNoNote(null)).toBe(true);
  expect(deriveAllowNoNote('')).toBe(true);
  expect(deriveAllowNoNote('   ')).toBe(true);
  expect(deriveAllowNoNote('Hi {firstName}')).toBe(false);
});

test('selectNoteSource picks custom over template, leaving {firstName} intact', () => {
  expect(selectNoteSource('Hey {firstName}', 'Hi {firstName}')).toBe('Hey {firstName}');
  expect(selectNoteSource(null, 'Hi {firstName}')).toBe('Hi {firstName}');
  expect(selectNoteSource('  ', '  ')).toBeNull();
});

test('applyFirstName substitutes the live name (and truncates)', () => {
  expect(applyFirstName('Hi {firstName}!', 'Liron')).toBe('Hi Liron!');
  expect(applyFirstName('Hi {firstName}!', null)).toBe('Hi there!');
  expect(applyFirstName('x'.repeat(400), 'Jane').length).toBe(300);
});

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
