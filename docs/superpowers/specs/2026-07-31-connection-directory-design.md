# Connection directory — design

**Date:** 2026-07-31
**Status:** approved (grilled 2026-07-31)

## Goal

Maintain a searchable, enriched, up-to-date list of the operator's LinkedIn connections —
independent of the outreach campaigns, and queryable by both the UI and an AI agent over
HTTP. The flagship query: *"Seattle connections who are security practitioners."*

Three capabilities:

1. **Ingest** — a LinkedIn `Connections.csv` export or a bare list of profile URLs, via the
   setup wizard or Settings.
2. **Maintain** — periodically discover newly-added connections (taking over the
   connections-page scrape that today lives inside the invite pipeline).
3. **Enrich & search** — scrape every connection's profile via Apify, then search by name,
   location, company, title, and free text; and retrieve everything known about one person.

## Decisions

| Question | Decision |
|---|---|
| Where the roster lives | New first-class `connections` table. No `cohort_id`, no campaign status. `profiles` stays purely the outreach queue and joins by URL |
| Identity | Normalized `profile_url` is the unique key; `linkedin_id` (from Apify) is a merge key for slug changes, with old URLs kept as aliases |
| Who scrapes the connections page | A dedicated `roster-sync` worker, `roster_sync_per_day` (default 2), reusing `acceptanceSlot()` |
| Acceptance checking | Eventually a pure DB read against `connections` (no browser, no cap). **Cut over last**, in phase 3, after the roster has proven itself |
| Send-time 1st-degree gate | Unchanged — stays a live page read (`isAlreadyConnected`). Never trusts the roster |
| Removals | **Not tracked.** Roster is append-only. `source` and `last_seen_at` are recorded anyway, leaving a cheap future path |
| Enrichment provider | Apify, ported to TypeScript. Actor `LpVuK3Zozwuipa5bp` (harvestapi/linkedin-profile-scraper), mode `Profile details no email ($4 per 1k)` |
| Posts | **Not scraped at all.** ~4× the profile cost, stale in days, adds nothing to the search use case |
| Enrichment trigger | Backfill everyone, then re-enrich past a 180-day TTL. Auto-starts on import |
| Enrichment pacing | None. Apify runs on third-party infrastructure and poses **zero risk to the LinkedIn account** — no guardrail, no browser mutex, no drip. **One URL per run** (matching the reference implementation), N concurrent — measured 5.2 s/profile, so 7,147 at concurrency 8 ≈ 77 min. Batching is unnecessary |
| Failures | `enrich_status` per row; 3 bounded attempts (silent-empty counts as an attempt), then parked as `failed`. Manual re-arm only |
| API key | `settings.apify_api_key`, write-only over HTTP (`GET /api/settings` returns `apify_key_set` only). `APIFY_API_KEY` env overrides |
| Storage shape | Scalar columns (filtered on) + `raw_json` blob (cherry-picked payload) + FTS5 virtual table over a flattened document |
| Location | **Superseded 2026-07-31 by live probe — see "Apify payload findings".** Apify returns an already-parsed location object (city/state/country/ISO code), so we store its fields directly instead of comma-splitting |
| Query model | Structured fields: OR within an array, AND across fields. Plus `q` (raw FTS5 MATCH) and `exclude_any` |
| `title_any` scope | `current_title` OR `headline` by default; `include_past_roles: true` widens to full experience history |
| Exclusions | `exclude_any` drops on whole-document match |
| Search corpus | **Enriched rows only.** Un-enriched rows exist in the roster and are visible in the UI's roster view, but are not searchable |
| Response | Compact rows + `matched` evidence + bm25 score + `campaign_state`; envelope carries `total` and an enrichment coverage block. Detail via `GET /api/connections/:slug` |
| UI | New **Connections** tab: filter chips mapping 1:1 to the API, results table, detail drawer |
| Campaign integration | Deferred to phase 4. Schema and search response carry `campaign_state` so it stays cheap to add |
| API exposure | Unchanged — Fastify binds `127.0.0.1` only |

## Scale and cost

~5,000–15,000 connections (assume ~8,000).

| | |
|---|---|
| Initial backfill | ~8,000 × $4/1k ≈ **$32**, a few hours at 10×4 concurrency |
| Steady state (180d TTL) | ~44 profiles/day ≈ **$5/month** |
| Re-import of the CSV | Near-free — only rows not already enriched enqueue |

## Data model

```sql
CREATE TABLE connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_url TEXT NOT NULL UNIQUE,   -- normalizeProfileUrl()
  linkedin_id TEXT,                   -- stable id from Apify; merge key for slug changes
  public_identifier TEXT,
  full_name TEXT,
  first_name TEXT,
  last_name TEXT,
  headline TEXT,
  location_raw TEXT,
  location_city TEXT,
  location_region TEXT,
  location_country TEXT,
  current_title TEXT,
  current_company TEXT,
  connected_on TEXT,                  -- ISO date; ONLY from the CSV or accepted_at. Never invented
  source TEXT NOT NULL,               -- csv | urls | scrape | migration
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  enrich_status TEXT NOT NULL DEFAULT 'pending', -- pending|enriching|enriched|empty|failed
  enrich_attempts INTEGER NOT NULL DEFAULT 0,
  enrich_error TEXT,
  enriched_at TEXT,
  raw_json TEXT,                      -- cherry-picked Apify payload
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE connection_aliases (    -- old URLs after a slug-change merge
  profile_url TEXT PRIMARY KEY,
  connection_id INTEGER NOT NULL REFERENCES connections(id)
);
```

Phase 2 adds `connections_fts` (FTS5, external-content over `connections`), rebuilt per
enrichment from: full name, headline, about, every experience title/company/description,
education, skills, certifications, and `location_raw`.

### Provenance rules

- `connected_on` — authoritative from the CSV, never overwritten by Apify (which does not
  return it). Scrape-discovered rows get `null`, never a value inferred from `first_seen_at`.
- `current_title` / `current_company` — provisional from the CSV, overwritten on enrichment.
- Everything else — Apify wins.
- Roster sync reads the connection card's name, so scrape-discovered rows have a name before
  enrichment.

## Phasing

| Phase | Contents | Status |
|---|---|---|
| **1 — Roster foundation** | `connections` table, seed migration, CSV + URL-list import, `roster-sync` worker, Settings/wizard import panel, stats + list API | **Done** — merged 2026-07-31 |
| **2 — Enrichment** | TS Apify client, enrichment queue + concurrent worker, FTS index build, failure handling, progress UI | **Done** |
| **3 — Search + UI** | `POST /api/connections/search`, `GET /api/connections/:slug`, Connections tab, acceptance cutover to the DB read | **Done** |
| **4 — Deferred** | Search → select → create message cohort | Not started |

During phases 1 and 2 the connections page was scraped twice per slot — once by
`roster-sync`, once by the untouched acceptance checker — deliberately, so a live pipeline
with 250 sent invites in flight was never exposed to unproven code. The phase-3 cutover
removed the duplicate and deleted `readRecentConnections()`.

## Search contract (phase 3)

```jsonc
POST /api/connections/search
{
  "title_any":    ["CISO", "security engineer", "SOC", "appsec", "threat intel"],
  "location_any": ["Seattle", "Bellevue"],
  "company_any":  [],
  "exclude_any":  ["physical security", "asset protection", "loss prevention"],
  "q":            "",            // raw FTS5 MATCH, for certs/tech/schools
  "include_past_roles": false,
  "limit": 25, "offset": 0       // limit default 25, max 200
}
```

Response:

```jsonc
{
  "total": 34,
  "limit": 25, "offset": 0,
  "coverage": { "total": 8214, "enriched": 6140, "pending": 2036, "unresolvable": 38 },
  "results": [{
    "profile_url": "...", "full_name": "...", "headline": "...",
    "current_title": "...", "current_company": "...", "location_raw": "...",
    "connected_on": "2023-04-11", "score": 12.4,
    "matched": { "title_any": ["CISO"], "location_any": ["Seattle"] },
    "campaign_state": "replied"
  }]
}
```

`GET /api/connections/:slug` returns the full row including `raw_json`.

## Known limitations (accepted)

1. **Auto-start on import spends ~$32 as a side effect of dropping a file.** Mitigated by
   showing row count and estimated cost on the import screen before the file is confirmed,
   and by a Pause control on the running job — but not gated behind a second click.
2. **No removal tracking** — search can return people who are no longer connections. The
   send-time `not_connected` skip catches it if one enters a message campaign.
3. **Enriched-only search** — a connection the CSV knows about but Apify hasn't reached is
   invisible to search. The coverage block makes this legible; the roster view in the UI
   shows them.
4. **Headline in `title_any` skews bm25** — headline-stuffers rank high. Needs field
   weighting, or a CISO search surfaces the loudest profiles rather than the most relevant.
5. **Top-slice roster sync** — an incremental scrape sees only the newest page of "recently
   added". Someone connected while the app was off for a long stretch is found by the next
   CSV re-import, not by sync.

## Apify payload findings (live-probed 2026-07-31)

Three real actor runs (~$0.012 total) against `LpVuK3Zozwuipa5bp`, mode
`Profile details no email ($4 per 1k)`. Raw fixture saved for tests. These findings
supersede two decisions taken during the brainstorm.

1. **`location` is a parsed object, not a string.** The reference Python script flattens it
   to `linkedinText` and discards the rest, which is why its cache looks like plain text.
   The raw field is:

   ```json
   "location": { "linkedinText": "Greater Leeds Area", "countryCode": "GB",
                 "parsed": { "text": "Leeds, United Kingdom", "city": "Leeds",
                             "state": "England", "country": "UK",
                             "countryFull": "United Kingdom", "countryCode": "GB" } }
   ```

   Apify resolves metro-area strings ("Greater Leeds Area" → Leeds / England / GB), which is
   exactly the geo-normalization we declined to build. **Store `parsed.*` directly; do not
   comma-split.** `parsed.city`/`parsed.state` can be absent (a country-only location yields
   neither); `country` is sometimes an abbreviation ("UK") so prefer `countryFull`.

   Measured over 6,333 cached profiles, the raw `linkedinText` shapes were 67.2%
   `City, Region, Country`, 29.6% single-segment metro names, 3.2% two-segment — where the
   second segment is sometimes a *country* (`Delhi, India`). Positional splitting would have
   written `region = "India"`. The parsed object avoids that entirely.

2. **`id` is a stable LinkedIn URN** (`ACoAABCb3-UBTG79PeQUR4P-txeGhSMVy1_AU5k`) — the
   slug-change merge key the design asked for.

3. **`originalQuery.query` echoes the exact input URL**, so batching *would* be safely
   mappable. It is still not worth it: one URL per run measured **5.2 s**, so 7,147 profiles
   at concurrency 8 is ~77 minutes. Keep one URL per run — it matches the implementation
   already proven over 6,333 profiles and removes the index-mapping hazard entirely.

4. **`interests` IS returned** in this mode, contradicting the reference script's
   `_scraper_limitations` note. Not needed for search, but the note is stale.

5. Other shape notes: `skills` are `{name, positions, endorsements}` objects (take `.name`);
   `currentPosition[]`/`experience[]` use `position`, not `title`; 50 top-level fields, most
   irrelevant.

## Implementation notes

- **Batch result mapping.** When batching N URLs into one actor run, map results back by
  `linkedinUrl`/`publicIdentifier`, **never by array index** — a private profile returns no
  item, and index-mapping would silently shift every row after it.
- **Silent-empty detection.** Port `is_empty_profile` from
  `C:\Projects\prospecting\apify_linkedin.py` verbatim in spirit: a payload is empty only
  when name, headline, about, experience, education and skills are *all* missing, so a
  sparse-but-real profile isn't falsely flagged.
- **No Python.** The README promises no Python toolchain; the Apify integration is ported to
  TypeScript using `fetch` against
  `POST https://api.apify.com/v2/acts/<ACTOR_ID>/run-sync-get-dataset-items?token=…`.
- **Testability.** The Apify client sits behind an interface, faked in vitest. One real
  payload, captured once, becomes the fixture. `scripts/verify-enrichment.ts` does a single
  live profile.
