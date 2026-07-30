import { test, expect } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { FakeDriver } from '../../src/browser/driver.js';
import { buildServer } from '../../src/api/server.js';
import { seedConnectionsFromProfiles } from '../../src/db/seed-connections.js';
import { Orchestrator } from '../../src/worker/orchestrator.js';
import { runAcceptanceCheck } from '../../src/worker/acceptance-checker.js';
import { runRosterSync } from '../../src/worker/roster-sync.js';

test('seed -> import -> sync builds one coherent roster, and acceptance is unaffected', async () => {
  const repos = new Repos(openDatabase(':memory:'));
  const driver = new FakeDriver();
  repos.appState.setLogin({ loggedIn: true, cookieExpiry: null }, '2026-07-31T00:00:00.000Z');
  const app = buildServer(repos, driver);

  // 1. Existing campaign data seeds the roster.
  const inv = repos.cohorts.create('inv', 'hi', true, 'invite');
  const accepted = repos.profiles.add(inv.id, 'https://www.linkedin.com/in/ada', null, 'invite');
  repos.profiles.setStatus(accepted.id, 'accepted', { accepted_at: '2026-05-04T09:00:00.000Z' });
  const pendingInvite = repos.profiles.add(inv.id, 'https://www.linkedin.com/in/pending', null, 'invite');
  repos.profiles.setStatus(pendingInvite.id, 'sent', { sent_at: '2026-07-01T00:00:00.000Z' });

  expect(seedConnectionsFromProfiles(repos, '2026-07-31T00:00:00.000Z')).toBe(1);

  // 2. A CSV import adds one more and enriches Ada's row with CSV detail.
  await app.inject({
    method: 'POST', url: '/api/connections/import',
    payload: {
      text: [
        'First Name,Last Name,URL,Company,Position,Connected On',
        'Ada,Lovelace,https://www.linkedin.com/in/ada,Analytical Engines,Mathematician,04 Mar 2024',
        'Grace,Hopper,https://www.linkedin.com/in/grace,US Navy,Rear Admiral,12 Dec 1985',
      ].join('\n'),
    },
  });
  expect(repos.connections.count()).toBe(2);
  const ada = repos.connections.findByUrl('https://www.linkedin.com/in/ada')!;
  expect(ada.current_title).toBe('Mathematician');
  expect(ada.connected_on).toBe('2026-05-04');   // the seed value wins — connected_on is immutable
  expect(ada.source).toBe('migration');          // first sighting wins

  // 3. Roster sync discovers a brand-new connection.
  driver.connectionCards = [
    { url: 'https://www.linkedin.com/in/ada', name: 'Ada Lovelace' },
    { url: 'https://www.linkedin.com/in/newperson', name: 'New Person' },
  ];
  await new Orchestrator(repos, driver).runRosterSyncTick(new Date(2026, 6, 31, 9, 0, 0));
  expect(repos.connections.count()).toBe(3);
  expect(repos.connections.findByUrl('https://www.linkedin.com/in/newperson')!.source).toBe('scrape');

  // 4. The invite pipeline is untouched: the pending invite is still pending. The roster
  //    growing must NOT promote it — acceptance still owns that verdict in phase 1.
  expect(repos.profiles.byStatus('sent').map((p) => p.id)).toEqual([pendingInvite.id]);
  expect(repos.profiles.byStatus('accepted').map((p) => p.id)).toEqual([accepted.id]);

  const stats = (await app.inject({ method: 'GET', url: '/api/connections/stats' })).json();
  expect(stats).toMatchObject({ total: 3, by_enrich_status: { pending: 3, enriched: 0 } });

  await app.close();
});

test('acceptance now resolves off the roster, with no browser involved', async () => {
  const repos = new Repos(openDatabase(':memory:'));
  const driver = new FakeDriver();
  repos.appState.setLogin({ loggedIn: true, cookieExpiry: null }, '2026-07-31T00:00:00.000Z');

  const inv = repos.cohorts.create('inv', 'hi', true, 'invite');
  const p = repos.profiles.add(inv.id, 'https://www.linkedin.com/in/ada', null, 'invite');
  repos.profiles.setStatus(p.id, 'sent', { sent_at: '2026-07-01T00:00:00.000Z' });

  // Roster sync is what learns about the connection...
  driver.connectionCards = [{ url: 'https://www.linkedin.com/in/ada', name: 'Ada Lovelace' }];
  await runRosterSync(repos, driver, new Date('2026-07-31T09:00:00.000Z'));

  // ...and acceptance reads it from the database, opening nothing.
  driver.open = false;
  await runAcceptanceCheck(repos, new Date('2026-07-31T12:00:00.000Z'));

  expect(repos.profiles.byStatus('accepted').map((x) => x.id)).toEqual([p.id]);
  expect(driver.open).toBe(false);
});
