/**
 * The Restart and Update routes.
 *
 * The app cannot restart or update itself, so these routes only ever do three things: write a
 * request to data/control.json, drain the browser lock, and exit with a code the supervisor
 * understands. `requestExit` is injected, which is the seam that lets all of this be tested
 * without killing the test runner.
 *
 * The load-bearing test is the drain one. Exiting between "clicked Connect on LinkedIn" and
 * "recorded the send" means that person gets invited twice, which is the only consequence here
 * that reaches a real human.
 */
import { test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { FakeDriver } from '../../src/browser/driver.js';
import { buildServer } from '../../src/api/server.js';
import { Mutex } from '../../src/core/mutex.js';
import { EXIT_RESTART, EXIT_UPDATE, reconcileControlOnBoot } from '../../src/core/lifecycle.js';
import { isPending, markDone, newRequest, readControl, writeControl } from '../../scripts/control-file.mjs';

let app: ReturnType<typeof buildServer>;
let repos: Repos;
let dataDir: string;
let exits: number[];
let browserLock: Mutex;

function build(opts: Parameters<typeof buildServer>[4] = {}) {
  return buildServer(repos, new FakeDriver(), browserLock, undefined, {
    dataDir,
    supervised: true,
    requestExit: (code) => { exits.push(code); },
    drainTimeoutMs: 200,
    updateCheck: async () => ({ available: 0, changes: [], checked_at: '2026-08-10T00:00:00.000Z' }),
    ...opts,
  });
}

beforeEach(() => {
  repos = new Repos(openDatabase(':memory:'));
  dataDir = mkdtempSync(join(tmpdir(), 'tm-lifecycle-'));
  exits = [];
  browserLock = new Mutex();
  app = build();
});

afterEach(async () => {
  // Let any pending handover finish while `exits` still points at THIS test's array. The routes
  // exit on a later tick by design, so without this a test that does not settle leaks its exit
  // into the next test's assertions.
  await settle();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
  vi.restoreAllMocks();
});

/** The routes exit on a later tick, on purpose — the response goes out first. */
const settle = () => new Promise((r) => setTimeout(r, 400));

test('POST /api/update answers immediately and does not exit while still replying', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/update' });
  expect(res.statusCode).toBe(202);
  expect(res.json()).toMatchObject({ ok: true, action: 'update' });
  // The whole point of 202: the browser gets an answer before the server goes away.
  expect(exits).toEqual([]);
});

test('POST /api/update writes the request the supervisor will read, and pauses first', async () => {
  await app.inject({ method: 'POST', url: '/api/update' });

  const control = readControl(dataDir);
  expect(control?.action).toBe('update');
  expect(isPending(control)).toBe(true);
  // Paused before anything else: if the handover goes wrong, the engines are already quiet.
  expect(repos.settings.get().paused).toBe(1);
  expect(repos.settings.get().pause_reason).toMatch(/Updating/);
});

test('POST /api/update then exits 43, the code the supervisor reads as "update"', async () => {
  await app.inject({ method: 'POST', url: '/api/update' });
  await settle();
  expect(exits).toEqual([EXIT_UPDATE]);
});

test('POST /api/restart exits 42 and records a restart, not an update', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/restart' });
  expect(res.statusCode).toBe(202);
  await settle();
  expect(exits).toEqual([EXIT_RESTART]);
  expect(readControl(dataDir)?.action).toBe('restart');
});

test('THE LOAD-BEARING ONE: it waits for in-flight browser work before exiting', async () => {
  // A send is a page load, a click, and then a database write. Exiting between the click and
  // the write means LinkedIn has an invite we have no record of, so the profile stays queued
  // and that person receives a second identical request days later.
  let sendFinished = false;
  const inFlight = browserLock.run(async () => {
    await new Promise((r) => setTimeout(r, 150));
    sendFinished = true;
  });

  await app.inject({ method: 'POST', url: '/api/update' });
  await settle();
  await inFlight;

  expect(sendFinished).toBe(true);
  expect(exits).toEqual([EXIT_UPDATE]);
});

test('a browser task that will not finish does not block the update forever', async () => {
  // Refusing to ever update is its own failure. It exits anyway, and the log says it was not
  // clean — see the warn in the route.
  let release: () => void = () => {};
  const stuck = browserLock.run(() => new Promise<void>((r) => { release = r; }));

  await app.inject({ method: 'POST', url: '/api/update' });
  await new Promise((r) => setTimeout(r, 600)); // past the 200ms drain timeout

  expect(exits).toEqual([EXIT_UPDATE]);
  release();
  await stuck;
});

test('UNSUPERVISED: it refuses rather than killing itself with nothing to bring it back', async () => {
  // Started by hand (`npm run start:app`, or a dev session), exiting would simply stop The
  // Machine until the operator next logs in — the opposite of what the button promises.
  const solo = build({ supervised: false });
  const res = await solo.inject({ method: 'POST', url: '/api/update' });

  expect(res.statusCode).toBe(409);
  expect(res.json().error).toMatch(/started by hand/i);
  expect(exits).toEqual([]);
  expect(readControl(dataDir)).toBeNull();
});

test('a second request while one is in flight is refused in plain language', async () => {
  await app.inject({ method: 'POST', url: '/api/update' });
  const second = await app.inject({ method: 'POST', url: '/api/update' });

  expect(second.statusCode).toBe(409);
  expect(second.json().error).toMatch(/already in progress/i);
  expect(second.json().error).not.toMatch(/409|conflict/i);
});

test('a finished request does not block the next one', async () => {
  writeControl(dataDir, markDone(newRequest('update', '2026-08-10T09:00:00.000Z'), { changes: ['a x'] }, '2026-08-10T09:01:00.000Z'));
  const res = await app.inject({ method: 'POST', url: '/api/update' });
  expect(res.statusCode).toBe(202);
});

test('GET /api/update/status reports the outcome across the restart', async () => {
  // This is what the dashboard reads after the server it asked has died and come back. Without
  // it there is no way to tell "updated" from "crashed and came back on the old code".
  writeControl(dataDir, markDone(
    newRequest('update', '2026-08-10T09:00:00.000Z'),
    { from: 'aaa', to: 'bbb', changes: ['bbb feat: one', 'ccc fix: two'] },
    '2026-08-10T09:02:00.000Z',
  ));

  const res = await app.inject({ method: 'GET', url: '/api/update/status' });

  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({
    state: 'done',
    message: 'Updated — 2 new changes installed.',
    action: 'update',
    supervised: true,
  });
  expect(res.json().changes).toHaveLength(2);
});

test('GET /api/update/status is idle and honest before anything has happened', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/update/status' });
  expect(res.json()).toMatchObject({ state: 'idle', action: null });
  expect(res.json().changes).toEqual([]);
});

test('GET /api/update/check reports what is available', async () => {
  const withUpdates = build({
    updateCheck: async () => ({ available: 2, changes: ['feat: one', 'fix: two'], checked_at: 'x' }),
  });
  const res = await withUpdates.inject({ method: 'GET', url: '/api/update/check' });
  expect(res.json()).toMatchObject({ available: 2 });
});

test('reconcileControlOnBoot closes out a request nobody is going to finish', async () => {
  // Otherwise the dashboard sits on "Updating…" forever, which reads as "still working" when
  // in fact nothing is happening.
  writeControl(dataDir, newRequest('update', '2026-08-10T09:00:00.000Z'));

  expect(reconcileControlOnBoot(dataDir, { supervised: false })).toBe('abandoned');

  const control = readControl(dataDir);
  expect(control?.status).toBe('failed');
  expect(control?.error).toMatch(/started by hand/i);
  expect(isPending(control)).toBe(false);
});

test('reconcileControlOnBoot blames the supervisor when there was one', async () => {
  writeControl(dataDir, newRequest('update', '2026-08-10T09:00:00.000Z'));
  reconcileControlOnBoot(dataDir, { supervised: true });
  expect(readControl(dataDir)?.error).toMatch(/stopped partway through/i);
});

test('reconcileControlOnBoot leaves a finished request alone', async () => {
  const done = markDone(newRequest('update', '2026-08-10T09:00:00.000Z'), { changes: [] }, '2026-08-10T09:01:00.000Z');
  writeControl(dataDir, done);
  expect(reconcileControlOnBoot(dataDir, { supervised: true })).toBe('none');
  expect(readControl(dataDir)?.status).toBe('done');
});

test('the exit codes are the literal numbers scripts/supervisor.mjs looks for', async () => {
  // These constants are declared twice — here and in supervisor.mjs, which cannot import
  // TypeScript. supervisor.test.mjs asserts the same literals from the other side. A silent
  // divergence would turn "Update" into "quietly stop The Machine until the next login".
  expect(EXIT_RESTART).toBe(42);
  expect(EXIT_UPDATE).toBe(43);
});

test('there is deliberately no Stop route', async () => {
  // With a login-launched service, "stopped" means "until the next login" — and there would be
  // no server left to serve the button that undoes it. Pause is the reversible equivalent.
  const res = await app.inject({ method: 'POST', url: '/api/stop' });
  expect(res.statusCode).toBe(404);
  expect((await app.inject({ method: 'POST', url: '/api/pause' })).statusCode).toBe(200);
});
