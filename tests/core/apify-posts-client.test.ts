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

interface FakeHeaders { get(name: string): string | null }

function fakeHeaders(map: Record<string, string>): FakeHeaders {
  return {
    get(name: string) {
      const key = Object.keys(map).find((k) => k.toLowerCase() === name.toLowerCase());
      return key ? map[key] : null;
    },
  };
}

/**
 * Scripted fetch: a queue of responses, returned in call order. Exhausting the script is a
 * hard error rather than a clamp-and-repeat — a client that issues one more (billable) call
 * than the test expects must fail the test, not silently get a plausible-looking repeat of
 * the last response.
 */
function scriptedFetch(steps: { status?: number; body: unknown; headers?: FakeHeaders }[]): {
  impl: typeof fetch; urls: string[]; bodies: unknown[];
} {
  const urls: string[] = [];
  const bodies: unknown[] = [];
  let i = 0;
  const impl = (async (url: string, init?: RequestInit) => {
    urls.push(url);
    if (init?.body) bodies.push(JSON.parse(String(init.body)));
    if (i >= steps.length) throw new Error(`unexpected extra request: ${url}`);
    const step = steps[i++];
    return {
      ok: (step.status ?? 200) < 400,
      status: step.status ?? 200,
      json: async () => step.body,
      text: async () => JSON.stringify(step.body),
      headers: step.headers,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, urls, bodies };
}

const startedRun = { data: { id: RUN_ID, status: 'RUNNING', defaultDatasetId: DATASET_ID } };
const succeeded = { data: { id: RUN_ID, status: 'SUCCEEDED', defaultDatasetId: DATASET_ID } };

test('starts a run with the batched input, polls, then reads the dataset to an empty page', async () => {
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
  // One run for many profiles — the whole point of using the async API. Exactly 4 calls:
  // run start, poll, one data page, one terminating empty page. Not 3 (an early-stop bug
  // would silently drop data) and not 5+ (a second run would silently double the bill).
  expect(urls).toHaveLength(4);
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

test('caps the run at maxItems (urls x maxPosts) and asks Apify to self-terminate at the poll budget', async () => {
  const { impl, urls } = scriptedFetch([{ body: startedRun }, { body: succeeded }, { body: [] }]);
  const client = new HttpApifyPostsClient(TOKEN, {
    fetchImpl: impl, sleep: async () => {}, maxRunMs: 60_000,
  });
  await client.fetchPosts(
    ['https://www.linkedin.com/in/a', 'https://www.linkedin.com/in/b'],
    { maxPosts: 5, postedLimit: '24h' },
  );
  expect(urls[0]).toContain('maxItems=10'); // 2 urls x 5 maxPosts — the billing ceiling
  expect(urls[0]).toContain('timeout=60'); // maxRunMs, in seconds — self-terminate with us
});

test('pages the dataset until an actually-empty page comes back, not merely a short one', async () => {
  const page = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `urn:li:activity:${i}` }));
  const { impl, urls } = scriptedFetch([
    { body: startedRun },
    { body: succeeded },
    { body: page(1000) },  // full page => ask for more
    { body: page(4) },     // short but NON-empty: filtering can do this without ending the
                            // dataset, so this must NOT be treated as the last page
    { body: [] },           // the actual end
  ]);
  const client = new HttpApifyPostsClient(TOKEN, { fetchImpl: impl, sleep: async () => {} });
  const items = await client.fetchPosts(['https://www.linkedin.com/in/a'],
    { maxPosts: 2000, postedLimit: '24h' });
  expect(items).toHaveLength(1004);
  expect(urls[2]).toContain('offset=0');
  expect(urls[3]).toContain('offset=1000');
  expect(urls[4]).toContain('offset=2000');
});

test('trusts an authoritative X-Apify-Pagination-Total header instead of waiting for an empty page', async () => {
  const page = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `urn:li:activity:${i}` }));
  const { impl, urls } = scriptedFetch([
    { body: startedRun },
    { body: succeeded },
    { body: page(1000) },
    { body: page(2), headers: fakeHeaders({ 'X-Apify-Pagination-Total': '1002' }) },
  ]);
  const client = new HttpApifyPostsClient(TOKEN, { fetchImpl: impl, sleep: async () => {} });
  const items = await client.fetchPosts(['https://www.linkedin.com/in/a'],
    { maxPosts: 2000, postedLimit: '24h' });
  expect(items).toHaveLength(1002);
  expect(urls).toHaveLength(4); // no extra request just to fetch a terminating empty page
});

test('dataset pagination throws instead of looping forever when pages never come back empty', async () => {
  const page1000 = () => Array.from({ length: 1000 }, (_, i) => ({ id: `urn:li:activity:${i}` }));
  // 1 url x maxPosts 3 => expectedMaxItems 3 => maxPages = ceil(3/1000) + 2 = 3
  const { impl } = scriptedFetch([
    { body: startedRun },
    { body: succeeded },
    { body: page1000() },
    { body: page1000() },
    { body: page1000() },
  ]);
  const client = new HttpApifyPostsClient(TOKEN, { fetchImpl: impl, sleep: async () => {} });
  await expect(client.fetchPosts(['https://www.linkedin.com/in/a'],
    { maxPosts: 3, postedLimit: '24h' })).rejects.toThrow(/did not terminate after/i);
});

test('a non-array dataset page throws with a shape hint', async () => {
  const { impl } = scriptedFetch([
    { body: startedRun }, { body: succeeded }, { body: { notAnArray: true } },
  ]);
  const client = new HttpApifyPostsClient(TOKEN, { fetchImpl: impl, sleep: async () => {} });
  const err = await client.fetchPosts(['https://www.linkedin.com/in/a'],
    { maxPosts: 3, postedLimit: '24h' }).catch((e: Error) => e) as Error;
  expect(err.message).toMatch(/unexpected shape/i);
  expect(err.message).toMatch(/object/i);
});

test('falls back to the run-start dataset id when the terminal poll response omits it', async () => {
  const { impl, urls } = scriptedFetch([
    { body: startedRun },
    { body: { data: { id: RUN_ID, status: 'SUCCEEDED' } } }, // no defaultDatasetId here
    { body: [] },
  ]);
  const client = new HttpApifyPostsClient(TOKEN, { fetchImpl: impl, sleep: async () => {} });
  const items = await client.fetchPosts(['https://www.linkedin.com/in/a'],
    { maxPosts: 3, postedLimit: '24h' });
  expect(items).toEqual([]);
  expect(urls[2]).toContain(`/v2/datasets/${DATASET_ID}/items`); // fell back to run-start's id
});

test('a run-start response missing a run id or dataset id throws', async () => {
  const { impl } = scriptedFetch([{ body: { data: { status: 'RUNNING' } } }]);
  const client = new HttpApifyPostsClient(TOKEN, { fetchImpl: impl, sleep: async () => {} });
  const err = await client.fetchPosts(['https://www.linkedin.com/in/a'],
    { maxPosts: 3, postedLimit: '24h' }).catch((e: Error) => e) as Error;
  expect(err.message).toMatch(/run id and dataset id/i);
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

test('surfaces Apify\'s own error body for a 403 — status alone can\'t distinguish a bad key from a spent quota', async () => {
  const quotaBody = {
    error: { type: 'insufficient-permissions', message: 'monthly usage hard limit exceeded' },
  };
  const { impl } = scriptedFetch([{ status: 403, body: quotaBody }]);
  const client = new HttpApifyPostsClient(TOKEN, { fetchImpl: impl, sleep: async () => {} });
  const err = await client.fetchPosts(['https://www.linkedin.com/in/a'],
    { maxPosts: 3, postedLimit: '24h' }).catch((e: Error) => e) as Error;
  expect(err.message).toMatch(/403/);
  expect(err.message).toMatch(/monthly usage hard limit exceeded/);
  expect(err.message).not.toContain('SECRETVALUE');
});

test('a hung request aborts after timeoutMs with a clear, token-free message', async () => {
  const impl = ((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      const err = new Error('This operation was aborted');
      err.name = 'AbortError';
      reject(err);
    });
  })) as unknown as typeof fetch;
  const client = new HttpApifyPostsClient(TOKEN, { fetchImpl: impl, sleep: async () => {}, timeoutMs: 20 });
  const err = await client.fetchPosts(['https://www.linkedin.com/in/a'],
    { maxPosts: 3, postedLimit: '24h' }).catch((e: Error) => e) as Error;
  expect(err.message).toMatch(/timed out/i);
  expect(err.message).not.toContain('SECRETVALUE');
}, 2000);

test('polling gives up rather than hanging forever', async () => {
  const { impl } = scriptedFetch([
    { body: startedRun }, { body: startedRun }, { body: startedRun }, { body: startedRun },
  ]);
  const client = new HttpApifyPostsClient(TOKEN, {
    fetchImpl: impl, sleep: async () => {}, maxPolls: 3,
  });
  await expect(client.fetchPosts(['https://www.linkedin.com/in/a'],
    { maxPosts: 3, postedLimit: '24h' })).rejects.toThrow(/did not finish/i);
});

test('gives up on the overall run-time budget before spending on another poll, even with polls remaining', async () => {
  const { impl, urls } = scriptedFetch([{ body: startedRun }]);
  const client = new HttpApifyPostsClient(TOKEN, {
    fetchImpl: impl, sleep: async () => {}, maxPolls: 100, maxRunMs: -1,
  });
  const err = await client.fetchPosts(['https://www.linkedin.com/in/a'],
    { maxPosts: 3, postedLimit: '24h' }).catch((e: Error) => e) as Error;
  expect(err.message).toMatch(/run budget/i);
  expect(urls).toHaveLength(1); // only the run-start POST — no poll was ever attempted
});

test('throws immediately on a poll response missing a string status, instead of burning all maxPolls polls', async () => {
  const { impl } = scriptedFetch([
    { body: startedRun },
    { body: { data: { id: RUN_ID, state: 'RUNNING' } } }, // field renamed: no `status`
  ]);
  const client = new HttpApifyPostsClient(TOKEN, {
    fetchImpl: impl, sleep: async () => {}, maxPolls: 240,
  });
  const err = await client.fetchPosts(['https://www.linkedin.com/in/a'],
    { maxPosts: 3, postedLimit: '24h' }).catch((e: Error) => e) as Error;
  expect(err.message).toMatch(/status/i);
  expect(err.message).not.toMatch(/240 polls/); // must not misattribute this to running out of polls
});

test('keeps polling on an unrecognized-but-present status string, for forward compatibility', async () => {
  const { impl } = scriptedFetch([
    { body: startedRun },
    { body: { data: { id: RUN_ID, status: 'READY', defaultDatasetId: DATASET_ID } } },
    { body: succeeded },
    { body: [] },
  ]);
  const client = new HttpApifyPostsClient(TOKEN, { fetchImpl: impl, sleep: async () => {} });
  const items = await client.fetchPosts(['https://www.linkedin.com/in/a'],
    { maxPosts: 3, postedLimit: '24h' });
  expect(items).toEqual([]);
});

test('sleeps pollMs between polls, not whatever the mock happens to be given', async () => {
  const sleepCalls: number[] = [];
  const sleepSpy = async (ms: number) => { sleepCalls.push(ms); };
  const { impl } = scriptedFetch([
    { body: startedRun },   // run start
    { body: startedRun },   // poll i=0: RUNNING (no sleep before this one)
    { body: startedRun },   // poll i=1: RUNNING
    { body: startedRun },   // poll i=2: RUNNING
    { body: succeeded },    // poll i=3: SUCCEEDED
    { body: [] },           // dataset page
  ]);
  const client = new HttpApifyPostsClient(TOKEN, { fetchImpl: impl, sleep: sleepSpy, pollMs: 5000 });
  await client.fetchPosts(['https://www.linkedin.com/in/a'], { maxPosts: 3, postedLimit: '24h' });
  expect(sleepCalls).toEqual([5000, 5000, 5000]);
});

test('retries a transient poll failure before giving up', async () => {
  let callCount = 0;
  const impl = (async () => {
    callCount++;
    if (callCount === 1) return { ok: true, status: 200, json: async () => startedRun } as Response;
    if (callCount === 2) throw new Error('socket hang up');
    if (callCount === 3) return { ok: true, status: 200, json: async () => succeeded } as Response;
    return { ok: true, status: 200, json: async () => [], text: async () => '[]' } as Response;
  }) as unknown as typeof fetch;
  const client = new HttpApifyPostsClient(TOKEN, { fetchImpl: impl, sleep: async () => {} });
  const items = await client.fetchPosts(['https://www.linkedin.com/in/a'],
    { maxPosts: 3, postedLimit: '24h' });
  expect(items).toEqual([]);
  expect(callCount).toBe(4); // start, poll (fails), poll (retried, succeeds), dataset page
});

test('gives up after exhausting retries on a persistently failing poll, surfacing the real cause', async () => {
  let callCount = 0;
  const impl = (async () => {
    callCount++;
    if (callCount === 1) return { ok: true, status: 200, json: async () => startedRun } as Response;
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
  const client = new HttpApifyPostsClient(TOKEN, {
    fetchImpl: impl, sleep: async () => {}, retryAttempts: 3,
  });
  const err = await client.fetchPosts(['https://www.linkedin.com/in/a'],
    { maxPosts: 3, postedLimit: '24h' }).catch((e: Error) => e) as Error;
  expect(err.message).toMatch(/ECONNREFUSED/);
  expect(callCount).toBe(1 + 3); // run start + exactly 3 poll attempts, not retried forever
});

test('never retries the run-start POST — an ambiguous failure there must not risk a second billable run', async () => {
  let callCount = 0;
  const impl = (async () => { callCount++; throw new Error('socket hang up'); }) as unknown as typeof fetch;
  const client = new HttpApifyPostsClient(TOKEN, {
    fetchImpl: impl, sleep: async () => {}, retryAttempts: 3,
  });
  const err = await client.fetchPosts(['https://www.linkedin.com/in/a'],
    { maxPosts: 3, postedLimit: '24h' }).catch((e: Error) => e) as Error;
  expect(err.message).toMatch(/socket hang up/);
  expect(callCount).toBe(1); // not 3 — run start gets exactly one attempt
});

test('rejects maxPosts that are zero, negative or non-integer before spending anything', async () => {
  const spy = vi.fn();
  const client = new HttpApifyPostsClient(TOKEN, {
    fetchImpl: spy as unknown as typeof fetch, sleep: async () => {},
  });
  for (const bad of [0, -1, 1.5, NaN]) {
    const err = await client.fetchPosts(['https://www.linkedin.com/in/a'],
      { maxPosts: bad, postedLimit: '24h' }).catch((e: Error) => e) as Error;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/positive integer/i);
  }
  expect(spy).not.toHaveBeenCalled();
});

test('an empty tracked list never starts a run', async () => {
  const spy = vi.fn();
  const client = new HttpApifyPostsClient(TOKEN, {
    fetchImpl: spy as unknown as typeof fetch, sleep: async () => {},
  });
  expect(await client.fetchPosts([], { maxPosts: 3, postedLimit: '24h' })).toEqual([]);
  expect(spy).not.toHaveBeenCalled();
});
