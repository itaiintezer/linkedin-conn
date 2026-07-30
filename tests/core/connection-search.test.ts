/**
 * Search semantics. The driving use case is an AI agent asking for
 * "Seattle connections who are security practitioners" — it fans that concept out into many
 * title keywords and expects OR-within / AND-across, plus a way to strip the physical-security
 * noise that any "security" query drags in.
 */
import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { searchConnections, ftsOrGroup } from '../../src/core/connection-search.js';
import type { EnrichedProfile } from '../../src/types.js';

let repos: Repos;
beforeEach(() => { repos = new Repos(openDatabase(':memory:')); });

interface PersonSpec {
  slug: string; name: string; title: string; company: string; headline?: string;
  city?: string; region?: string; country?: string; code?: string;
  about?: string; pastTitle?: string; pastCompany?: string; skills?: string[];
}

function person(s: PersonSpec): void {
  const url = `https://www.linkedin.com/in/${s.slug}`;
  repos.connections.upsert({ profile_url: url }, 'csv', '2026-07-01T00:00:00.000Z');
  const [row] = repos.connections.claimForEnrichment(1);
  const doc = [
    s.name, s.headline ?? s.title, s.about ?? '', s.city ?? '', s.region ?? '', s.country ?? '',
    s.title, s.company, s.pastTitle ?? '', s.pastCompany ?? '', ...(s.skills ?? []),
  ].filter(Boolean).join('\n');
  const p: EnrichedProfile = {
    linkedin_id: `ACoAA-${s.slug}`, public_identifier: s.slug, full_name: s.name,
    first_name: s.name.split(' ')[0], last_name: s.name.split(' ')[1] ?? null,
    headline: s.headline ?? s.title,
    location_raw: [s.city, s.region, s.country].filter(Boolean).join(', ') || null,
    location_city: s.city ?? null, location_region: s.region ?? null,
    location_country: s.country ?? null, location_country_code: s.code ?? null,
    current_title: s.title, current_company: s.company,
    compact: {}, doc,
  };
  repos.connections.applyEnrichment(row.id, p, '2026-07-30T00:00:00.000Z');
}

/** A small but realistic network: security people, noise, and other cities. */
function seedNetwork(): void {
  person({ slug: 'a', name: 'Ada Sec', title: 'Chief Information Security Officer', company: 'Amazon', city: 'Seattle', region: 'Washington', country: 'United States', code: 'US' });
  person({ slug: 'b', name: 'Bob Soc', title: 'SOC Analyst', company: 'Expedia', city: 'Bellevue', region: 'Washington', country: 'United States', code: 'US' });
  person({ slug: 'c', name: 'Cara Guard', title: 'Physical Security Manager', company: 'Boeing', city: 'Seattle', region: 'Washington', country: 'United States', code: 'US' });
  person({ slug: 'd', name: 'Dan Dev', title: 'Backend Engineer', company: 'Zillow', city: 'Seattle', region: 'Washington', country: 'United States', code: 'US' });
  person({ slug: 'e', name: 'Eve Ciso', title: 'CISO', company: 'Barclays', city: 'London', region: 'England', country: 'United Kingdom', code: 'GB' });
  person({
    slug: 'f', name: 'Fay Past', title: 'VP Engineering', company: 'Stripe',
    city: 'Seattle', region: 'Washington', country: 'United States', code: 'US',
    pastTitle: 'Head of Security', pastCompany: 'Microsoft',
  });
}

test('the flagship query: Seattle-area security practitioners, minus the physical-security noise', () => {
  seedNetwork();

  const r = searchConnections(repos.db, {
    title_any: ['CISO', 'Chief Information Security', 'SOC', 'security engineer', 'appsec'],
    location_any: ['Seattle', 'Bellevue'],
    exclude_any: ['physical security'],
  });

  const names = r.results.map((x) => x.full_name).sort();
  expect(names).toEqual(['Ada Sec', 'Bob Soc']);
  // Cara is in Seattle and her title says "Security" — excluded by document match.
  // Dan is in Seattle but not security. Eve is security but in London.
  expect(r.total).toBe(2);
});

test('OR within a field, AND across fields', () => {
  seedNetwork();
  // OR within: Eve's title is "CISO", Bob's is "SOC Analyst" — both match the group.
  expect(searchConnections(repos.db, { title_any: ['CISO', 'SOC Analyst'] }).total).toBe(2);
  // AND across: adding a location narrows the same group to Bellevue only.
  expect(searchConnections(repos.db, { title_any: ['CISO', 'SOC Analyst'], location_any: ['Bellevue'] }).total).toBe(1);
});

test('matching is substring-based, so a spelled-out title needs a spelled-out term', () => {
  seedNetwork();
  // Ada's title is "Chief Information Security Officer" — the acronym is NOT a substring of
  // it. This is exactly why the API asks the caller to supply several title keywords.
  expect(searchConnections(repos.db, { title_any: ['CISO'] }).results.map((r) => r.full_name)).toEqual(['Eve Ciso']);
  expect(searchConnections(repos.db, { title_any: ['Chief Information Security'] }).results.map((r) => r.full_name)).toEqual(['Ada Sec']);
});

test('location matches city, region, country or ISO code', () => {
  seedNetwork();
  expect(searchConnections(repos.db, { location_any: ['Washington'] }).total).toBe(5);
  expect(searchConnections(repos.db, { location_any: ['GB'] }).total).toBe(1);
  expect(searchConnections(repos.db, { location_any: ['United Kingdom'] }).total).toBe(1);
});

test('past roles are excluded by default and included on request', () => {
  seedNetwork();
  // Fay is now a VP of Engineering; she ran security at Microsoft years ago.
  expect(searchConnections(repos.db, { title_any: ['Head of Security'] }).total).toBe(0);

  const widened = searchConnections(repos.db, { title_any: ['Head of Security'], include_past_roles: true });
  expect(widened.results.map((x) => x.full_name)).toEqual(['Fay Past']);
});

test('company search, current and historical', () => {
  seedNetwork();
  expect(searchConnections(repos.db, { company_any: ['Amazon'] }).total).toBe(1);
  expect(searchConnections(repos.db, { company_any: ['Microsoft'] }).total).toBe(0);
  expect(searchConnections(repos.db, { company_any: ['Microsoft'], include_past_roles: true }).total).toBe(1);
});

test('free-text q searches the whole document', () => {
  person({ slug: 'k', name: 'Kay Cert', title: 'Security Architect', company: 'Acme', skills: ['CISSP', 'Kubernetes'] });
  expect(searchConnections(repos.db, { q: 'CISSP' }).total).toBe(1);
  expect(searchConnections(repos.db, { q: 'Terraform' }).total).toBe(0);
});

test('matched evidence says which supplied term hit which field', () => {
  seedNetwork();
  const r = searchConnections(repos.db, {
    title_any: ['Chief Information Security', 'SOC'], location_any: ['Seattle', 'Bellevue'],
  });

  const ada = r.results.find((x) => x.full_name === 'Ada Sec')!;
  expect(ada.matched.title_any).toEqual(['Chief Information Security']);
  expect(ada.matched.location_any).toEqual(['Seattle']);

  const bob = r.results.find((x) => x.full_name === 'Bob Soc')!;
  expect(bob.matched.title_any).toEqual(['SOC']);
  expect(bob.matched.location_any).toEqual(['Bellevue']);
});

test('un-enriched connections are never returned, but are reported in coverage', () => {
  seedNetwork();
  repos.connections.upsert({ profile_url: 'https://www.linkedin.com/in/unenriched', full_name: 'Nobody Yet' }, 'csv', '2026-07-01T00:00:00.000Z');

  const r = searchConnections(repos.db, {});
  expect(r.total).toBe(6);
  expect(r.coverage).toEqual({ total: 7, enriched: 6, pending: 1, unresolvable: 0 });
});

test('coverage separates pending from unresolvable so a caller can tell why a set is thin', () => {
  person({ slug: 'a', name: 'Ada', title: 'CISO', company: 'Acme' });
  repos.connections.upsert({ profile_url: 'https://www.linkedin.com/in/p1' }, 'csv', '2026-07-01T00:00:00.000Z');
  repos.connections.upsert({ profile_url: 'https://www.linkedin.com/in/p2' }, 'csv', '2026-07-01T00:00:00.000Z');
  const rows = repos.connections.claimForEnrichment(2);
  repos.connections.markEnrichFailure(rows[0].id, 'boom', 1);
  repos.connections.markEnrichEmpty(rows[1].id);

  expect(searchConnections(repos.db, {}).coverage).toEqual({ total: 3, enriched: 1, pending: 0, unresolvable: 2 });
});

test('paginates and reports the unpaginated total', () => {
  seedNetwork();
  const page = searchConnections(repos.db, { location_any: ['Washington'], limit: 2, offset: 2 });
  expect(page.results).toHaveLength(2);
  expect(page.total).toBe(5);
  expect(page.limit).toBe(2);
});

test('limit is clamped so a caller cannot pull the whole roster into context', () => {
  seedNetwork();
  expect(searchConnections(repos.db, { limit: 99999 }).limit).toBe(200);
  expect(searchConnections(repos.db, { limit: 0 }).limit).toBe(25);
});

test('an empty query returns the enriched roster rather than erroring', () => {
  seedNetwork();
  expect(searchConnections(repos.db, {}).total).toBe(6);
});

test('search terms are matched literally, not executed as FTS syntax', () => {
  person({ slug: 'a', name: 'Ada', title: 'CISO', company: 'Acme' });
  // A term full of FTS operators must not blow up the query or match everything.
  expect(() => searchConnections(repos.db, { exclude_any: ['NOT OR AND *'] })).not.toThrow();
  expect(() => searchConnections(repos.db, { title_any: ['a"b'], include_past_roles: true })).not.toThrow();
  expect(searchConnections(repos.db, { title_any: ['100%'] }).total).toBe(0); // LIKE wildcard escaped
});

test('ftsOrGroup quotes phrases and drops blanks', () => {
  expect(ftsOrGroup(['security engineer', 'CISO'])).toBe('("security engineer" OR "CISO")');
  expect(ftsOrGroup(['  ', ''])).toBeNull();
  expect(ftsOrGroup(['say "hi"'])).toBe('("say ""hi""")');
});
