/**
 * "Is there anything to install?"
 *
 * The behaviour that matters most here is the failure one: a laptop that is offline, or whose
 * git credentials have lapsed, must produce silence rather than an alarming banner. We do not
 * know is not the same as there is a problem.
 */
import { test, expect, vi } from 'vitest';
import { checkForUpdates, parseChangeList } from '../../src/core/update-check.js';

const NOW = new Date('2026-08-10T12:00:00.000Z');

test('parseChangeList drops the sha and keeps the subject', () => {
  // The sha means nothing to a sales rep; the subject is the entire value of the list.
  const out = parseChangeList('abc1234 feat: add a thing\ndef5678 fix: correct a thing');
  expect(out).toEqual(['feat: add a thing', 'fix: correct a thing']);
});

test('parseChangeList ignores blank lines and caps the list', () => {
  expect(parseChangeList('\n\n')).toEqual([]);
  const long = Array.from({ length: 30 }, (_, i) => `abc123${i} commit ${i}`).join('\n');
  expect(parseChangeList(long, 5)).toHaveLength(5);
});

test('reports the number of changes waiting', async () => {
  const git = vi.fn(async (_root: string, args: string[]) =>
    args[0] === 'fetch' ? '' : 'aaaaaaa feat: one\nbbbbbbb fix: two');

  const out = await checkForUpdates('/repo', { now: NOW, git });

  expect(out.available).toBe(2);
  expect(out.changes).toEqual(['feat: one', 'fix: two']);
  expect(out.checked_at).toBe(NOW.toISOString());
});

/**
 * One PR merged with GitHub's button reached the top bar as "2 updates available" for a single
 * fix, listing the merge commit above it. `scripts/update.mjs` already dropped merges from the
 * after-the-fact changelog (PR #32); the availability check the pill reads did not.
 */
test('a merge commit is not counted or listed as an update of its own', async () => {
  const git = vi.fn(async (_root: string, args: string[]) => {
    if (args[0] === 'fetch') return '';
    // What `git log --oneline` would print for a button-merged PR, minus the merge line.
    return args.includes('--no-merges') ? 'a2cdd47 feat: one real change' : '';
  });

  const out = await checkForUpdates('/repo', { now: NOW, git });

  expect(out.available).toBe(1);
  expect(out.changes).toEqual(['feat: one real change']);
});

test('a merge commit alone still counts — hiding a real update is the worse failure', async () => {
  // `main` ahead by only a merge commit is rare, but an operator cannot run git to find out.
  const git = vi.fn(async (_root: string, args: string[]) => {
    if (args[0] === 'fetch') return '';
    return args.includes('--no-merges') ? '' : '708bec6 Merge pull request #40 from someone/thing';
  });

  const out = await checkForUpdates('/repo', { now: NOW, git });

  expect(out.available).toBe(1);
  expect(out.changes).toEqual(['Merge pull request #40 from someone/thing']);
});

test('fetches before comparing — otherwise it reports on a stale view of the remote', async () => {
  const calls: string[][] = [];
  const git = vi.fn(async (_root: string, args: string[]) => { calls.push(args); return ''; });

  await checkForUpdates('/repo', { now: NOW, git });

  expect(calls[0][0]).toBe('fetch');
  expect(calls[1].join(' ')).toContain('HEAD..origin/main');
});

test('up to date reports zero, not an error', async () => {
  const out = await checkForUpdates('/repo', { now: NOW, git: async () => '' });
  expect(out.available).toBe(0);
  expect(out.error).toBeUndefined();
});

test('OFFLINE: a failed fetch is silence, not an alarm', async () => {
  // An operator on a train must not see a red banner about their outreach tool. The dashboard
  // shows nothing when `available` is 0, and the reason is kept for the log only.
  const out = await checkForUpdates('/repo', {
    now: NOW,
    git: async () => { throw new Error('could not resolve host github.com'); },
  });

  expect(out.available).toBe(0);
  expect(out.changes).toEqual([]);
  expect(out.error).toContain('github.com');
});

test('it never throws, whatever git does', async () => {
  await expect(checkForUpdates('/repo', { now: NOW, git: async () => { throw 'a string, not an Error'; } }))
    .resolves.toMatchObject({ available: 0 });
});
