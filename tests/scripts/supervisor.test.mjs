// Plain .mjs for the same reason as update.test.mjs: the supervisor must run on a bare Node
// with zero dependencies, so it can't be TypeScript.
//
// Two halves. The first drives whole app lifetimes through runSupervisor() with fakes — no
// processes, milliseconds per test, and it can express things that are hard to arrange for
// real (three consecutive start failures, an update that rewrites the supervisor). The second
// spawns the real supervisor against a disposable repo containing a ten-line fake app, which is
// what proves the exit-code protocol actually works across a process boundary.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempRepo, publishCommit, scriptExits } from './helpers/temp-repo.mjs';
import { newRequest, readControl, writeControl } from '../../scripts/control-file.mjs';
import {
  EXIT_RESTART,
  EXIT_STOP,
  EXIT_UPDATE,
  MAX_BACKOFF_MS,
  acquireLock,
  backoffMs,
  decideNextAction,
  lockPath,
  resolveConfig,
  runSupervisor,
} from '../../scripts/supervisor.mjs';

const SUPERVISOR = join(process.cwd(), 'scripts', 'supervisor.mjs');

describe('the exit-code protocol', () => {
  test('is these exact numbers — the app declares them separately in src/core/lifecycle.ts', () => {
    // Duplicated because this file must run on a bare Node and cannot import TypeScript.
    // tests/api/lifecycle.test.ts asserts the same literals from the other side.
    expect(EXIT_STOP).toBe(0);
    expect(EXIT_RESTART).toBe(42);
    expect(EXIT_UPDATE).toBe(43);
  });
});

describe('decideNextAction', () => {
  test('maps the codes the app uses to say what it wants', () => {
    expect(decideNextAction(EXIT_STOP)).toBe('stop');
    expect(decideNextAction(EXIT_RESTART)).toBe('restart');
    expect(decideNextAction(EXIT_UPDATE)).toBe('update');
  });

  test('anything else is a crash — including the codes Node picks on its own', () => {
    for (const code of [1, 2, 7, 130, 137, 255, null, undefined]) {
      expect(decideNextAction(code)).toBe('crash');
    }
  });
});

describe('backoffMs', () => {
  test('doubles, and is capped so a wedged install cannot spin all day', () => {
    expect(backoffMs(0)).toBe(0);
    expect(backoffMs(1)).toBe(1000);
    expect(backoffMs(2)).toBe(2000);
    expect(backoffMs(3)).toBe(4000);
    expect(backoffMs(50)).toBe(MAX_BACKOFF_MS);
  });
});

describe('acquireLock', () => {
  let repo;
  beforeEach(() => { repo = makeTempRepo(); });
  afterEach(() => { repo?.cleanup(); });

  test('the first caller gets it', () => {
    const lock = acquireLock(repo.dataDir, { pid: 111, isAlive: () => true });
    expect(lock.ok).toBe(true);
    expect(readFileSync(lockPath(repo.dataDir), 'utf8')).toBe('111');
  });

  test('a second live holder is refused by pid, so the rep gets a sentence not a browser error', () => {
    acquireLock(repo.dataDir, { pid: 111, isAlive: () => true });
    const second = acquireLock(repo.dataDir, { pid: 222, isAlive: () => true });
    expect(second.ok).toBe(false);
    expect(second.holder).toBe(111);
  });

  test('a stale lock from a machine that lost power is taken over', () => {
    acquireLock(repo.dataDir, { pid: 111, isAlive: () => true });
    const second = acquireLock(repo.dataDir, { pid: 222, isAlive: () => false });
    expect(second.ok).toBe(true);
  });

  test('release removes it', () => {
    const lock = acquireLock(repo.dataDir, { pid: 111, isAlive: () => true });
    lock.release();
    expect(existsSync(lockPath(repo.dataDir))).toBe(false);
  });
});

describe('resolveConfig', () => {
  test('defaults to running the real app under tsx', () => {
    const cfg = resolveConfig({ argv: [], env: {} });
    expect(cfg.appArgs).toContain('tsx');
    expect(cfg.appArgs.some((a) => a.includes('index.ts'))).toBe(true);
  });

  test('--app aims it at something else, which is what lets these tests supervise a fake', () => {
    const cfg = resolveConfig({ argv: ['--root=/tmp/r', '--app=/tmp/r/app.mjs'], env: {} });
    expect(cfg.root).toBe('/tmp/r');
    expect(cfg.appArgs).toEqual(['/tmp/r/app.mjs']);
  });
});

// ---------------------------------------------------------------------------
// The loop, with fakes
// ---------------------------------------------------------------------------

describe('runSupervisor', () => {
  let repo;
  beforeEach(() => { repo = makeTempRepo(); });
  afterEach(() => { repo?.cleanup(); });

  /** Drives a fixed sequence of app lifetimes, then asserts what the supervisor did. */
  function harness(codes, opts = {}) {
    const spawned = [];
    let clock = 0;
    return {
      spawned,
      result: runSupervisor({
        dataDir: repo.dataDir,
        spawnApp: async () => {
          const next = codes.shift();
          if (next === undefined) throw new Error('the supervisor spawned more times than the test expected');
          const code = typeof next === 'object' ? next.code : next;
          clock += typeof next === 'object' ? next.ranMs : 60_000;
          spawned.push(code);
          return code;
        },
        sleep: async () => { clock += 1000; },
        now: () => clock,
        ...opts,
      }),
    };
  }

  test('a clean exit stops supervising — it does not helpfully restart', async () => {
    const h = harness([EXIT_STOP]);
    const stats = await h.result;
    expect(stats.reason).toBe('stop');
    expect(h.spawned).toEqual([EXIT_STOP]);
  });

  test('exit 42 restarts the app', async () => {
    const h = harness([EXIT_RESTART, EXIT_STOP]);
    const stats = await h.result;
    expect(h.spawned).toEqual([EXIT_RESTART, EXIT_STOP]);
    expect(stats.restarts).toBe(1);
  });

  test('repeated START failures back off with a growing delay', async () => {
    const slept = [];
    const h = harness(
      [{ code: 1, ranMs: 100 }, { code: 1, ranMs: 100 }, EXIT_STOP],
      { sleep: async (ms) => { slept.push(ms); } },
    );
    await h.result;
    expect(h.spawned).toEqual([1, 1, EXIT_STOP]);
    expect(slept).toEqual([1000, 2000]);
  });

  test('a long-lived process that dies is bad luck, not a failing install — no growing backoff', async () => {
    const slept = [];
    const h = harness(
      [{ code: 1, ranMs: 60_000 }, { code: 1, ranMs: 60_000 }, EXIT_STOP],
      { sleep: async (ms) => { slept.push(ms); } },
    );
    await h.result;
    // Each ran well past the startup grace, so the failure counter resets and the backoff
    // stays at the first step instead of escalating toward five minutes.
    expect(slept).toEqual([1000, 1000]);
  });

  test('exit 43 runs the update, then brings the app back', async () => {
    writeControl(repo.dataDir, newRequest('update', '2026-08-10T10:00:00.000Z'));
    const runUpdate = vi.fn(async () => ({ ok: true, from: 'aaa', to: 'bbb', log: 'bbb feat: a thing' }));
    const h = harness([EXIT_STOP], { runUpdate });

    // The request is already on disk, as it would be after the app exited 43.
    const stats = await h.result;

    expect(runUpdate).toHaveBeenCalledTimes(1);
    expect(stats.updates).toBe(1);
    const control = readControl(repo.dataDir);
    expect(control.status).toBe('done');
    expect(control.changes).toEqual(['bbb feat: a thing']);
    expect(control.from_sha).toBe('aaa');
  });

  test('a failed update is recorded and the OLD version is started anyway', async () => {
    // The operator must end up with a working Machine even when the update fails. Leaving them
    // with nothing running would be the worst outcome of pressing a button.
    writeControl(repo.dataDir, newRequest('update', '2026-08-10T10:00:00.000Z'));
    const runUpdate = vi.fn(async () => ({ ok: false, error: 'npm install exploded' }));
    const h = harness([EXIT_STOP], { runUpdate });

    await h.result;

    expect(h.spawned).toEqual([EXIT_STOP]); // it still started the app
    const control = readControl(repo.dataDir);
    expect(control.status).toBe('failed');
    expect(control.error).toContain('npm install exploded');
  });

  test('an update that throws is caught — the supervisor never dies with the app down', async () => {
    writeControl(repo.dataDir, newRequest('update', '2026-08-10T10:00:00.000Z'));
    const h = harness([EXIT_STOP], { runUpdate: async () => { throw new Error('git vanished'); } });

    await h.result;

    expect(readControl(repo.dataDir).status).toBe('failed');
    expect(readControl(repo.dataDir).error).toContain('git vanished');
  });

  test('a pending restart request is closed out rather than left pending forever', async () => {
    writeControl(repo.dataDir, newRequest('restart', '2026-08-10T10:00:00.000Z'));
    const h = harness([EXIT_STOP]);
    await h.result;
    expect(readControl(repo.dataDir).status).toBe('done');
  });

  test('nothing pending means no update is run', async () => {
    const runUpdate = vi.fn();
    const h = harness([EXIT_STOP], { runUpdate });
    await h.result;
    expect(runUpdate).not.toHaveBeenCalled();
  });

  test('rolls back after three straight start failures following an update', async () => {
    writeControl(repo.dataDir, newRequest('update', '2026-08-10T10:00:00.000Z'));
    const rollbackTo = vi.fn(async () => true);
    const h = harness(
      // The update installs, then the new version dies instantly three times, then the
      // restored version runs and is asked to stop.
      [{ code: 1, ranMs: 100 }, { code: 1, ranMs: 100 }, { code: 1, ranMs: 100 }, EXIT_STOP],
      {
        runUpdate: async () => ({ ok: true, from: 'goodsha', to: 'badsha', log: 'badsha feat: broken' }),
        rollbackTo,
      },
    );

    const stats = await h.result;

    expect(rollbackTo).toHaveBeenCalledWith('goodsha');
    expect(stats.rollbacks).toBe(1);
    const control = readControl(repo.dataDir);
    expect(control.status).toBe('failed');
    expect(control.error).toMatch(/previous one was put back/i);
  });

  test('no rollback when the update found nothing new — there is nothing to go back to', async () => {
    writeControl(repo.dataDir, newRequest('update', '2026-08-10T10:00:00.000Z'));
    const rollbackTo = vi.fn(async () => true);
    const h = harness(
      [{ code: 1, ranMs: 100 }, { code: 1, ranMs: 100 }, { code: 1, ranMs: 100 }, EXIT_STOP],
      { runUpdate: async () => ({ ok: true, unchanged: true, from: 'same', to: 'same' }), rollbackTo },
    );
    await h.result;
    expect(rollbackTo).not.toHaveBeenCalled();
  });

  test('crashes with no preceding update never roll back', async () => {
    const rollbackTo = vi.fn(async () => true);
    const h = harness(
      [{ code: 1, ranMs: 100 }, { code: 1, ranMs: 100 }, { code: 1, ranMs: 100 }, { code: 1, ranMs: 100 }, EXIT_STOP],
      { rollbackTo },
    );
    await h.result;
    expect(rollbackTo).not.toHaveBeenCalled();
  });

  test('a failed rollback says so instead of claiming the previous version is back', async () => {
    writeControl(repo.dataDir, newRequest('update', '2026-08-10T10:00:00.000Z'));
    const h = harness(
      [{ code: 1, ranMs: 100 }, { code: 1, ranMs: 100 }, { code: 1, ranMs: 100 }, EXIT_STOP],
      {
        runUpdate: async () => ({ ok: true, from: 'goodsha', to: 'badsha', log: 'x' }),
        rollbackTo: async () => false,
      },
    );
    const stats = await h.result;
    expect(stats.rollbacks).toBe(0);
    expect(readControl(repo.dataDir).error).toMatch(/could not be restored/i);
  });

  test('an update that rewrote the supervisor hands off to a fresh process', async () => {
    // The running supervisor is executing the old file from memory, so it must not keep
    // supervising with stale code. This is the one file an update cannot hot-fix.
    writeControl(repo.dataDir, newRequest('update', '2026-08-10T10:00:00.000Z'));
    let hash = 'before';
    const h = harness([], {
      runUpdate: async () => { hash = 'after'; return { ok: true, from: 'a', to: 'b', log: 'b feat: x' }; },
      selfHash: () => hash,
    });

    const stats = await h.result;

    expect(stats.reExec).toBe(true);
    expect(stats.reason).toBe('reexec');
    expect(h.spawned).toEqual([]); // it did not start the app under the old code
    expect(readControl(repo.dataDir).status).toBe('done');
  });

  test('an update that left the supervisor alone does NOT re-exec', async () => {
    writeControl(repo.dataDir, newRequest('update', '2026-08-10T10:00:00.000Z'));
    const h = harness([EXIT_STOP], {
      runUpdate: async () => ({ ok: true, from: 'a', to: 'b', log: 'b feat: x' }),
      selfHash: () => 'unchanged',
    });
    const stats = await h.result;
    expect(stats.reExec).toBe(false);
    expect(h.spawned).toEqual([EXIT_STOP]);
  });
});

// ---------------------------------------------------------------------------
// The real supervisor, real processes, disposable repo
// ---------------------------------------------------------------------------

describe('the real supervisor against a fake app', () => {
  let repo;
  beforeEach(() => { repo = makeTempRepo(); });
  afterEach(() => { repo?.cleanup(); });

  /** Runs the real scripts/supervisor.mjs to completion and returns its stdout. */
  function runReal(repoRef, { timeout = 90_000 } = {}) {
    return execFileSync(process.execPath, [
      SUPERVISOR,
      `--root=${repoRef.root}`,
      `--data-dir=${repoRef.dataDir}`,
      `--app=${join(repoRef.root, 'app.mjs')}`,
    ], { encoding: 'utf8', timeout, env: { ...process.env, THEMACHINE_DATA_DIR: repoRef.dataDir } });
  }

  const runLog = () => readFileSync(join(repo.dataDir, 'app-runs.log'), 'utf8').trim().split('\n');

  test('spawns the app and exits when the app exits cleanly', () => {
    scriptExits(repo, [0]);
    runReal(repo);
    expect(runLog()).toEqual(['v1']);
  });

  test('exit 42 really does restart the app across a process boundary', () => {
    scriptExits(repo, [42, 0]);
    runReal(repo);
    expect(runLog()).toEqual(['v1', 'v1']);
    expect(readControl(repo.dataDir).status).toBe('done');
  }, 60_000);

  test('END TO END: exit 43 pulls the new version and brings THAT version back up', () => {
    // The whole mechanism in one test, with no human and no browser: the app asks for an update
    // and dies, a real git pull runs against a real remote, a real npm install follows, and the
    // process that comes back is proven to be running the NEW code.
    publishCommit(repo, { version: 'v2', subject: 'feat: the new version' });
    scriptExits(repo, [43, 0]);

    runReal(repo);

    const runs = runLog();
    expect(runs[0]).toBe('v1'); // the lifetime that asked for the update
    expect(runs[1]).toBe('v2'); // came back on the new code
    const control = readControl(repo.dataDir);
    expect(control.status).toBe('done');
    expect(control.changes.join(' ')).toContain('feat: the new version');
  }, 120_000);

  test('a failed update still leaves the operator with a running Machine', () => {
    // Divergence makes the pull refuse, which is the realistic "update cannot proceed" case.
    // Pressing a button must never end with nothing running.
    writeFileSync(join(repo.root, 'tracked.txt'), 'local work\n');
    execFileSync('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-am', 'diverge'], { cwd: repo.root });
    publishCommit(repo, { version: 'v2' });
    scriptExits(repo, [43, 0]);

    runReal(repo);

    expect(runLog()).toEqual(['v1', 'v1']); // still v1, still running
    expect(readControl(repo.dataDir).status).toBe('failed');
  }, 120_000);

  test('the lock refuses a second copy in plain language', () => {
    writeFileSync(lockPath(repo.dataDir), String(process.pid)); // a pid that is definitely alive
    scriptExits(repo, [0]);
    let stderr = '';
    try {
      runReal(repo);
      throw new Error('expected the supervisor to refuse to start');
    } catch (e) {
      stderr = String(e.stderr ?? '');
    }
    expect(stderr).toContain('already running');
    expect(stderr).toMatch(/only one copy/i);
  });
});
