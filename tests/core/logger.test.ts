import { test, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatLine, createLogger } from '../../src/core/logger.js';

test('formatLine renders ISO, level, component, message and quoted data', () => {
  const line = formatLine('2026-07-01T00:00:00.000Z', 'info', 'sender', 'sent', { profile: 123, cohort: 'Security VPs' });
  expect(line).toBe('2026-07-01T00:00:00.000Z INFO sender sent profile=123 cohort="Security VPs"');
});

test('formatLine collapses newlines in values', () => {
  const line = formatLine('2026-07-01T00:00:00.000Z', 'error', 'sender', 'boom', { err: 'a\nb' });
  expect(line).toBe('2026-07-01T00:00:00.000Z ERROR sender boom err="a b"');
});

test('logger writes lines and tail returns the last n', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relaylog-'));
  const path = join(dir, 'relay.log');
  const log = createLogger(path, { maxBytes: 1_000_000, echo: false });
  log.info('t', 'one');
  log.info('t', 'two');
  log.debug('t', 'three');
  const tail = log.tail(2);
  expect(tail).toHaveLength(2);
  expect(tail[0]).toContain('two');
  expect(tail[1]).toContain('three');
});

test('logger rotates to .1 when the file exceeds maxBytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relaylog-'));
  const path = join(dir, 'relay.log');
  const log = createLogger(path, { maxBytes: 80, echo: false });
  log.info('t', 'first message padded out to exceed the tiny threshold aaaaaaaaaa');
  log.info('t', 'second');
  expect(existsSync(path + '.1')).toBe(true);
  expect(readFileSync(path, 'utf8')).toContain('second');
});
