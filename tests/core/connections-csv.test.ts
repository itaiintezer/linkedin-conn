import { test, expect } from 'vitest';
import { parseConnectedOn, parseConnectionsCsv, looksLikeConnectionsCsv } from '../../src/core/connections-csv.js';

const REAL_EXPORT = [
  'Notes:',
  '"When exporting your connection data, you may notice that some of the email addresses are missing."',
  '',
  'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
  'Ada,Lovelace,https://www.linkedin.com/in/ada,,Analytical Engines,Mathematician,04 Mar 2024',
  'Grace,Hopper,https://www.linkedin.com/in/grace-hopper/,grace@navy.mil,"US Navy, Reserve",Rear Admiral,12 Dec 1985',
].join('\n');

test('skips the preamble and maps columns by header name', () => {
  const { rows, skipped } = parseConnectionsCsv(REAL_EXPORT);
  expect(skipped).toBe(0);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toEqual({
    profile_url: 'https://www.linkedin.com/in/ada',
    first_name: 'Ada', last_name: 'Lovelace', full_name: 'Ada Lovelace',
    current_company: 'Analytical Engines', current_title: 'Mathematician',
    connected_on: '2024-03-04',
  });
});

test('normalizes URLs (trailing slash, case, tracking params)', () => {
  const { rows } = parseConnectionsCsv(REAL_EXPORT);
  expect(rows[1].profile_url).toBe('https://www.linkedin.com/in/grace-hopper');
  expect(rows[1].current_company).toBe('US Navy, Reserve'); // quoted comma survived
});

test('counts rows with an unusable URL as skipped rather than throwing', () => {
  const csv = 'First Name,Last Name,URL,Company,Position,Connected On\nX,Y,,Acme,CEO,01 Jan 2024';
  const { rows, skipped } = parseConnectionsCsv(csv);
  expect(rows).toHaveLength(0);
  expect(skipped).toBe(1);
});

test('tolerates a column order it has never seen, and missing optional columns', () => {
  const csv = 'URL,Position,First Name\nhttps://www.linkedin.com/in/z,CTO,Zed';
  const { rows } = parseConnectionsCsv(csv);
  expect(rows[0]).toEqual({
    profile_url: 'https://www.linkedin.com/in/z',
    first_name: 'Zed', last_name: null, full_name: 'Zed',
    current_company: null, current_title: 'CTO', connected_on: null,
  });
});

test('throws a legible error when there is no recognizable header', () => {
  expect(() => parseConnectionsCsv('just,some,columns\n1,2,3')).toThrow(/header/i);
});

test('parseConnectedOn handles LinkedIn\'s "DD Mon YYYY" and returns null on junk', () => {
  expect(parseConnectedOn('04 Mar 2024')).toBe('2024-03-04');
  expect(parseConnectedOn('4 Mar 2024')).toBe('2024-03-04');
  expect(parseConnectedOn('12 Dec 1985')).toBe('1985-12-12');
  expect(parseConnectedOn('2024-03-04')).toBe('2024-03-04');
  expect(parseConnectedOn('')).toBeNull();
  expect(parseConnectedOn('sometime last spring')).toBeNull();
});

test('looksLikeConnectionsCsv distinguishes an export from a bare URL list', () => {
  expect(looksLikeConnectionsCsv(REAL_EXPORT)).toBe(true);
  expect(looksLikeConnectionsCsv('https://www.linkedin.com/in/a\nhttps://www.linkedin.com/in/b')).toBe(false);
});
