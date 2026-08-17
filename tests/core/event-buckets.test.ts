import { describe, it, expect } from 'vitest';
import {
  bucketKeyFor, buildBuckets, displayLabelFor, geoCandidatesFor, keyId, selectionDiff,
  typeaheadQueryFor,
  type LocatedRow,
} from '../../src/core/event-buckets.js';

const row = (o: Partial<LocatedRow> & { profile_url: string }): LocatedRow => ({
  location_country: null, location_country_code: null, location_region: null, ...o,
});

const noRoster = { rosterCounts: new Map<string, number>(), childRegions: new Map<string, { region: string; count: number }[]>() };

describe('bucketKeyFor', () => {
  it('buckets a US row by state, never by country', () => {
    expect(bucketKeyFor(row({
      profile_url: 'a', location_country: 'United States of America',
      location_country_code: 'US', location_region: 'California',
    }))).toEqual({ kind: 'us_state', region: 'California' });
  });

  it('reports a US row with no state as unreachable rather than falling back to the country', () => {
    // A country-wide United States filter is 3x the 1000-row cap, so falling back would
    // burn a bucket to surface an arbitrary third of the US roster.
    expect(bucketKeyFor(row({
      profile_url: 'a', location_country: 'United States of America', location_country_code: 'US',
    }))).toBe('us_without_state');
  });

  it('buckets a non-US row by country', () => {
    expect(bucketKeyFor(row({
      profile_url: 'a', location_country: 'Israel', location_country_code: 'IL',
    }))).toEqual({ kind: 'country', country: 'Israel' });
  });

  it('reports a row with no country as unreachable', () => {
    expect(bucketKeyFor(row({ profile_url: 'a' }))).toBe('no_country');
    expect(bucketKeyFor(row({ profile_url: 'a', location_country: '   ' }))).toBe('no_country');
  });
});

describe('geoCandidatesFor', () => {
  it('qualifies a US state so exact matching cannot pick the country of the same name', () => {
    // Live-verified: typing "Georgia" ranks the COUNTRY Georgia first and
    // "Georgia, United States" second. Only the qualified form is safe.
    expect(geoCandidatesFor({ kind: 'us_state', region: 'Georgia' }))
      .toEqual(['Georgia, United States']);
  });

  it('passes a country through when LinkedIn uses the same name', () => {
    expect(geoCandidatesFor({ kind: 'country', country: 'Israel' })).toEqual(['Israel']);
  });

  it('tries the LinkedIn alias first but keeps the raw name as a fallback', () => {
    expect(geoCandidatesFor({ kind: 'country', country: 'Russian Federation' }))
      .toEqual(['Russia', 'Russian Federation']);
  });

  it('builds a region label against the aliased country', () => {
    expect(geoCandidatesFor({ kind: 'region', country: 'Israel', region: 'Tel Aviv District' }))
      .toEqual(['Tel Aviv District, Israel']);
  });
});

describe('typeaheadQueryFor', () => {
  it('types only the leading segment, which is safer for typeahead latency', () => {
    expect(typeaheadQueryFor('California, United States')).toBe('California');
    expect(typeaheadQueryFor('Israel')).toBe('Israel');
  });
});

describe('selectionDiff', () => {
  it('agrees when the page shows exactly the ticked people', () => {
    expect(selectionDiff(['ACoAAa', 'ACoAAb'], ['ACoAAb', 'ACoAAa']))
      .toEqual({ missing: [], extra: [] });
  });

  it('collapses duplicate page rows — the picker serves the same person twice', () => {
    expect(selectionDiff(['ACoAAa', 'ACoAAb'], ['ACoAAa', 'ACoAAa', 'ACoAAb']))
      .toEqual({ missing: [], extra: [] });
  });

  it('names who is missing and who is extra', () => {
    expect(selectionDiff(['ACoAAa', 'ACoAAb'], ['ACoAAb', 'ACoAAc']))
      .toEqual({ missing: ['ACoAAa'], extra: ['ACoAAc'] });
  });

  it('an empty page selection is all-missing, not a crash', () => {
    expect(selectionDiff(['ACoAAa'], [])).toEqual({ missing: ['ACoAAa'], extra: [] });
    expect(selectionDiff([], [])).toEqual({ missing: [], extra: [] });
  });
});

describe('buildBuckets', () => {
  it('ranks buckets by invitee density, not by roster size', () => {
    const invitees = [
      ...Array.from({ length: 3 }, (_, i) => row({ profile_url: `il${i}`, location_country: 'Israel', location_country_code: 'IL' })),
      ...Array.from({ length: 7 }, (_, i) => row({ profile_url: `uk${i}`, location_country: 'United Kingdom', location_country_code: 'GB' })),
    ];
    // Israel has a far bigger roster, but fewer of THIS list's people.
    const rosterCounts = new Map([['country:Israel', 2017], ['country:United Kingdom', 365]]);
    const { buckets } = buildBuckets(invitees, { ...noRoster, rosterCounts });
    expect(buckets.map((b) => [b.label, b.targetCount])).toEqual([
      ['United Kingdom', 7], ['Israel', 3],
    ]);
  });

  it('breaks a tie toward the cheaper bucket', () => {
    const invitees = [
      row({ profile_url: 'a', location_country: 'Israel', location_country_code: 'IL' }),
      row({ profile_url: 'b', location_country: 'Ireland', location_country_code: 'IE' }),
    ];
    const rosterCounts = new Map([['country:Israel', 2017], ['country:Ireland', 36]]);
    const { buckets } = buildBuckets(invitees, { ...noRoster, rosterCounts });
    expect(buckets.map((b) => b.label)).toEqual(['Ireland', 'Israel']);
  });

  it('collects unreachable rows with a reason instead of silently dropping them', () => {
    const invitees = [
      row({ profile_url: 'ok', location_country: 'Israel', location_country_code: 'IL' }),
      row({ profile_url: 'nocountry' }),
      row({ profile_url: 'usnostate', location_country: 'United States of America', location_country_code: 'US' }),
    ];
    const { buckets, unreachable } = buildBuckets(invitees, noRoster);
    expect(buckets).toHaveLength(1);
    expect(unreachable).toEqual([
      { profile_url: 'nocountry', reason: 'no_country' },
      { profile_url: 'usnostate', reason: 'us_without_state' },
    ]);
  });

  it('does not shard a bucket under the threshold', () => {
    const invitees = Array.from({ length: 5 }, (_, i) =>
      row({ profile_url: `x${i}`, location_country: 'Israel', location_country_code: 'IL', location_region: 'Tel Aviv District' }));
    const { buckets } = buildBuckets(invitees, {
      rosterCounts: new Map([['country:Israel', 400]]),
      childRegions: new Map([['Israel', [{ region: 'Tel Aviv District', count: 300 }]]]),
      shardThreshold: 900,
    });
    expect(buckets.map((b) => b.label)).toEqual(['Israel']);
  });

  it('shards an oversized bucket into child geos AND keeps the parent for the region-less', () => {
    // The picker caps at 1000 rows in a stable order, so Israel's other ~1000 are
    // permanently invisible under the country filter. Districts reach past that — but
    // members whose location is just "Israel" have no district, so the parent must stay.
    const invitees = [
      ...Array.from({ length: 4 }, (_, i) => row({ profile_url: `tlv${i}`, location_country: 'Israel', location_country_code: 'IL', location_region: 'Tel Aviv District' })),
      ...Array.from({ length: 2 }, (_, i) => row({ profile_url: `ctr${i}`, location_country: 'Israel', location_country_code: 'IL', location_region: 'Central District' })),
      ...Array.from({ length: 9 }, (_, i) => row({ profile_url: `bare${i}`, location_country: 'Israel', location_country_code: 'IL' })),
    ];
    const { buckets } = buildBuckets(invitees, {
      rosterCounts: new Map([['country:Israel', 2017]]),
      childRegions: new Map([['Israel', [
        { region: 'Tel Aviv District', count: 674 },
        { region: 'Central District', count: 140 },
      ]]]),
      shardThreshold: 900,
    });
    expect(buckets.map((b) => [b.label, b.targetCount, b.rosterCount])).toEqual([
      ['Israel', 9, 2017],
      ['Tel Aviv District, Israel', 4, 674],
      ['Central District, Israel', 2, 140],
    ]);
    expect(buckets[1]!.parentIndex).toBe(0);
    expect(buckets[1]!.geoLabel).toBe('Tel Aviv District, Israel');
  });

  it('drops a shard that holds none of this list', () => {
    const invitees = Array.from({ length: 9 }, (_, i) =>
      row({ profile_url: `bare${i}`, location_country: 'Israel', location_country_code: 'IL' }));
    const { buckets } = buildBuckets(invitees, {
      rosterCounts: new Map([['country:Israel', 2017]]),
      childRegions: new Map([['Israel', [{ region: 'Tel Aviv District', count: 674 }]]]),
      shardThreshold: 900,
    });
    expect(buckets.map((b) => b.label)).toEqual(['Israel']);
  });

  it('returns every bucket, not just the ceiling — the cursor walks them across days', () => {
    const invitees = Array.from({ length: 30 }, (_, i) =>
      row({ profile_url: `p${i}`, location_country: `Country${String(i).padStart(2, '0')}`, location_country_code: 'XX' }));
    const { buckets } = buildBuckets(invitees, noRoster);
    expect(buckets).toHaveLength(30);
    expect(buckets.map((b) => b.rank)).toEqual(Array.from({ length: 30 }, (_, i) => i));
  });

  it('keys and labels a region distinctly from its parent country', () => {
    expect(keyId({ kind: 'region', country: 'Israel', region: 'Haifa District' }))
      .toBe('region:Israel/Haifa District');
    expect(displayLabelFor({ kind: 'region', country: 'Israel', region: 'Haifa District' }))
      .toBe('Haifa District, Israel');
  });
});
