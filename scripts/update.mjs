/**
 * One-command update for The Machine:  npm run update
 *
 * Pulls the newest code and reinstalls dependencies, having first refused to run in any
 * situation where doing so could lose data or leave a half-updated install. The refusals are
 * the point of this script — the four commands it wraps are easy, but running them in the
 * wrong order, or while the app is live, is not.
 *
 * Deliberately plain ESM JavaScript with ZERO dependencies and no TypeScript, matching
 * scripts/preflight.mjs: an update may be the thing that repairs a broken node_modules, so
 * this file must run before `npm install` has fetched anything.
 *
 * The pure checks are exported and unit-tested in tests/scripts/update.test.mjs; the probes
 * and the runner below are the impure half.
 */
import { execFileSync, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
const DB_PATH = join(DATA_DIR, 'app.db');
const BACKUP_DIR = join(DATA_DIR, 'backups');
const PORT = Number(process.env.PORT ?? 4400);

/** The branch colleagues track. A clone lands here; anything else is a maintainer mid-work. */
export const RELEASE_BRANCH = 'main';

/** How many database backups to retain. An enriched roster is not small; five is plenty. */
export const KEEP_BACKUPS = 5;

/** Lines of changelog to print before collapsing the rest into a count. */
export const LOG_CAP = 20;

const BACKUP_PREFIX = 'app.db.';

const ok = (id, label, message) => ({ id, label, severity: 'ok', message });
// Same three-severity shape as scripts/preflight.mjs. Only 'error' blocks (see summarize),
// so 'warn' is how a check reports something the operator should see without stopping them.
const warn = (id, label, message, fix) => ({ id, label, severity: 'warn', message, fix });
const fail = (id, label, message, fix) => ({ id, label, severity: 'error', message, fix });

// ---------------------------------------------------------------------------
// Pure checks — each takes an already-probed fact so it can be tested directly.
// ---------------------------------------------------------------------------

export function checkGitRepo(hasGitDir) {
  if (hasGitDir) return ok('repo', 'Git checkout', 'yes');
  return fail(
    'repo',
    'Git checkout',
    'this folder was not cloned with git, so there is nothing to pull from.',
    'You most likely have a copy that was sent to you as a zip. Clone it instead: `git clone https://github.com/itaiintezer/linkedin-conn.git`, then copy your old `data` folder into the new one.',
  );
}

export function checkGitAvailable(version) {
  if (version) return ok('git', 'git', version);
  return fail(
    'git',
    'git',
    'git was not found on your PATH.',
    'Install it — macOS: `xcode-select --install`; Windows: https://git-scm.com/download/win; Linux: your package manager. Then reopen your terminal and try again.',
  );
}

/**
 * `state` is 'free', 'ours' (our /api/status answered) or 'foreign' (something else is on
 * the port). Only 'ours' blocks: an unrelated service on 4400 has no bearing on updating,
 * and telling someone to shut down a program that isn't The Machine would be wrong.
 */
export function checkNotRunning(state, port = PORT) {
  if (state === 'ours') {
    return fail(
      'running',
      'The Machine',
      `still running on port ${port}.`,
      'Click the terminal window running `npm start` and press Ctrl+C, wait for it to come back to a prompt, then run this again. Do not close the window instead — that can leave the LinkedIn browser running and block the next start.',
    );
  }
  if (state === 'foreign') {
    return ok('running', 'The Machine', `not running (something unrelated is on port ${port})`);
  }
  return ok('running', 'The Machine', 'not running');
}

/**
 * `porcelain` is the raw output of `git status --porcelain`.
 *
 * EDITS to tracked files are refused rather than stashed: `git pull` into local edits is how
 * you get a merge conflict, which is the one failure a non-technical operator has no way out of.
 *
 * UNTRACKED files ('??') only warn. A pull cannot collide with a file git is not tracking
 * unless the incoming commit creates that very path, and git refuses that case loudly by
 * itself. Blocking on them was worse than useless: a colleague's Mac dropped a `.DS_Store` in
 * the folder, which stopped the update dead — and NEITHER remedy suggested below (`git checkout
 * -- .`, `git stash`) removes an untracked file, so the advice looped him back to the same
 * error while he was waiting on a fix (2026-08-03). `.DS_Store` is also gitignored now; this
 * check still has to be right for whatever the next stray file turns out to be.
 */
export function checkCleanTree(porcelain) {
  // Strip the two-column status code and its separator rather than slicing a fixed width:
  // an unstaged edit is " M path", so any caller that trimmed the output would leave the
  // first line one character short and silently report "ackage.json".
  const strip = (l) => l.replace(/^\s*[A-Z?!ADMRCU]{1,2}\s+/, '').trim();
  const lines = String(porcelain ?? '').split('\n').filter((l) => l.trim());
  const isUntracked = (l) => l.trimStart().startsWith('??');
  const edited = lines.filter((l) => !isUntracked(l)).map(strip).filter(Boolean);
  const untracked = lines.filter(isUntracked).map(strip).filter(Boolean);

  if (edited.length === 0 && untracked.length === 0) return ok('clean', 'Local changes', 'none');

  const listOf = (files) => {
    const shown = files.slice(0, 10);
    const more = files.length - shown.length;
    return shown.map((f) => `  · ${f}`).join('\n') + (more > 0 ? `\n  · …and ${more} more` : '');
  };
  // Reported either way, so the operator still sees them — just never as a reason to stop.
  const note = untracked.length === 0 ? ''
    : `\n${untracked.length} file${untracked.length === 1 ? '' : 's'} git is not tracking`
      + ` (${untracked.length === 1 ? 'this does' : 'these do'} NOT block the update):\n${listOf(untracked)}`;

  if (edited.length === 0) return warn('clean', 'Local changes', `none that block the update.${note}`);

  return fail(
    'clean',
    'Local changes',
    `${edited.length} file${edited.length === 1 ? '' : 's'} in this folder ${edited.length === 1 ? 'has' : 'have'} been edited:\n${listOf(edited)}${note}`,
    'Updating would try to merge those edits and could stop halfway. Undo them with `git checkout -- .`, or save them with `git stash`, then run this again. Your queue and login are not in git and are never affected.',
  );
}

export function checkBranch(branch) {
  if (branch === RELEASE_BRANCH) return ok('branch', 'Branch', branch);
  const where = branch ? `\`${branch}\`` : 'a detached commit';
  return fail(
    'branch',
    'Branch',
    `this checkout is on ${where}, not \`${RELEASE_BRANCH}\`.`,
    `Updates are published on \`${RELEASE_BRANCH}\`. Switch with \`git checkout ${RELEASE_BRANCH}\` and run this again.`,
  );
}

export function summarize(results) {
  const errors = results.filter((r) => r.severity === 'error');
  return { ok: errors.length === 0, exitCode: errors.length === 0 ? 0 : 1, errors };
}

export function formatResults(results) {
  const mark = { ok: '  ok  ', warn: ' warn ', error: ' FAIL ' };
  return results
    .map((r) => {
      const head = `[${mark[r.severity]}] ${r.label}: ${r.message}`;
      return r.severity === 'ok' || !r.fix ? head : `${head}\n           → ${r.fix}`;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

/**
 * Sortable, and legal on Windows — which is why the time is dashed rather than the colons an
 * ISO string would use. Lexical order therefore equals chronological order, which is what
 * lets backupsToPrune() work on filenames alone.
 */
export function backupFilename(date) {
  const iso = date.toISOString().slice(0, 19); // 2026-08-03T00:41:12
  return `${BACKUP_PREFIX}${iso.replace(/:/g, '-')}`;
}

/** The backups to delete, oldest first, keeping the newest `keep`. Ignores unrelated files. */
export function backupsToPrune(filenames, keep = KEEP_BACKUPS) {
  const ours = filenames.filter((f) => f.startsWith(BACKUP_PREFIX)).sort();
  return ours.slice(0, Math.max(0, ours.length - keep));
}

/**
 * Fold the WAL into the main file in a child process. Importing node:sqlite here would print
 * "ExperimentalWarning: SQLite is an experimental feature" into the middle of the update
 * output; NODE_NO_WARNINGS in a child suppresses it. The path travels by environment variable
 * rather than being interpolated into -e source, so a folder name with a quote in it is safe.
 */
function checkpointWal(dbPath) {
  const src = [
    "const { DatabaseSync } = await import('node:sqlite');",
    'const db = new DatabaseSync(process.env.UPDATE_DB_PATH);',
    "db.exec('PRAGMA wal_checkpoint(TRUNCATE);');",
    'db.close();',
  ].join('\n');
  try {
    execFileSync(process.execPath, ['--input-type=module', '-e', src], {
      env: { ...process.env, NODE_NO_WARNINGS: '1', UPDATE_DB_PATH: dbPath },
      stdio: 'ignore',
      timeout: 60_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy the database aside before anything else runs. Returns a human-readable note, or null
 * when there is no database yet (a fresh clone, where there is nothing to protect).
 */
function backupDatabase(now) {
  if (!fs.existsSync(DB_PATH)) return null;
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const name = backupFilename(now);
  const folded = checkpointWal(DB_PATH);
  fs.copyFileSync(DB_PATH, join(BACKUP_DIR, name));

  // If the checkpoint failed the main file may not hold the most recent writes, so the
  // sidecars come along too — an incomplete backup is worse than an ugly one.
  let note = '';
  if (!folded) {
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(DB_PATH + suffix)) fs.copyFileSync(DB_PATH + suffix, join(BACKUP_DIR, name + suffix));
    }
    note = ' (with its -wal/-shm sidecars: the write-ahead log could not be folded in)';
  }

  for (const stale of backupsToPrune(fs.readdirSync(BACKUP_DIR))) {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.rmSync(join(BACKUP_DIR, stale + suffix), { force: true });
      } catch {
        /* a backup we couldn't delete is not a reason to stop the update */
      }
    }
  }
  const mb = (fs.statSync(join(BACKUP_DIR, name)).size / 1024 ** 2).toFixed(1);
  return `data/backups/${name} (${mb} MB)${note}`;
}

// ---------------------------------------------------------------------------
// Probes — the impure half.
// ---------------------------------------------------------------------------

function gitRaw(args) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Trimmed — convenient for the single-value queries (branch name, sha, version). Anything
 * whose leading whitespace is significant, i.e. porcelain status, must use gitRaw.
 */
function git(args) {
  return gitRaw(args).trim();
}

function probeGitVersion() {
  try {
    return git(['--version']) || null;
  } catch {
    return null;
  }
}

function probeGitRepo() {
  return fs.existsSync(join(ROOT, '.git'));
}

function probeBranch() {
  try {
    const b = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    return b === 'HEAD' ? null : b; // detached
  } catch {
    return null;
  }
}

function probePorcelain() {
  try {
    return gitRaw(['status', '--porcelain']);
  } catch {
    return '';
  }
}

function probeHead() {
  try {
    return git(['rev-parse', 'HEAD']);
  } catch {
    return null;
  }
}

/**
 * 'ours' | 'foreign' | 'free'. Asking /api/status rather than just testing whether the port
 * binds is what separates "The Machine is up, go press Ctrl+C" from "some other program of
 * yours happens to use 4400", which are different situations needing different advice.
 */
async function probeServer(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return 'foreign';
    const body = await res.json();
    return body && typeof body === 'object' && 'weekly_cap' in body && 'msg_counts' in body ? 'ours' : 'foreign';
  } catch (e) {
    // A refused connection means nothing is there; anything else (a socket that accepts but
    // never answers) is something we should not assume is ours.
    return e?.cause?.code === 'ECONNREFUSED' ? 'free' : e?.name === 'TimeoutError' ? 'foreign' : 'free';
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** Format `git log --oneline old..new` for humans, capping the list. */
export function describeUpdates(logOutput, cap = LOG_CAP) {
  const lines = String(logOutput ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return 'Already up to date — no new changes.';
  const shown = lines.slice(0, cap).map((l) => `  · ${l}`);
  const more = lines.length - shown.length;
  if (more > 0) shown.push(`  · …and ${more} more change${more === 1 ? '' : 's'}`);
  return `${lines.length} new change${lines.length === 1 ? '' : 's'}:\n${shown.join('\n')}`;
}

export function fastForwardFailureMessage(stderr) {
  return [
    'Could not update: git refused to fast-forward.',
    '',
    String(stderr ?? '').trim(),
    '',
    'This means this copy has commits that the published version does not, so the two have',
    'diverged. Nothing was changed and your queue, login and settings are untouched — the',
    'install still works exactly as it did. Ask whoever maintains The Machine to look at it,',
    'or start fresh with a new clone and copy your `data` folder across.',
  ]
    .filter((l, i, a) => !(l === '' && a[i - 1] === '')) // collapse the gap when stderr is empty
    .join('\n');
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export async function runPreconditions() {
  const results = [];
  const isRepo = probeGitRepo();
  results.push(checkGitRepo(isRepo));

  const version = probeGitVersion();
  results.push(checkGitAvailable(version));

  results.push(checkNotRunning(await probeServer(PORT), PORT));

  // Both need a working git in a real checkout; skip rather than emit a confusing second
  // failure that is really just the first one restated.
  if (isRepo && version) {
    results.push(checkBranch(probeBranch()));
    results.push(checkCleanTree(probePorcelain()));
  }
  return results;
}

async function main() {
  console.log('\nThe Machine — update\n');

  const results = await runPreconditions();
  const { ok: passed, exitCode } = summarize(results);
  console.log(formatResults(results));
  console.log('');
  if (!passed) {
    console.error('Cannot update yet — fix the FAIL lines above and try again.');
    console.error('Nothing has been changed. Non-technical walkthrough: RUNBOOK.md\n');
    process.exit(exitCode);
  }

  const before = probeHead();

  const backup = backupDatabase(new Date());
  console.log(backup ? `Backed up your database to ${backup}` : 'No database yet — nothing to back up.');

  console.log('\nFetching the newest version…');
  try {
    git(['pull', '--ff-only']);
  } catch (e) {
    console.error(`\n${fastForwardFailureMessage(e?.stderr)}\n`);
    process.exit(1);
  }

  const after = probeHead();
  const unchanged = before && after && before === after;

  if (unchanged) {
    console.log('Already up to date — no new changes.\n');
    console.log('Start it with:  npm start\n');
    return;
  }

  console.log('Installing dependencies…\n');
  try {
    // execSync, not execFileSync: on Windows npm is a .cmd shim that Node refuses to
    // execFile without a shell. A fixed literal command has no injection surface.
    execSync('npm install', { cwd: ROOT, stdio: 'inherit' });
  } catch {
    console.error('\n`npm install` failed. The new code is in place but its dependencies are not.');
    console.error('Fix whatever npm reported above, then run `npm install` again by hand.\n');
    process.exit(1);
  }

  let log = '';
  try {
    log = git(['log', '--oneline', `${before}..${after}`]);
  } catch {
    /* the update worked; not being able to list it is cosmetic */
  }
  console.log(`\nUpdated.\n\n${describeUpdates(log)}\n`);
  console.log('Start it with:  npm start\n');
}

/**
 * Only run when invoked directly — importing this file (tests) must not call process.exit.
 * The basename fallback covers npm/Windows handing us a differently-formed path than the URL
 * this module was loaded from; without it the update could silently never run.
 */
const invoked = process.argv[1] ?? '';
const isMain =
  invoked !== '' &&
  (pathToFileURL(invoked).href === import.meta.url || basename(invoked) === basename(fileURLToPath(import.meta.url)));

if (isMain) await main();
