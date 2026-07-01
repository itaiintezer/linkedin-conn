import { test, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listDocs, readDoc } from '../../src/core/docs.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'docs-'));
  writeFileSync(join(dir, 'API.md'), '# Relay API\n\nHello.');
  return dir;
}

test('listDocs returns known docs that exist, with titles from the first heading', () => {
  const docs = listDocs(fixture());
  expect(docs).toContainEqual({ slug: 'api', title: 'Relay API' });
});

test('readDoc returns markdown for a known slug', () => {
  const doc = readDoc('api', fixture());
  expect(doc).not.toBeNull();
  expect(doc!.markdown).toContain('Hello.');
  expect(doc!.title).toBe('Relay API');
});

test('readDoc returns null for an unknown slug', () => {
  expect(readDoc('nope', fixture())).toBeNull();
});
