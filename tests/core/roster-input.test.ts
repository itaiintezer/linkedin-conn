import { test, expect } from 'vitest';
import { parseRosterInput } from '../../src/core/roster-input.js';

test('recognizes a Connections.csv export', () => {
  const csv = [
    'Notes:', '', 'First Name,Last Name,URL,Company,Position,Connected On',
    'Ada,Lovelace,https://www.linkedin.com/in/ada,Analytical Engines,Mathematician,04 Mar 2024',
  ].join('\n');
  const out = parseRosterInput(csv);
  expect(out.format).toBe('csv');
  expect(out.rows).toHaveLength(1);
  expect(out.rows[0].full_name).toBe('Ada Lovelace');
});

test('falls back to extracting bare URLs, deduped and normalized', () => {
  const out = parseRosterInput([
    'https://www.linkedin.com/in/ada',
    'https://linkedin.com/in/ADA/',            // same person, different form
    'https://www.linkedin.com/in/grace-hopper?utm_source=x',
    'not a url at all',
  ].join('\n'));
  expect(out.format).toBe('urls');
  expect(out.rows.map((r) => r.profile_url)).toEqual([
    'https://www.linkedin.com/in/ada',
    'https://www.linkedin.com/in/grace-hopper',
  ]);
  expect(out.rows[0].full_name).toBeUndefined();
});

test('empty input yields no rows rather than throwing', () => {
  expect(parseRosterInput('   ')).toEqual({ format: 'urls', rows: [], skipped: 0 });
});
