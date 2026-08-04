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
