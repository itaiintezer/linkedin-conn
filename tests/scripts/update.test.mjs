// Plain .mjs (not .ts) for the same reason as preflight.test.mjs: the update script must run
// on a bare Node with zero dependencies — it may be the thing repairing a broken
// node_modules — so it can't be TypeScript, and a .ts test importing it would break
// `tsc --noEmit` (no declarations).
import { describe, expect, test } from 'vitest';
import {
  KEEP_BACKUPS,
  RELEASE_BRANCH,
  backupFilename,
  backupsToPrune,
  checkBranch,
  checkCleanTree,
  checkGitAvailable,
  checkGitRepo,
  checkNotRunning,
  describeUpdates,
  fastForwardFailureMessage,
  formatResults,
  summarize,
} from '../../scripts/update.mjs';

describe('checkGitRepo', () => {
  test('passes inside a clone', () => {
    expect(checkGitRepo(true).severity).toBe('ok');
  });

  test('a zip copy is told to clone rather than left guessing', () => {
    const r = checkGitRepo(false);
    expect(r.severity).toBe('error');
    expect(r.fix).toContain('git clone');
    expect(r.fix).toContain('data');
  });
});

describe('checkGitAvailable', () => {
  test('reports the version it found', () => {
    const r = checkGitAvailable('git version 2.47.0');
    expect(r.severity).toBe('ok');
    expect(r.message).toContain('2.47.0');
  });

  test('missing git names an install route per OS', () => {
    const r = checkGitAvailable(null);
    expect(r.severity).toBe('error');
    expect(r.fix).toContain('git-scm.com');
    expect(r.fix).toContain('xcode-select');
  });
});

describe('checkNotRunning', () => {
  test('a live Machine blocks the update and asks for Ctrl+C', () => {
    const r = checkNotRunning('ours', 4400);
    expect(r.severity).toBe('error');
    expect(r.message).toContain('4400');
    expect(r.fix).toContain('Ctrl+C');
  });

  test('the Ctrl+C advice warns against closing the window instead', () => {
    // Closing the window orphans the browser holding .linkedin-profile and blocks the next
    // start — the single most common way people break their install.
    expect(checkNotRunning('ours').fix).toMatch(/not close the window|Do not close/i);
  });

  test('a free port passes', () => {
    expect(checkNotRunning('free').severity).toBe('ok');
  });

  test('an unrelated program on the port does not block the update', () => {
    const r = checkNotRunning('foreign', 4400);
    expect(r.severity).toBe('ok');
    expect(r.message).toContain('unrelated');
  });
});

describe('checkCleanTree', () => {
  test('an untouched checkout passes', () => {
    expect(checkCleanTree('').severity).toBe('ok');
    expect(checkCleanTree('\n').severity).toBe('ok');
  });

  test('edited files are named, not merely counted', () => {
    const r = checkCleanTree(' M src/index.ts\n?? notes.txt\n');
    expect(r.severity).toBe('error');
    expect(r.message).toContain('src/index.ts');
    expect(r.message).toContain('notes.txt');
    expect(r.message).toContain('2 files');
  });

  test('one file reads as singular', () => {
    expect(checkCleanTree(' M src/index.ts').message).toContain('1 file in this folder has been edited');
  });

  test('a trimmed first line still yields the whole filename', () => {
    // Regression: the probe used to trim git's output, eating the leading space of an
    // unstaged " M package.json" and reporting the file as "ackage.json". Parsing is now
    // width-independent, so both forms give the same answer.
    expect(checkCleanTree('M  package.json').message).toContain('package.json');
    expect(checkCleanTree('M  package.json').message).not.toContain('ackage.json\n');
    expect(checkCleanTree(' M package.json').message).toContain('package.json');
  });

  test('handles every status code git emits, staged or not', () => {
    const r = checkCleanTree(['A  added.ts', 'MM both.ts', 'D  gone.ts', '?? new.ts', ' M edited.ts'].join('\n'));
    for (const f of ['added.ts', 'both.ts', 'gone.ts', 'new.ts', 'edited.ts']) {
      expect(r.message).toContain(f);
    }
  });

  test('a long list is capped and the remainder counted', () => {
    const porcelain = Array.from({ length: 14 }, (_, i) => ` M src/f${i}.ts`).join('\n');
    const r = checkCleanTree(porcelain);
    expect(r.message).toContain('14 files');
    expect(r.message).toContain('…and 4 more');
    expect(r.message).not.toContain('src/f10.ts');
  });

  test('the fix offers both undo and stash, and reassures about the queue', () => {
    const r = checkCleanTree(' M src/index.ts');
    expect(r.fix).toContain('git checkout -- .');
    expect(r.fix).toContain('git stash');
    expect(r.fix).toMatch(/queue and login are not in git/i);
  });
});

describe('checkBranch', () => {
  test('passes on the release branch', () => {
    expect(checkBranch(RELEASE_BRANCH).severity).toBe('ok');
  });

  test('another branch is refused by name', () => {
    const r = checkBranch('feat/something');
    expect(r.severity).toBe('error');
    expect(r.message).toContain('feat/something');
    expect(r.fix).toContain(`git checkout ${RELEASE_BRANCH}`);
  });

  test('a detached HEAD is described, not printed as an empty name', () => {
    const r = checkBranch(null);
    expect(r.severity).toBe('error');
    expect(r.message).toContain('detached');
  });
});

describe('summarize', () => {
  test('any error fails the run', () => {
    const s = summarize([checkGitRepo(true), checkBranch('nope')]);
    expect(s.ok).toBe(false);
    expect(s.exitCode).toBe(1);
    expect(s.errors).toHaveLength(1);
  });

  test('all-clear exits zero', () => {
    const s = summarize([checkGitRepo(true), checkBranch(RELEASE_BRANCH), checkNotRunning('free')]);
    expect(s.ok).toBe(true);
    expect(s.exitCode).toBe(0);
  });
});

describe('formatResults', () => {
  test('a failure prints its fix, an ok line does not', () => {
    const out = formatResults([checkGitRepo(true), checkGitAvailable(null)]);
    expect(out).toContain('[  ok  ] Git checkout');
    expect(out).toContain('[ FAIL ] git');
    expect(out).toContain('→');
  });
});

describe('backupFilename', () => {
  test('has no colons — Windows cannot create such a file', () => {
    const name = backupFilename(new Date('2026-08-03T00:41:12.500Z'));
    expect(name).not.toContain(':');
    expect(name).toBe('app.db.2026-08-03T00-41-12');
  });

  test('sorts chronologically as a string, which is what pruning relies on', () => {
    const older = backupFilename(new Date('2026-08-03T00:41:12Z'));
    const newer = backupFilename(new Date('2026-08-03T09:02:00Z'));
    expect([newer, older].sort()).toEqual([older, newer]);
  });
});

describe('backupsToPrune', () => {
  const nameAt = (h) => backupFilename(new Date(`2026-08-0${h}T10:00:00Z`));

  test('keeps everything while under the limit', () => {
    const files = [1, 2, 3].map(nameAt);
    expect(backupsToPrune(files)).toEqual([]);
  });

  test('drops the oldest once over the limit', () => {
    const files = [1, 2, 3, 4, 5, 6, 7].map(nameAt);
    expect(backupsToPrune(files)).toEqual([nameAt(1), nameAt(2)]);
  });

  test('keeps exactly KEEP_BACKUPS behind', () => {
    const files = Array.from({ length: 9 }, (_, i) => nameAt(i + 1));
    expect(files.length - backupsToPrune(files).length).toBe(KEEP_BACKUPS);
  });

  test('ignores files that are not backups, including the live database', () => {
    const files = ['app.db', 'app.db-wal', 'README.txt', ...[1, 2, 3, 4, 5, 6].map(nameAt)];
    const pruned = backupsToPrune(files);
    expect(pruned).toEqual([nameAt(1)]);
    expect(pruned).not.toContain('app.db');
  });

  test('order is unaffected by how the directory listing arrives', () => {
    const files = [6, 1, 4, 2, 5, 3].map(nameAt);
    expect(backupsToPrune(files)).toEqual([nameAt(1)]);
  });
});

describe('describeUpdates', () => {
  test('no commits reads as already up to date', () => {
    expect(describeUpdates('')).toContain('Already up to date');
  });

  test('lists the commits it pulled', () => {
    const out = describeUpdates('abc123 fix: a thing\ndef456 feat: another');
    expect(out).toContain('2 new changes');
    expect(out).toContain('fix: a thing');
  });

  test('one commit reads as singular', () => {
    expect(describeUpdates('abc123 fix: a thing')).toContain('1 new change:');
  });

  test('caps a long list and counts the remainder', () => {
    const log = Array.from({ length: 25 }, (_, i) => `sha${i} commit ${i}`).join('\n');
    const out = describeUpdates(log, 20);
    expect(out).toContain('25 new changes');
    expect(out).toContain('…and 5 more changes');
    expect(out).not.toContain('commit 22');
  });
});

describe('fastForwardFailureMessage', () => {
  test('states that nothing changed and the data is safe', () => {
    const out = fastForwardFailureMessage('fatal: Not possible to fast-forward, aborting.');
    expect(out).toContain('Not possible to fast-forward');
    expect(out).toMatch(/Nothing was changed/);
    expect(out).toMatch(/queue, login and settings are untouched/);
  });

  test('reads cleanly when git said nothing', () => {
    expect(fastForwardFailureMessage('')).not.toContain('\n\n\n');
  });
});
