/**
 * Location bucketing for the event-invite pipeline.
 *
 * Pure: no DB, no browser. Given the invitee list and roster counts, decide which
 * LinkedIn location filters to apply, in what order, and which people are structurally
 * unreachable.
 *
 * Two different counts drive two different decisions, and conflating them is the easy
 * mistake here:
 *
 *   target_count — how many of THIS event's invitees fall in the bucket. Ranks the list,
 *                  because working the densest bucket first maximises yield per minute.
 *   roster_count — how many of your connections LinkedIn will list under that filter.
 *                  Decides SHARDING, because the picker hard-caps at 1000 rows in a
 *                  stable order (verified: Israel returned exactly 1000 of 2017), so
 *                  everything past the cap is permanently invisible under that filter.
 *
 * US rows bucket by state, never by country — the operator's call, and a sound one: the
 * US roster is 3057 people, three times the cap.
 */

/** A location we can filter by. */
export type BucketKey =
  | { kind: 'us_state'; region: string }
  | { kind: 'country'; country: string }
  | { kind: 'region'; country: string; region: string };

/** The roster fields bucketing reads. Both invitees and roster rows use this shape. */
export interface LocatedRow {
  profile_url: string;
  location_country: string | null;
  location_country_code: string | null;
  location_region: string | null;
}

export interface PlannedBucket {
  rank: number;
  key: BucketKey;
  /** Display label. */
  label: string;
  /** Primary exact `.search-typeahead-v2__hit-text` to match. */
  geoLabel: string;
  /** Exact labels to try in order; the first that resolves wins. */
  geoCandidates: string[];
  kind: BucketKey['kind'];
  targetCount: number;
  rosterCount: number;
  /** Index into the returned array of the parent this was sharded from, else null. */
  parentIndex: number | null;
}

export type UnreachableReason = 'no_country' | 'us_without_state';

export interface Unreachable {
  profile_url: string;
  reason: UnreachableReason;
}

export interface BucketPlan {
  buckets: PlannedBucket[];
  unreachable: Unreachable[];
}

/**
 * Country names where Apify's vocabulary differs from LinkedIn's geo vocabulary. A name
 * LinkedIn does not recognise costs the entire bucket, silently, so the mapped name is
 * tried first and the raw one kept as a fallback candidate.
 *
 * This list is best-effort by construction — it cannot be exhaustive, which is exactly
 * why resolution is candidate-based and an unresolvable bucket is reported rather than
 * guessed at.
 */
const COUNTRY_GEO_ALIASES: Record<string, string> = {
  'United States of America': 'United States',
  "People's Republic of China": 'China',
  'Russian Federation': 'Russia',
  'Taiwan, Province of China': 'Taiwan',
  'The Republic of North Macedonia': 'North Macedonia',
  'United Republic of Tanzania': 'Tanzania',
  'Czech Republic': 'Czechia',
  'Hong Kong': 'Hong Kong SAR',
};

/** Distinct, order-preserving. */
function uniq(xs: string[]): string[] {
  return [...new Set(xs.filter((x) => x.length > 0))];
}

/** Which bucket a row belongs to, or why it belongs to none. */
export function bucketKeyFor(row: LocatedRow): BucketKey | UnreachableReason {
  const country = row.location_country?.trim() || '';
  if (country.length === 0) return 'no_country';
  if (row.location_country_code === 'US') {
    const region = row.location_region?.trim() || '';
    // Deliberate: never fall back to a country-wide "United States" filter. It is three
    // times the 1000-row cap, so it would burn a bucket to surface an arbitrary third of
    // the US roster. These people are unreachable until their state is known.
    if (region.length === 0) return 'us_without_state';
    return { kind: 'us_state', region };
  }
  return { kind: 'country', country };
}

/** Stable identity for a key, used for grouping and dedupe. */
export function keyId(key: BucketKey): string {
  switch (key.kind) {
    case 'us_state': return `us_state:${key.region}`;
    case 'country': return `country:${key.country}`;
    case 'region': return `region:${key.country}/${key.region}`;
  }
}

/** Human-facing label. */
export function displayLabelFor(key: BucketKey): string {
  switch (key.kind) {
    case 'us_state': return `${key.region} (US state)`;
    case 'country': return key.country;
    case 'region': return `${key.region}, ${key.country}`;
  }
}

/**
 * Exact typeahead labels to try, in order.
 *
 * Exactness is the whole point: querying "Georgia" ranks the COUNTRY Georgia first and
 * "Georgia, United States" second, and querying "California" also returns "California,
 * Maryland, United States" and "Baja California, Mexico". Matching the first suggestion
 * would filter the wrong place.
 */
export function geoCandidatesFor(key: BucketKey): string[] {
  switch (key.kind) {
    case 'us_state':
      return [`${key.region}, United States`];
    case 'country': {
      const alias = COUNTRY_GEO_ALIASES[key.country];
      return uniq(alias ? [alias, key.country] : [key.country]);
    }
    case 'region': {
      const alias = COUNTRY_GEO_ALIASES[key.country] ?? key.country;
      return uniq([`${key.region}, ${alias}`, `${key.region}, ${key.country}`]);
    }
  }
}

/** What the query typed into the combobox should be (partial is safer for latency). */
export function typeaheadQueryFor(geoLabel: string): string {
  return geoLabel.split(',')[0]!.trim();
}

export interface BuildBucketsOptions {
  /**
   * Roster counts per bucket key id — how many connections LinkedIn will list. Only
   * used to decide sharding, never to rank.
   */
  rosterCounts: Map<string, number>;
  /**
   * Child regions of a country, with their roster counts, for sharding oversized
   * buckets. Keyed by country name.
   */
  childRegions: Map<string, { region: string; count: number }[]>;
  /** Shard a bucket whose roster count reaches this. Default 900 (cap is 1000). */
  shardThreshold?: number;
}

/**
 * Plan every bucket for an invitee list, ranked densest-first.
 *
 * Returns ALL buckets, not just the first N: the ceiling is a per-RUN limit and the
 * cursor walks the full list across days, so truncating here would permanently discard
 * the tail the resumable design exists to reach.
 */
export function buildBuckets(invitees: LocatedRow[], opts: BuildBucketsOptions): BucketPlan {
  const shardThreshold = opts.shardThreshold ?? 900;
  const unreachable: Unreachable[] = [];

  // Group invitees by their own location.
  const groups = new Map<string, { key: BucketKey; rows: LocatedRow[] }>();
  for (const row of invitees) {
    const k = bucketKeyFor(row);
    if (typeof k === 'string') { unreachable.push({ profile_url: row.profile_url, reason: k }); continue; }
    const id = keyId(k);
    const g = groups.get(id) ?? { key: k, rows: [] };
    g.rows.push(row);
    groups.set(id, g);
  }

  // Expand oversized buckets into child geos PLUS the parent. The parent is kept because
  // it is the only way to reach members whose LinkedIn location is just the country —
  // 651 of Israel's visible 1000 had no district at all. It stays capped at 1000, but it
  // is strictly better than dropping those people.
  type Draft = { key: BucketKey; targetCount: number; rosterCount: number; parentId: string | null };
  const drafts: Draft[] = [];

  for (const [id, g] of groups) {
    const rosterCount = opts.rosterCounts.get(id) ?? 0;
    const isCountry = g.key.kind === 'country';
    const children = isCountry
      ? (opts.childRegions.get((g.key as { country: string }).country) ?? [])
      : [];

    if (!isCountry || rosterCount < shardThreshold || children.length === 0) {
      drafts.push({ key: g.key, targetCount: g.rows.length, rosterCount, parentId: null });
      continue;
    }

    const country = (g.key as { country: string }).country;
    // Partition this country's invitees by their own region. Note the run itself ticks
    // ANY visible row whose URN is still pending — this partition only ranks the work,
    // so a Tel Aviv invitee surfacing under the parent country pass is still invited.
    const byRegion = new Map<string, number>();
    let regionless = 0;
    for (const r of g.rows) {
      const region = r.location_region?.trim() || '';
      if (region.length === 0) regionless++;
      else byRegion.set(region, (byRegion.get(region) ?? 0) + 1);
    }

    for (const child of children) {
      const key: BucketKey = { kind: 'region', country, region: child.region };
      drafts.push({
        key,
        targetCount: byRegion.get(child.region) ?? 0,
        rosterCount: child.count,
        parentId: id,
      });
    }
    // The parent, carrying the invitees with no finer location of their own.
    drafts.push({ key: g.key, targetCount: regionless, rosterCount, parentId: null });
  }

  // A shard with no invitees of its own is pure cost — drop it. The parent is kept even
  // at zero only if it has targets; otherwise it goes too.
  const useful = drafts.filter((d) => d.targetCount > 0);

  // Rank densest first. Ties break toward the CHEAPER bucket (fewer rows to page
  // through), then by label so the order is deterministic for tests and for the UI.
  useful.sort((a, b) =>
    b.targetCount - a.targetCount
    || a.rosterCount - b.rosterCount
    || displayLabelFor(a.key).localeCompare(displayLabelFor(b.key)));

  const indexById = new Map<string, number>();
  useful.forEach((d, i) => { if (d.parentId === null) indexById.set(keyId(d.key), i); });

  const buckets: PlannedBucket[] = useful.map((d, i) => {
    const candidates = geoCandidatesFor(d.key);
    return {
      rank: i,
      key: d.key,
      label: displayLabelFor(d.key),
      geoLabel: candidates[0]!,
      geoCandidates: candidates,
      kind: d.key.kind,
      targetCount: d.targetCount,
      rosterCount: d.rosterCount,
      parentIndex: d.parentId !== null ? indexById.get(d.parentId) ?? null : null,
    };
  });

  return { buckets, unreachable };
}
