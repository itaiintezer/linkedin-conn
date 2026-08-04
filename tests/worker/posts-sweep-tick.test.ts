/**
 * The sweep TICK — the gates, as opposed to the pass itself (posts-sweep.test.ts).
 *
 * The guardrail test is the one that matters most: Apify never touches the LinkedIn session,
 * so a tripped guardrail must NOT stop the sweep. Please do not "fix" that.
 */
import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { FakeDriver } from '../../src/browser/driver.js';
import { Orchestrator } from '../../src/worker/orchestrator.js';
import { isPostsSweepRunning } from '../../src/worker/posts-sweep.js';
import type { ApifyPostsClient } from '../../src/core/apify-posts-client.js';

let repos: Repos;
const NOW = new Date('2026-08-04T10:00:00.000Z');
const URL_A = 'https://www.linkedin.com/in/dana';

beforeEach(() => {
  repos = new Repos(openDatabase(':memory:'));
  repos.settings.update({ apify_api_key: 'apify_api_test' });
  repos.trackedProfiles.add(URL_A, null, 'urls');
});

/** Counts runs so "never spends" can be asserted precisely. */
function spyFactory(): { factory: (t: string) => ApifyPostsClient; runs: string[][] } {
  const runs: string[][] = [];
  return {
    runs,
    factory: () => ({ async fetchPosts(urls) { runs.push([...urls]); return []; } }),
  };
}

function orchestrator(factory: (t: string) => ApifyPostsClient): Orchestrator {
  return new Orchestrator(repos, new FakeDriver(), undefined, {}, undefined, factory);
}

test('a tick sweeps and stamps', async () => {
  const spy = spyFactory();
  await orchestrator(spy.factory).runPostsSweepTick(NOW);
  expect(spy.runs).toHaveLength(1);
  expect(repos.appState.get().posts_swept_at).toBe(NOW.toISOString());
});

test('the slot gate keeps one sweep per day', async () => {
  const spy = spyFactory();
  const orc = orchestrator(spy.factory);
  await orc.runPostsSweepTick(NOW);
  await orc.runPostsSweepTick(new Date('2026-08-04T14:00:00.000Z'));   // same day, same slot
  expect(spy.runs).toHaveLength(1);
  await orc.runPostsSweepTick(new Date('2026-08-05T10:00:00.000Z'));   // next day
  expect(spy.runs).toHaveLength(2);
});

test('paused blocks the sweep — it is the operator stop switch and that includes spending', async () => {
  repos.settings.update({ paused: 1 });
  const spy = spyFactory();
  await orchestrator(spy.factory).runPostsSweepTick(NOW);
  expect(spy.runs).toHaveLength(0);
});

test('a tripped guardrail does NOT block the sweep', async () => {
  // The guardrail means the LinkedIn session is in trouble. Apify never touches that
  // session, so gating on it here would stop harmless work for an unrelated reason.
  repos.appState.trip('checkpoint', 'verification requested', NOW.toISOString());
  const spy = spyFactory();
  await orchestrator(spy.factory).runPostsSweepTick(NOW);
  expect(spy.runs).toHaveLength(1);
});

test('a latched halt blocks the sweep instead of retrying it 1,440 times a day', async () => {
  repos.appState.haltPosts('auth', 'bad key', NOW.toISOString());
  const spy = spyFactory();
  await orchestrator(spy.factory).runPostsSweepTick(NOW);
  expect(spy.runs).toHaveLength(0);
});

test('no tracked profiles means no run and no client is ever built', async () => {
  const fresh = new Repos(openDatabase(':memory:'));
  fresh.settings.update({ apify_api_key: 'apify_api_test' });
  const built: string[] = [];
  const orc = new Orchestrator(fresh, new FakeDriver(), undefined, {}, undefined,
    (t: string) => { built.push(t); return { async fetchPosts() { return []; } }; });
  await orc.runPostsSweepTick(NOW);
  expect(built).toEqual([]);
});

test('work but no API key halts with a reason the operator can act on', async () => {
  repos.settings.update({ apify_api_key: '' });
  const spy = spyFactory();
  await orchestrator(spy.factory).runPostsSweepTick(NOW);
  expect(spy.runs).toHaveLength(0);
  const app = repos.appState.get();
  expect(app.posts_halted).toBe(1);
  expect(app.posts_halt_reason).toBe('no_api_key');
});

test('a throwing sweep never escapes the tick', async () => {
  const orc = orchestrator(() => ({
    async fetchPosts(): Promise<never> { throw new Error('unexpected'); },
  }));
  // A tick fires as `void this.runPostsSweepTick()`, so an uncaught rejection would crash
  // the whole process.
  await expect(orc.runPostsSweepTick(NOW)).resolves.toBeUndefined();
});

test('an overlapping tick is refused before ever building a second client', async () => {
  // Hold the first pass open inside the actor call, exactly where a real sweep spends its
  // minutes — same shape as posts-sweep.test.ts's own re-entry test, one layer up.
  //
  // NOTE on what this actually proves: runPostsSweep's OWN reentry guard (the `if (running)
  // throw` at its top, checked synchronously before any await) already makes a second
  // fetchPosts call impossible on its own — that guard reads the very same module-level flag
  // this tick's isPostsSweepRunning() peeks at, so a second overlapping call can never reach
  // the actor regardless of whether this gate exists. Asserting on fetchPosts call count would
  // therefore pass even with this gate deleted, and prove nothing about it. What this gate
  // buys is keeping that throw a BACKSTOP rather than the normal path: without it, every
  // overlapping tick during a long sweep builds a real client, immediately throws inside
  // runPostsSweep, and gets routed through handleTickError as a logged failure — wasted work
  // and log noise on every tick for the whole sweep's duration. So the property to pin is
  // "no second client is ever constructed", not "no second fetchPosts call".
  let release = (): void => {};
  const gate = new Promise<void>((r) => { release = r; });
  const built: string[] = [];
  const orc = orchestrator((t) => {
    built.push(t);
    return { async fetchPosts() { await gate; return []; } };
  });

  const first = orc.runPostsSweepTick(NOW);
  // The first tick has run synchronously up to the held actor call, so the flag is already
  // set — same assertion point posts-sweep.test.ts uses for the worker's own guard.
  expect(isPostsSweepRunning()).toBe(true);

  const second = orc.runPostsSweepTick(NOW);

  // Release only after both ticks have been issued, so the second one's gate check is
  // evaluated while the first is still genuinely in flight.
  release();
  await first;
  await second;

  expect(built).toHaveLength(1);
  expect(isPostsSweepRunning()).toBe(false);
});

test('a factory that throws never escapes the tick, and the failed pass is not stamped', async () => {
  // The factory call sits INSIDE the tick's own try — unlike a throwing fetchPosts, which
  // posts-sweep.ts already swallows internally and never lets reach this layer. This is the
  // case that actually exercises the tick's own catch.
  const orc = orchestrator(() => { throw new Error('client construction failed'); });
  // The tick fires as `void this.runPostsSweepTick()`, so an uncaught rejection here would
  // take down a process that holds a browser profile and a live send queue.
  await expect(orc.runPostsSweepTick(NOW)).resolves.toBeUndefined();
  // A pass that never ran must not be recorded as done — the next tick has to retry it
  // inside the same slot rather than silently skipping a whole day.
  expect(repos.appState.get().posts_swept_at).toBeNull();
});
