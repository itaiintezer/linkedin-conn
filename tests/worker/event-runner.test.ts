import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { FakeDriver } from '../../src/browser/driver.js';
import { createEventCampaign, armEventCampaign } from '../../src/worker/event-campaign.js';
import { runEventCampaign } from '../../src/worker/event-runner.js';

let repos: Repos;
let driver: FakeDriver;
beforeEach(() => {
  repos = new Repos(openDatabase(':memory:'));
  driver = new FakeDriver();
  driver.eventInfo = { title: 'Fake', startsAtText: 'Thu, Sep 10, 2026, 6:15 PM', attending: false, canAttend: true };
});

const EVENT = 'https://www.linkedin.com/events/7486088214579982336/';
const NOW = new Date('2026-08-03T10:00:00');

function conn(slug: string, o: { country?: string; cc?: string; region?: string | null } = {}): string {
  const url = `https://www.linkedin.com/in/${slug}`;
  const iso = NOW.toISOString();
  repos.db.prepare(`
    INSERT INTO connections
      (profile_url, linkedin_id, full_name, location_country, location_country_code,
       location_region, source, first_seen_at, last_seen_at, enrich_status)
    VALUES (?, ?, ?, ?, ?, ?, 'scrape', ?, ?, 'enriched')
  `).run(url, `ACoAA${slug}`, slug, o.country ?? 'Israel', o.cc ?? 'IL', o.region ?? null, iso, iso);
  return url;
}

function campaign(urls: string[]) {
  const r = createEventCampaign(repos, EVENT, urls) as { event: { id: number } };
  armEventCampaign(repos, r.event.id, NOW);
  return repos.eventCampaigns.findById(r.event.id)!;
}

test('attends before inviting, because the Invite menu item does not exist otherwise', async () => {
  const ev = campaign([conn('keren')]);
  driver.eventRowsByGeo.set('Israel', ['ACoAAkeren']);
  await runEventCampaign(repos, driver, ev, { clock: () => NOW });
  expect(repos.eventCampaigns.findById(ev.id)!.attended).toBe(1);
  expect(driver.invited).toEqual(['ACoAAkeren']);
});

test('every bucket request carries the event URL, the driver\'s hard reset', async () => {
  const ev = campaign([conn('keren')]);
  driver.eventRowsByGeo.set('Israel', ['ACoAAkeren']);
  await runEventCampaign(repos, driver, ev, { clock: () => NOW });
  expect(driver.bucketCalls.length).toBeGreaterThan(0);
  for (const call of driver.bucketCalls) expect(call.eventUrl).toBe(EVENT);
});

test('does not re-attend when already attending', async () => {
  driver.eventInfo = { title: 'Fake', startsAtText: null, attending: true, canAttend: false };
  const ev = campaign([conn('keren')]);
  driver.eventRowsByGeo.set('Israel', ['ACoAAkeren']);
  let attendCalls = 0;
  const orig = driver.attendEvent.bind(driver);
  driver.attendEvent = async () => { attendCalls++; return orig(); };
  await runEventCampaign(repos, driver, ev, { clock: () => NOW });
  expect(attendCalls).toBe(0);
  expect(repos.eventCampaigns.findById(ev.id)!.attended).toBe(1);
});

test('a dry run selects but never submits, and leaves everyone pending', async () => {
  const ev = campaign([conn('keren'), conn('or')]);
  driver.eventRowsByGeo.set('Israel', ['ACoAAkeren', 'ACoAAor']);
  const r = await runEventCampaign(repos, driver, ev, { mode: 'dry', clock: () => NOW });
  expect(driver.invited).toEqual([]);
  expect(r.invited).toBe(0);
  expect(repos.eventInvitees.countsByStatus(ev.id).pending).toBe(2);
  // A dry run must not advance the cursor either, or the real run would skip buckets.
  expect(repos.eventCampaigns.findById(ev.id)!.bucket_cursor).toBe(0);
});

test('stops at the lifetime cap and invites no more than it allows', async () => {
  const urls = Array.from({ length: 5 }, (_, i) => conn(`p${i}`));
  const ev = campaign(urls);
  repos.eventCampaigns.update(ev.id, { invite_cap: 2 });
  driver.eventRowsByGeo.set('Israel', urls.map((_, i) => `ACoAAp${i}`));
  const r = await runEventCampaign(repos, driver, { ...ev, invite_cap: 2 }, { clock: () => NOW });
  expect(r.invited).toBe(2);
  expect(repos.eventInvitees.invitedCount(ev.id)).toBe(2);
});

test('closes the campaign when the event has already started', async () => {
  const ev = campaign([conn('keren')]);
  driver.eventInfo = { title: 'Fake', startsAtText: 'Thu, Sep 10, 2020, 6:15 PM', attending: false, canAttend: true };
  const r = await runEventCampaign(repos, driver, ev, { clock: () => NOW });
  expect(r.outcome).toBe('event_started');
  const after = repos.eventCampaigns.findById(ev.id)!;
  expect(after.status).toBe('done');
  expect(repos.eventInvitees.countsByStatus(ev.id).unreachable).toBe(1);
  expect(driver.invited).toEqual([]);
});

test('a checkpoint trips the guardrail and halts the run', async () => {
  const ev = campaign([conn('keren')]);
  driver.openEventStatus = 'checkpoint';
  const r = await runEventCampaign(repos, driver, ev, { clock: () => NOW });
  expect(r.outcome).toBe('halted');
  expect(repos.appState.get().guardrail_tripped).toBe(1);
});

test('skips a bucket whose geo cannot be resolved, without inventing a near-match', async () => {
  const ev = campaign([conn('keren')]);
  // No geo registered at all -> the fake reports no_geo, as the real driver does when no
  // typeahead hit matches exactly.
  const r = await runEventCampaign(repos, driver, ev, { clock: () => NOW });
  expect(driver.invited).toEqual([]);
  expect(repos.eventBuckets.list(ev.id)[0]!.status).toBe('skipped');
  // The person stays reachable-in-principle; they are parked only once every bucket
  // has been tried, which is what happened here (one bucket).
  expect(r.outcome).not.toBe('failed');
});

test('advances the cursor so the next day resumes at the next bucket', async () => {
  const urls = [
    conn('uk0', { country: 'United Kingdom', cc: 'GB' }),
    conn('uk1', { country: 'United Kingdom', cc: 'GB' }),
    conn('il0'),
  ];
  const ev = campaign(urls);
  repos.eventCampaigns.update(ev.id, { bucket_ceiling: 1 });
  driver.eventRowsByGeo.set('United Kingdom', ['ACoAAuk0', 'ACoAAuk1']);
  driver.eventRowsByGeo.set('Israel', ['ACoAAil0']);

  const first = await runEventCampaign(
    repos, driver, { ...ev, bucket_ceiling: 1 }, { clock: () => NOW });
  expect(first.bucketsWorked).toBe(1);
  expect(driver.invited).toEqual(['ACoAAuk0', 'ACoAAuk1']);
  expect(repos.eventCampaigns.findById(ev.id)!.bucket_cursor).toBe(1);

  const mid = repos.eventCampaigns.findById(ev.id)!;
  expect(mid.status).toBe('armed'); // still work to do tomorrow

  await runEventCampaign(repos, driver, { ...mid, bucket_ceiling: 1 }, { clock: () => NOW });
  expect(driver.invited).toEqual(['ACoAAuk0', 'ACoAAuk1', 'ACoAAil0']);
  expect(repos.eventCampaigns.findById(ev.id)!.status).toBe('done');
});

test('ticks a pending person who surfaces in a bucket they were not assigned to', async () => {
  // Bucket membership ranks the work; it must not restrict who may be selected. A Tel
  // Aviv invitee appearing under the parent country pass should still be invited.
  const tlv = conn('tlv', { region: 'Tel Aviv District' });
  const bare = conn('bare');
  const ev = campaign([tlv, bare]);
  // One bucket ("Israel"), and the picker shows both people under it.
  driver.eventRowsByGeo.set('Israel', ['ACoAAtlv', 'ACoAAbare']);
  await runEventCampaign(repos, driver, ev, { clock: () => NOW });
  expect(driver.invited.sort()).toEqual(['ACoAAbare', 'ACoAAtlv']);
});

test('parks the remainder as unreachable once every bucket has been tried', async () => {
  const found = conn('found');
  const missing = conn('missing');
  const ev = campaign([found, missing]);
  driver.eventRowsByGeo.set('Israel', ['ACoAAfound']); // "missing" never appears
  await runEventCampaign(repos, driver, ev, { clock: () => NOW });
  const counts = repos.eventInvitees.countsByStatus(ev.id);
  expect(counts.invited).toBe(1);
  expect(counts.unreachable).toBe(1);
  expect(repos.eventCampaigns.findById(ev.id)!.status).toBe('done');
});

test('stops starting buckets past the deadline but finishes the one in flight', async () => {
  const urls = [
    conn('uk0', { country: 'United Kingdom', cc: 'GB' }),
    conn('il0'),
  ];
  const ev = campaign(urls);
  driver.eventRowsByGeo.set('United Kingdom', ['ACoAAuk0']);
  driver.eventRowsByGeo.set('Israel', ['ACoAAil0']);

  // Deadline already passed: not a single bucket may START.
  const r = await runEventCampaign(repos, driver, ev, {
    clock: () => NOW, deadline: new Date(NOW.getTime() - 1000),
  });
  expect(r.outcome).toBe('deadline');
  expect(r.bucketsWorked).toBe(0);
  expect(driver.invited).toEqual([]);
});

test('records live per-bucket progress', async () => {
  const ev = campaign([conn('keren')]);
  driver.eventRowsByGeo.set('Israel', ['ACoAAkeren']);
  driver.eventRowsLoaded.set('Israel', 840);
  await runEventCampaign(repos, driver, ev, { clock: () => NOW });
  const runs = repos.eventRuns.listForEvent(ev.id);
  const progress = repos.eventRuns.bucketProgress(runs[0]!.id);
  expect(progress).toHaveLength(1);
  expect(progress[0]!.rows_loaded).toBe(840);
  expect(progress[0]!.ticked).toBe(1);
  expect(progress[0]!.submitted).toBe(1);
});

test('releases the reserved window when the run ends', async () => {
  const ev = campaign([conn('keren')]);
  driver.eventRowsByGeo.set('Israel', ['ACoAAkeren']);
  repos.reservations.create(
    NOW.toISOString(), new Date(NOW.getTime() + 20 * 60 * 1000).toISOString(),
    'event_invite', ev.id);
  await runEventCampaign(repos, driver, ev, { clock: () => NOW });
  expect(repos.reservations.between(
    NOW.toISOString(), new Date(NOW.getTime() + 60 * 60 * 1000).toISOString())).toHaveLength(0);
});
