/**
 * npm run service:doctor — the checks that CANNOT be automated in the test suite.
 *
 * Everything else about the supervisor and the update mechanism is covered by `npm test`,
 * including a real git pull and a real restart, because the app under supervision there is a
 * ten-line fake. These four cannot be: they need the actual OS, and three of them cannot even
 * run on the other platform. So they are a one-time check per machine at install time rather
 * than a per-change test.
 *
 * Deliberately read-only. It reports; it does not fix.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adapterFor, resolvePaths, SERVICE_LABEL, TASK_NAME } from './service.mjs';
import { lockPath } from './supervisor.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 4400);

const results = [];
const ok = (label, msg) => results.push({ severity: 'ok', label, msg });
const warn = (label, msg, fix) => results.push({ severity: 'warn', label, msg, fix });
const bad = (label, msg, fix) => results.push({ severity: 'error', label, msg, fix });

function tryRun(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return null;
  }
}

// 1. Is the login hook actually registered? (Needs the OS; no test can assert this.)
const adapter = adapterFor();
const paths = resolvePaths({ root: ROOT });
if (!adapter) {
  warn('Start at login', `not automated on ${process.platform}`, 'Run the supervisor from a user systemd unit — see scripts/service.mjs.');
} else {
  const s = adapter.status(paths);
  if (s.installed) ok('Start at login', `registered (${process.platform === 'darwin' ? SERVICE_LABEL : TASK_NAME})`);
  else bad('Start at login', 'not registered', 'Run `npm run service:install`.');
}

// 2. Are node, npm AND git reachable at the absolute paths baked into the login hook?
//    This is the failure that lets The Machine start fine and then never update.
for (const [name, p] of [['node', paths.node], ['npm', paths.npm], ['git', paths.git]]) {
  if (!p) bad(name, 'not found on the PATH', `Install ${name}, then run \`npm run service:install\` again so the new location is recorded.`);
  else if (!existsSync(p)) bad(name, `recorded at ${p}, which no longer exists`, 'Run `npm run service:install` again to re-record it.');
  else ok(name, p);
}

// 3. Does the registered artifact really point at THIS checkout? A second clone, or a moved
//    folder, silently leaves the login hook starting the wrong copy.
if (process.platform === 'darwin') {
  const plist = join(process.env.HOME ?? '', 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
  if (existsSync(plist)) {
    const body = readFileSync(plist, 'utf8');
    if (body.includes(paths.supervisor)) ok('Points at this folder', ROOT);
    else bad('Points at this folder', 'the LaunchAgent starts a different copy of The Machine', 'Run `npm run service:install` from the folder you want to use.');
  }
} else if (process.platform === 'win32') {
  const shim = join(ROOT, 'data', 'start-hidden.vbs');
  if (existsSync(shim)) {
    const body = readFileSync(shim, 'utf8');
    if (body.includes(paths.supervisor)) ok('Points at this folder', ROOT);
    else bad('Points at this folder', 'the hidden launcher starts a different copy', 'Run `npm run service:install` from the folder you want to use.');
  }
  // The console window cannot be observed from here; state plainly how to confirm it.
  warn('No console window', 'cannot be checked automatically',
    'Log out and back in. You should see NO black terminal window, and the dashboard should answer.');
}

// 4. Is it actually up, and is it the supervised copy?
// The HTTP status comes back too, so a copy that predates this feature is not mislabelled as
// "running unsupervised" — those need different advice.
const probe = `fetch('http://127.0.0.1:${PORT}/api/update/status')`
  + `.then(async r=>{console.log(JSON.stringify({http:r.status,body:await r.json().catch(()=>null)}));process.exit(0)})`
  + '.catch(()=>process.exit(1))';
const status = tryRun(process.execPath, ['-e', probe]);
if (!status) {
  warn('Running now', `nothing answering on port ${PORT}`, 'If you have not logged out since installing, that is expected. Otherwise run `npm start` and read the error.');
} else {
  let parsed = null;
  try { parsed = JSON.parse(status); } catch { /* fall through */ }
  if (parsed?.http === 404) {
    warn('Running now', 'answering, but this copy is older than the Restart/Update feature',
      'It is still running the previous version. Restart it (`npm start`, or log out and back in) to pick up the new code.');
  } else if (parsed?.body?.supervised) {
    ok('Running now', 'yes, under the supervisor — Restart and Update will work');
  } else {
    warn('Running now', 'answering, but NOT under the supervisor',
      'Something started the app directly. The dashboard\'s Restart and Update buttons stay disabled until it is started the normal way.');
  }
}

// 5. The single-instance lock, which is what turns "two copies" into a sentence rather than a
//    Chromium error deep in the browser layer.
const lock = lockPath(join(ROOT, 'data'));
ok('Single-instance lock', existsSync(lock) ? `held (${lock})` : 'free');

// ---------------------------------------------------------------------------

const mark = { ok: '  ok  ', warn: ' warn ', error: ' FAIL ' };
console.log('\nThe Machine — service check\n');
for (const r of results) {
  console.log(`[${mark[r.severity]}] ${r.label}: ${r.msg}`);
  if (r.fix) console.log(`           → ${r.fix}`);
}
const failed = results.filter((r) => r.severity === 'error');
console.log(failed.length === 0
  ? '\nAll good.\n'
  : `\n${failed.length} problem${failed.length === 1 ? '' : 's'} to fix (see the arrows above).\n`);
process.exit(failed.length === 0 ? 0 : 1);
