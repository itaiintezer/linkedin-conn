import { test, expect } from 'vitest';
import { validatePlaceholders, applyFirstName } from '../../src/core/message.js';

test('the real token, plain text, and no text all pass', () => {
  expect(validatePlaceholders('Hi {firstName}, loved your post')).toBeNull();
  expect(validatePlaceholders('Hi {firstName}, {firstName} again')).toBeNull();
  expect(validatePlaceholders('No placeholder at all.')).toBeNull();
  expect(validatePlaceholders('')).toBeNull();
  expect(validatePlaceholders(null)).toBeNull();
  expect(validatePlaceholders(undefined)).toBeNull();
});

test('a case near-miss is rejected with the correct spelling — cohort 8 sent "Hi {FirstName}," to four people', () => {
  // applyFirstName is case-sensitive, so the token would have gone out verbatim.
  expect(applyFirstName('Hi {FirstName},', 'Nick')).toBe('Hi {FirstName},');
  for (const t of ['{FirstName}', '{firstname}', '{FIRSTNAME}', '{first_name}', '{first-name}', '{First name}', '{ firstName }']) {
    const err = validatePlaceholders(`Hi ${t}, hello`);
    expect(err, t).toMatch(/did you mean \{firstName\}/);
    expect(err, t).toContain(t);
  }
});

test('the token in the wrong brackets is rejected — "Hey [First name]," went to two prospects', () => {
  expect(validatePlaceholders('Hey [First name],\n\nIntezer is…')).toMatch(/\[First name\] — write \{firstName\} instead/);
  expect(validatePlaceholders('Hey <firstName>')).toMatch(/write \{firstName\} instead/);
  expect(validatePlaceholders('Hey [firstname]')).toMatch(/write \{firstName\} instead/);
});

test('double braces are rejected', () => {
  expect(validatePlaceholders('Hi {{firstName}}')).toMatch(/\{\{firstName\}\} — write \{firstName\} with single braces/);
});

test('any other word-like {token} is rejected — only {firstName} exists', () => {
  expect(validatePlaceholders('Hi {name}')).toMatch(/unknown placeholder \{name\} — only \{firstName\} is supported/);
  expect(validatePlaceholders('Hi {firstName} from {company}')).toMatch(/\{company\}/);
  expect(validatePlaceholders('Hi {last_name}')).toMatch(/\{last_name\}/);
});

test('braces inside ordinary prose are left alone — fail closed on placeholders, not on punctuation', () => {
  expect(validatePlaceholders("We're hiring {we're serious!}")).toBeNull();
  expect(validatePlaceholders('config: { "a": 1 }')).toBeNull();
  expect(validatePlaceholders('an unmatched { brace')).toBeNull();
  expect(validatePlaceholders('see [the deck] and <link>')).toBeNull();
});
