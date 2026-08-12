// Plain .mjs (not .ts) for the same reason as preflight.test.mjs: the update script must run
// on a bare Node with zero dependencies — it may be the thing repairing a broken
// node_modules — so it can't be TypeScript, and a .ts test importing it would break
// `tsc --noEmit` (no declarations).
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git as gitIn, makeTempRepo, publishCommit } from './helpers/temp-repo.mjs';
import {
  KEEP_BACKUPS,
  RELEASE_BRANCH,
  backupFilename,
  backupsToPrune,
  blockedReason,
  checkBranch,
  checkGitAvailable,
  checkGitRepo,
  checkNotRunning,
  describeLocalChanges,
  describeUpdates,
  discardedPatchFilename,
  fastForwardFailureMessage,
  formatResults,
  parseLocalChanges,
  resolveConfig,
  rollbackTo,
  runUpdate,
  summarize,
} from '../../scripts/update.mjs';
// The banner text is the point of blockedReason, so the assertions go through the same two
// functions the dashboard does rather than stopping at the string runUpdate returned.
import { markFailed, newRequest, summarizeControl } from '../../scripts/control-file.mjs';

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
  test('a live Machine is sent to the dashboard button, not to a terminal', () => {
    // The check survives the rework because `npm install` against a live app leaves files
    // locked and the install half-finished. What changed is the remedy: the Update button
    // stops, updates and restarts for them, which is the one route this audience can take.
    const r = checkNotRunning('ours', 4400);
    expect(r.severity).toBe('error');
    expect(r.message).toContain('4400');
    expect(r.fix).toContain('Update button');
    expect(r.fix).toContain('http://localhost:4400');
    expect(r.fix).not.toContain('Ctrl+C');
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

describe('parseLocalChanges', () => {
  test('separates tracked edits from untracked strays', () => {
    const r = parseLocalChanges(' M src/index.ts\n?? notes.txt\n');
    expect(r.edited).toEqual(['src/index.ts']);
    expect(r.untracked).toEqual(['notes.txt']);
  });

  test('a trimmed first line still yields the whole filename', () => {
    // Regression: the probe used to trim git's output, eating the leading space of an
    // unstaged " M package.json" and reporting the file as "ackage.json". Parsing is now
    // width-independent, so both forms give the same answer.
    expect(parseLocalChanges('M  package.json').edited).toEqual(['package.json']);
    expect(parseLocalChanges(' M package.json').edited).toEqual(['package.json']);
  });

  test('handles every status code git emits, staged or not', () => {
    const r = parseLocalChanges(['A  added.ts', 'MM both.ts', 'D  gone.ts', '?? new.ts', ' M edited.ts'].join('\n'));
    expect(r.edited).toEqual(['added.ts', 'both.ts', 'gone.ts', 'edited.ts']);
    expect(r.untracked).toEqual(['new.ts']);
  });
});

describe('describeLocalChanges', () => {
  test('an untouched checkout passes', () => {
    expect(describeLocalChanges('').severity).toBe('ok');
    expect(describeLocalChanges('\n').severity).toBe('ok');
  });

  test('NOTHING here can block the update, whatever the folder looks like', () => {
    // The whole point of the rework. Reps do not edit code on purpose, so a local change is
    // always an accident, and the old failure handed them a git command they could not run.
    const shapes = [
      ' M src/index.ts',
      '?? .DS_Store',
      'A  staged.ts',
      ['MM both.ts', '?? junk.txt', 'D  gone.ts'].join('\n'),
    ];
    for (const porcelain of shapes) {
      expect(describeLocalChanges(porcelain).severity).not.toBe('error');
      expect(summarize([describeLocalChanges(porcelain)]).ok).toBe(true);
      expect(summarize([describeLocalChanges(porcelain)]).exitCode).toBe(0);
    }
  });

  test('edited and untracked files are both named and counted separately', () => {
    const r = describeLocalChanges(' M src/index.ts\n?? notes.txt\n');
    expect(r.message).toContain('src/index.ts');
    expect(r.message).toContain('notes.txt');
    expect(r.message).toContain('1 edited file');
    expect(r.message).toContain('1 file git is not tracking');
  });

  test('says what will happen to them, and that nothing important is at risk', () => {
    const r = describeLocalChanges(' M src/index.ts');
    expect(r.message).toMatch(/put back the way the published version/i);
    expect(r.fix).toMatch(/queue, contacts, settings and LinkedIn login are not stored in git/i);
    expect(r.fix).toContain('data/backups/');
  });

  test('a long list is capped and the remainder counted', () => {
    const porcelain = Array.from({ length: 14 }, (_, i) => ` M src/f${i}.ts`).join('\n');
    const r = describeLocalChanges(porcelain);
    expect(r.message).toContain('14 edited files');
    expect(r.message).toContain('…and 4 more');
    expect(r.message).not.toContain('src/f10.ts');
  });
});

describe('checkBranch', () => {
  test('passes on the release branch', () => {
    expect(checkBranch(RELEASE_BRANCH, 0).severity).toBe('ok');
  });

  test('a stray branch with nothing of its own is a warn — runUpdate heals it', () => {
    const r = checkBranch('claude/some-merged-fix', 0);
    expect(r.severity).toBe('warn');
    expect(r.message).toContain('claude/some-merged-fix');
    expect(r.message).toContain(RELEASE_BRANCH);
  });

  test('a branch carrying unpublished commits is refused by name', () => {
    const r = checkBranch('feat/something', 2);
    expect(r.severity).toBe('error');
    expect(r.message).toContain('feat/something');
    expect(r.fix).toContain(`git checkout ${RELEASE_BRANCH}`);
  });

  test('an unknowable ahead-count refuses rather than guessing it safe', () => {
    expect(checkBranch('feat/something', null).severity).toBe('error');
  });

  test('a detached HEAD is described, not printed as an empty name', () => {
    const r = checkBranch(null, 1);
    expect(r.severity).toBe('error');
    expect(r.message).toContain('detached');
  });

  test('a detached HEAD with nothing of its own heals like a stray branch', () => {
    expect(checkBranch(null, 0).severity).toBe('warn');
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

describe('blockedReason', () => {
  const branchFail = {
    id: 'branch', label: 'Branch', severity: 'error',
    message: 'this checkout is on `claude/wip`, not `main`.',
    fix: 'Updates are published on `main`. Switch with `git checkout main` and run this again.',
  };

  test('gives the check, the problem AND the next action', () => {
    expect(blockedReason([branchFail])).toBe(
      'Branch: this checkout is on `claude/wip`, not `main`. Updates are published on `main`.'
      + ' Switch with `git checkout main` and run this again.',
    );
  });

  test('reports every failure, not just the first', () => {
    const gitFail = { id: 'git', label: 'git', severity: 'error', message: 'not installed.', fix: 'Install git.' };
    const reason = blockedReason([branchFail, gitFail]);
    expect(reason).toContain('Branch:');
    expect(reason).toContain('git: not installed. Install git.');
  });

  test('a failure with no fix still reads as a sentence', () => {
    expect(blockedReason([{ label: 'Folder', message: 'this is not a git checkout.' }]))
      .toBe('Folder: this is not a git checkout.');
  });

  test('falls back rather than producing an empty banner', () => {
    // Reached only if something failed without being recorded — say the honest thing instead of
    // rendering "The update did not finish." followed by nothing.
    expect(blockedReason([])).toBe('the update did not complete');
    expect(blockedReason(undefined)).toBe('the update did not complete');
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

// ---------------------------------------------------------------------------
// The real thing, against a disposable repo.
//
// Everything above is a pure function fed a string. These run the actual script against an
// actual git checkout, which is the only way to know that `reset --hard` plus `clean -fd`
// discard what they should and — much more importantly — leave `data/` alone.
// ---------------------------------------------------------------------------

describe('resolveConfig', () => {
  test('defaults to the checkout this script lives in', () => {
    const cfg = resolveConfig({ argv: [], env: {} });
    expect(cfg.root).toContain('linkedin-conn');
    expect(cfg.dataDir).toContain('data');
    expect(cfg.port).toBe(4400);
    expect(cfg.supervised).toBe(false);
  });

  test('a flag aims it at another folder, which is what lets these tests exist', () => {
    const cfg = resolveConfig({ argv: ['--root=/tmp/x', '--data-dir=/tmp/y'], env: {} });
    expect(cfg.root).toBe('/tmp/x');
    expect(cfg.dataDir).toBe('/tmp/y');
    expect(cfg.dbPath).toBe(join('/tmp/y', 'app.db'));
  });

  test('the environment works too, and the supervisor flag is recognised', () => {
    const cfg = resolveConfig({ argv: [], env: { THEMACHINE_ROOT: '/srv/m', THEMACHINE_SUPERVISED_UPDATE: '1', PORT: '4500' } });
    expect(cfg.root).toBe('/srv/m');
    expect(cfg.dataDir).toBe(join('/srv/m', 'data'));
    expect(cfg.port).toBe(4500);
    expect(cfg.supervised).toBe(true);
  });
});

describe('runUpdate against a disposable repo', () => {
  let repo;
  const quiet = { log: () => {}, error: () => {} };

  beforeEach(() => { repo = makeTempRepo(); });
  afterEach(() => { repo?.cleanup(); });

  const cfgFor = (r) => resolveConfig({
    argv: [`--root=${r.root}`, `--data-dir=${r.dataDir}`],
    // Supervised: the port probe is irrelevant here and would otherwise reach whatever is
    // really listening on 4400 on the machine running the suite.
    env: { THEMACHINE_SUPERVISED_UPDATE: '1' },
  });

  test('an untouched install pulls the new commit', async () => {
    publishCommit(repo, { subject: 'feat: something new', extraFile: 'brand-new.txt' });
    const r = await runUpdate(cfgFor(repo), { out: quiet });
    expect(r.ok).toBe(true);
    expect(r.unchanged).toBe(false);
    expect(r.log).toContain('feat: something new');
    expect(existsSync(join(repo.root, 'brand-new.txt'))).toBe(true);
  }, 60_000);

  test('nothing to pull is reported as unchanged, not as a failure', async () => {
    const r = await runUpdate(cfgFor(repo), { out: quiet });
    expect(r.ok).toBe(true);
    expect(r.unchanged).toBe(true);
  }, 60_000);

  test('an edited tracked file is discarded instead of blocking the update', async () => {
    writeFileSync(join(repo.root, 'tracked.txt'), 'the rep somehow edited this\n');
    publishCommit(repo);

    const r = await runUpdate(cfgFor(repo), { out: quiet });

    expect(r.ok).toBe(true);
    expect(readFileSync(join(repo.root, 'tracked.txt'), 'utf8')).toBe('original\n');
  }, 60_000);

  test('a STAGED edit is discarded too — the reason this uses reset, not checkout', async () => {
    // `git checkout -- .` restores the worktree from the index, so a staged change survives it
    // and still gets merged by the pull. That is the merge conflict we exist to prevent.
    writeFileSync(join(repo.root, 'tracked.txt'), 'staged edit\n');
    gitIn(repo.root, ['add', 'tracked.txt']);
    publishCommit(repo);

    const r = await runUpdate(cfgFor(repo), { out: quiet });

    expect(r.ok).toBe(true);
    expect(readFileSync(join(repo.root, 'tracked.txt'), 'utf8')).toBe('original\n');
    // Scoped to the file: `npm install` legitimately writes a package-lock.json afterwards, so
    // asserting the whole tree is pristine would be asserting the wrong thing.
    expect(gitIn(repo.root, ['status', '--porcelain', 'tracked.txt'])).toBe('');
  }, 60_000);

  test('a stray untracked file is removed — the .DS_Store dead end, closed', async () => {
    writeFileSync(join(repo.root, '.DS_Store'), 'finder junk');
    writeFileSync(join(repo.root, 'notes.txt'), 'a stray file');
    publishCommit(repo);

    const r = await runUpdate(cfgFor(repo), { out: quiet });

    expect(r.ok).toBe(true);
    expect(existsSync(join(repo.root, 'notes.txt'))).toBe(false);
    expect(existsSync(join(repo.root, '.DS_Store'))).toBe(false);
  }, 60_000);

  test('THE LOAD-BEARING ONE: data/ survives the reset and the clean', async () => {
    // If this ever fails, an update destroys the operator's queue, roster, settings and
    // LinkedIn login. It passes because .gitignore covers data/ and clean is run WITHOUT -x.
    writeFileSync(join(repo.dataDir, 'app.db'), 'pretend database');
    writeFileSync(join(repo.dataDir, 'app.db-wal'), 'pretend wal');
    mkdirSync(join(repo.root, '.linkedin-profile'), { recursive: true });
    writeFileSync(join(repo.root, '.linkedin-profile', 'cookies'), 'logged in');
    writeFileSync(join(repo.root, 'tracked.txt'), 'edited\n');
    publishCommit(repo);

    await runUpdate(cfgFor(repo), { out: quiet });

    expect(readFileSync(join(repo.dataDir, 'app.db'), 'utf8')).toBe('pretend database');
    expect(readFileSync(join(repo.dataDir, 'app.db-wal'), 'utf8')).toBe('pretend wal');
    expect(readFileSync(join(repo.root, '.linkedin-profile', 'cookies'), 'utf8')).toBe('logged in');
  }, 60_000);

  test('data/ and the login survive even when .gitignore has been broken', async () => {
    // The excludes passed to `git clean` are deliberately redundant with .gitignore. This test
    // is why: relying on .gitignore alone makes the operator's login only as safe as a file
    // anyone can edit, and an early version of this suite really did delete the fake login.
    writeFileSync(join(repo.root, '.gitignore'), 'node_modules/\n');
    gitIn(repo.root, ['add', '-A']);
    gitIn(repo.root, ['commit', '-m', 'oops: dropped the protective ignores']);
    gitIn(repo.root, ['push', 'origin', 'main']);
    writeFileSync(join(repo.dataDir, 'app.db'), 'pretend database');
    mkdirSync(join(repo.root, '.linkedin-profile'), { recursive: true });
    writeFileSync(join(repo.root, '.linkedin-profile', 'cookies'), 'logged in');
    writeFileSync(join(repo.root, 'tracked.txt'), 'edited\n');

    await runUpdate(cfgFor(repo), { out: quiet });

    expect(readFileSync(join(repo.dataDir, 'app.db'), 'utf8')).toBe('pretend database');
    expect(readFileSync(join(repo.root, '.linkedin-profile', 'cookies'), 'utf8')).toBe('logged in');
  }, 60_000);

  test('discarded work is recoverable from a patch under data/backups', async () => {
    writeFileSync(join(repo.root, 'tracked.txt'), 'work worth keeping\n');
    writeFileSync(join(repo.root, 'stray.txt'), 'untracked');
    publishCommit(repo);

    await runUpdate(cfgFor(repo), { out: quiet });

    const patches = readdirSync(join(repo.dataDir, 'backups')).filter((f) => f.startsWith('discarded-'));
    expect(patches).toHaveLength(1);
    const patch = readFileSync(join(repo.dataDir, 'backups', patches[0]), 'utf8');
    expect(patch).toContain('work worth keeping');
    // Untracked contents cannot be expressed as a diff, so their names are recorded instead.
    expect(patch).toContain('stray.txt');
  }, 60_000);

  test('a clean folder writes no patch — no noise in data/backups on a routine update', async () => {
    publishCommit(repo);
    await runUpdate(cfgFor(repo), { out: quiet });
    const backups = existsSync(join(repo.dataDir, 'backups')) ? readdirSync(join(repo.dataDir, 'backups')) : [];
    expect(backups.filter((f) => f.startsWith('discarded-'))).toHaveLength(0);
  }, 60_000);

  test('rollbackTo puts a known-good version back and leaves the branch usable', async () => {
    // The supervisor calls this when the version it just installed will not start three times
    // running. Deliberately a plain `reset --hard`, not a detached checkout: detaching would
    // make the branch check refuse every FUTURE update, permanently wedging the install.
    const good = gitIn(repo.root, ['rev-parse', 'HEAD']);
    publishCommit(repo, { version: 'v2', subject: 'feat: the broken one' });
    await runUpdate(cfgFor(repo), { out: quiet });
    expect(gitIn(repo.root, ['rev-parse', 'HEAD'])).not.toBe(good);

    const restored = await rollbackTo(cfgFor(repo), good);

    expect(restored).toBe(true);
    expect(gitIn(repo.root, ['rev-parse', 'HEAD'])).toBe(good);
    // Still on main, so the operator can still take the next real fix through the same button.
    expect(gitIn(repo.root, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
  }, 120_000);

  test('rollbackTo reports failure rather than pretending, given a sha that does not exist', async () => {
    expect(await rollbackTo(cfgFor(repo), 'notasha')).toBe(false);
  }, 60_000);

  test('rollbackTo with no sha is a no-op, not a reset to nowhere', async () => {
    const head = gitIn(repo.root, ['rev-parse', 'HEAD']);
    expect(await rollbackTo(cfgFor(repo), null)).toBe(false);
    expect(gitIn(repo.root, ['rev-parse', 'HEAD'])).toBe(head);
  });

  test('local COMMITS still refuse — the one thing not recoverable from the remote', async () => {
    writeFileSync(join(repo.root, 'tracked.txt'), 'local work\n');
    gitIn(repo.root, ['add', '-A']);
    gitIn(repo.root, ['commit', '-m', 'a local commit nobody else has']);
    publishCommit(repo);

    const r = await runUpdate(cfgFor(repo), { out: quiet });

    expect(r.ok).toBe(false);
    expect(r.diverged).toBe(true);
    // Nothing was destroyed: the commit is still there to be rescued.
    expect(gitIn(repo.root, ['log', '-1', '--format=%s'])).toBe('a local commit nobody else has');
    // ...and the operator is told it is not theirs to fix, rather than just "did not finish".
    expect(r.error).toMatch(/history no longer matches/);
  }, 60_000);

  /**
   * The failure that actually happened on the author's machine, twice: an agent branched to
   * open a PR and never switched back, and the next Update refused — with a `git checkout`
   * instruction as the fix, on a machine whose operator does not know what a terminal is.
   * A branch with no commits of its own loses nothing by being left, so Update heals it.
   */
  test('a stray branch with nothing of its own is healed: back on main, update applied', async () => {
    gitIn(repo.root, ['checkout', '-b', 'claude/some-merged-fix']);
    publishCommit(repo, { subject: 'feat: something new', extraFile: 'brand-new.txt' });

    const r = await runUpdate(cfgFor(repo), { out: quiet });

    expect(r.ok).toBe(true);
    expect(gitIn(repo.root, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
    expect(existsSync(join(repo.root, 'brand-new.txt'))).toBe(true);
    expect(r.log).toContain('feat: something new');
  }, 60_000);

  test('a detached checkout with nothing of its own heals the same way', async () => {
    gitIn(repo.root, ['checkout', '--detach']);
    publishCommit(repo, { subject: 'feat: something new' });

    const r = await runUpdate(cfgFor(repo), { out: quiet });

    expect(r.ok).toBe(true);
    expect(gitIn(repo.root, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
  }, 60_000);

  /**
   * Healing must stop exactly where it would abandon work: a branch whose commits the
   * published version lacks is a maintainer mid-something, and the dashboard names the
   * branch rather than falling back to "the update did not finish".
   */
  test('a branch carrying its own commits still refuses, untouched, and the dashboard says why', async () => {
    gitIn(repo.root, ['checkout', '-b', 'claude/work-in-progress']);
    writeFileSync(join(repo.root, 'tracked.txt'), 'unfinished maintainer work\n');
    gitIn(repo.root, ['add', '-A']);
    gitIn(repo.root, ['commit', '-m', 'wip: not published anywhere']);
    publishCommit(repo, { subject: 'feat: something new' });

    const r = await runUpdate(cfgFor(repo), { out: quiet });

    expect(r.ok).toBe(false);
    expect(r.blocked).toBe(true);
    // Nothing was healed away: still on the branch, the commit still at its tip.
    expect(gitIn(repo.root, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('claude/work-in-progress');
    expect(gitIn(repo.root, ['log', '-1', '--format=%s'])).toBe('wip: not published anywhere');

    const { state, message } = summarizeControl(
      markFailed(newRequest('update'), r.error, '2026-08-11T00:00:00.000Z'),
    );

    expect(state).toBe('failed');
    expect(message).toContain('claude/work-in-progress');
    expect(message).toContain('git checkout main');
    // The old generic fallback must be gone, not merely accompanied.
    expect(message).not.toContain('the update did not complete');
  }, 60_000);
});
