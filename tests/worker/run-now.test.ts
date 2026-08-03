import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { parseBelt, weeklyRemaining, preflight } from '../../src/worker/run-now.js';
import { RESERVATION_PURPOSE } from '../../src/worker/event-campaign.js';

let repos: Repos;
const NOW = new Date('2026-08-04T10:00:00.000Z');

beforeEach(() => {
  repos = new Repos(openDatabase(':memory:'));
  repos.appState.setLogin({ loggedIn: true, cookieExpiry: null }, NOW.toISOString());
});

test('parseBelt accepts the four belts, defaults to all, rejects anything else', () => {
  expect(parseBelt('invite')).toBe('invite');
  expect(parseBelt('message')).toBe('message');
  expect(parseBelt('engagement')).toBe('engagement');
  expect(parseBelt('event')).toBe('event');
  expect(parseBelt('all')).toBe('all');
  expect(parseBelt(undefined)).toBe('all');
  expect(parseBelt(null)).toBe('all');
  expect(parseBelt('invites')).toBeNull();
  expect(parseBelt(7)).toBeNull();
});

test('weeklyRemaining reads each belt against its own cap', () => {
  repos.settings.update({ weekly_cap: 10, msg_weekly_cap: 20, engage_weekly_cap: 30 });
  expect(weeklyRemaining(repos, 'invite', NOW)).toBe(10);
  expect(weeklyRemaining(repos, 'message', NOW)).toBe(20);
  expect(weeklyRemaining(repos, 'engagement', NOW)).toBe(30);
});

test('weeklyRemaining subtracts what has already gone out this week', () => {
  repos.settings.update({ weekly_cap: 10, engage_weekly_cap: 30 });
  const c = repos.cohorts.create('C', null, true);
  const p = repos.profiles.add(c.id, 'https://www.linkedin.com/in/counted', null);
  repos.events.recordSend(p.id, 'sent', NOW.toISOString());
  expect(weeklyRemaining(repos, 'invite', NOW)).toBe(9);
  // Untouched by an invite send — proves per-belt capacity is actually per-belt.
  expect(weeklyRemaining(repos, 'message', NOW)).toBe(250);

  const e = repos.engagements.add('https://www.linkedin.com/posts/abc', 'urn:li:activity:1', 'like', null);
  repos.engagements.setStatus(e.id, 'sent', { reacted_at: NOW.toISOString() });
  expect(weeklyRemaining(repos, 'engagement', NOW)).toBe(29);
});

test('preflight refuses a paused engine and echoes the real pause reason', () => {
  repos.settings.update({ paused: 1, pause_reason: 'LinkedIn weekly invitation limit reached' });
  const r = preflight(repos, 'invite', NOW);
  expect(r?.code).toBe('paused');
  expect(r?.error).toContain('LinkedIn weekly invitation limit reached');
});

test('preflight refuses a tripped guardrail', () => {
  repos.appState.trip('repeated_failures', 'five in a row', NOW.toISOString());
  const r = preflight(repos, 'invite', NOW);
  expect(r?.code).toBe('guardrail');
  expect(r?.error).toContain('five in a row');
});

test('preflight refuses when logged out', () => {
  repos.appState.setLogin({ loggedIn: false, cookieExpiry: null }, NOW.toISOString());
  expect(preflight(repos, 'invite', NOW)?.code).toBe('not_logged_in');
});

test('preflight refuses a belt whose weekly cap is spent, naming the cap', () => {
  repos.settings.update({ weekly_cap: 1 });
  const c = repos.cohorts.create('C', null, true);
  const p = repos.profiles.add(c.id, 'https://www.linkedin.com/in/spent', null);
  repos.events.recordSend(p.id, 'sent');
  const r = preflight(repos, 'invite', NOW);
  expect(r?.code).toBe('capped');
  expect(r?.error).toContain('1/1 invites');
});

test('a spent invite cap does not refuse the message belt', () => {
  repos.settings.update({ weekly_cap: 1 });
  const c = repos.cohorts.create('C', null, true);
  const p = repos.profiles.add(c.id, 'https://www.linkedin.com/in/spent', null);
  repos.events.recordSend(p.id, 'sent');
  expect(preflight(repos, 'message', NOW)).toBeNull();
});

test('the all alias checks only the shared gates, not any belt cap', () => {
  repos.settings.update({ weekly_cap: 0 });
  expect(preflight(repos, 'all', NOW)).toBeNull();
});

/* ---------- event belt ---------- */

/**
 * Seed an enriched roster row straight into the table, the same way
 * tests/worker/event-campaign.test.ts does — `connections.upsertMany` takes the CSV-import
 * shape, which carries no location columns at all, so it cannot build a bucketable row.
 */
function conn(slug: string): string {
  const url = `https://www.linkedin.com/in/${slug}`;
  const nowIso = new Date().toISOString();
  repos.db.prepare(`
    INSERT INTO connections
      (profile_url, linkedin_id, full_name, location_country, location_country_code,
       location_region, source, first_seen_at, last_seen_at, enrich_status)
    VALUES (?, ?, ?, 'Israel', 'IL', NULL, 'scrape', ?, ?, 'enriched')
  `).run(url, `urn:li:member:${slug}`, slug, nowIso, nowIso);
  return url;
}

/** An armed campaign with one bucket and one pending invitee — the minimum runnable state. */
function armedCampaign(): number {
  const url = conn('ev-1');
  const row = repos.connections.findByUrl(url)!;
  const ev = repos.eventCampaigns.create('https://www.linkedin.com/events/7000000000000000000/', {
    eventUrn: '7000000000000000000', inviteCap: 100, bucketCeiling: 3,
  });
  repos.eventBuckets.replaceAll(ev.id, [{
    rank: 0,
    key: { kind: 'country', country: 'Israel' },
    label: 'Israel',
    geoLabel: 'Israel',
    geoCandidates: ['Israel'],
    kind: 'country',
    targetCount: 1,
    rosterCount: 1,
    parentIndex: null,
  }]);
  repos.eventInvitees.addMany(ev.id, [{
    profile_url: row.profile_url, connection_id: row.id,
    member_urn: row.linkedin_id, full_name: row.full_name,
  }]);
  repos.eventCampaigns.update(ev.id, { status: 'armed', armed_at: NOW.toISOString() });
  return ev.id;
}

test('event preflight refuses when nothing is armed', () => {
  expect(preflight(repos, 'event', NOW)?.code).toBe('nothing_armed');
});

// This test protects gate ORDER: with a live reservation AND a live event_runs row (the
// budget-spending signal), a preflight that checked the daily cap before the running check
// would misreport this as daily_cap instead of already_running.
test('event preflight refuses a campaign that is already running', () => {
  const id = armedCampaign();
  repos.eventCampaigns.update(id, { status: 'running' });
  // `nextEventRun` only returns a running campaign when it holds a live reservation —
  // otherwise it falls back to `byStatus('armed')`, which a running campaign no longer
  // matches, and the preflight would see nothing_armed instead.
  repos.reservations.create(
    NOW.toISOString(), new Date(NOW.getTime() + 20 * 60_000).toISOString(),
    RESERVATION_PURPOSE, id,
  );
  // A campaign that is actually running got there via a live event_runs row started today —
  // which alone would spend the (default 1/day) budget. Recording it here is what makes this
  // test actually exercise the stated ordering (running-check before daily-cap-check): a
  // preflight that checked the cap first would misreport this as daily_cap, not already_running.
  const run = repos.eventRuns.start(id, 'live', null);
  repos.db.prepare('UPDATE event_runs SET started_at = ? WHERE id = ?').run(NOW.toISOString(), run.id);
  expect(preflight(repos, 'event', NOW)?.code).toBe('already_running');
});

// This test protects a DIFFERENT property: running-detection must not depend on a live
// reservation at all. event-runner.ts documents that a run is expected to overrun its
// reserved window by up to one bucket's worth of work — the campaign is still `running` in
// the DB, but its reservation has already expired (to_ts <= now). `nextEventRun` alone would
// no longer surface it (falls through to byStatus('armed'), which excludes a running
// campaign), so the preflight must check `status = 'running'` independently of any
// reservation.
test('a run that overran its reserved window is still detected as running', () => {
  const id = armedCampaign();
  repos.eventCampaigns.update(id, { status: 'running' });
  // Reservation already closed — exactly the overrun case event-runner.ts anticipates.
  repos.reservations.clearFor(RESERVATION_PURPOSE, id);
  expect(preflight(repos, 'event', NOW)?.code).toBe('already_running');
});

test('event preflight refuses once the day s run budget is spent', () => {
  const id = armedCampaign();
  repos.settings.update({ events_per_day: 1 });
  const run = repos.eventRuns.start(id, 'live', null);
  // `start()` stamps `started_at` via SQLite's own `datetime('now')` — the real wall clock,
  // not this test's fixed NOW — so `countRunsOnDate(NOW)` would miss it whenever the test
  // happens to run on a different UTC calendar date than NOW. Pin it explicitly instead.
  repos.db.prepare('UPDATE event_runs SET started_at = ? WHERE id = ?').run(NOW.toISOString(), run.id);
  repos.eventRuns.finish(run.id, 'complete', 1, NOW.toISOString());
  const r = preflight(repos, 'event', NOW);
  expect(r?.code).toBe('daily_cap');
  expect(r?.error).toContain('1/1');
});

test('event preflight passes for a fresh armed campaign', () => {
  armedCampaign();
  expect(preflight(repos, 'event', NOW)).toBeNull();
});
