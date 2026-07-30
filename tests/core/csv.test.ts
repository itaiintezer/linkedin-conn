import { test, expect } from 'vitest';
import { parseCsv } from '../../src/core/csv.js';

test('parses plain rows', () => {
  expect(parseCsv('a,b\n1,2')).toEqual([['a', 'b'], ['1', '2']]);
});

test('handles quoted fields containing commas', () => {
  expect(parseCsv('name,company\nAda,"Analytical Engines, Ltd"')).toEqual([
    ['name', 'company'], ['Ada', 'Analytical Engines, Ltd'],
  ]);
});

test('handles escaped double quotes inside a quoted field', () => {
  expect(parseCsv('a\n"she said ""hi"""')).toEqual([['a'], ['she said "hi"']]);
});

test('handles newlines inside a quoted field', () => {
  expect(parseCsv('a,b\n"line1\nline2",x')).toEqual([['a', 'b'], ['line1\nline2', 'x']]);
});

test('tolerates CRLF and a trailing newline', () => {
  expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([['a', 'b'], ['1', '2']]);
});

test('keeps empty fields and drops fully blank lines', () => {
  expect(parseCsv('a,b\n1,\n\n2,3')).toEqual([['a', 'b'], ['1', ''], ['2', '3']]);
});
