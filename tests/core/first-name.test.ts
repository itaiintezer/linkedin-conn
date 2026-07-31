/**
 * firstNameFrom — the single definition of "the name to greet this person by".
 * Every case below is a real string observed in the live 7,153-row roster.
 */
import { test, expect } from 'vitest';
import { firstNameFrom } from '../../src/core/first-name.js';

test('passes a clean name through unchanged', () => {
  expect(firstNameFrom('Ada')).toBe('Ada');
  expect(firstNameFrom('Ada Lovelace')).toBe('Ada');
});

test('strips invisible and bidi characters', () => {
  // Two of these were actually SENT as "Hi \u200FErik," before this fix.
  expect(firstNameFrom('\u200FErik')).toBe('Erik');
  expect(firstNameFrom('Andrew\u200B')).toBe('Andrew');
  expect(firstNameFrom('\u202AChristopher\u202C')).toBe('Christopher');
});

test('strips emoji and pictographs', () => {
  expect(firstNameFrom('🪐 Leonardo Pizarro')).toBe('Leonardo');
  expect(firstNameFrom('👨\u200D💻 Akash')).toBe('Akash');
  expect(firstNameFrom('⚙\uFE0F Orlando')).toBe('Orlando');
});

test('drops honorifics', () => {
  expect(firstNameFrom('Dr. Chidhanandham Arunachalam')).toBe('Chidhanandham');
  expect(firstNameFrom('Maj Sumit Sharma')).toBe('Sumit');
  expect(firstNameFrom('Er. Pratik Paudel')).toBe('Pratik');   // Er. = Engineer (South Asia)
  expect(firstNameFrom('Prof Jane Doe')).toBe('Jane');
});

test('drops middle initials and post-nominals', () => {
  expect(firstNameFrom('Darrell J. Stinson, CISSP, CEH')).toBe('Darrell');
  expect(firstNameFrom('Mark S. Babbitt')).toBe('Mark');
  expect(firstNameFrom('Pritam H Mungse')).toBe('Pritam');
});

test('strips parentheticals and quoted nicknames', () => {
  expect(firstNameFrom('Xinyu (Jade) Fan')).toBe('Xinyu');
  expect(firstNameFrom('Akyl "Ambition" Phillips')).toBe('Akyl');
  expect(firstNameFrom('Suvarchala(Suva) Mareedu')).toBe('Suvarchala');
});

test('strips leading junk punctuation', () => {
  expect(firstNameFrom("' John R.")).toBe('John');
});

test('KEEPS an initialism people actually go by', () => {
  // "K.C. O'Brien" goes by "K.C." — mangling it to "K.C" would be worse than useless.
  expect(firstNameFrom("K.C. O'Brien")).toBe('K.C.');
  expect(firstNameFrom('T.M. White')).toBe('T.M.');
  expect(firstNameFrom('K.V.N. Rajesh, Ph.D.')).toBe('K.V.N.');
});

test('returns null when there is no usable name — caller sends "there"', () => {
  expect(firstNameFrom('M. G.')).toBeNull();
  expect(firstNameFrom('B L.')).toBeNull();
  expect(firstNameFrom('❕A H.')).toBeNull();
  expect(firstNameFrom('')).toBeNull();
  expect(firstNameFrom(null)).toBeNull();
  expect(firstNameFrom('   ')).toBeNull();
  expect(firstNameFrom('🪐')).toBeNull();
});

test('"Surname, Given" takes the GIVEN name, not the surname', () => {
  // name-match.ts documents this as a real LinkedIn display order. Taking token[0]
  // would greet David Cohen as "Cohen".
  expect(firstNameFrom('Cohen, David')).toBe('David');
  // …but a two-token head means the tail is a role or credential, not a name.
  expect(firstNameFrom('Keren Tevet, Head of Security')).toBe('Keren');
  expect(firstNameFrom('Erik Decker, CISSP')).toBe('Erik');
});

test('handles a name that is only a middle-dot-joined fragment', () => {
  expect(firstNameFrom('K N.Nitin')).toBe('Nitin');
});

test('non-Latin scripts: takes the first real token', () => {
  expect(firstNameFrom('דנאיל דימיטרוב')).toBe('דנאיל');
  expect(firstNameFrom('Tomer Segev תומר שגב')).toBe('Tomer');
  expect(firstNameFrom('益夫 加藤')).toBe('益夫');
});

test('ignores decorative combining-mark spam', () => {
  expect(firstNameFrom('Robert ็็้้้็็็ McCurdy')).toBe('Robert');
});

test('is pure and total — never throws on hostile input', () => {
  for (const s of ['', '   ', '...', ',,,', '()', '""', '\u200F', '🙂🙃', 'a'.repeat(500)]) {
    expect(() => firstNameFrom(s)).not.toThrow();
  }
});

/* ---------------------------------------------------------------------------
 * Regressions found by the roster audit (scripts/audit-first-names.ts) after the
 * first implementation landed. Each case below is a real person in the 7,153-row
 * roster who would otherwise have been greeted wrongly.
 * ------------------------------------------------------------------------- */

test('an apostrophe INSIDE a name is part of the name, not a quote delimiter', () => {
  // 5 real rows. "Hi Ze," to Ze'ev reads as a broken tool.
  expect(firstNameFrom("Ze'ev Manilovich")).toBe("Ze'ev");
  expect(firstNameFrom("Ra'anan Cohen")).toBe("Ra'anan");
  expect(firstNameFrom("De'Onn Griffin, MBA, PhD.")).toBe("De'Onn");
  expect(firstNameFrom("Ya'akov Ben David Ajb-Id")).toBe("Ya'akov");
  expect(firstNameFrom('Ze’ev Dreifuss')).toBe('Ze’ev');   // curly apostrophe too
  // …but a quoting apostrophe still goes: it is not between two letters.
  expect(firstNameFrom("' John R.")).toBe('John');
});

test('drops "Ts." — the Malaysian technologist title', () => {
  expect(firstNameFrom('Ts. Muhammad Haris Jafri')).toBe('Muhammad');
  expect(firstNameFrom('Ts. Zulhairy Z.')).toBe('Zulhairy');
});

test('a lone trailing token after initials is a SURNAME, not a greeting name', () => {
  // Greeting someone "Hi Palmore," is worse than "Hi there,".
  expect(firstNameFrom('M. K. Palmore')).toBeNull();
  expect(firstNameFrom('C M UPPIN')).toBeNull();
  expect(firstNameFrom('S Kumar')).toBeNull();
  expect(firstNameFrom('J A Chowdary')).toBeNull();
  // Two tokens after the initials means the first of them IS the given name.
  expect(firstNameFrom('M. Naveed Mukadam')).toBe('Naveed');
  expect(firstNameFrom('P. Raquel B.')).toBe('Raquel');
  expect(firstNameFrom('M D Sathees Kumar')).toBe('Sathees');
  expect(firstNameFrom('M. Ariel Evans')).toBe('Ariel');
});

test('a leading initialism outranks the post-nominal list', () => {
  // "jd" is Juris Doctor as a SUFFIX, but "J.D. Miller" is what the man is called.
  expect(firstNameFrom('J.D. Miller')).toBe('J.D.');
  // A post-nominal in its normal trailing position is still dropped.
  expect(firstNameFrom('Dennis E. Leber, Ph.D.')).toBe('Dennis');
  expect(firstNameFrom('Erik Decker, CISSP')).toBe('Erik');
});

test('is idempotent — feeding the result back in is a no-op', () => {
  // backfillFirstNames re-runs this over values it already sanitised, so a rule that kept
  // eating its own output would never converge and every start would report work to do.
  // Verified across all 7,153 live rows; these are the shapes that could plausibly break it.
  for (const s of [
    'Dr. Chidhanandham Arunachalam', '🪐 Leonardo Pizarro', "Ze'ev Manilovich", 'K.C. O\'Brien',
    'Cohen, David', 'K N.Nitin', 'Darrell J. Stinson, CISSP', 'Ada', 'T.M. White', 'דנאיל דימיטרוב',
  ]) {
    const once = firstNameFrom(s);
    expect(firstNameFrom(once)).toBe(once);
  }
});
