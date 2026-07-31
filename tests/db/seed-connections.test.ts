import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { seedConnectionsFromProfiles } from '../../src/db/seed-connections.js';

let repos: Repos;
const NOW = '2026-07-31T12:00:00.000Z';
beforeEach(() => { repos = new Repos(openDatabase(':memory:')); });

test('seeds accepted, replied, and successfully-messaged profiles — and nothing else', () => {
  const inv = repos.cohorts.create('inv', 'hi', true, 'invite');
  const msg = repos.cohorts.create('msg', 'hello', false, 'message');

  const accepted = repos.profiles.add(inv.id, 'https://www.linkedin.com/in/accepted', null, 'invite');
  repos.profiles.setStatus(accepted.id, 'accepted', { accepted_at: '2026-05-04T09:00:00.000Z' });

  const messaged = repos.profiles.add(msg.id, 'https://www.linkedin.com/in/messaged', null, 'message');
  repos.profiles.setStatus(messaged.id, 'sent', { sent_at: '2026-06-01T00:00:00.000Z' });

  // A SENT INVITE is a pending request, not a connection — must not be seeded.
  const pending = repos.profiles.add(inv.id, 'https://www.linkedin.com/in/pending', null, 'invite');
  repos.profiles.setStatus(pending.id, 'sent', { sent_at: '2026-06-01T00:00:00.000Z' });

  repos.profiles.add(inv.id, 'https://www.linkedin.com/in/queued', null, 'invite');

  const n = seedConnectionsFromProfiles(repos, NOW);

  expect(n).toBe(2);
  const urls = repos.connections.list(50, 0).map((c) => c.profile_url).sort();
  expect(urls).toEqual([
    'https://www.linkedin.com/in/accepted',
    'https://www.linkedin.com/in/messaged',
  ]);
});

test('uses accepted_at as connected_on, and leaves it null when unknown', () => {
  const inv = repos.cohorts.create('inv', 'hi', true, 'invite');
  const msg = repos.cohorts.create('msg', 'hello', false, 'message');

  const a = repos.profiles.add(inv.id, 'https://www.linkedin.com/in/a', null, 'invite');
  repos.profiles.setStatus(a.id, 'accepted', { accepted_at: '2026-05-04T09:00:00.000Z', full_name: 'Ada L' });
  const b = repos.profiles.add(msg.id, 'https://www.linkedin.com/in/b', null, 'message');
  repos.profiles.setStatus(b.id, 'sent', { sent_at: '2026-06-01T00:00:00.000Z' });

  seedConnectionsFromProfiles(repos, NOW);

  expect(repos.connections.findByUrl('https://www.linkedin.com/in/a')!.connected_on).toBe('2026-05-04');
  expect(repos.connections.findByUrl('https://www.linkedin.com/in/a')!.full_name).toBe('Ada L');
  expect(repos.connections.findByUrl('https://www.linkedin.com/in/b')!.connected_on).toBeNull();
  expect(repos.connections.findByUrl('https://www.linkedin.com/in/b')!.source).toBe('migration');
});

test('collapses a person who appears in both an invite and a message cohort into one row', () => {
  const inv = repos.cohorts.create('inv', 'hi', true, 'invite');
  const msg = repos.cohorts.create('msg', 'hello', false, 'message');
  const url = 'https://www.linkedin.com/in/dup';

  const a = repos.profiles.add(inv.id, url, null, 'invite');
  repos.profiles.setStatus(a.id, 'accepted', { accepted_at: '2026-05-04T09:00:00.000Z' });
  const b = repos.profiles.add(msg.id, url, null, 'message');
  repos.profiles.setStatus(b.id, 'replied', { replied_at: '2026-06-10T00:00:00.000Z', full_name: 'Dup Person' });

  expect(seedConnectionsFromProfiles(repos, NOW)).toBe(1);
  const c = repos.connections.findByUrl(url)!;
  expect(c.connected_on).toBe('2026-05-04');
  expect(c.full_name).toBe('Dup Person');
});

test('is a one-shot: a second call seeds nothing and the stamp is recorded', () => {
  const inv = repos.cohorts.create('inv', 'hi', true, 'invite');
  const a = repos.profiles.add(inv.id, 'https://www.linkedin.com/in/a', null, 'invite');
  repos.profiles.setStatus(a.id, 'accepted', { accepted_at: '2026-05-04T09:00:00.000Z' });

  expect(seedConnectionsFromProfiles(repos, NOW)).toBe(1);
  expect(repos.appState.get().connections_seeded_at).toBe(NOW);
  expect(seedConnectionsFromProfiles(repos, '2026-08-01T00:00:00.000Z')).toBe(0);
  expect(repos.appState.get().connections_seeded_at).toBe(NOW);
});

test('never overwrites a connection that already exists from an import', () => {
  const inv = repos.cohorts.create('inv', 'hi', true, 'invite');
  const url = 'https://www.linkedin.com/in/a';
  repos.connections.upsert({ profile_url: url, full_name: 'From CSV', connected_on: '2020-01-01' }, 'csv', NOW);
  const a = repos.profiles.add(inv.id, url, null, 'invite');
  repos.profiles.setStatus(a.id, 'accepted', { accepted_at: '2026-05-04T09:00:00.000Z', full_name: 'From Profiles' });

  seedConnectionsFromProfiles(repos, NOW);

  const c = repos.connections.findByUrl(url)!;
  expect(c.full_name).toBe('From CSV');
  expect(c.connected_on).toBe('2020-01-01');
  expect(c.source).toBe('csv');
});

test('an empty profiles table seeds nothing but still stamps, so it never re-runs', () => {
  expect(seedConnectionsFromProfiles(repos, NOW)).toBe(0);
  expect(repos.appState.get().connections_seeded_at).toBe(NOW);
});

test('names the seed carries over from campaign history end up sanitised', () => {
  // The seed is a raw INSERT…SELECT: it copies profiles.first_name straight across, so it is
  // the one write path that does NOT go through ConnectionRepo.upsert. What saves it is that
  // src/index.ts runs the backfill immediately afterwards. That ordering is load-bearing and
  // invisible — reorder those two calls and dirty names reappear with no test failing.
  const c = repos.cohorts.create('msg', 'hi', false, 'message');
  const p = repos.profiles.add(c.id, 'https://www.linkedin.com/in/chid', null, 'message');
  repos.profiles.setStatus(p.id, 'sent', {
    sent_at: NOW, full_name: 'Dr. Chidhanandham Arunachalam', first_name: 'Dr. Chidhanandham',
  });

  expect(seedConnectionsFromProfiles(repos, NOW)).toBe(1);
  // Straight after the seed the roster still holds the raw fragment…
  expect(repos.connections.findByUrl('https://www.linkedin.com/in/chid')!.first_name).toBe('Dr. Chidhanandham');
  // …and the backfill, which index.ts runs next, is what makes it sendable.
  expect(repos.connections.backfillFirstNames()).toBe(1);
  expect(repos.connections.findByUrl('https://www.linkedin.com/in/chid')!.first_name).toBe('Chidhanandham');
});
