import { test, expect } from 'vitest';
import { HttpApifyClient } from '../../src/core/apify-client.js';

/** A fetch stub returning a scripted sequence of responses. */
function scriptedFetch(...responses: { ok: boolean; status: number; body: unknown }[]) {
  const calls: string[] = [];
  let i = 0;
  const impl = async (url: string) => {
    calls.push(url);
    const r = responses[Math.min(i++, responses.length - 1)];
    return { ok: r.ok, status: r.status, json: async () => r.body };
  };
  return { impl: impl as never, calls };
}

const ok = (body: unknown) => ({ ok: true, status: 201, body });
const fail = (status: number, body: unknown = {}) => ({ ok: false, status, body });

test('returns the first dataset item on success', async () => {
  const { impl, calls } = scriptedFetch(ok([{ publicIdentifier: 'ada', headline: 'Mathematician' }]));
  const client = new HttpApifyClient('tok', { fetchImpl: impl, backoffMs: 0 });

  const out = await client.fetchProfile('https://www.linkedin.com/in/ada');

  expect(out.publicIdentifier).toBe('ada');
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain('LpVuK3Zozwuipa5bp');
});

test('retries a 5xx and then succeeds', async () => {
  const { impl, calls } = scriptedFetch(fail(502), ok([{ publicIdentifier: 'ada' }]));
  const client = new HttpApifyClient('tok', { fetchImpl: impl, backoffMs: 0 });

  const out = await client.fetchProfile('https://www.linkedin.com/in/ada');

  expect(calls).toHaveLength(2);
  expect(out.publicIdentifier).toBe('ada');
});

test('gives up after maxRetries and reports the status', async () => {
  const { impl, calls } = scriptedFetch(fail(500));
  const client = new HttpApifyClient('tok', { fetchImpl: impl, backoffMs: 0, maxRetries: 2 });

  await expect(client.fetchProfile('https://www.linkedin.com/in/ada')).rejects.toThrow(/500/);
  expect(calls).toHaveLength(3); // initial + 2 retries
});

test('never leaks the API token in an error message', async () => {
  const { impl } = scriptedFetch(fail(401, { error: 'invalid token' }));
  const client = new HttpApifyClient('SUPER-SECRET-TOKEN', { fetchImpl: impl, backoffMs: 0, maxRetries: 0 });

  // The token travels in the query string, so a naive `${url}` in an error would leak it
  // straight into the run log the operator downloads and shares.
  const err = await client.fetchProfile('https://www.linkedin.com/in/ada').catch((e: Error) => e);
  expect(String(err)).toMatch(/401/);
  expect(String(err)).not.toContain('SUPER-SECRET-TOKEN');
});

test('an empty dataset is an error, not an undefined profile', async () => {
  const { impl } = scriptedFetch(ok([]));
  const client = new HttpApifyClient('tok', { fetchImpl: impl, backoffMs: 0, maxRetries: 0 });
  await expect(client.fetchProfile('https://www.linkedin.com/in/ada')).rejects.toThrow(/empty dataset/i);
});

test('a non-array payload is an error', async () => {
  const { impl } = scriptedFetch(ok({ error: 'actor exploded' }));
  const client = new HttpApifyClient('tok', { fetchImpl: impl, backoffMs: 0, maxRetries: 0 });
  await expect(client.fetchProfile('https://www.linkedin.com/in/ada')).rejects.toThrow(/unexpected/i);
});

test('a network throw is retried like an HTTP failure', async () => {
  let n = 0;
  const impl = (async () => {
    if (++n === 1) throw new Error('ECONNRESET');
    return { ok: true, status: 201, json: async () => [{ publicIdentifier: 'ada' }] };
  }) as never;
  const client = new HttpApifyClient('tok', { fetchImpl: impl, backoffMs: 0 });

  const out = await client.fetchProfile('https://www.linkedin.com/in/ada');
  expect(n).toBe(2);
  expect(out.publicIdentifier).toBe('ada');
});

test('sends the profile URL as a single-item queries array', async () => {
  let sentBody: string | undefined;
  const impl = (async (_url: string, init: { body: string }) => {
    sentBody = init.body;
    return { ok: true, status: 201, json: async () => [{ publicIdentifier: 'ada' }] };
  }) as never;
  const client = new HttpApifyClient('tok', { fetchImpl: impl, backoffMs: 0 });

  await client.fetchProfile('https://www.linkedin.com/in/ada');

  const body = JSON.parse(sentBody!);
  expect(body.queries).toEqual(['https://www.linkedin.com/in/ada']);
  expect(body.profileScraperMode).toContain('no email');
});
