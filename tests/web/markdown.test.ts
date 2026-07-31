// @vitest-environment jsdom
/// <reference lib="dom" />
/**
 * The Docs-tab markdown renderer. First coverage this file has had.
 *
 * Motivating defects, both visible on the rendered API reference: every source line became
 * its own <p>, so hard-wrapped prose rendered as a stack of orphan fragments; and pipe
 * tables were not supported at all, so a parameter table came out as literal `| … |` text.
 */
import { test, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let render: (md: string) => string;

beforeAll(() => {
  const src = readFileSync(join(process.cwd(), 'src/web/markdown.js'), 'utf8');
  const w: Record<string, unknown> = {};
  new Function('window', src)(w);
  render = w.renderMarkdown as (md: string) => string;
});

test('joins hard-wrapped lines into one paragraph', () => {
  const html = render('A cohort\'s kind is fixed at creation\nand every profile inherits it.');
  expect(html).toBe("<p>A cohort's kind is fixed at creation and every profile inherits it.</p>");
});

test('a blank line still starts a new paragraph', () => {
  const html = render('First para.\n\nSecond para.');
  expect(html.match(/<p>/g)).toHaveLength(2);
});

test('renders a pipe table with a header row', () => {
  const html = render(['| Field | Type |', '|---|---|', '| `q` | string |', '| `limit` | number |'].join('\n'));
  expect(html).toContain('<table class="md-table">');
  expect(html).toContain('<th>Field</th>');
  expect(html).toContain('<th>Type</th>');
  expect(html).toContain('<td><code>q</code></td>');
  expect(html).toContain('<td>number</td>');
  expect(html).not.toContain('|---|');
});

test('a table ends cleanly at the following paragraph', () => {
  const html = render(['| A |', '|---|', '| 1 |', '', 'After the table.'].join('\n'));
  expect(html).toContain('</table>');
  expect(html).toContain('<p>After the table.</p>');
  expect(html.indexOf('</table>')).toBeLessThan(html.indexOf('<p>After'));
});

test('inline markup still works inside table cells and paragraphs', () => {
  expect(render('| `code` | **bold** |\n|---|---|\n| a | b |')).toContain('<strong>bold</strong>');
  expect(render('Use `q` for **free text**.')).toContain('<code>q</code>');
});

test('a wrapped list item stays part of its bullet', () => {
  const html = render('- first bullet that\n  wraps onto a second line\n- second bullet');
  expect(html.match(/<li>/g)).toHaveLength(2);
  expect(html).toContain('first bullet that wraps onto a second line');
});

test('code fences are untouched by paragraph joining', () => {
  const html = render('```\nline one\nline two\n```');
  expect(html).toContain('<pre class="md-pre"><code>line one\nline two</code></pre>');
});

test('a heading interrupts a paragraph rather than being absorbed into it', () => {
  const html = render('Some prose.\n## A heading\nMore prose.');
  expect(html).toContain('<h2>A heading</h2>');
  expect(html).toContain('<p>Some prose.</p>');
  expect(html).toContain('<p>More prose.</p>');
});

test('html in the source is escaped, not executed', () => {
  expect(render('<img src=x onerror=alert(1)>')).not.toContain('<img');
  expect(render('| <b>x</b> |\n|---|\n| y |')).not.toContain('<b>x</b>');
});

test('renders the real API reference without leaving raw pipes or orphan fragments', () => {
  const md = readFileSync(join(process.cwd(), 'API.md'), 'utf8');
  const html = render(md);
  expect(html).toContain('<table class="md-table">');
  // No table row should survive as literal text in a paragraph.
  expect(html).not.toMatch(/<p>\s*\|/);
  expect(html).toContain('POST /api/connections/search');
});
