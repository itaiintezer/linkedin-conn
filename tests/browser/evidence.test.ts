import { test, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureEvidence, listIncidents, type PageEvidenceSource } from '../../src/browser/evidence.js';

function fakePage(overrides: Partial<PageEvidenceSource> = {}): PageEvidenceSource {
  return {
    url: () => 'https://www.linkedin.com/checkpoint/challenge/x',
    title: async () => 'Security Verification | LinkedIn',
    content: async () => '<html><body>challenge</body></html>',
    screenshot: async () => Buffer.from('png-bytes'),
    ...overrides,
  };
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'incidents-')); });

test('writes screenshot, html and meta json; returns their names', async () => {
  const now = new Date('2026-07-02T13:02:44.267Z');
  const ev = await captureEvidence(fakePage(), 'checkpoint', { matched: 'security verification' }, dir, now);
  expect(ev).not.toBeNull();
  expect(ev!.screenshot).toBe('2026-07-02T13-02-44-checkpoint.png');
  expect(ev!.html).toBe('2026-07-02T13-02-44-checkpoint.html');
  expect(ev!.pageUrl).toBe('https://www.linkedin.com/checkpoint/challenge/x');
  expect(readFileSync(join(dir, ev!.screenshot!)).toString()).toBe('png-bytes');
  const meta = JSON.parse(readFileSync(join(dir, '2026-07-02T13-02-44-checkpoint.json'), 'utf8'));
  expect(meta.tag).toBe('checkpoint');
  expect(meta.matched).toBe('security verification');
  expect(meta.title).toBe('Security Verification | LinkedIn');
});

test('a failing screenshot does not lose the html or meta', async () => {
  const page = fakePage({ screenshot: async () => { throw new Error('target closed'); } });
  const ev = await captureEvidence(page, 'send-failed', {}, dir, new Date('2026-07-02T13:02:44Z'));
  expect(ev).not.toBeNull();
  expect(ev!.screenshot).toBeNull();
  expect(ev!.html).toBe('2026-07-02T13-02-44-send-failed.html');
});

test('never throws even when everything fails', async () => {
  const page = fakePage({
    url: () => { throw new Error('dead'); },
  });
  const ev = await captureEvidence(page, 'checkpoint', {}, dir, new Date());
  expect(ev).toBeNull();
});

test('two captures in the same second get distinct file names', async () => {
  const now = new Date('2026-07-02T13:02:44Z');
  const a = await captureEvidence(fakePage(), 'checkpoint', {}, dir, now);
  const b = await captureEvidence(fakePage(), 'checkpoint', {}, dir, now);
  expect(a!.screenshot).not.toBe(b!.screenshot);
});

test('listIncidents returns parsed meta newest first', async () => {
  await captureEvidence(fakePage(), 'older', {}, dir, new Date('2026-07-02T10:00:00Z'));
  await captureEvidence(fakePage(), 'newer', {}, dir, new Date('2026-07-02T12:00:00Z'));
  const rows = listIncidents(dir, 10);
  expect(rows).toHaveLength(2);
  expect((rows[0] as { tag: string }).tag).toBe('newer');
});

test('prunes old incidents beyond the retention cap', async () => {
  for (let i = 0; i < 65; i++) {
    await captureEvidence(fakePage(), 'checkpoint', {}, dir, new Date(Date.UTC(2026, 0, 1, 0, 0, i)));
  }
  const jsons = readdirSync(dir).filter((f) => f.endsWith('.json'));
  expect(jsons.length).toBeLessThanOrEqual(60);
  // oldest incident (00-00-00) is gone, with all its files
  expect(existsSync(join(dir, '2026-01-01T00-00-00-checkpoint.json'))).toBe(false);
  expect(existsSync(join(dir, '2026-01-01T00-00-00-checkpoint.png'))).toBe(false);
});
