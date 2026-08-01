import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import {
  armEventCampaign, createEventCampaign, dueEventRun, ensureEventReservation,
} from '../../src/worker/event-campaign.js';

let repos: Repos;
beforeEach(() => { repos = new Repos(openDatabase(':memory:')); });

const EVENT = 'https://www.linkedin.com/events/7486088214579982336/';

/**
 * Seed an enriched roster row. Written straight to the table rather than through
 * `connections.upsert`, whose input shape is the CSV export — it carries no location
 * columns at all, since locations only ever arrive via enrichment.
 */
function conn(slug: string, o: {
  country?: string | null; cc?: string | null; region?: string | null; urn?: string | null;
} = {}): string {
  const url = `https://www.linkedin.com/in/${slug}`;
  const nowIso = new Date().toISOString();
  repos.db.prepare(`
    INSERT INTO connections
      (profile_url, linkedin_id, full_name, location_country, location_country_code,
       location_region, source, first_seen_at, last_seen_at, enrich_status)
    VALUES (?, ?, ?, ?, ?, ?, 'scrape', ?, ?, 'enriched')
  `).run(
    url, o.urn ?? `ACoAA${slug}`, slug,
    o.country === undefined ? 'Israel' : o.country,
    o.cc === undefined ? 'IL' : o.cc,
    o.region ?? null, nowIso, nowIso,
  );
  return url;
}

test('rejects a url that is not a LinkedIn event', () => {
  const r = createEventCampaign(repos, 'https://www.linkedin.com/in/someone', []);
  expect(r).toHaveProperty('error');
});

test('names the URLs that are not connections instead of failing mid-run', () => {
  const known = conn('keren');
  const r = createEventCampaign(repos, EVENT, [
    known,
    'https://www.linkedin.com/in/a-stranger',
    'not a url at all',
  ]) as { added: number; rejected: { url: string; reason: string }[] };
  expect(r.added).toBe(1);
  expect(r.rejected).toEqual(expect.arrayContaining([
    { url: 'https://www.linkedin.com/in/a-stranger', reason: 'not_a_connection' },
    { url: 'not a url at all', reason: 'invalid_url' },
  ]));
});

test('stores unbucketable people as unreachable rather than dropping them silently', () => {
  const ok = conn('keren');
  const noCountry = conn('nowhere', { country: null, cc: null });
  const usNoState = conn('yank', { country: 'United States of America', cc: 'US' });
  const r = createEventCampaign(repos, EVENT, [ok, noCountry, usNoState]) as { event: { id: number } };
  const counts = repos.eventInvitees.countsByStatus(r.event.id);
  expect(counts.pending).toBe(1);
  expect(counts.unreachable).toBe(2);
  const notes = repos.eventInvitees.list(r.event.id)
    .filter((i) => i.status === 'unreachable').map((i) => i.note).sort();
  expect(notes).toEqual(['no_country', 'us_without_state']);
});

test('deduplicates the input list', () => {
  const u = conn('keren');
  const r = createEventCampaign(repos, EVENT, [u, u, `${u}/`]) as { added: number };
  expect(r.added).toBe(1);
});

test('refuses a second campaign for the same event', () => {
  conn('keren');
  createEventCampaign(repos, EVENT, []);
  expect(createEventCampaign(repos, EVENT, [])).toHaveProperty('error');
});

test('ranks buckets by invitee density and persists them', () => {
  const urls = [
    ...Array.from({ length: 2 }, (_, i) => conn(`il${i}`)),
    ...Array.from({ length: 5 }, (_, i) => conn(`uk${i}`, { country: 'United Kingdom', cc: 'GB' })),
  ];
  const r = createEventCampaign(repos, EVENT, urls) as { event: { id: number } };
  const buckets = repos.eventBuckets.list(r.event.id);
  expect(buckets.map((b) => [b.label, b.target_count]))
    .toEqual([['United Kingdom', 5], ['Israel', 2]]);
  expect(buckets[0]!.geo_label).toBe('United Kingdom');
});

test('arming requires a draft with reachable invitees', () => {
  const bad = conn('nowhere', { country: null, cc: null });
  const r = createEventCampaign(repos, EVENT, [bad]) as { event: { id: number } };
  const armed = armEventCampaign(repos, r.event.id, new Date());
  expect(armed).toEqual({ ok: false, error: expect.stringContaining('no location buckets') });
});

test('arming refuses an event that already started', () => {
  const r = createEventCampaign(repos, EVENT, [conn('keren')]) as { event: { id: number } };
  repos.eventCampaigns.update(r.event.id, { starts_at: new Date('2020-01-01T00:00:00').toISOString() });
  expect(armEventCampaign(repos, r.event.id, new Date())).toEqual(
    { ok: false, error: 'the event has already started' });
});

test('arming twice is refused', () => {
  const r = createEventCampaign(repos, EVENT, [conn('keren')]) as { event: { id: number } };
  const now = new Date('2026-08-03T09:00:00');
  expect(armEventCampaign(repos, r.event.id, now)).toEqual({ ok: true });
  expect(armEventCampaign(repos, r.event.id, now)).toEqual(
    { ok: false, error: 'campaign is armed, not draft' });
});

test('reserves a window for an armed campaign, and only one per day', () => {
  const r = createEventCampaign(repos, EVENT, [conn('keren')]) as { event: { id: number } };
  const now = new Date('2026-08-03T09:00:00'); // Monday
  armEventCampaign(repos, r.event.id, now);

  ensureEventReservation(repos, now);
  const held = repos.reservations.between(now.toISOString(), new Date('2026-08-04T00:00:00').toISOString());
  expect(held).toHaveLength(1);
  expect(new Date(held[0]!.to_ts).getTime() - new Date(held[0]!.from_ts).getTime())
    .toBe(20 * 60 * 1000);

  ensureEventReservation(repos, now); // idempotent
  expect(repos.reservations.between(now.toISOString(), new Date('2026-08-04T00:00:00').toISOString()))
    .toHaveLength(1);
});

test('does not reserve while paused', () => {
  const r = createEventCampaign(repos, EVENT, [conn('keren')]) as { event: { id: number } };
  const now = new Date('2026-08-03T09:00:00');
  armEventCampaign(repos, r.event.id, now);
  repos.settings.update({ paused: 1 });
  ensureEventReservation(repos, now);
  expect(repos.reservations.between(now.toISOString(), new Date('2026-08-04T00:00:00').toISOString()))
    .toHaveLength(0);
});

test('does not reserve outside working hours or at the weekend', () => {
  const r = createEventCampaign(repos, EVENT, [conn('keren')]) as { event: { id: number } };
  armEventCampaign(repos, r.event.id, new Date('2026-08-03T09:00:00'));
  ensureEventReservation(repos, new Date('2026-08-03T23:00:00')); // after hours
  ensureEventReservation(repos, new Date('2026-08-02T10:00:00')); // Sunday
  expect(repos.reservations.between(
    new Date('2026-08-01T00:00:00').toISOString(),
    new Date('2026-08-05T00:00:00').toISOString())).toHaveLength(0);
});

test('dueEventRun fires only inside the reserved window', () => {
  const r = createEventCampaign(repos, EVENT, [conn('keren')]) as { event: { id: number } };
  const now = new Date('2026-08-03T09:00:00');
  armEventCampaign(repos, r.event.id, now);
  ensureEventReservation(repos, now);
  const held = repos.reservations.between(now.toISOString(), new Date('2026-08-04T00:00:00').toISOString())[0]!;

  expect(dueEventRun(repos, new Date(new Date(held.from_ts).getTime() - 60_000))).toBeNull();
  expect(dueEventRun(repos, new Date(held.from_ts))?.event.id).toBe(r.event.id);
  expect(dueEventRun(repos, new Date(held.to_ts))).toBeNull();
});

test('a reserved window is not handed to a campaign that is no longer armed', () => {
  const r = createEventCampaign(repos, EVENT, [conn('keren')]) as { event: { id: number } };
  const now = new Date('2026-08-03T09:00:00');
  armEventCampaign(repos, r.event.id, now);
  ensureEventReservation(repos, now);
  const held = repos.reservations.between(now.toISOString(), new Date('2026-08-04T00:00:00').toISOString())[0]!;
  repos.eventCampaigns.close(r.event.id, 'stopped', 'operator', now.toISOString());
  expect(dueEventRun(repos, new Date(held.from_ts))).toBeNull();
});
