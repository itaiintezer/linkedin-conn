/**
 * Shared fixtures for building a runnable event campaign in tests.
 *
 * Extracted from tests/worker/run-now.test.ts (added there for Task 4's event-preflight
 * tests) because Task 5's `moveEventWindow` tests need the exact same minimum-runnable-state
 * setup. Parameterised on `repos`/`now` rather than closing over module-level state, so each
 * caller supplies its own in-memory `Repos` and clock — see tests/web/helpers/load-app.ts for
 * the house pattern this follows (a plain function returning/mutating against caller-owned
 * state, not a shared singleton).
 *
 * tests/worker/event-campaign.test.ts and tests/api/events.test.ts each keep their own local
 * `conn`/`armedCampaign`-shaped helpers (with extra options those suites need, e.g. country
 * overrides) rather than being migrated onto this one — deliberately out of scope for the
 * change that added this file. Only import this from new test files.
 */
import type { Repos } from '../../src/db/repositories.js';

/**
 * Seed an enriched roster row straight into the `connections` table, the same way
 * tests/worker/event-campaign.test.ts does — `connections.upsertMany` takes the CSV-import
 * shape, which carries no location columns at all, so it cannot build a bucketable row.
 */
export function conn(repos: Repos, slug: string): string {
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
export function armedCampaign(repos: Repos, now: Date): number {
  const url = conn(repos, 'ev-1');
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
  repos.eventCampaigns.update(ev.id, { status: 'armed', armed_at: now.toISOString() });
  return ev.id;
}
