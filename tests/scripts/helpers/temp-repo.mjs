/**
 * A disposable git repo for testing update.mjs and supervisor.mjs for real.
 *
 * This is what makes the supervisor/update mechanism testable without a human: the scripts
 * under test are pointed at one of these instead of the real checkout, and the "app" inside it
 * is a ten-line fake that exits with whatever code a file tells it to. Real git, real
 * `npm install` (over zero dependencies, so it is fast), no browser, no LinkedIn, no network.
 *
 * Plain .mjs for the same reason as the scripts it tests: they must run on a bare Node.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Commit identity, so the test does not depend on the machine having git configured. */
const IDENT = ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false'];

export function git(cwd, args) {
  return execFileSync('git', [...IDENT, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * The fake app that stands in for the real server under supervision.
 *
 * It does the three things the supervisor cares about and nothing else:
 *  - records that it ran, and which version it was, in data/app-runs.log
 *  - takes its exit code from the next line of data/exit-codes, CONSUMING it, so a test can
 *    script a sequence of lifetimes deterministically instead of racing a timer
 *  - when that code is 42/43, writes the same data/control.json request the real app writes
 *    before exiting, so the supervisor sees exactly what it would see in production
 *
 * VERSION is bumped by publishCommit(), which is how a test proves the process that came back
 * after an update is running the NEW code.
 */
function fakeApp(version) {
  return `import { appendFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.THEMACHINE_DATA_DIR ?? join(root, 'data');
const VERSION = ${JSON.stringify(version)};
mkdirSync(dataDir, { recursive: true });
appendFileSync(join(dataDir, 'app-runs.log'), VERSION + '\\n');

// Consume one scripted exit code, leaving the rest for the next lifetime.
let code = 0;
const queuePath = join(dataDir, 'exit-codes');
try {
  const lines = readFileSync(queuePath, 'utf8').split('\\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length > 0) {
    code = Number(lines[0]);
    writeFileSync(queuePath, lines.slice(1).join('\\n'));
  }
} catch {}

// Mirror the real app: a restart/update exit is preceded by a request on disk.
if (code === 42 || code === 43) {
  writeFileSync(join(dataDir, 'control.json'), JSON.stringify({
    action: code === 43 ? 'update' : 'restart',
    status: 'requested',
    requested_at: new Date().toISOString(),
    finished_at: null, from_sha: null, to_sha: null, changes: [], error: null, unchanged: false,
  }, null, 2));
}
process.exit(code);
`;
}

/** Scripts the fake app's lifetimes: one exit code per run, in order. */
export function scriptExits(repo, codes) {
  writeFileSync(join(repo.dataDir, 'exit-codes'), codes.join('\n'));
}

/**
 * Creates a bare "published" repo plus a clone standing in for an operator's install.
 * Returns { base, remote, root, cleanup }.
 */
export function makeTempRepo({ version = 'v1' } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'tm-repo-'));
  const remote = join(base, 'remote.git');
  const root = join(base, 'install');

  git(base, ['init', '--bare', '-b', 'main', remote]);
  git(base, ['clone', remote, root]);
  // Otherwise git rewrites LF to CRLF on checkout on Windows and every content assertion in
  // the suite has to care which machine it is running on.
  git(root, ['config', 'core.autocrlf', 'false']);

  // Mirrors the real repo's .gitignore — the fixture is only useful if it ignores what
  // production ignores.
  writeFileSync(join(root, '.gitignore'), 'data/\nnode_modules/\n*.db\n*.db-*\n.linkedin-profile/\n');
  // No dependencies: a real `npm install` over this finishes in about a second.
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fake-machine', version: '0.0.0', private: true, type: 'module' }, null, 2) + '\n');
  writeFileSync(join(root, 'app.mjs'), fakeApp(version));
  writeFileSync(join(root, 'tracked.txt'), 'original\n');
  mkdirSync(join(root, 'data'), { recursive: true });

  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'initial']);
  git(root, ['push', '-u', 'origin', 'main']);

  return {
    base,
    remote,
    root,
    dataDir: join(root, 'data'),
    cleanup: () => rmSync(base, { recursive: true, force: true, maxRetries: 3 }),
  };
}

/**
 * Publishes a new commit to the "remote" the install pulls from, as the maintainer would.
 * Bumps the fake app's VERSION so a test can prove the new code is what came back up.
 */
export function publishCommit(repo, { version = 'v2', subject = 'feat: a new thing', extraFile } = {}) {
  const staging = join(repo.base, `staging-${version}`);
  git(repo.base, ['clone', repo.remote, staging]);
  writeFileSync(join(staging, 'app.mjs'), fakeApp(version));
  if (extraFile) writeFileSync(join(staging, extraFile), 'added by the update\n');
  git(staging, ['add', '-A']);
  git(staging, ['commit', '-m', subject]);
  git(staging, ['push', 'origin', 'main']);
  rmSync(staging, { recursive: true, force: true, maxRetries: 3 });
}
