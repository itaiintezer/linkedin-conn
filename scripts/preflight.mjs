/**
 * Prerequisite check for The Machine. Runs on macOS, Windows and Linux.
 *
 * Deliberately plain ESM JavaScript with ZERO dependencies and no TypeScript: it runs as
 * npm's `preinstall` hook, i.e. before `npm install` has fetched tsx, and its whole job is
 * to explain — in one readable message — why this machine can't run the app yet.
 *
 * Run it by hand any time:  npm run preflight
 *
 * Stages:
 *   --stage=install  before dependencies are installed (preinstall)
 *   --stage=start    before the server boots (prestart)
 *   --stage=all      everything (default, used by `npm run preflight`)
 */
import { execFileSync, execSync } from 'node:child_process';
// Namespace import for fs on purpose: statfsSync only exists from Node 18.15, and a named
// import of a missing builtin export is a load-time SyntaxError. This script has to survive
// the very old Node it exists to complain about, so it feature-detects instead (ES2020
// syntax throughout, for the same reason).
import * as fs from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * `node:sqlite` (src/db/database.ts) sat behind --experimental-sqlite until Node 22.13.0.
 * On 22.5–22.12 `npm install` succeeds and the app then dies on its first import, so the
 * floor is 22.13.0 — not the 22.5.0 the module was introduced in.
 */
export const REQUIRED_NODE = '22.13.0';

/** Platforms CloakBrowser publishes a patched Chromium for (cloakbrowser/dist/config.js). */
const SUPPORTED_TARGETS = new Set(['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64', 'linux-arm64']);

/** Room for the one-time Chromium download plus its extracted copy. */
const REQUIRED_FREE_BYTES = 1.5 * 1024 * 1024 * 1024;

const BROWSER_CACHE_DIR = process.env.CLOAKBROWSER_CACHE_DIR || join(homedir(), '.cloakbrowser');
const DOWNLOAD_HOST = 'https://cloakbrowser.dev';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 4400);

const STAGE_CHECKS = {
  install: ['node', 'sqlite', 'npm', 'platform', 'writable', 'disk', 'browser', 'network'],
  start: ['node', 'sqlite', 'platform', 'writable', 'port', 'browser'],
};

const ok = (id, label, message) => ({ id, label, severity: 'ok', message });
const warn = (id, label, message, fix) => ({ id, label, severity: 'warn', message, fix });
const fail = (id, label, message, fix) => ({ id, label, severity: 'error', message, fix });

// ---------------------------------------------------------------------------
// Pure checks — each takes an already-probed fact so it can be tested directly.
// ---------------------------------------------------------------------------

/** -1 / 0 / 1, tolerating a leading `v` and a missing patch segment. */
export function compareVersions(a, b) {
  const parse = (v) => String(v).replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0) ? 1 : -1;
  }
  return 0;
}

export function checkNodeVersion(version) {
  const clean = String(version).replace(/^v/, '');
  if (compareVersions(clean, REQUIRED_NODE) >= 0) return ok('node', 'Node.js', `v${clean}`);
  return fail(
    'node',
    'Node.js',
    `v${clean} is too old — The Machine needs v${REQUIRED_NODE} or newer.`,
    `Install the current LTS from https://nodejs.org (or \`nvm install --lts\`), reopen your terminal, then run this again. Node ${clean} would crash on boot: its built-in SQLite still needs a command-line flag.`,
  );
}

export function checkSqlite(loadable) {
  if (loadable) return ok('sqlite', 'Built-in SQLite', 'node:sqlite available');
  return fail(
    'sqlite',
    'Built-in SQLite',
    'This Node build cannot import node:sqlite, which stores the queue.',
    `Upgrade to Node v${REQUIRED_NODE} or newer from https://nodejs.org — before that release node:sqlite was hidden behind the --experimental-sqlite flag.`,
  );
}

export function checkNpm(version) {
  if (version) return ok('npm', 'npm', `v${String(version).replace(/^v/, '')}`);
  return fail(
    'npm',
    'npm',
    'npm was not found on your PATH.',
    'npm ships with Node.js — reinstall Node from https://nodejs.org and reopen your terminal.',
  );
}

export function checkPlatform(platform, arch) {
  const target = `${platform}-${arch}`;
  if (SUPPORTED_TARGETS.has(target)) return ok('platform', 'Platform', target);
  const hint =
    platform === 'win32'
      ? `Windows on ${arch} has no stealth-browser build. Use a 64-bit (x64) Windows machine or a Mac.`
      : `There is no stealth-browser build for ${target}. Supported: macOS (arm64/x64), Windows x64, Linux x64/arm64.`;
  return fail('platform', 'Platform', `${target} is not supported.`, hint);
}

export function checkWritable(writable, dir) {
  if (writable) return ok('writable', 'Folder permissions', 'writable');
  return fail(
    'writable',
    'Folder permissions',
    `Cannot write inside ${dir} — The Machine keeps its database and browser profile there.`,
    'Move the folder somewhere you own (e.g. your Documents or home folder) instead of a system location, then run this again.',
  );
}

export function checkDiskSpace(freeBytes) {
  if (freeBytes == null) return ok('disk', 'Disk space', 'not checked');
  const gb = (freeBytes / 1024 ** 3).toFixed(1);
  if (freeBytes >= REQUIRED_FREE_BYTES) return ok('disk', 'Disk space', `${gb} GB free`);
  return warn(
    'disk',
    'Disk space',
    `only ${gb} GB free.`,
    'The first LinkedIn login downloads a ~1 GB browser. Free up some space before then.',
  );
}

export function checkBrowserCache(cached, stage = 'all') {
  if (cached) return ok('browser', 'Stealth browser', 'cached — ready');
  // At install time it is simply not downloaded yet — postinstall is about to do it.
  if (stage === 'install') {
    return ok('browser', 'Stealth browser', 'not downloaded yet — npm install fetches it next (~1 GB, a few minutes, one time only)');
  }
  return warn(
    'browser',
    'Stealth browser',
    'not downloaded — the install-time download was skipped or failed.',
    'Run `npm run install-browser` (needs ~1 GB and a few minutes). Otherwise the first "Connect LinkedIn" click has to download it, which looks like a hang.',
  );
}

export function checkNetwork(reachable, needed) {
  if (!needed) return ok('network', 'Download server', 'skipped — browser already cached');
  if (reachable) return ok('network', 'Download server', `${DOWNLOAD_HOST} reachable`);
  return warn(
    'network',
    'Download server',
    `could not reach ${DOWNLOAD_HOST} — the browser download may fail.`,
    'Check your connection, VPN or proxy before clicking "Connect LinkedIn".',
  );
}

export function checkPort(port, inUse) {
  if (!inUse) return ok('port', 'Port', `${port} free`);
  return warn(
    'port',
    'Port',
    `something is already listening on ${port} — probably another copy of The Machine.`,
    `Use that window (http://localhost:${port}), or start this one on another port: PORT=${port + 1} npm start (PowerShell: $env:PORT=${port + 1}; npm start).`,
  );
}

/** Which check ids run at a given stage. Unknown stage → everything. */
export function checksForStage(stage) {
  return STAGE_CHECKS[stage] ?? [...new Set([...STAGE_CHECKS.install, ...STAGE_CHECKS.start])];
}

export function summarize(results) {
  const errors = results.filter((r) => r.severity === 'error');
  const warnings = results.filter((r) => r.severity === 'warn');
  return { ok: errors.length === 0, exitCode: errors.length === 0 ? 0 : 1, errors, warnings };
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
// Probes — the impure half: they look at this machine and hand facts to the checks.
// ---------------------------------------------------------------------------

/**
 * Probe in a child process rather than importing node:sqlite here: the import prints
 * "ExperimentalWarning: SQLite is an experimental feature", and this script runs on every
 * install and every start — it must not add noise of its own. NODE_NO_WARNINGS silences it,
 * and a non-zero exit means this Node cannot open the queue database.
 */
function probeSqlite() {
  try {
    execFileSync(process.execPath, ['--input-type=module', '-e', "await import('node:sqlite');"], {
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
      stdio: 'ignore',
      timeout: 20_000,
    });
    return true;
  } catch {
    return false;
  }
}

function probeNpm() {
  // execSync, not execFileSync: on Windows npm is a .cmd shim that Node refuses to execFile
  // without a shell (EINVAL), and passing args alongside shell:true is deprecated (DEP0190).
  // A fixed literal command has no injection surface.
  try {
    const out = execSync('npm --version', {
      encoding: 'utf8',
      timeout: 20_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out) return out;
  } catch {
    /* fall through to the user-agent hint below */
  }
  // Fall back to the npm that is running us, if any (npm/11.8.0 node/v24.13.1 …).
  const ua = process.env.npm_config_user_agent ?? '';
  const m = ua.match(/npm\/([\d.]+)/);
  return m ? m[1] : null;
}

function probeWritable(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function probeFreeBytes(dir) {
  try {
    if (typeof fs.statfsSync !== 'function') return null; // Node < 18.15
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

function probeBrowserCached() {
  try {
    return fs.readdirSync(BROWSER_CACHE_DIR).some((e) => e.startsWith('chromium-'));
  } catch {
    return false;
  }
}

async function probeReachable(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(4000) });
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

function probePortInUse(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', (e) => resolve(e.code === 'EADDRINUSE'));
    server.once('listening', () => server.close(() => resolve(false)));
    server.listen(port, '127.0.0.1');
  });
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export async function runChecks(stage = 'all') {
  const wanted = new Set(checksForStage(stage));
  const results = [];
  const nodeOk = compareVersions(process.versions.node, REQUIRED_NODE) >= 0;

  if (wanted.has('node')) results.push(checkNodeVersion(process.version));
  // A too-old Node already explains the node:sqlite failure; don't say it twice.
  if (wanted.has('sqlite') && nodeOk) results.push(checkSqlite(probeSqlite()));
  if (wanted.has('npm')) results.push(checkNpm(probeNpm()));
  if (wanted.has('platform')) results.push(checkPlatform(process.platform, process.arch));
  if (wanted.has('writable')) results.push(checkWritable(probeWritable(ROOT), ROOT));
  if (wanted.has('disk')) results.push(checkDiskSpace(probeFreeBytes(homedir())));
  if (wanted.has('port')) results.push(checkPort(PORT, await probePortInUse(PORT)));

  const cached = probeBrowserCached();
  if (wanted.has('browser')) results.push(checkBrowserCache(cached, stage));
  // Only worth a network round-trip when there is actually something to download.
  if (wanted.has('network')) results.push(checkNetwork(!cached && (await probeReachable(DOWNLOAD_HOST)), !cached));

  return results;
}

async function main() {
  const stageArg = process.argv.find((a) => a.startsWith('--stage='));
  const stage = stageArg ? stageArg.slice('--stage='.length) : 'all';
  const results = await runChecks(stage);
  const { ok: passed, exitCode, warnings } = summarize(results);

  // On a clean install stage, stay out of the way: one line, no wall of green.
  const quiet = stage === 'install' || stage === 'start';
  if (!quiet || !passed || warnings.length) {
    console.log(`\nThe Machine — prerequisite check (${stage})\n`);
    console.log(formatResults(results));
    console.log('');
  }
  if (!passed) {
    console.error('Prerequisites are not met — fix the FAIL lines above and try again.');
    console.error('Full setup instructions: README.md · non-technical walkthrough: RUNBOOK.md\n');
  } else if (quiet && !warnings.length) {
    console.log('Prerequisites ok.');
  }
  process.exit(exitCode);
}

/**
 * Only run when invoked directly — importing this file (tests) must not call process.exit.
 * The basename fallback covers npm/Windows handing us a differently-formed path than the URL
 * this module was loaded from; without it the check could silently never run.
 */
const invoked = process.argv[1] ?? '';
const isMain =
  invoked !== '' &&
  (pathToFileURL(invoked).href === import.meta.url || basename(invoked) === basename(fileURLToPath(import.meta.url)));

if (isMain) await main();
