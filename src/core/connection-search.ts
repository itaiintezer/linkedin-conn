import type { DB } from '../db/database.js';
import type { Connection } from '../types.js';

/**
 * Structured search over the enriched roster.
 *
 * Semantics: **OR within a field, AND across fields**. `title_any: ["CISO","SOC"]` matches
 * either; adding `location_any: ["Seattle"]` narrows to people matching both groups. That is
 * the shape an AI agent needs in order to fan one concept ("security practitioner") out into
 * many keywords in a single round trip.
 */
export interface SearchQuery {
  /** Matches the person's name. Substring, so "ada" finds "Ada Lovelace". */
  name_any?: string[];
  /** Matches current_title OR headline. Widened to every past role by include_past_roles. */
  title_any?: string[];
  /** Matches any of location_raw / city / region / country / ISO code. */
  location_any?: string[];
  /** Matches current_company (plus past employers when include_past_roles is set). */
  company_any?: string[];
  /** Dropped if ANY of these appears anywhere in the person's document. */
  exclude_any?: string[];
  /** Free text, passed to FTS5 as a phrase-OR over the whole document. */
  q?: string;
  /** Widen title/company matching to the full experience history. Default false. */
  include_past_roles?: boolean;
  limit?: number;
  offset?: number;
}

export interface SearchRow {
  profile_url: string;
  full_name: string | null;
  headline: string | null;
  current_title: string | null;
  current_company: string | null;
  location_raw: string | null;
  location_city: string | null;
  location_country: string | null;
  connected_on: string | null;
  enriched_at: string | null;
  /** Which supplied terms matched, per field — so an agent can tell a strong hit from a weak one. */
  matched: Record<string, string[]>;
}

export interface SearchCoverage {
  total: number;
  enriched: number;
  pending: number;
  unresolvable: number;
}

export interface SearchResult {
  total: number;
  limit: number;
  offset: number;
  coverage: SearchCoverage;
  results: SearchRow[];
}

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 200;

/** Quote a term as an FTS5 phrase. Embedded double quotes are doubled, per FTS5 syntax. */
function ftsPhrase(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

/**
 * Build an FTS5 OR-group from free terms, dropping anything that would produce invalid
 * syntax. Every term is quoted as a phrase, so operator-looking user input ("AND", "*", a
 * stray bracket) is matched literally instead of being executed as query syntax.
 */
export function ftsOrGroup(terms: string[]): string | null {
  const parts = terms.map((t) => t.trim()).filter((t) => t !== '').map(ftsPhrase);
  return parts.length === 0 ? null : `(${parts.join(' OR ')})`;
}

const clean = (xs: string[] | undefined): string[] =>
  (xs ?? []).map((x) => String(x).trim()).filter((x) => x !== '');

/** `col LIKE %term%` OR-group, with LIKE wildcards in the term escaped. */
function likeAny(columns: string[], terms: string[], params: unknown[]): string {
  const ors: string[] = [];
  for (const t of terms) {
    const needle = `%${t.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    for (const col of columns) {
      ors.push(`${col} LIKE ? ESCAPE '\\'`);
      params.push(needle);
    }
  }
  return `(${ors.join(' OR ')})`;
}

export function searchConnections(db: DB, query: SearchQuery): SearchResult {
  const name = clean(query.name_any);
  const title = clean(query.title_any);
  const location = clean(query.location_any);
  const company = clean(query.company_any);
  const exclude = clean(query.exclude_any);
  const q = (query.q ?? '').trim();
  const past = query.include_past_roles === true;

  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(query.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT));
  const offset = Math.max(0, Math.floor(query.offset ?? 0) || 0);

  // Search covers the ENRICHED corpus only. A CSV-only row has no location and no history,
  // so including it would make a location filter behave inconsistently row to row. The
  // coverage block below is what keeps that honest to the caller.
  const where: string[] = ["c.enrich_status = 'enriched'"];
  const params: unknown[] = [];

  if (name.length) {
    where.push(likeAny(['c.full_name', 'c.first_name', 'c.last_name'], name, params));
  }

  if (title.length) {
    if (past) {
      // Past roles live only in the document, so widen through FTS rather than columns.
      where.push(`(${likeAny(['c.current_title', 'c.headline'], title, params)} OR c.id IN (SELECT rowid FROM connections_fts WHERE connections_fts MATCH ?))`);
      params.push(ftsOrGroup(title));
    } else {
      where.push(likeAny(['c.current_title', 'c.headline'], title, params));
    }
  }

  if (location.length) {
    // A two-letter term is read as an ISO country code and matched EXACTLY; anything longer
    // is a substring match across the text fields (which is what lets "Seattle" find
    // "Seattle Metropolitan Area").
    //
    // Live data forced this split: `LIKE '%US%'` matched Ho-us-ton, A-us-tralia, Br-us-sels
    // and D-us-seldorf, so a "US" filter silently returned Australian, Belgian and German
    // profiles. Two characters carry too little signal to be a substring of free text — so
    // for short terms we only trust the one field that is genuinely a two-letter token.
    const codeTerms = location.filter((t) => t.length <= 2);
    const textTerms = location.filter((t) => t.length > 2);
    const ors: string[] = [];
    if (textTerms.length) {
      ors.push(likeAny(
        ['c.location_raw', 'c.location_city', 'c.location_region', 'c.location_country'],
        textTerms, params,
      ));
    }
    for (const t of codeTerms) {
      ors.push('c.location_country_code = ? COLLATE NOCASE');
      params.push(t);
    }
    where.push(`(${ors.join(' OR ')})`);
  }

  if (company.length) {
    if (past) {
      where.push(`(${likeAny(['c.current_company'], company, params)} OR c.id IN (SELECT rowid FROM connections_fts WHERE connections_fts MATCH ?))`);
      params.push(ftsOrGroup(company));
    } else {
      where.push(likeAny(['c.current_company'], company, params));
    }
  }

  if (q) {
    where.push('c.id IN (SELECT rowid FROM connections_fts WHERE connections_fts MATCH ?)');
    params.push(q);
  }

  if (exclude.length) {
    // Whole-document exclusion: this is what makes "security" usable in a network full of
    // physical-security and asset-protection roles.
    where.push('c.id NOT IN (SELECT rowid FROM connections_fts WHERE connections_fts MATCH ?)');
    params.push(ftsOrGroup(exclude));
  }

  const whereSql = where.join(' AND ');
  const total = (db.prepare(`SELECT COUNT(*) c FROM connections c WHERE ${whereSql}`)
    .get(...(params as never[])) as unknown as { c: number }).c;

  // Ordering: a current-role match is a stronger signal than a headline or history match, so
  // rank those first, then most-recently-connected. Deliberately NOT bm25 — term frequency
  // across a profile document rewards headline-stuffers, which is exactly the wrong bias
  // when the question is "who does this job".
  const rows = db.prepare(`
    SELECT c.* FROM connections c
    WHERE ${whereSql}
    ORDER BY
      CASE WHEN c.current_title IS NOT NULL THEN 0 ELSE 1 END,
      c.connected_on DESC NULLS LAST,
      c.full_name
    LIMIT ? OFFSET ?
  `).all(...(params as never[]), limit, offset) as unknown as Connection[];

  return {
    total,
    limit,
    offset,
    coverage: coverageOf(db),
    results: rows.map((r) => toRow(r, { name, title, location, company })),
  };
}

/** Which of the caller's terms actually hit, and where. */
function toRow(c: Connection, terms: { name: string[]; title: string[]; location: string[]; company: string[] }): SearchRow {
  const hit = (fields: (string | null)[], candidates: string[]): string[] => {
    const hay = fields.filter((f): f is string => !!f).join('  ').toLowerCase();
    return candidates.filter((t) => hay.includes(t.toLowerCase()));
  };
  const matched: Record<string, string[]> = {};
  const n = hit([c.full_name], terms.name);
  if (n.length) matched.name_any = n;
  const t = hit([c.current_title, c.headline], terms.title);
  if (t.length) matched.title_any = t;
  const l = hit([c.location_raw, c.location_city, c.location_region, c.location_country, c.location_country_code], terms.location);
  if (l.length) matched.location_any = l;
  const co = hit([c.current_company], terms.company);
  if (co.length) matched.company_any = co;

  return {
    profile_url: c.profile_url,
    full_name: c.full_name,
    headline: c.headline,
    current_title: c.current_title,
    current_company: c.current_company,
    location_raw: c.location_raw,
    location_city: c.location_city,
    location_country: c.location_country,
    connected_on: c.connected_on,
    enriched_at: c.enriched_at,
    matched,
  };
}

/**
 * How much of the roster the answer could possibly have covered.
 *
 * Returned on EVERY search so a caller can tell "nobody matches" from "we haven't looked at
 * 2,000 people yet" — without it an agent reports a confident, wrong negative.
 */
export function coverageOf(db: DB): SearchCoverage {
  const rows = db.prepare('SELECT enrich_status s, COUNT(*) c FROM connections GROUP BY enrich_status')
    .all() as unknown as { s: string; c: number }[];
  const by = Object.fromEntries(rows.map((r) => [r.s, r.c]));
  return {
    total: rows.reduce((n, r) => n + r.c, 0),
    enriched: by.enriched ?? 0,
    pending: (by.pending ?? 0) + (by.enriching ?? 0),
    unresolvable: (by.failed ?? 0) + (by.empty ?? 0),
  };
}
