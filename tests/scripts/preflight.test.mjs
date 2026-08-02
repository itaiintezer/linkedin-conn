// Plain .mjs (not .ts) on purpose: the preflight script must run on a bare Node with
// zero dependencies — before `npm install` has fetched tsx/typescript — so it can't be
// TypeScript, and a .ts test importing it would break `tsc --noEmit` (no declarations).
import { describe, expect, test } from 'vitest';
import {
  REQUIRED_NODE,
  checkBrowserCache,
  checkDiskSpace,
  checkNetwork,
  checkNodeVersion,
  checkGit,
  checkNpm,
  checkPlatform,
  checkPort,
  checkSqlite,
  checkWritable,
  checksForStage,
  compareVersions,
  formatResults,
  summarize,
} from '../../scripts/preflight.mjs';

describe('compareVersions', () => {
  test('orders by major, then minor, then patch', () => {
    expect(compareVersions('22.13.0', '22.5.0')).toBe(1);
    expect(compareVersions('22.5.0', '22.13.0')).toBe(-1);
    expect(compareVersions('24.0.0', '22.13.0')).toBe(1);
    expect(compareVersions('22.13.0', '22.13.0')).toBe(0);
  });

  test('tolerates a leading v and a missing patch', () => {
    expect(compareVersions('v22.13', '22.13.0')).toBe(0);
  });
});

describe('checkNodeVersion', () => {
  test('fails on 22.12 — node:sqlite still needs --experimental-sqlite there', () => {
    const r = checkNodeVersion('v22.12.0');
    expect(r.severity).toBe('error');
    expect(r.message).toContain('22.12.0');
    expect(r.fix).toContain('nodejs.org');
  });

  test('passes on the required floor exactly', () => {
    expect(checkNodeVersion(`v${REQUIRED_NODE}`).severity).toBe('ok');
  });

  test('passes on a newer major', () => {
    expect(checkNodeVersion('v24.13.1').severity).toBe('ok');
  });

  test('fails on Node 20', () => {
    expect(checkNodeVersion('v20.18.0').severity).toBe('error');
  });
});

describe('checkPlatform', () => {
  test('supports Apple Silicon and Intel Macs', () => {
    expect(checkPlatform('darwin', 'arm64').severity).toBe('ok');
    expect(checkPlatform('darwin', 'x64').severity).toBe('ok');
  });

  test('supports 64-bit Windows', () => {
    expect(checkPlatform('win32', 'x64').severity).toBe('ok');
  });

  test('rejects Windows on ARM — the stealth browser has no arm64 Windows build', () => {
    const r = checkPlatform('win32', 'arm64');
    expect(r.severity).toBe('error');
    expect(r.message).toMatch(/arm64/);
  });

  test('rejects platforms with no published binary', () => {
    expect(checkPlatform('freebsd', 'x64').severity).toBe('error');
  });
});

describe('checkPort', () => {
  test('warns (never fails) when the port is already serving', () => {
    const r = checkPort(4400, true);
    expect(r.severity).toBe('warn');
    expect(r.message).toContain('4400');
    expect(r.fix).toContain('PORT');
  });

  test('passes when the port is free', () => {
    expect(checkPort(4400, false).severity).toBe('ok');
  });
});

describe('checkSqlite', () => {
  test('fails when node:sqlite cannot be imported on this Node', () => {
    const r = checkSqlite(false);
    expect(r.severity).toBe('error');
    expect(r.fix).toContain('--experimental-sqlite');
  });

  test('passes when node:sqlite is importable', () => {
    expect(checkSqlite(true).severity).toBe('ok');
  });
});

describe('checkNpm', () => {
  test('fails when npm is not on PATH', () => {
    const r = checkNpm(null);
    expect(r.severity).toBe('error');
    expect(r.fix).toContain('nodejs.org');
  });

  test('passes and reports the version when npm is present', () => {
    const r = checkNpm('11.8.0');
    expect(r.severity).toBe('ok');
    expect(r.message).toContain('11.8.0');
  });
});

describe('checkGit', () => {
  test('missing git only warns — the app runs fine without it, only updating needs it', () => {
    const r = checkGit(null);
    expect(r.severity).toBe('warn');
    expect(r.message).toContain('npm run update');
    expect(r.fix).toContain('git-scm.com');
  });

  test('passes and reports the version when git is present', () => {
    const r = checkGit('git version 2.47.0');
    expect(r.severity).toBe('ok');
    expect(r.message).toContain('2.47.0');
  });
});

describe('checkWritable', () => {
  test('fails when the install folder cannot be written to', () => {
    const r = checkWritable(false, 'C:\\Program Files\\the-machine');
    expect(r.severity).toBe('error');
    expect(r.message).toContain('C:\\Program Files\\the-machine');
  });

  test('passes when the folder is writable', () => {
    expect(checkWritable(true, '/Users/x/the-machine').severity).toBe('ok');
  });
});

describe('checkDiskSpace', () => {
  test('warns when free space is under the browser download requirement', () => {
    const r = checkDiskSpace(300 * 1024 * 1024);
    expect(r.severity).toBe('warn');
    expect(r.message).toContain('0.3 GB');
  });

  test('passes with a couple of gigabytes free', () => {
    expect(checkDiskSpace(4 * 1024 * 1024 * 1024).severity).toBe('ok');
  });

  test('stays quiet when free space could not be determined', () => {
    expect(checkDiskSpace(null).severity).toBe('ok');
  });
});

describe('checkBrowserCache', () => {
  test('at install time a missing browser is expected — it is about to be downloaded', () => {
    const r = checkBrowserCache(false, 'install');
    expect(r.severity).toBe('ok');
    expect(r.message).toMatch(/download/i);
  });

  test('at start time a missing browser means the install-time download did not happen', () => {
    const r = checkBrowserCache(false, 'start');
    expect(r.severity).toBe('warn');
    expect(r.fix).toContain('npm run install-browser');
  });

  test('reports the cache as ready when the browser is already there', () => {
    expect(checkBrowserCache(true, 'start').severity).toBe('ok');
    expect(checkBrowserCache(true, 'start').message).toMatch(/ready|cached/i);
  });
});

describe('checkNetwork', () => {
  test('warns when the browser still needs downloading and the host is unreachable', () => {
    const r = checkNetwork(false, true);
    expect(r.severity).toBe('warn');
    expect(r.message).toMatch(/cloakbrowser\.dev/);
  });

  test('skips the probe entirely when the browser is already cached', () => {
    expect(checkNetwork(false, false).severity).toBe('ok');
  });
});

describe('summarize', () => {
  test('exit code 1 and ok=false when any check errored', () => {
    const s = summarize([
      { id: 'a', severity: 'ok', message: 'fine' },
      { id: 'b', severity: 'error', message: 'broken' },
    ]);
    expect(s.ok).toBe(false);
    expect(s.exitCode).toBe(1);
    expect(s.errors).toHaveLength(1);
  });

  test('warnings alone still exit 0', () => {
    const s = summarize([
      { id: 'a', severity: 'ok', message: 'fine' },
      { id: 'b', severity: 'warn', message: 'heads up' },
    ]);
    expect(s.ok).toBe(true);
    expect(s.exitCode).toBe(0);
    expect(s.warnings).toHaveLength(1);
  });
});

describe('formatResults', () => {
  test('prints the fix line for a failing check', () => {
    const out = formatResults([
      { id: 'node', label: 'Node.js', severity: 'error', message: 'too old', fix: 'install 22.13' },
    ]);
    expect(out).toContain('Node.js');
    expect(out).toContain('too old');
    expect(out).toContain('install 22.13');
  });

  test('does not print a fix line for a passing check', () => {
    const out = formatResults([
      { id: 'node', label: 'Node.js', severity: 'ok', message: 'v24.13.1', fix: 'unused' },
    ]);
    expect(out).not.toContain('unused');
  });
});

describe('checksForStage', () => {
  test('the install stage checks the things that make npm install pointless if wrong', () => {
    const ids = checksForStage('install');
    expect(ids).toContain('node');
    expect(ids).toContain('sqlite');
    expect(ids).toContain('platform');
    expect(ids).toContain('npm');
    expect(ids).toContain('git');
    expect(ids).toContain('writable');
  });

  test('the port check belongs to the start stage only', () => {
    expect(checksForStage('start')).toContain('port');
    expect(checksForStage('install')).not.toContain('port');
  });

  test('an unknown stage runs every check', () => {
    expect(checksForStage('all').length).toBeGreaterThan(checksForStage('install').length);
  });
});
