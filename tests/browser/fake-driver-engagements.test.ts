import { test, expect } from 'vitest';
import { FakeDriver } from '../../src/browser/driver.js';

const POST = 'https://www.linkedin.com/feed/update/urn:li:activity:7489401096851906561/';

test('reactToPost defaults to done and records the reaction', async () => {
  const d = new FakeDriver();
  const out = await d.reactToPost(POST, 'insightful');
  expect(out.result).toBe('done');
  expect(d.reactLog).toEqual([{ url: POST, reaction: 'insightful' }]);
  expect(d.open).toBe(true);
});

test('a scripted already reports the reaction already on the post', async () => {
  // The real driver reads this off the trigger's "Unreact <X>" aria-label rather than
  // clicking, because clicking an already-reacted post would REMOVE the reaction.
  const d = new FakeDriver();
  d.reactScripted.set(POST, 'already');
  d.existingReaction = 'celebrate';
  const out = await d.reactToPost(POST, 'like');
  expect(out.result).toBe('already');
  expect(out.existingReaction).toBe('celebrate');
});

test('done carries no existingReaction', async () => {
  const d = new FakeDriver();
  expect(await d.reactToPost(POST, 'like')).not.toHaveProperty('existingReaction');
});

test('observedUrn is absent by default and present once the fake reads one', async () => {
  const d = new FakeDriver();
  expect(await d.reactToPost(POST, 'like')).not.toHaveProperty('observedUrn');
  // The canonical URN differs from the id in the share URL — that is the whole point of
  // the field, so script one that does not match POST.
  d.observedUrn = 'urn:li:activity:7489401096851906561';
  const out = await d.reactToPost('https://www.linkedin.com/posts/x-7489401095899770880', 'like');
  expect(out.observedUrn).toBe('urn:li:activity:7489401096851906561');
});

test('an empty observedUrn is treated as absent, not reported as a URN', async () => {
  const d = new FakeDriver();
  d.observedUrn = '';
  expect(await d.reactToPost(POST, 'like')).not.toHaveProperty('observedUrn');
});

test('commentOnPost defaults to done and records the text', async () => {
  const d = new FakeDriver();
  const out = await d.commentOnPost(POST, 'Sharp read 👀');
  expect(out.result).toBe('done');
  expect(d.commentLog).toEqual([{ url: POST, text: 'Sharp read 👀' }]);
});

test('a comment can be scripted unverified — the result the sender must never retry', async () => {
  const d = new FakeDriver();
  d.commentScripted.set(POST, 'unverified');
  const out = await d.commentOnPost(POST, 'hello');
  expect(out.result).toBe('unverified');
  // Not a failure the operator gets a screenshot for; it parks for review instead.
  expect(out.evidence).toBeUndefined();
});

const EVIDENCE = {
  pageUrl: 'https://www.linkedin.com/checkpoint/challenge/fake',
  matched: 'linkedin.com/checkpoint/',
  screenshot: 'fake.png',
};

test.each(['checkpoint', 'error', 'unavailable'] as const)(
  'evidence rides along on a %s outcome',
  async (result) => {
    const d = new FakeDriver();
    d.evidence = EVIDENCE;
    d.reactScripted.set(POST, result);
    d.commentScripted.set(POST, result);
    expect((await d.reactToPost(POST, 'like')).evidence).toEqual(EVIDENCE);
    expect((await d.commentOnPost(POST, 'hi')).evidence).toEqual(EVIDENCE);
  },
);

test.each(['done', 'already'] as const)('no evidence on a %s outcome', async (result) => {
  const d = new FakeDriver();
  d.evidence = EVIDENCE;
  d.reactScripted.set(POST, result);
  d.commentScripted.set(POST, result);
  expect((await d.reactToPost(POST, 'like')).evidence).toBeUndefined();
  expect((await d.commentOnPost(POST, 'hi')).evidence).toBeUndefined();
});
