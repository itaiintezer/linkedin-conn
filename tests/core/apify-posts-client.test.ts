/**
 * The posts client. Every test drives an injected fetch — nothing here reaches Apify.
 *
 * The token appears in the query string, and these tests pin the rule that it must never
 * reach an error message: those land in data/relay.log, which the operator downloads and
 * shares when troubleshooting.
 */
import { test, expect, vi } from 'vitest';
import { HttpApifyPostsClient } from '../../src/core/apify-posts-client.js';

const TOKEN = 'apify_api_SECRETVALUE';
const RUN_ID = 'run123';
const DATASET_ID = 'ds456';

/** Scripted fetch: a queue of responses, returned in call order. */
function scriptedFetch(steps: { status?: number; body: unknown }[]): {
  impl: typeof fetch; urls: string[]; bodies: unknown[];
} {
  const urls: string[] = [];
  const bodies: unknown[] = [];
  let i = 0;
  const impl = (async (url: string, init?: RequestInit) => {
    urls.push(url);
    if (init?.body) bodies.push(JSON.parse(String(init.body)));
    const step = steps[Math.min(i++, steps.length - 1)];
    return {
      ok: (step.status ?? 200) < 400,
      status: step.status ?? 200,
      json: async () => step.body,
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, urls, bodies };
}

const startedRun = { data: { id: RUN_ID, status: 'RUNNING', defaultDatasetId: DATASET_ID } };
const succeeded = { data: { id: RUN_ID, status: 'SUCCEEDED', defaultDatasetId: DATASET_ID } };

test('starts a run with the batched input, polls, then reads the dataset', async () => {
  const { impl, urls, bodies } = scriptedFetch([
    { body: startedRun },
    { body: succeeded },
    { body: [{ id: 'urn:li:activity:1' }, { id: 'urn:li:activity:2' }] },
    { body: [] },
  ]);
  const client = new HttpApifyPostsClient(TOKEN, { fetchImpl: impl, sleep: async () => {} });

  const items = await client.fetchPosts(
    ['https://www.linkedin.com/in/a', 'https://www.linkedin.com/in/b'],
    { maxPosts: 3, postedLimit: '24h' },
  );

  expect(items).toHaveLength(2);
  // One run for many profiles — the whole point of using the async API.
  expect(bodies[0]).toEqual({
    targetUrls: ['https://www.linkedin.com/in/a', 'https://www.linkedin.com/in/b'],
    maxPosts: 3,
    postedLimit: '24h',
    scrapeReactions: false,
    scrapeComments: false,
  });
  expect(urls[0]).toContain('/v2/acts/harvestapi~linkedin-profile-posts/runs');
  expect(urls[1]).toContain(`/v2/actor-runs/${RUN_ID}`);
  expect(urls[2]).toContain(`/v2/datasets/${DATASET_ID}/items`);
});

test('scrapeReactions and scrapeComments are always false — they bill as extra posts', async () => {
  const { impl, bodies } = scriptedFetch([
    { body: startedRun }, { body: succeeded }, { body: [] },
  ]);
  const client = new HttpApifyPostsClient(TOKEN, { fetchImpl: impl, sleep: async () => {} });
  await client.fetchPosts(['https://www.linkedin.com/in/a'], { maxPosts: 3, postedLimit: 'week' });
  const sent = bodies[0] as Record<string, unknown>;
  expect(sent.scrapeReactions).toBe(false);
  expect(sent.scrapeComments).toBe(false);
});

test('pages the dataset until a short page comes back', async () => {
  const page = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `urn:li:activity:${i}` }));
  const { impl, urls } = scriptedFetch([
    { body: startedRun },
    { body: succeeded },
    { body: page(1000) },   // full page => ask for more
    { body: page(4) },      // short page => stop
  ]);
  const client = new HttpApifyPostsClient(TOKEN, { fetchImpl: impl, sleep: async () => {} });
  const items = await client.fetchPosts(['https://www.linkedin.com/in/a'],
    { maxPosts: 3, postedLimit: '24h' });
  expect(items).toHaveLength(1004);
  expect(urls[2]).toContain('offset=0');
  expect(urls[3]).toContain('offset=1000');
});

test('a failed run throws, naming the status but never the token', async () => {
  const { impl } = scriptedFetch([
    { body: startedRun },
    { body: { data: { id: RUN_ID, status: 'FAILED', defaultDatasetId: DATASET_ID } } },
  ]);
  const client = new HttpApifyPostsClient(TOKEN, { fetchImpl: impl, sleep: async () => {} });
  const err = await client.fetchPosts(['https://www.linkedin.com/in/a'],
    { maxPosts: 3, postedLimit: '24h' }).catch((e: Error) => e) as Error;
  expect(err.message).toMatch(/FAILED/);
  expect(err.message).not.toContain('SECRETVALUE');
});

test('an HTTP error names the status but never the token', async () => {
  const { impl } = scriptedFetch([{ status: 401, body: {} }]);
  const client = new HttpApifyPostsClient(TOKEN, { fetchImpl: impl, sleep: async () => {} });
  const err = await client.fetchPosts(['https://www.linkedin.com/in/a'],
    { maxPosts: 3, postedLimit: '24h' }).catch((e: Error) => e) as Error;
  expect(err.message).toMatch(/401/);
  expect(err.message).not.toContain('SECRETVALUE');
});

test('polling gives up rather than hanging forever', async () => {
  const { impl } = scriptedFetch([{ body: startedRun }, { body: startedRun }]);
  const client = new HttpApifyPostsClient(TOKEN, {
    fetchImpl: impl, sleep: async () => {}, maxPolls: 3,
  });
  await expect(client.fetchPosts(['https://www.linkedin.com/in/a'],
    { maxPosts: 3, postedLimit: '24h' })).rejects.toThrow(/did not finish/i);
});

test('an empty tracked list never starts a run', async () => {
  const spy = vi.fn();
  const client = new HttpApifyPostsClient(TOKEN, {
    fetchImpl: spy as unknown as typeof fetch, sleep: async () => {},
  });
  expect(await client.fetchPosts([], { maxPosts: 3, postedLimit: '24h' })).toEqual([]);
  expect(spy).not.toHaveBeenCalled();
});
