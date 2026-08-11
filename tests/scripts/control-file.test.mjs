// Plain .mjs: control-file.mjs is the supervisor↔app contract and the supervisor runs on a bare
// Node, so the implementation cannot be TypeScript. src/ imports it through control-file.d.mts.
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  controlPath,
  isPending,
  markDone,
  markFailed,
  markRunning,
  newRequest,
  readControl,
  summarizeControl,
  writeControl,
} from '../../scripts/control-file.mjs';

const NOW = '2026-08-10T10:00:00.000Z';
let dir;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tm-control-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); });

describe('read/write', () => {
  test('a request survives the round trip', () => {
    writeControl(dir, newRequest('update', NOW));
    const c = readControl(dir);
    expect(c.action).toBe('update');
    expect(c.status).toBe('requested');
    expect(c.requested_at).toBe(NOW);
  });

  test('a missing file reads as null rather than throwing', () => {
    expect(readControl(dir)).toBeNull();
  });

  test('a CORRUPT file reads as null — it must never crash either side', () => {
    // The supervisor and the API both read this on startup. A half-written or hand-edited file
    // taking down the app would be a far worse failure than losing an update's status line.
    writeFileSync(controlPath(dir), '{ this is not json');
    expect(readControl(dir)).toBeNull();
  });

  test('no .tmp file is left behind — the write is a rename, not a truncate', () => {
    // A reader polling once a second would otherwise eventually catch a partial file, at exactly
    // the moment the operator is watching the dashboard most closely.
    writeControl(dir, newRequest('update', NOW));
    expect(() => readFileSync(`${controlPath(dir)}.tmp`, 'utf8')).toThrow();
  });
});

describe('transitions', () => {
  test('requested → running → done', () => {
    let c = newRequest('update', NOW);
    expect(isPending(c)).toBe(true);
    c = markRunning(c, NOW);
    expect(isPending(c)).toBe(true);
    c = markDone(c, { from: 'aaa', to: 'bbb', changes: ['bbb feat: x'] }, NOW);
    expect(isPending(c)).toBe(false);
    expect(c.status).toBe('done');
    expect(c.from_sha).toBe('aaa');
  });

  test('a failure keeps the reason and stops being pending', () => {
    const c = markFailed(newRequest('update', NOW), 'npm exploded', NOW);
    expect(c.status).toBe('failed');
    expect(c.error).toBe('npm exploded');
    expect(isPending(c)).toBe(false);
  });

  test('markDone clears any earlier error', () => {
    const failed = markFailed(newRequest('update', NOW), 'transient', NOW);
    expect(markDone(failed, {}, NOW).error).toBeNull();
  });

  test('isPending tolerates null', () => {
    expect(isPending(null)).toBe(false);
  });
});

describe('summarizeControl — what the operator actually reads', () => {
  test('nothing has happened', () => {
    expect(summarizeControl(null).state).toBe('idle');
  });

  test('in flight, named by the action', () => {
    expect(summarizeControl(newRequest('update', NOW)).message).toMatch(/Updating/);
    expect(summarizeControl(newRequest('restart', NOW)).message).toMatch(/Restarting/);
    expect(summarizeControl(markRunning(newRequest('update', NOW), NOW)).state).toBe('busy');
  });

  test('a successful update counts the changes', () => {
    const c = markDone(newRequest('update', NOW), { changes: ['a x', 'b y', 'c z'] }, NOW);
    expect(summarizeControl(c).message).toBe('Updated — 3 new changes installed.');
  });

  test('one change reads as singular', () => {
    const c = markDone(newRequest('update', NOW), { changes: ['a x'] }, NOW);
    expect(summarizeControl(c).message).toContain('1 new change installed');
  });

  test('nothing new says so plainly instead of claiming an update', () => {
    const c = markDone(newRequest('update', NOW), { unchanged: true }, NOW);
    expect(summarizeControl(c).message).toMatch(/Already up to date/);
  });

  test('a failed update reassures that the old version is still running', () => {
    // The one thing an operator needs to know after a failed update: is my Machine broken?
    const c = markFailed(newRequest('update', NOW), 'could not reach github.com', NOW);
    const s = summarizeControl(c);
    expect(s.state).toBe('failed');
    expect(s.message).toMatch(/still running the version it was on/i);
    expect(s.message).toContain('could not reach github.com');
  });

  test('no status codes or jargon reach the operator', () => {
    const shapes = [
      newRequest('update', NOW),
      markDone(newRequest('update', NOW), { changes: ['a x'] }, NOW),
      markDone(newRequest('restart', NOW), {}, NOW),
      markFailed(newRequest('update', NOW), 'boom', NOW),
    ];
    for (const c of shapes) {
      expect(summarizeControl(c).message).not.toMatch(/\b(4\d\d|5\d\d|exit code|sha|stderr)\b/i);
    }
  });
});
