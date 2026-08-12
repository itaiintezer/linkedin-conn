/**
 * One-command update for The Machine:  npm run update  (also run by scripts/supervisor.mjs
 * when the dashboard's Update button asks for it).
 *
 * Pulls the newest code and reinstalls dependencies. It used to REFUSE whenever the folder had
 * been edited; it now discards those edits instead. The reasoning changed with the audience:
 * the operators are sales reps who never intentionally edit anything, so a local change is
 * always an accident (a stray file, an editor that reformatted on open), and refusing left them
 * stuck at a git error with no way forward. The repo is the single source of truth for code —
 * and `.gitignore` covers `data/`, `*.db*` and `.linkedin-profile/`, so neither `git reset
 * --hard` nor `git clean -fd` can reach the queue, the roster or the LinkedIn login.
 *
 * Discarded work is still recoverable: it goes to data/backups/discarded-<ts>.patch first.
 *
 * The same reasoning covers a checkout left on the wrong branch (an agent that branched for a
 * PR and never switched back): when the branch has no commits of its own, the update puts the
 * folder back on the release branch and continues. Only a branch carrying unpublished commits
 * — a maintainer mid-work — still refuses.
 *
 * Deliberately plain ESM JavaScript with ZERO dependencies and no TypeScript, matching
 * scripts/preflight.mjs: an update may be the thing that repairs a broken node_modules, so
 * this file must run before `npm install` has fetched anything.
 *
 * The pure checks are exported and unit-tested in tests/scripts/update.test.mjs; the probes
 * and the runner below are the impure half. Paths come from resolveConfig() rather than from
 * import.meta.url so a test can point the whole script at a disposable repo — nothing here may
 * ever touch the real data/app.db.
 */
import { execFileSync, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Where this run operates. Defaults to the checkout this file lives in, which is what `npm run
 * update` wants; `--root=`/`--data-dir=` (or THEMACHINE_ROOT/THEMACHINE_DATA_DIR) are how the
 * supervisor and the tests aim it somewhere else.
 */
export function resolveConfig({ argv = [], env = {} } = {}) {
  const flag = (name) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };
  const root = flag('root') ?? env.THEMACHINE_ROOT ?? SCRIPT_ROOT;
  const dataDir = flag('data-dir') ?? env.THEMACHINE_DATA_DIR ?? join(root, 'data');
  return {
    root,
    dataDir,
    dbPath: join(dataDir, 'app.db'),
    backupDir: join(dataDir, 'backups'),
    port: Number(env.PORT ?? 4400),
    // The supervisor has already stopped the app before calling us, so the "is it running"
    // check is noise there — and its advice ("use the dashboard") would be absurd, since the
    // dashboard is what asked for this update.
    supervised: env.THEMACHINE_SUPERVISED_UPDATE === '1',
  };
}

/** The branch colleagues track. A clone lands here; anything else is a maintainer mid-work. */
export const RELEASE_BRANCH = 'main';

/** How many database backups to retain. An enriched roster is not small; five is plenty. */
export const KEEP_BACKUPS = 5;

/** Lines of changelog to print before collapsing the rest into a count. */
export const LOG_CAP = 20;

/**
 * Never deleted by the clean, whatever .gitignore happens to say. Everything an operator would
 * lose forever: the queue and roster database, and the logged-in browser profile.
 */
export const PROTECTED = ['data', '.linkedin-profile'];

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
export function checkNotRunning(state, port = 4400) {
  if (state === 'ours') {
    return fail(
      'running',
      'The Machine',
      `still running on port ${port}.`,
      `Use the Update button on the dashboard (http://localhost:${port} → Settings) — it stops The Machine, updates it and starts it again for you. This terminal command cannot: reinstalling while the app is live leaves files locked and the install half-finished.`,
    );
  }
  if (state === 'foreign') {
    return ok('running', 'The Machine', `not running (something unrelated is on port ${port})`);
  }
  return ok('running', 'The Machine', 'not running');
}

/**
 * `porcelain` is the raw output of `git status --porcelain`. Splits it into the tracked edits
 * and the untracked strays, so the caller can both report and discard them.
 */
export function parseLocalChanges(porcelain) {
  // Strip the two-column status code and its separator rather than slicing a fixed width:
  // an unstaged edit is " M path", so any caller that trimmed the output would leave the
  // first line one character short and silently report "ackage.json".
  const strip = (l) => l.replace(/^\s*[A-Z?!ADMRCU]{1,2}\s+/, '').trim();
  const lines = String(porcelain ?? '').split('\n').filter((l) => l.trim());
  const isUntracked = (l) => l.trimStart().startsWith('??');
  return {
    edited: lines.filter((l) => !isUntracked(l)).map(strip).filter(Boolean),
    untracked: lines.filter(isUntracked).map(strip).filter(Boolean),
  };
}

/**
 * Reports local changes. NEVER an error — this used to be the gate that blocked the update, and
 * it is now only the sentence that tells the operator what got put back.
 *
 * The history is worth keeping in view. Blocking on untracked files was worse than useless: a
 * colleague's Mac dropped a `.DS_Store` in the folder, which stopped the update dead — and
 * neither remedy the old message suggested (`git checkout -- .`, `git stash`) removes an
 * untracked file, so the advice looped him back to the same error while he waited on a fix
 * (2026-08-03). Blocking on tracked edits had the same shape of problem one step later: the
 * operator was handed a git command and told to run it in a terminal, which is precisely what
 * this audience cannot do. Both are now handled by resetWorkingTree() instead of explained.
 */
export function describeLocalChanges(porcelain) {
  const { edited, untracked } = parseLocalChanges(porcelain);
  if (edited.length === 0 && untracked.length === 0) return ok('clean', 'Local changes', 'none');

  const listOf = (files) => {
    const shown = files.slice(0, 10);
    const more = files.length - shown.length;
    return shown.map((f) => `  · ${f}`).join('\n') + (more > 0 ? `\n  · …and ${more} more` : '');
  };
  const parts = [];
  if (edited.length > 0) {
    parts.push(`${edited.length} edited file${edited.length === 1 ? '' : 's'}:\n${listOf(edited)}`);
  }
  if (untracked.length > 0) {
    parts.push(`${untracked.length} file${untracked.length === 1 ? '' : 's'} git is not tracking:\n${listOf(untracked)}`);
  }
  return warn(
    'clean',
    'Local changes',
    `${parts.join('\n')}\nThese will be put back the way the published version has them.`,
    'Nothing you care about is affected — your queue, contacts, settings and LinkedIn login are not stored in git. A copy of the discarded changes is saved under data/backups/ just in case.',
  );
}

/**
 * `aheadOfRelease` is how many commits HEAD carries that the published branch does not
 * (null = could not tell). Zero means switching back to the release branch loses nothing —
 * the checkout was merely LEFT somewhere, e.g. by an agent that branched for a PR and never
 * switched back — so the update heals it (runUpdate performs the checkout) instead of
 * refusing with a git instruction the operator audience cannot execute. Anything else is a
 * maintainer's work in progress, which healing would silently abandon: still a refusal.
 */
export function checkBranch(branch, aheadOfRelease) {
  if (branch === RELEASE_BRANCH) return ok('branch', 'Branch', branch);
  const where = branch ? `\`${branch}\`` : 'a detached commit';
  if (aheadOfRelease === 0) {
    return warn(
      'branch',
      'Branch',
      `this checkout was left on ${where}, which has no changes of its own — it will be put back on \`${RELEASE_BRANCH}\`.`,
    );
  }
  return fail(
    'branch',
    'Branch',
    `this checkout is on ${where}, not \`${RELEASE_BRANCH}\`, and it carries commits the published version does not.`,
    `This looks like a maintainer's work in progress — updating would abandon it. Push or merge that work, or switch back with \`git checkout ${RELEASE_BRANCH}\`, then run this again.`,
  );
}

export function summarize(results) {
  const errors = results.filter((r) => r.severity === 'error');
  return { ok: errors.length === 0, exitCode: errors.length === 0 ? 0 : 1, errors };
}

/**
 * Why a blocked update was blocked, in a sentence an operator can act on.
 *
 * This is what reaches data/control.json, and therefore the dashboard banner. It exists because
 * the reason used to live ONLY in the terminal output above: the supervisor had nothing specific
 * to record, so it fell back to "the update did not complete" — a restatement of the headline,
 * not a reason. On a machine that starts at login there is no console to read the real one in, so
 * an operator saw the button appear to do nothing. `fix` is included deliberately: the whole
 * value here is the next action, not the diagnosis.
 */
export function blockedReason(errors) {
  if (!Array.isArray(errors) || errors.length === 0) return 'the update did not complete';
  return errors
    .map((e) => [`${e.label}: ${e.message}`, e.fix].filter(Boolean).join(' '))
    .join(' ');
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
function backupDatabase(cfg, now) {
  const { dbPath: DB_PATH, backupDir: BACKUP_DIR } = cfg;
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
// Putting the folder back
// ---------------------------------------------------------------------------

/** Sortable and Windows-legal, same reasoning as backupFilename. */
export function discardedPatchFilename(date) {
  return `discarded-${date.toISOString().slice(0, 19).replace(/:/g, '-')}.patch`;
}

/**
 * Save whatever we are about to destroy, then destroy it.
 *
 * `reset --hard` rather than `checkout -- .`: the latter restores the worktree FROM THE INDEX,
 * so anything already `git add`ed survives it and still gets merged by the pull — which is the
 * merge conflict we are trying to make impossible.
 *
 * `clean -fd` and never `-fdx`: without `-x`, git skips ignored paths, which is exactly the
 * line we want. `data/`, `*.db*` and `.linkedin-profile/` are ignored, so the queue, the roster
 * and the logged-in browser profile are all out of reach. Adding `-x` would delete every one of
 * them, along with node_modules.
 *
 * PROTECTED is belt-and-braces on top of that. Relying on .gitignore alone makes an operator's
 * login and queue only as safe as a file anyone can edit — drop one line from .gitignore and
 * this function starts deleting the things it exists to protect. A test deliberately breaks
 * .gitignore to prove these excludes still hold.
 *
 * Returns a description of what was discarded, or null when the folder was already clean.
 */
function resetWorkingTree(cfg, now) {
  const porcelain = probePorcelain(cfg.root);
  const { edited, untracked } = parseLocalChanges(porcelain);
  if (edited.length === 0 && untracked.length === 0) return null;

  let saved = null;
  if (edited.length > 0) {
    // Only tracked edits can be expressed as a patch; the untracked list is recorded as names.
    try {
      const diff = gitRaw(cfg.root, ['diff', 'HEAD']);
      fs.mkdirSync(cfg.backupDir, { recursive: true });
      const name = discardedPatchFilename(now);
      const header = untracked.length > 0
        ? `# Untracked files also removed (contents not captured):\n${untracked.map((f) => `#   ${f}`).join('\n')}\n\n`
        : '';
      fs.writeFileSync(join(cfg.backupDir, name), header + diff);
      saved = `data/backups/${name}`;
    } catch {
      /* Failing to save the patch must not stop the update — the repo is the source of truth. */
    }
  }

  git(cfg.root, ['reset', '--hard', 'HEAD']);
  git(cfg.root, ['clean', '-fd', ...PROTECTED.flatMap((p) => ['-e', p])]);

  const counts = [
    edited.length > 0 ? `${edited.length} edited file${edited.length === 1 ? '' : 's'}` : null,
    untracked.length > 0 ? `${untracked.length} stray file${untracked.length === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(' and ');
  return `Put the folder back the way the published version has it (${counts})${saved ? `; a copy of the changes is in ${saved}` : ''}.`;
}

// ---------------------------------------------------------------------------
// Probes — the impure half.
// ---------------------------------------------------------------------------

function gitRaw(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Trimmed — convenient for the single-value queries (branch name, sha, version). Anything
 * whose leading whitespace is significant, i.e. porcelain status, must use gitRaw.
 */
function git(root, args) {
  return gitRaw(root, args).trim();
}

function probeGitVersion(root) {
  try {
    return git(root, ['--version']) || null;
  } catch {
    return null;
  }
}

function probeGitRepo(root) {
  return fs.existsSync(join(root, '.git'));
}

function probeBranch(root) {
  try {
    const b = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return b === 'HEAD' ? null : b; // detached
  } catch {
    return null;
  }
}

function probePorcelain(root) {
  try {
    return gitRaw(root, ['status', '--porcelain']);
  } catch {
    return '';
  }
}

/**
 * How many commits HEAD has that the published branch does not — the fact checkBranch needs
 * to tell a strayed checkout (heal it) from abandoned work (refuse). Fetches first so a
 * branch already merged upstream counts as safe even though this clone has not pulled since;
 * offline, it falls back to wherever origin/<release> was last seen, which can only be
 * pessimistic (report commits as unpublished), never destructive. `null` = could not tell,
 * which checkBranch treats as a refusal rather than a guess.
 */
function probeAheadOfRelease(root) {
  try {
    gitRaw(root, ['fetch', '--quiet', 'origin', RELEASE_BRANCH]);
  } catch {
    /* offline is fine — see above */
  }
  for (const ref of [`origin/${RELEASE_BRANCH}`, RELEASE_BRANCH]) {
    try {
      const n = Number(git(root, ['rev-list', '--count', `${ref}..HEAD`]));
      if (Number.isInteger(n)) return n;
    } catch {
      /* ref unknown — try the next */
    }
  }
  return null;
}

function probeHead(root) {
  try {
    return git(root, ['rev-parse', 'HEAD']);
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

/** Format `git log --oneline --no-merges old..new` for humans, capping the list. */
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

export async function runPreconditions(cfg) {
  const results = [];
  const isRepo = probeGitRepo(cfg.root);
  results.push(checkGitRepo(isRepo));

  const version = probeGitVersion(cfg.root);
  results.push(checkGitAvailable(version));

  // Skipped under the supervisor, which has already stopped the app — see resolveConfig.
  if (!cfg.supervised) results.push(checkNotRunning(await probeServer(cfg.port), cfg.port));

  // Both need a working git in a real checkout; skip rather than emit a confusing second
  // failure that is really just the first one restated.
  if (isRepo && version) {
    const branch = probeBranch(cfg.root);
    // The ahead-count probe fetches, so it is only paid on the stray-branch path.
    results.push(checkBranch(branch, branch === RELEASE_BRANCH ? 0 : probeAheadOfRelease(cfg.root)));
    results.push(describeLocalChanges(probePorcelain(cfg.root)));
  }
  return results;
}

/**
 * The whole update, as a function so the supervisor can call it in-process and tests can point
 * it at a disposable repo. Returns { ok, unchanged, log } rather than exiting, so the only
 * process.exit in this file stays in main().
 */
export async function runUpdate(cfg, { now = new Date(), out = console } = {}) {
  const results = await runPreconditions(cfg);
  const { ok: passed, exitCode, errors } = summarize(results);
  out.log(formatResults(results));
  out.log('');
  if (!passed) return { ok: false, exitCode, blocked: true, error: blockedReason(errors) };

  const before = probeHead(cfg.root);

  const backup = backupDatabase(cfg, now);
  out.log(backup ? `Backed up your database to ${backup}` : 'No database yet — nothing to back up.');

  // Before the pull, so the pull always runs against a folder that matches its own history.
  const reset = resetWorkingTree(cfg, now);
  if (reset) out.log(reset);

  // A checkout left on another branch (or a detached commit) with nothing of its own is put
  // back on the release branch rather than explained — the operator audience cannot run git.
  // Preconditions only let a stray checkout through when it carries no commits the published
  // version lacks (checkBranch), and the reset above just cleaned the tree, so the switch
  // can neither collide nor lose anything.
  if (probeBranch(cfg.root) !== RELEASE_BRANCH) {
    try {
      git(cfg.root, ['checkout', RELEASE_BRANCH]);
      out.log(`Put this install back on \`${RELEASE_BRANCH}\`.`);
    } catch (e) {
      out.error(`\nCould not switch back to \`${RELEASE_BRANCH}\`:\n${String(e?.stderr ?? e).trim()}\n`);
      return {
        ok: false,
        exitCode: 1,
        error: `This folder was left on the wrong branch and could not be put back on \`${RELEASE_BRANCH}\`, so no new code was installed. Ask whoever maintains The Machine to look at it.`,
      };
    }
  }

  out.log('\nFetching the newest version…');
  try {
    git(cfg.root, ['pull', '--ff-only']);
  } catch (e) {
    out.error(`\n${fastForwardFailureMessage(e?.stderr)}\n`);
    return {
      ok: false,
      exitCode: 1,
      diverged: true,
      // Short on purpose: the terminal gets the full explanation above, the banner gets the one
      // line that tells an operator this is not something they can fix themselves.
      error: "This folder's history no longer matches the published version, so no new code was"
        + ' installed. Ask whoever maintains The Machine to look at it.',
    };
  }

  const after = probeHead(cfg.root);
  if (before && after && before === after) {
    out.log('Already up to date — no new changes.\n');
    return { ok: true, unchanged: true, from: before, to: after, log: '' };
  }

  out.log('Installing dependencies…\n');
  try {
    // execSync, not execFileSync: on Windows npm is a .cmd shim that Node refuses to
    // execFile without a shell. A fixed literal command has no injection surface.
    // --no-audit --no-fund: neither is actionable by a sales rep, and both add pages of output
    // to a screen they are meant to read for a yes/no answer.
    execSync('npm install --no-audit --no-fund', { cwd: cfg.root, stdio: 'inherit' });
  } catch {
    out.error('\n`npm install` failed. The new code is in place but its dependencies are not.');
    out.error('Fix whatever npm reported above, then run `npm install` again by hand.\n');
    // Deliberately silent about WHICH version is running: the new code is on disk but its
    // dependencies are not, and the supervisor's rollback decides the rest. Claiming either
    // version here would be a guess, and a wrong one is worse than none.
    return {
      ok: false,
      exitCode: 1,
      from: before,
      to: after,
      installFailed: true,
      error: "Installing the new version's parts failed part-way. Try the update again — if it"
        + ' keeps failing, ask whoever maintains The Machine.',
    };
  }

  let log = '';
  try {
    // --no-merges, because this list is a changelog and a merge commit is not a change. A PR
    // merged with GitHub's button lands as the branch's own commit PLUS a merge commit, so
    // counting both told the operator "2 new changes" for one fix — and the extra line
    // ("Merge pull request #31 from itaiintezer/claude/…") is the one that means least to
    // someone who has never seen a branch name.
    log = git(cfg.root, ['log', '--oneline', '--no-merges', `${before}..${after}`]);
  } catch {
    /* the update worked; not being able to list it is cosmetic */
  }
  out.log(`\nUpdated.\n\n${describeUpdates(log)}\n`);
  return { ok: true, unchanged: false, from: before, to: after, log };
}

/**
 * Put a known-good version back, for when the one we just installed will not start.
 *
 * Deliberately a plain `reset --hard <sha>` and NOT a detached checkout. Detaching would make
 * the branch check refuse every future update, which permanently wedges the install and needs a
 * maintainer — whereas moving the branch back means the operator is running working code and the
 * next real fix still arrives through the normal Update button. The cost is that clicking Update
 * again re-installs the same broken version, which the control file's failure message says
 * plainly.
 */
export async function rollbackTo(cfg, sha) {
  if (!sha) return false;
  try {
    git(cfg.root, ['reset', '--hard', sha]);
  } catch {
    return false;
  }
  try {
    execSync('npm install --no-audit --no-fund', { cwd: cfg.root, stdio: 'inherit' });
  } catch {
    // The code is back; its dependencies may be a mix. Still better than a version that cannot
    // start at all, and the next update will reinstall.
    return true;
  }
  return true;
}

async function main() {
  console.log('\nThe Machine — update\n');
  const cfg = resolveConfig({ argv: process.argv.slice(2), env: process.env });
  const result = await runUpdate(cfg);

  if (!result.ok) {
    if (result.blocked) {
      console.error('Cannot update yet — fix the FAIL lines above and try again.');
      console.error('Nothing has been changed. Non-technical walkthrough: RUNBOOK.md\n');
    }
    process.exit(result.exitCode ?? 1);
  }
  if (!cfg.supervised) console.log('Start it with:  npm start\n');
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
