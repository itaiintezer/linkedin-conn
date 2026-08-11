/**
 * The only thing that is ever launched. `npm start` runs this, and so does the OS at login
 * (see scripts/service.mjs).
 *
 * The app never manages its own lifecycle — it cannot. A process cannot restart itself, and
 * `npm install` cannot rewrite node_modules while tsx and esbuild hold their binaries open,
 * which on Windows fails outright. So the app instead chooses HOW IT DIES, and this file decides
 * what happens next:
 *
 *     exit 0   → a real stop; the supervisor exits too
 *     exit 42  → restart
 *     exit 43  → run the update, then restart
 *     anything → crashed; back off and restart
 *
 * That single idea is what makes the dashboard's Restart and Update buttons possible, gives both
 * platforms identical restart behaviour (so the OS only has to know "run this at login"), and
 * keeps crash recovery in one place.
 *
 * Zero dependencies and plain ESM on purpose: this must run before `npm install` has fetched
 * anything, because an update is sometimes what repairs a broken node_modules.
 *
 * The loop is `runSupervisor()`, which takes everything impure as an argument so
 * tests/scripts/supervisor.test.mjs can drive whole lifetimes in milliseconds without spawning
 * a process. main() at the bottom is the thin real-world wiring.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isPending, markDone, markFailed, markRunning, readControl, writeControl } from './control-file.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPT_ROOT = join(SCRIPT_DIR, '..');

/** Exit codes the app uses to tell us what it wants. Mirrored in src/core/exit-codes.ts. */
export const EXIT_STOP = 0;
export const EXIT_RESTART = 42;
export const EXIT_UPDATE = 43;

/**
 * A non-zero exit sooner than this is treated as "failed to start" rather than "ran for a while
 * and then died", which is what distinguishes a bad release from ordinary bad luck. Only start
 * failures count toward a rollback.
 */
export const STARTUP_GRACE_MS = 20_000;

/** Consecutive start failures after an update before we put the previous version back. */
export const ROLLBACK_AFTER = 3;

/** Backoff is capped rather than unbounded: nobody is coming to restart this by hand. */
export const MAX_BACKOFF_MS = 5 * 60_000;

export function decideNextAction(code) {
  if (code === EXIT_STOP) return 'stop';
  if (code === EXIT_RESTART) return 'restart';
  if (code === EXIT_UPDATE) return 'update';
  return 'crash';
}

/** 1s, 2s, 4s, 8s … capped. Doubling keeps a wedged install from spinning the CPU all day. */
export function backoffMs(failures, cap = MAX_BACKOFF_MS) {
  if (failures <= 0) return 0;
  return Math.min(cap, 1000 * 2 ** (failures - 1));
}

/**
 * The lock is what stops a rep who still has an `npm start` habit from starting a second copy
 * while the login-launched one is already running. Without it they get a Chromium failure deep
 * in the browser layer, because `.linkedin-profile` is single-instance — one of the most
 * confusing ways this app can break.
 *
 * A stale lock from a machine that lost power is expected, so the pid is checked rather than
 * trusted.
 */
export function lockPath(dataDir) {
  return join(dataDir, 'supervisor.lock');
}

/**
 * The pid currently holding the lock, or null when it is free or stale. Read-only counterpart to
 * acquireLock, so the service installer can ask "is a copy already running?" without duplicating
 * the staleness rule.
 */
export function lockHolder(dataDir, { isAlive = defaultIsAlive } = {}) {
  try {
    const pid = Number(String(readFileSync(lockPath(dataDir), 'utf8')).trim());
    return Number.isInteger(pid) && isAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

export function acquireLock(dataDir, { pid = process.pid, isAlive = defaultIsAlive } = {}) {
  mkdirSync(dataDir, { recursive: true });
  const path = lockPath(dataDir);
  if (existsSync(path)) {
    const holder = Number(String(readFileSync(path, 'utf8')).trim());
    if (Number.isInteger(holder) && holder !== pid && isAlive(holder)) return { ok: false, holder };
    /* otherwise the previous run died without cleaning up; the lock is ours to take */
  }
  writeFileSync(path, String(pid));
  return { ok: true, release: () => { try { rmSync(path, { force: true }); } catch { /* best effort */ } } };
}

function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means it exists but belongs to someone else, which still counts as alive.
    return e?.code === 'EPERM';
  }
}

export function hashFile(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

/**
 * Runs app lifetimes until one of them asks to stop.
 *
 * Injected:
 *   spawnApp()          → resolves to the app's exit code
 *   runUpdate()         → resolves to { ok, unchanged, from, to, log }  (scripts/update.mjs)
 *   rollbackTo(sha)     → resolves truthy when the previous version is back in place
 *   sleep(ms), now()    → clock
 *   log(message)        → progress for the operator
 *   selfHash()          → hash of this file, for the "the update changed the supervisor" case
 *
 * Returns { reason, restarts, updates, rollbacks, reExec } — reExec true means the caller should
 * replace this process with a fresh one.
 */
export async function runSupervisor({
  dataDir,
  spawnApp,
  runUpdate,
  rollbackTo = async () => false,
  sleep = defaultSleep,
  now = () => Date.now(),
  log = () => {},
  selfHash = () => null,
  rollbackAfter = ROLLBACK_AFTER,
  startupGraceMs = STARTUP_GRACE_MS,
}) {
  const startingHash = selfHash();
  const stats = { reason: 'stop', restarts: 0, updates: 0, rollbacks: 0, reExec: false };
  let startFailures = 0;
  // The sha to go back to if the version we just installed cannot start.
  let rollbackTarget = null;

  for (;;) {
    // ---- Any request left behind by the app (or by a previous, interrupted run) ----
    const pending = readControl(dataDir);
    if (isPending(pending)) {
      if (pending.action === 'update') {
        stats.updates++;
        writeControl(dataDir, markRunning(pending, new Date(now()).toISOString()));
        log('Updating…');
        let result;
        try {
          result = await runUpdate();
        } catch (e) {
          result = { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
        const iso = new Date(now()).toISOString();
        if (result?.ok) {
          const changes = String(result.log ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
          writeControl(dataDir, markDone(pending, {
            from: result.from ?? null,
            to: result.to ?? null,
            changes,
            unchanged: Boolean(result.unchanged),
          }, iso));
          // Only arm a rollback when the code actually moved.
          rollbackTarget = result.unchanged ? null : (result.from ?? null);
          log(result.unchanged ? 'Already up to date.' : `Updated (${changes.length} change(s)).`);

          // The update may have rewritten this very file, and we are still executing the old
          // one from memory. Hand off to a fresh process rather than supervising with stale code.
          if (startingHash && selfHash() !== startingHash) {
            log('The supervisor itself was updated — restarting it.');
            stats.reason = 'reexec';
            stats.reExec = true;
            return stats;
          }
        } else {
          writeControl(dataDir, markFailed(pending, result?.error ?? 'the update did not complete', iso));
          log('Update failed — starting the version that was already installed.');
        }
      } else {
        // A restart needs no work beyond the one this loop is already doing.
        writeControl(dataDir, markDone(pending, {}, new Date(now()).toISOString()));
      }
    }

    // ---- One app lifetime ----
    const startedAt = now();
    const code = await spawnApp();
    const ranMs = now() - startedAt;
    const action = decideNextAction(code);

    if (action === 'stop') {
      stats.reason = 'stop';
      return stats;
    }

    if (action === 'restart' || action === 'update') {
      startFailures = 0;
      stats.restarts++;
      continue; // an 'update' request is picked up at the top of the loop
    }

    // ---- Crash ----
    // A long-lived process that died is bad luck (LinkedIn hung, machine slept); a process that
    // dies immediately is a broken install, and only the latter should trigger a rollback.
    const failedToStart = ranMs < startupGraceMs;
    startFailures = failedToStart ? startFailures + 1 : 0;
    stats.restarts++;
    log(`The Machine stopped unexpectedly (exit ${code}).`);

    if (rollbackTarget && startFailures >= rollbackAfter) {
      log(`It has failed to start ${startFailures} times since the last update — putting the previous version back.`);
      let restored = false;
      try {
        restored = await rollbackTo(rollbackTarget);
      } catch {
        restored = false;
      }
      const iso = new Date(now()).toISOString();
      const control = readControl(dataDir);
      if (control) {
        writeControl(dataDir, markFailed(
          control,
          restored
            ? 'The new version would not start, so the previous one was put back. Nothing was lost.'
            : 'The new version would not start and the previous one could not be restored automatically.',
          iso,
        ));
      }
      if (restored) stats.rollbacks++;
      rollbackTarget = null;
      startFailures = 0;
      continue; // try again immediately on the restored version
    }

    // Floored at one step. A process that ran for a while and then died resets the counter, and
    // backoffMs(0) is 0 — which would restart instantly, forever, if the app happened to die
    // just past the grace window every time.
    await sleep(backoffMs(Math.max(1, startFailures)));
  }
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Real-world wiring
// ---------------------------------------------------------------------------

export function resolveConfig({ argv = [], env = {} } = {}) {
  const flag = (name) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };
  const root = flag('root') ?? env.THEMACHINE_ROOT ?? SCRIPT_ROOT;
  const dataDir = flag('data-dir') ?? env.THEMACHINE_DATA_DIR ?? join(root, 'data');
  // The app entry, overridable so the tests can supervise a ten-line fake instead of the real
  // thing (which would open a browser and reach LinkedIn).
  const appArgs = flag('app') ? [flag('app')] : ['--import', 'tsx', join(root, 'src', 'index.ts')];
  return { root, dataDir, appArgs };
}

function realSpawnApp(cfg) {
  return () => new Promise((resolve) => {
    const child = spawn(process.execPath, cfg.appArgs, {
      cwd: cfg.root,
      stdio: 'inherit',
      env: {
        ...process.env,
        THEMACHINE_SUPERVISED: '1',
        THEMACHINE_DATA_DIR: cfg.dataDir,
      },
    });
    // 'close' rather than 'exit': stdio is inherited, and we want the streams drained before
    // the next lifetime starts writing to the same console.
    child.on('close', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    child.on('error', () => resolve(1));
  });
}

async function main() {
  const cfg = resolveConfig({ argv: process.argv.slice(2), env: process.env });
  const lock = acquireLock(cfg.dataDir);
  if (!lock.ok) {
    console.error(`\nThe Machine is already running (process ${lock.holder}).`);
    console.error('Open http://localhost:4400 to use it. Only one copy can run at a time —');
    console.error('they would fight over the same LinkedIn browser profile.\n');
    process.exit(1);
  }

  const { resolveConfig: updateConfig, runUpdate, rollbackTo } = await import('./update.mjs');
  const updateCfg = updateConfig({
    argv: [`--root=${cfg.root}`, `--data-dir=${cfg.dataDir}`],
    env: { ...process.env, THEMACHINE_SUPERVISED_UPDATE: '1' },
  });

  const cleanup = () => { lock.release?.(); };
  process.on('exit', cleanup);
  // Ctrl+C in the foreground case: stop supervising rather than racing the child's own handler.
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { cleanup(); process.exit(0); });
  }

  const stats = await runSupervisor({
    dataDir: cfg.dataDir,
    spawnApp: realSpawnApp(cfg),
    runUpdate: () => runUpdate(updateCfg),
    rollbackTo: (sha) => rollbackTo(updateCfg, sha),
    log: (m) => console.log(`[supervisor] ${m}`),
    selfHash: () => hashFile(fileURLToPath(import.meta.url)),
  });

  cleanup();
  if (stats.reExec) {
    // Replace ourselves with the updated supervisor, detached so this process can exit and the
    // new one keeps the console (or the service's) stdio.
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
      cwd: cfg.root,
      stdio: 'inherit',
      detached: false,
    });
    child.on('close', (code) => process.exit(code ?? 0));
    return;
  }
  process.exit(0);
}

const invoked = process.argv[1] ?? '';
const isMain =
  invoked !== '' &&
  (pathToFileURL(invoked).href === import.meta.url || basename(invoked) === basename(fileURLToPath(import.meta.url)));

if (isMain) await main();
