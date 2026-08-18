# The Machine API

Local HTTP API for The Machine LinkedIn outreach console. Base URL: `http://localhost:4400`.
All request/response bodies are JSON. No authentication (localhost, single user).

## Campaign kinds

Two kinds of campaign run on the same engine:

- `invite` — connection requests (the default, and everything that existed before).
- `message` — direct messages to people you are already connected to.

A cohort's `kind` is fixed at creation and every profile in it inherits that kind. Pacing
is independent per kind (`weekly_cap`/`batch_size`/`batches_per_day` vs
`msg_weekly_cap`/`msg_batch_size`/`msg_batches_per_day`); working hours, weekday rule,
send delays, pause state and the guardrail are shared. Kind-specific fields are called
out per endpoint below.

## For agents: the two you need

### POST /api/profiles
Enqueue one profile. Creates the cohort if it does not exist.

Request: `{ "url": "https://www.linkedin.com/in/jane-doe/", "cohort": "Security VPs", "message": "Hi {firstName}, …", "kind": "invite" | "message" }`
- `url` (required) — a LinkedIn profile URL; normalized server-side.
- `cohort` (optional) — cohort name; defaults to today's date.
- `kind` (optional) — defaults to `invite`. Anything other than `"message"` is treated as
  `invite`.
- `message` (optional) — per-profile note (invites) or DM body (messages); `{firstName}` is
  substituted at send time. Max length 2000 for messages, 300 for invite notes; over that
  is `400`. It takes precedence over the cohort template.

`400` if the URL is not a recognizable `/in/<slug>` link.

`409` if a cohort with that name already exists with the other kind — including the common
case of omitting `kind` (so defaulting to `invite`) while naming a message cohort. Without
that guard the row would be sent by the *invite* sender, which resolves its text from the
DM template and truncates it to a 300-char connection note.

When `kind` is `message`, there must be something to send: `400` unless the request carries
a non-blank `message` **or** the target cohort already has a non-blank template.
`POST /api/lists` applies the same rule.

Response: `{ "id": 42, "profile_url": "https://www.linkedin.com/in/jane-doe", "kind": "invite" }`

```
curl -s http://localhost:4400/api/profiles \
  -H 'content-type: application/json' \
  -d '{"url":"https://www.linkedin.com/in/jane-doe/","cohort":"Security VPs"}'
```

### GET /api/status
Queue snapshot + weekly usage + forecast, per campaign kind.

Response (abridged): `{ "paused": 0, "weekly_sent": 12, "weekly_cap": 100, "counts": { "queued": 30, "scheduled": 5, "sent": 12, "accepted": 4 }, "msg_counts": { "queued": 8, "sent": 3, "replied": 1 }, "msg_weekly_sent": 3, "msg_weekly_cap": 250, "loggedIn": true, "acceptance_checked_at": "…", "replies_checked_at": "…", "forecast": { "queue_remaining": 35, "eta": { "sendingDays": 7, "finishDate": "…" }, "next_batch": { "estimated": false, "at": "…", "count": 5 }, "msg_next_batch": { "estimated": true, "pending": true, "count": 5 } } }`

- `counts`, `weekly_sent`, `weekly_cap`, `forecast.queue_remaining`, `forecast.eta` and
  `forecast.next_batch` are **invite-only** — they mean exactly what they meant before
  messages existed.
- `msg_counts` (same status keys, plus `replied`), `msg_weekly_sent`, `msg_weekly_cap` and
  `forecast.msg_next_batch` are the message side.
- `replies_checked_at` is the last successful reply pass (`acceptance_checked_at` the last
  acceptance pass); `null` until one succeeds.
- `paused`, `guardrail` and `sending` are shared: there is one pause and one halt for both
  kinds.
- `event` is the third pipeline's summary, and it is paced in **runs**, not sends:
  `{ "campaigns": 2, "open": 1, "listed": 214, "up_next": 96, "invited": 128, "unreachable": 31, "locations_next": 4, "locations_left": 6, "runs_today": 0, "events_per_day": 1, "next_run": { "event_id": 3, "title": "…", "from": "…", "to": null }, "running": null }`.
  `listed` counts open campaigns only; `invited` and `unreachable` are lifetime, across
  every campaign. `up_next` / `locations_next` describe the slice **one** run reaches, and
  `next_run.from` is `null` for a campaign that is armed but has not been given a window
  yet — never render a clock time for it.
- `engagements` is the fourth pipeline's summary, paced in reactions with a second cap for
  comments:
  `{ "counts": { "queued": 3, "scheduled": 15, "sent": 41 }, "weekly_used": 41, "weekly_cap": 500, "weekly_remaining": 459, "comments_today": 2, "comment_daily_cap": 10, "next_scheduled": "2026-08-02T14:05:00.000Z" }`.
  `counts` is a `GROUP BY status`, so **a status with no rows is absent rather than zero** —
  read it with a default, never as a complete set of keys. `next_scheduled` is the earliest
  real `scheduled_for` among `scheduled` rows, or `null` when nothing is scheduled; it is
  deliberately **not** a `next_batch` forecast, so there is never a clock time here without a
  slot behind it.
- A `next_batch` / `msg_next_batch` is one of four shapes: `null` (nothing queued),
  `{ blocked, reason }`, `{ estimated: false, at, count }` for a materialized slot, or
  `{ estimated: true, count, … }` for a prediction. A prediction carries **either** `at`
  (a known future window start — today is finished, or it's a non-sending day) **or**
  `pending: true` and **no `at` at all**, meaning today is still open and the next planning
  pass will place the batch. Never render a clock time for a `pending` forecast: there is no
  slot behind it.

## Bulk & cohorts

### POST /api/lists
Bulk-enqueue from pasted text. Request: `{ "cohort": "Security VPs", "text": "url1\nurl2", "message_template": "Hi {firstName}", "kind": "invite" | "message" }`. Response: `{ "added": 2, "found": 2 }`.

- `kind` (optional) — defaults to `invite`. Anything other than `"message"` is treated as
  `invite`.
- `message_template` is required when `kind` is `message` **unless the target cohort already
  has one** — a DM has nothing to send without a body, but that body may already live on the
  cohort. `400` only when nothing can supply one. Max length 2000 for messages, 300 for
  invite notes; over that is `400`.
- **Omitting `message_template` leaves the cohort's template and its no-note policy alone.**
  Supplying one overwrites both — which rewrites the message for everyone already queued in
  that cohort, so omit it unless you mean to change it.
- `409` if a cohort with that name already exists with the other kind. Checked before the
  template rule, so a kind mismatch reports itself as one.
- Both `POST /api/lists` and `POST /api/profiles` run a planning pass on the new backlog, so
  added work gets real slots immediately instead of waiting for the hourly scheduler tick.
  Planning still declines while paused, halted, outside working hours or on a non-sending
  day — adding work never slips a send past those gates.

### GET /api/cohorts
List active (non-archived) cohorts: `[{ "id", "name", "kind", "message_template", "allow_no_note", "created_at" }]`.

### POST /api/cohorts
Create or update by name. Request: `{ "name": "Security VPs", "kind": "message", "message_template": "Hi {firstName}" }`.
`kind` (optional) defaults to `invite` and only applies at creation — a cohort's kind can
never change. `409` if the name exists with the other kind **and** the request stated a
`kind`; an edit that omits `kind` is not rejected by the default.

### Archiving
- `GET /api/cohorts/archived` — same shape, archived cohorts only.
- `POST /api/cohorts/:id/archive` — hide the cohort from metrics/dropdowns and skip its
  remaining queue. History stays in the database. `404` if the cohort doesn't exist.
- `POST /api/cohorts/:id/unarchive` — restore it.

### GET /api/metrics
Per-cohort funnel metrics, both kinds in one list:
`[{ "cohort_id", "cohort_name", "kind", "total", "sent", "pending", "accepted", "expired", "skipped", "acceptance_rate", "median_time_to_accept_days", "replied", "reply_rate", "median_time_to_reply_days" }]`.

Every row carries every field; which ones mean anything depends on `kind`. Filter on
`kind` and read the acceptance triplet for `invite` rows, the reply triplet for `message`
rows. Two shape notes:

- `sent` is "attempted, still countable": for invites `accepted + pending + expired`, for
  messages `replied + pending` (messages never expire).
- `pending` is status `sent` in both cases — an invite awaiting acceptance, or a message
  awaiting a reply. `median_time_to_reply_days` is `null` until something replies.

## Connections (roster)

The connection roster is separate from the campaign queue: one row per person you are
connected to, with no cohort and no campaign status. A person in two campaigns is still one
connection, and a connection you never contacted is still a first-class record.

The roster is **append-only** — nothing here removes a connection, and absence from a scrape
never deletes anyone.

### POST /api/connections/import
Ingest a roster. Request: `{ "text": "…" }`. The body is the same whether you send a
LinkedIn `Connections.csv` export or a bare list of profile URLs — the format is sniffed.
Response: `{ "format": "csv" | "urls", "parsed", "inserted", "updated", "skipped" }`.

- **CSV** — the export's `Notes:` preamble is skipped automatically, and columns are mapped
  by header **name**, not position, so a reordered or trimmed export still works. Yields
  name, company, position and `connected_on`.
- **URL list** — newline- or comma-separated, or any pasted text containing profile URLs.
  Yields only the URL; everything else waits for enrichment.
- **Idempotent.** Re-importing the same file updates existing rows rather than duplicating
  them (`inserted: 0, updated: N`).
- `skipped` counts data rows that had no usable LinkedIn profile URL.
- `400` when the input contains no usable URLs, or when a CSV has no recognizable header.

Merge rules on an existing row: `first_seen_at` and `source` record the first sighting and
never change; `last_seen_at` always advances; `connected_on` fills a NULL and is then
immutable (the CSV is its only real source). Other fields fill NULLs, and overwrite only
while the row is un-enriched — once enriched, scraped data wins over a stale CSV.

### GET /api/connections?limit=N&offset=M
Browse the roster, newest first. Response:
`{ "total", "limit", "offset", "results": [ …connection rows… ] }`.
`limit` defaults to 50 and is clamped to 200. This is a plain browse view over the whole
roster including un-enriched rows; for filtered queries use `POST /api/connections/search`.

### GET /api/connections/stats
`{ "total", "by_enrich_status": { "pending", "enriching", "enriched", "empty", "failed" }, "last_synced_at" }`.
Every row is `pending` until the enrichment phase ships.

### POST /api/roster/sync-now
Force one read of the connections page immediately. Response is the pass result:
`{ "ran", "reason"?, "seen", "discovered", "syncedAt"? }`.

`ran: false` always carries a `reason` — `paused` (never, for this endpoint: it forces past
a pause), `guardrail`, `logged_out`, `login_lost`, `read_error`, or `empty_read`. A pass
that declines to run is reported, never silently treated as a successful no-op.

### Roster sync (scheduled)
`roster_sync_per_day` (default 2) governs automatic discovery of newly-added connections,
using the same day-slicing as reply checks: at most one successful pass per equal slot of the
day, retried on the next 30-minute tick if a pass bails out. The pass is read-only against
LinkedIn and does not consume any weekly cap. An empty read changes nothing and does not
consume the slot.

**This is the only place connections are discovered.** Acceptance tracking resolves pending
invites against the roster rather than scraping separately, so `roster_sync_per_day` alone
determines how quickly an accepted invite is noticed. `acceptance_checks_per_day` is retained
in settings for backwards compatibility but nothing reads it: the acceptance pass is now a
pure database read and runs every minute.

### POST /api/connections/search

Structured search over the **enriched** roster. This is the endpoint an AI agent should use
to answer "who do I know who…".

#### Request

All fields are optional. An empty body `{}` returns the whole enriched roster.

| Field | Type | Default | Searches |
|---|---|---|---|
| `name_any` | `string[]` | – | `full_name`, `first_name`, `last_name` |
| `title_any` | `string[]` | – | `current_title`, `headline` (+ every past role with `include_past_roles`) |
| `location_any` | `string[]` | – | `location_raw`, city, region, country (+ ISO code — see below) |
| `company_any` | `string[]` | – | `current_company` (+ every past employer with `include_past_roles`) |
| `exclude_any` | `string[]` | – | drops the person if a term appears **anywhere** in their document |
| `q` | `string` | `""` | raw FTS5 `MATCH` over the whole document |
| `include_past_roles` | `boolean` | `false` | widens `title_any` and `company_any` to full history |
| `limit` | `number` | `25` | clamped to 200 |
| `offset` | `number` | `0` | pagination |

A bare string is accepted wherever an array is expected (`"location_any": "Seattle"`).
Values of the wrong type are ignored rather than rejected.

#### Semantics: OR within a field, AND across fields

Each array is a group of alternatives; the groups are combined with AND.

```jsonc
{
  "title_any":    ["CISO", "Chief Information Security", "SOC", "appsec"],
  "location_any": ["Seattle", "Bellevue"],
  "exclude_any":  ["physical security", "asset protection"]
}
// (CISO OR Chief Information Security OR SOC OR appsec)
//   AND (Seattle OR Bellevue)
//   AND NOT (physical security OR asset protection)
```

That shape is the point: fan one concept out into many keywords in a single round trip.

#### Matching rules — read these before writing a query

- **Matching is substring, not semantic.** `"CISO"` does **not** match a title spelled out as
  "Chief Information Security Officer". Supply both spellings and the adjacent titles.
- **`title_any` searches the headline too**, because senior people describe themselves there
  rather than in their job title. A hit may therefore be on the headline, not the role.
- **A two-letter `location_any` term is treated as an ISO-3166 country code and matched
  exactly.** Longer terms are substrings, so `"Seattle"` also finds "Seattle Metropolitan
  Area". Without this rule `"US"` would match Ho*us*ton, A*us*tralia, Br*us*sels and
  D*us*seldorf — all observed on real data.
- **`exclude_any` matches the whole document**, not just the title. That is what makes a
  "security" query usable in a network full of physical-security and asset-protection roles —
  but keep terms specific (`"physical security"`, not `"physical"`).
- **Only enriched connections are searchable.** A roster row that has not been scraped has no
  location and no history, so including it would make filters behave inconsistently. See
  `coverage`.
- Search terms are quoted as FTS phrases, so operator-looking input (`AND`, `*`, brackets) in
  the structured fields is matched literally rather than executed.

#### Response

```jsonc
{
  "total": 34,          // matches BEFORE pagination
  "limit": 25,
  "offset": 0,
  "coverage": { "total": 7153, "enriched": 7151, "pending": 0, "unresolvable": 2 },
  "results": [{
    "profile_url":     "https://www.linkedin.com/in/ada",
    "full_name":       "Ada Lovelace",
    "headline":        "CISO | Cloud security",
    "current_title":   "Chief Information Security Officer",
    "current_company": "Amazon",
    "location_raw":    "Greater Seattle Area",
    "location_city":   "Seattle",
    "location_country":"United States",
    "connected_on":    "2024-03-04",   // null unless the CSV supplied it
    "enriched_at":     "2026-07-31T00:12:03.114Z",
    "matched": { "title_any": ["Chief Information Security"], "location_any": ["Seattle"] }
  }]
}
```

**`matched`** reports which of *your* supplied terms hit which field, so a strong hit is
distinguishable from a weak one. Two caveats:

- It only inspects **current** fields. With `include_past_roles: true`, a row matched purely
  on history comes back with `"matched": {}` — that is a history match, not a bug.
- A field absent from `matched` was not the reason that row matched.

**`coverage`** describes the corpus the answer was drawn from, and is returned on every
search. Always read it:

| Key | Meaning |
|---|---|
| `total` | every connection in the roster |
| `enriched` | scraped, and therefore searchable |
| `pending` | queued or in-flight for enrichment — **not yet searchable** |
| `unresolvable` | permanently unscrapeable (deleted or locked-down profiles) |

A small or empty result set with a large `pending` means the corpus is still filling, **not**
that nobody matches. Say so rather than reporting a confident negative.

#### Ordering

Rows with a current title first, then most-recently-connected, then name. Deliberately **not**
bm25: term frequency across a profile document rewards headline-stuffers, which is the wrong
bias for "who actually does this job".

#### Errors

The endpoint is permissive — unknown fields and wrong types are ignored, and no combination of
structured filters produces an error. The one exception:

- **`400`** when `q` is not valid FTS5, e.g. `{"error": "fts5: syntax error near \"AND\""}`.
  `q` is passed through raw. If you are not deliberately using FTS5 operators, prefer the
  structured fields, which quote your input for you.

#### Turning a request into a query

The caller supplies the vocabulary; the endpoint does not expand concepts. For
"Seattle security practitioners":

```bash
curl -sS -X POST http://localhost:4400/api/connections/search   -H 'Content-Type: application/json'   -d '{
    "title_any": ["CISO","Chief Information Security","security engineer",
                  "security architect","SOC","appsec","application security",
                  "threat","incident response","infosec"],
    "location_any": ["Seattle","Bellevue","Redmond","Kirkland"],
    "exclude_any": ["physical security","asset protection","loss prevention"],
    "limit": 25
  }'
```

More keywords cost nothing — recall is cheap and `exclude_any` cleans up the noise. For a
metro, list the nearby cities too. For "who *used to* work at X", add
`"include_past_roles": true`.

### Queueing search results

There is no dedicated endpoint. Search returns `profile_url`; feed the ones you want to the
existing `POST /api/lists` with `kind: "message"` and a newline-joined `text`. Two notes:

- **Omit `message_template` when targeting an existing cohort.** Supplying one overwrites
  that cohort's template for everyone already queued in it.
- Anyone already present as a `message` profile is a no-op (`UNIQUE(profile_url, kind)`), so
  the response's `added` vs `found` is your dedupe report.

#### Name resolution

Two name fields, and they are not interchangeable:

| Field | What it is |
|---|---|
| `full_name` | The **verbatim** display name, exactly as LinkedIn renders it — emoji, credentials, honorifics and all. Search, the UI and the reply matcher all depend on it staying untouched. |
| `first_name` | The **greeting name**: what `{firstName}` becomes in a note or message. Normalised at write time by `firstNameFrom` (`src/core/first-name.ts`), so it is safe to use directly. |

`first_name` has honorifics (`Dr.`), post-nominals (`CISSP`), emoji, invisible and bidi
characters, parentheticals and quoted nicknames removed, and multi-token fragments reduced to
the given name — `"Dr. Chidhanandham"` → `Chidhanandham`, `"Darrell J."` → `Darrell`. An
apostrophe *inside* a name is kept (`Ze'ev`), as is an initialism someone goes by (`K.C.`).

It is **`null`** when nothing in the name can be trusted as a given name (`"M. G."`,
`"M. K. Palmore"` — the tail there is a surname). Senders substitute the literal `there` in
that case, so a null is a deliberate answer, not missing data.

`npx tsx scripts/verify-first-names.ts` prints what the rule would change over the live
roster and writes nothing.

### GET /api/connections/:slug

Everything known about one person. `:slug` is the part after `/in/` in their profile URL.
Use this after a search when you need depth on a specific individual.

```jsonc
{
  // every roster column…
  "profile_url": "https://www.linkedin.com/in/ada",
  "full_name": "Ada Lovelace",
  "headline": "CISO | Cloud security",
  "current_title": "Chief Information Security Officer",
  "current_company": "Amazon",
  "location_raw": "Greater Seattle Area",
  "location_city": "Seattle", "location_region": "Washington",
  "location_country": "United States", "location_country_code": "US",
  "linkedin_id": "ACoAA…",          // stable across a public-slug change
  "connected_on": "2024-03-04",     // null unless the CSV supplied it
  "source": "csv",                  // csv | urls | scrape | migration
  "first_seen_at": "…", "last_seen_at": "…",
  "enrich_status": "enriched",      // pending|enriching|enriched|empty|failed
  "enriched_at": "…",
  "enrich_attempts": 1, "enrich_error": null,

  // …plus the stored Apify payload, unwrapped from raw_json
  "profile": {
    "name": "…", "headline": "…", "about": "…", "location": "…",
    "currentPosition": [{ "title": "…", "companyName": "…", "duration": "…" }],
    "experience":  [{ "title": "…", "companyName": "…", "location": "…",
                      "duration": "…", "startDate": "…", "endDate": "…",
                      "description": "…" }],   // up to 12, newest first
    "education":   [{ "schoolName": "…", "degree": "…", "fieldOfStudy": "…" }],
    "skills":      ["Incident Response", "CISSP"],   // names only, up to 40
    "topSkills":   ["…"],                            // up to 10
    "certifications": [{ "name": "…", "authority": "…" }],
    "languages":   ["…"]
  }
}
```

- `profile` is `null` for a connection that has not been enriched yet — the roster columns
  will still carry whatever the CSV supplied (name, company, position, connected date).
- Fields inside `profile` are omitted or empty when LinkedIn had nothing there. Measured over
  400 real profiles: experience 99%, education 96%, skills 94%, about 82%, certifications 61%.
- `raw_json` is never returned as a string — it is parsed into `profile`.
- **An old slug still resolves** after a public-URL change: the alias table maps it to the
  merged connection, and the response carries the surviving `profile_url`.
- `404` if the slug is not a connection.

## Enrichment

Every connection is scraped once via Apify (actor `harvestapi/linkedin-profile-scraper`,
mode *Profile details no email*, ~**$0.004/profile**) and re-scraped after
`enrich_ttl_days` (default 180). Enrichment runs on Apify's infrastructure and **never
touches your LinkedIn session**, so unlike the sender it has no pacing, no weekly cap and no
guardrail — the only limits are money and your Apify plan's concurrency
(`enrich_concurrency`, default 8).

**Enrichment is automatic.** A drain tick every 60 seconds scrapes whatever is `pending`,
whatever put it there — an import, roster discovery of a new connection, the TTL staleness
sweep, or recovery after a crash. So the roster converges on fully-enriched without anyone
clicking anything, and `POST /api/enrichment/start` exists for forcing a run (it also works
while The Machine is paused, which the automatic tick does not).

The tick stands down while The Machine is **paused** — pause is the operator's "stop doing things"
switch, so it stops unattended spending too. It deliberately **ignores a tripped guardrail**,
which is about LinkedIn session health and has no bearing on Apify.

Each connection carries an `enrich_status`:

| Status | Meaning |
|---|---|
| `pending` | queued for scraping — picked up within a minute |
| `enriching` | claimed by a worker right now |
| `enriched` | scraped successfully |
| `empty` | Apify returned a shell with no identifying signal — restricted or deleted. **Terminal**: a retry cannot make it real |
| `failed` | 3 attempts failed. **Terminal** — only `retry-failed` re-arms it, because every attempt bills |

### POST /api/enrichment/start
Force a run now rather than waiting for the next tick, and clear any halt (see below).
Returns immediately — a full backfill runs for over an hour. Response:
`{ "started": true, "queued": 7147, "estimated_cost_usd": 28.59 }`.
`400` if no Apify key is configured; `409` if a run is already in progress.

### GET /api/enrichment/status
`{ "running", "halt", "total", "enriched", "pending", "enriching", "empty", "failed", "startedAt" }`.
Safe to poll while idle. `halt` is `null` when healthy, otherwise
`{ "reason", "detail", "at" }` — see [Halts](#halts).

### POST /api/enrichment/resume
Clear a halt and start a run immediately: the "I've fixed it" action behind the dashboard
banner. Response `{ "resumed": true, "queued": N }`; `400` if there is still no Apify key.

### POST /api/enrichment/pause
Stops claiming new work; in-flight requests finish. Every claimed-but-unprocessed row is
returned to `pending`, so **nothing is ever stranded in `enriching`**. Response:
`{ "paused": true|false }` — `false` means nothing was running. Restarting resumes exactly
where it stopped.

### POST /api/enrichment/retry-failed
Re-arms every `failed`/`empty` row back to `pending` with attempts zeroed.
Response: `{ "requeued": N }`. Never happens automatically.

### POST /api/connections/:slug/refresh
Re-scrape one person immediately. Response `{ "status": "enriched" | "empty" }`; `404` for an
unknown slug, `502` when Apify fails. Works during a halt — one deliberate profile is how you
test whether the problem is fixed.

### Halts

Because enrichment now runs unattended, a broken *account* must not be mistaken for broken
*profiles*: three attempts park a row as `failed`, which only `retry-failed` undoes, so an
expired key would otherwise convert the whole roster into rows needing manual rescue. Errors
that are not a given profile's fault therefore stop the run, leave the rows `pending` with
their attempt counts untouched, and latch a halt that the dashboard shows.

| `reason` | Raised when |
|---|---|
| `no_api_key` | there is work to do and no key is configured |
| `auth` | Apify returned 401/403 — key rotated or revoked |
| `billing` | Apify returned 402 — plan out of credit |
| `rate_limit` | Apify returned 429 |
| `upstream` | Apify returned 5xx |
| `repeated_errors` | 5 profile-level failures in a row with no success between them |

While halted, the 60-second tick stands down — a reported problem must not be retried 1,440
times a day. Clear it with `resume` (or `start`), or let a run that successfully enriches
somebody clear it as a side effect. A run that enriched nothing leaves the halt standing,
because it disproved nothing. `GET /api/status` carries the same object as `enrich_halt`.

### The Apify key
Set it with `POST /api/settings` `{ "apify_api_key": "…" }`. It is **write-only**:
`GET /api/settings` returns `apify_key_set: true|false` and never the key itself — and
neither does the `POST` response, which echoes the same sanitized shape.

## Event invites

The third pipeline: invite 1st-degree connections to a LinkedIn event, filtered by
location. It does **not** use cohorts, profiles or campaign kinds — an event invite is a
different LinkedIn quota from a connection request, with its own caps.

**How it works.** Your list is matched against the connections roster, then bucketed by
location (US by state, everything else by country) and ranked by how many of *your list*
each bucket holds. A run works `event_bucket_ceiling` buckets, filtering to one location
at a time, paging the invitee list, ticking every match by member URN, and submitting per
bucket. Whoever is left rolls into the next day's run, until the list is exhausted or the
event starts.

**It is best effort, by design.** LinkedIn hard-caps the invitee list at 1000 rows in a
stable order, so a bucket bigger than that is only partly listable (oversized buckets are
sub-sharded by child geo to claw some of it back). People with no country, or in the US
with no state on record, can never be reached at all. The draft screen states projected
reach before you arm anything.

Only URNs on your list are ever ticked, so a mis-resolved location can lose coverage but
can never invite the wrong person.

The browser always opens the event with `?viewAsMember=true`: an event **you organize**
renders the organizer console by default — no Attend button, no Share control — which the
run would otherwise report as `no Share control — not an event page, or no access`. The
member view has both, and the parameter is ignored on events you don't organize.

### POST /api/events
Create a campaign as a **draft**. Nothing is sent until you arm it.
```json
{ "event_url": "https://www.linkedin.com/events/7486088214579982336/",
  "profile_urls": ["https://www.linkedin.com/in/some-slug"] }
```
`text` may be sent instead of `profile_urls` to paste a blob and have URLs extracted.
Responds `201` with the campaign, its ranked buckets, and — importantly — `rejected`
(URLs that are not connections) and `unreachable` (connections with no usable location),
each listed by URL so nothing fails silently mid-run.

An event has at most one campaign, but creating again for the same URL while that campaign
is still a **draft** is not an error: the list is folded into the draft exactly as
`POST /api/events/:id/invitees` would (plan re-ranked, reachability recomputed), and the
response is `200` with `merged: true` instead of `201`. So "add more people to the same
event" is simply creating it again. Once the campaign is armed, running, or closed, a
repeat create gets a `400` that says why.

### POST /api/events/:id/invitees
Add more people to a **draft**: `{ "profile_urls": [...] }`, or `text` to paste a blob.
This is what the Connections screen's "Invite to event" posts when you pick an existing
draft, so a list can be assembled from several searches.

The whole location plan is **re-ranked** from the full list, not appended to — one extra
person can make a location worth working ahead of another. Every invitee's reachability is
recomputed too, so someone who was `unreachable` at creation and has since been enriched
comes back onto the list. `409` once the campaign is armed, because the resume cursor
indexes into that bucket list. Responds like `POST /api/events`.

### GET /api/events · GET /api/events/:id · GET /api/events/:id/invitees
The list, one campaign in full (buckets, counts, reserved window, recent runs with live
per-bucket progress), and the invitee ledger.

### POST /api/events/:id/buckets/remove
`{ "ranks": [3, 7] }` — drop buckets before arming; remaining ranks close up. Rejected
with `409` once armed, because the resume cursor indexes into that list.

### POST /api/events/:id/arm
Draft → armed, and claims a run window. Refused if the event has already started or
nothing on the list is reachable.

### POST /api/events/:id/dry-run
Everything except the submit: resolves the geo, pages the list, ticks the matches, asserts
the counter, then discards the selection. Sends nothing, records no invites, does not
advance the cursor. Use it to see real reach before arming.

### POST /api/events/:id/run-now · POST /api/events/:id/stop
Run immediately rather than waiting for the reserved window; or close the campaign and
release its window.

### POST /api/events/:id/reopen
Failed/stopped → **draft**, so a campaign killed by a page problem can be re-armed once
the cause is fixed. Invitees, buckets and the cursor are untouched — arming re-validates
everything. `409` for a `done` campaign: that means everyone reachable was invited or the
event already started, and neither is undone by reopening.

### Scheduling
An armed campaign reserves `event_run_budget_minutes` (default 20) in the largest free gap
of the working day, and the send planner routes invite/message batches around that window
rather than colliding with it. `events_per_day` (default 1) caps live runs per day. The
time budget gates *starting* another bucket — a bucket in flight always finishes, so the
worst-case overrun is one bucket.

### Settings
`events_per_day`, `event_invite_cap` (lifetime per event, default 500),
`event_bucket_ceiling` (locations per run, default 10), `event_run_budget_minutes`,
`event_shard_threshold` (roster size above which a bucket is sub-sharded, default 900).

## Post engagements

The fourth pipeline: react to a LinkedIn post, optionally with a comment. Like event invites
it does **not** use cohorts, profiles or campaign kinds — a post is not a person — but it is
drained by the same sender tick as invites and messages, behind the same pause, guardrail,
working-hours and browser-lock rails, with its own caps.

There is **one row per post**, keyed on the post URN and never on the URL (the same post is
reachable as `/feed/update/<urn>/`, `/posts/<slug>-activity-…`, `/posts/<slug>-share-…` and
`?updateId=…`, so deduping on the URL would dedupe nothing). Statuses are
`queued` → `scheduled` → `sending` → `sent`, plus `skipped`, `failed` and `needs_attention`;
`skip_reason` is one of `not_found`, `unavailable`, `comments_disabled` or `dismissed`. There
is no acceptance or reply funnel — `attempts`, `last_error`, `reacted_at` and `commented_at`
on the row are the whole history.

Four behaviours are worth reading before you call anything here.

**Shortlinks are expanded server-side.** A `lnkd.in/…` reference (with or without a scheme —
a mobile share sheet omits it) is followed with an unauthenticated `GET` before validation:
at most 3 hops, 5s per hop, and across one bulk request at most 4 in flight under a total
15s budget. Whatever the budget cuts off, plus anything that redirects off `linkedin.com`,
is rejected as `shortlink_unresolvable` — paste the full post URL instead. The **expanded**
URL is what gets parsed and stored.

**The URN is the identity, and it can change after enqueue.** A share-link slug carries a
different number from the post's own `data-urn` — observed live: slug `7489401095899770880`
against `urn:li:activity:7489401096851906561` for one post. So the `post_urn` you get back at
creation is **provisional**: the driver reads the canonical URN off the live post on first
execution and reconciles the row to it. If that canonical URN turns out to be held by another
row, this row is the redundant one and is retired as `skipped` with
`skip_reason: "dismissed"` rather than engaging with the same post twice.

**A comment is always paired with a reaction.** There is no comment-only engagement; `comment`
rides along with the `reaction` on the same task. An all-whitespace `comment` is stored as
`null` — otherwise it would claim a slot against the daily comment cap and then publish
nothing.

**A reaction is never replaced.** If the post already carries one of your reactions, the
engine records that, logs which one it found, and leaves it alone. The LinkedIn control is a
toggle: clicking it while your reaction is on the post **removes** the reaction, so switching
one is not something this pipeline will do to a reaction you placed by hand.

### POST /api/engagements

Enqueue one post, or many. Single form:

```json
{ "post_url": "https://www.linkedin.com/feed/update/urn:li:activity:7489401096851906561/",
  "reaction": "insightful",
  "comment": "Useful framing — thanks for writing it up." }
```

- `post_url` (required) — a post URL in any of the forms above, a bare
  `urn:li:activity:…` / `urn:li:ugcPost:…` / `urn:li:share:…`, or a `lnkd.in` shortlink.
- `reaction` (optional) — one of `like`, `celebrate`, `support`, `love`, `insightful`,
  `funny`. **Defaults to `like`** when absent. Unlike `kind` on `/api/profiles`, absent is a
  real default here: a mis-defaulted reaction is cosmetic, where a mis-defaulted campaign kind
  sends an unsendable request.
- `comment` (optional) — literal text, no templates and no `{firstName}` substitution. Max
  1250 characters.

Responds `201` with the created row, re-read after planning so its `status` and
`scheduled_for` are the ones planning just assigned:

```json
{ "id": 7, "post_url": "https://www.linkedin.com/feed/update/urn:li:activity:7489401096851906561/",
  "post_urn": "urn:li:activity:7489401096851906561", "reaction": "insightful",
  "comment_text": "Useful framing — thanks for writing it up.", "status": "scheduled",
  "attempts": 0, "last_error": null, "skip_reason": null,
  "scheduled_for": "2026-08-02T14:05:00.000Z", "reacted_at": null, "commented_at": null,
  "priority": 0, "created_at": "2026-08-02T11:20:14.000Z" }
```

Bulk form — `{ "items": [ { post_url, reaction?, comment? }, … ] }` — reports rejects **by
URL and reason**, the way `POST /api/events` does, because finding out mid-run that a URL was
junk is far too late:

```json
{ "added": 2,
  "engagements": [ { "id": 8, "…": "…" }, { "id": 9, "…": "…" } ],
  "rejected": [ { "post_url": "https://lnkd.in/p/deadbeef",
                  "reason": "shortlink_unresolvable",
                  "message": "could not expand the shortlink https://lnkd.in/p/deadbeef — open it and paste the full post URL" } ] }
```

**The bulk form always answers `201`, even when everything was rejected** (`added: 0`) — the
per-item verdicts are the payload, not the status code. The single form is the one that turns
a reject into an HTTP error: `400`, or `409` for a duplicate, with the reject's `message` as
`error`. `{ "items": [] }` is `400 no items supplied`. A non-object entry inside `items` is
kept and reported as an `invalid_url` reject rather than silently vanishing from the count.

| `reason` | Single-form status | Meaning |
|---|---|---|
| `invalid_url` | `400` | `post_url` is not a recognizable LinkedIn post reference (or was empty/missing) |
| `shortlink_unresolvable` | `400` | a `lnkd.in` link that could not be followed inside the hop/time bounds, or that redirected off `linkedin.com` |
| `unknown_reaction` | `400` | `reaction` is not one of the six |
| `comment_too_long` | `400` | `comment` is over 1250 characters |
| `duplicate` | `409` | this post already has a row; the message names its id and status |

Two items naming the same post inside **one** bulk request resolve correctly: the second is a
`duplicate` reject against the first one's insert.

Creation runs a planning pass immediately, so a task enqueued at 09:05 gets a real slot
instead of sitting until the hourly tick — same reasoning as `POST /api/lists`, and with the
same gates: planning still declines while paused, halted, outside working hours or on a
non-sending day.

```
curl -s http://localhost:4400/api/engagements \
  -H 'content-type: application/json' \
  -d '{"post_url":"https://lnkd.in/p/dkTR-yYF","reaction":"insightful"}'
```

```
curl -s http://localhost:4400/api/engagements \
  -H 'content-type: application/json' \
  -d '{"items":[{"post_url":"https://www.linkedin.com/feed/update/urn:li:activity:7489401096851906561/"},
                {"post_url":"urn:li:activity:7488617458552070144","reaction":"celebrate","comment":"Congrats!"}]}'
```

### GET /api/engagements?status=X&limit=N
Engagement rows, **newest first** (`id DESC`, so a limit keeps the newest rather than the
oldest). `limit` defaults to **200** and is clamped to **500**; anything non-finite, zero or
negative falls back to the default. `status` is optional and must be one of the seven
statuses — an unknown one is a `400`, not a silently-dropped filter, because an empty list
would otherwise read as "no such rows".

```
curl -s 'http://localhost:4400/api/engagements?status=needs_attention&limit=20'
```

### GET /api/engagements/:id
One row. `404` if unknown.

### POST /api/engagements/:id/retry
Requeue one row: back to `queued` with `scheduled_for`, `last_error`, `skip_reason` and
`commented_at` cleared. `404` if unknown, `409` unless its status is `failed`,
`needs_attention` or `skipped`.

`needs_attention` is retryable **on purpose**. Parking an unverified comment exists so a human
can open the post and decide, and retry is how they say "I checked, it did not post". Nothing
is re-driven twice: the sender's comment step is guarded on `commented_at` and its reaction
step on `reacted_at`, so a retry after a landed reaction re-drives only what is missing.

Clearing `commented_at` is what makes that statement true. The sender stamps it on an
**unverified** comment as well as a confirmed one — the submit click is irreversible, so it
has to cost a slot of `engage_comment_daily_cap` whether or not the confirmation read
succeeded — so on a parked row the timestamp means "may be live". Retry unwinds exactly that:
it refunds the budget slot and re-opens the comment guard. `reacted_at` is deliberately left
standing; a confirmed reaction is never re-driven.

Note that the bulk `POST /api/retry` walks the **profiles** table only — engagements are
retried one row at a time.

### POST /api/engagements/:id/dismiss
Terminal skip (`skipped`, reason `dismissed`), and also the cancel path for a row that has not
run yet. `scheduled_for` is cleared rather than left standing, so a dismissed row stops
answering `/api/status`'s `next_scheduled` question. `404` if unknown.

### Settings
`engage_weekly_cap` (reactions per rolling 7 days, default 500), `engage_batch_size` (15),
`engage_batches_per_day` (6), `engage_comment_daily_cap` (published comments per day, 10).
15 × 6 = 90 reactions a day, 450 a week under the 500 cap. The comment sub-cap is separate
because 90 comments a day under the operator's own name is a materially different risk from
90 likes; it is applied at **planning** time as well as at send time, so comment-bearing tasks
do not sit consuming slots they can never use.

#### Ranges

**Every numeric setting below is range-checked on `POST /api/settings`, and the whole patch is
validated before anything is written.** If any key in the patch fails, the response is `400`
and **nothing in the patch is applied — not even the keys that were fine.** There is no partial
write to reason about: either every key in the request took effect, or none did. Retry with a
corrected patch rather than assuming the good half already landed.

All 28 keys below take whole numbers only; a non-integer or out-of-range value fails the same
way. `min` and `max` are both inclusive.

| Key | Range | Key | Range |
|---|---|---|---|
| `weekly_cap` | 0–150 | `batch_size` | 1–25 |
| `batches_per_day` | 0–12 | `msg_weekly_cap` | 0–700 |
| `msg_batch_size` | 1–10 | `msg_batches_per_day` | 0–12 |
| `reply_checks_per_day` | 1–4 | `events_per_day` | 0–2 |
| `event_invite_cap` | 1–1000 | `event_bucket_ceiling` | 1–50 |
| `event_run_budget_minutes` | 1–120 | `engage_weekly_cap` | 0–1000 |
| `engage_batch_size` | 1–50 | `engage_batches_per_day` | 0–12 |
| `engage_comment_daily_cap` | 0–50 | `posts_sweep_per_day` | 0–4 |
| `posts_max_per_sweep` | 1–25 | `posts_retention_days` | 1–365 |
| `tracked_profile_cap` | 1–1000 | `workday_start_hour` | 0–23 |
| `workday_end_hour` | 0–23 | `roster_sync_per_day` | 1–24 |
| `min_delay_ms` | 5000–600000 | `max_delay_ms` | 5000–600000 |
| `enrich_ttl_days` | 1–3650 | `enrich_concurrency` | 1–32 |
| `event_shard_threshold` | 1–1000 | `posts_sweep_batch_size` | 1–1000 |

The five `posts_*` / `tracked_*` keys are the only ones whose ceiling bounds **money** rather
than LinkedIn risk: they multiply into a pay-per-result Apify bill (profiles × posts-per-profile
× sweeps-per-day) that nothing downstream re-checks, because the sweep runs unattended. In
particular `posts_max_per_sweep` **cannot be 0** — it reaches the actor as `maxPosts`, where 0
means *all posts, ever*, which is also what an operator types to mean "off". `posts_sweep_per_day`
is the one that may be 0; it only gates the tick, so 0 means "never sweep automatically".

Two rules also compare a key against another one, not just against its own range:

- `workday_end_hour` must be **strictly after** `workday_start_hour`. Equal is rejected, not
  just inverted — an end hour equal to the start hour is a zero-length send window, which would
  otherwise silently schedule nothing.
- `max_delay_ms` must be **at least** `min_delay_ms`. Equal **is** allowed here — a fixed delay
  (no jitter) is a deliberate, valid configuration, unlike a zero-length workday.

Both rules read against the **stored** value for whichever side the patch doesn't touch — a
patch that sends only `workday_end_hour` is still checked against the `workday_start_hour`
already saved, not skipped. Conversely, a rule does not fire at all when the patch touches
**neither** of its two keys — an install can already hold an inverted or equal pair (nothing
enforced this before these rules existed), and re-validating it on every unrelated patch would
leave that operator unable to change anything else, including pausing.

The `400` body:

```json
{ "error": "Workday end hour must be after the start hour (currently 9).", "fields": [{ "key": "workday_end_hour", "message": "Workday end hour must be after the start hour (currently 9)." }] }
```

**This shape is unusual for this API — most error bodies here carry just an `error` string**
(see `POST /api/profiles`'s `{ "error": "invalid linkedin profile url" }`, or the FTS `400`).
`POST /api/run-now` folds `error` into a larger response alongside `ok`/`belt`/`code`, but even
that carries only ever one error, not a list. Settings is the only endpoint that reports
**multiple, independent** failures via `fields`, because one patch can violate several unrelated
keys at once — a single profile URL or message template can't. `error` always repeats
`fields[0].message` — that's the one sentence to relay to a non-technical operator. `fields` is
the full list, for anything that
wants to know about every failure, not just the first.

Ordering is deterministic: per-field failures come back in the same order as the table above,
then any cross-field failures. So the same patch always produces the same `error` sentence,
regardless of what order the keys appear in the request body.

Not every allow-listed key is range-checked — these seven pass through unvalidated: `paused`,
`pause_reason`, `onboarded`, `weekdays_only`, `note_quota_exhausted`, `expiry_days`,
`apify_api_key`.

`GET /api/settings` returns this same table under a `rules` property, shaped
`{ "<key>": { "label", "min", "max" } }`. The dashboard's Settings form reads it to configure
each input's bounds rather than hardcoding them twice. `label` is the operator-facing name for
the key and is what appears verbatim inside `message` above.

## Posts

The fifth pipeline, and the only one that discovers its own work rather than waiting to be
told: track a set of profiles, and their recent posts are pulled in automatically by a sweep
so you can react to (and optionally comment on) the ones worth engaging. Sweeping and acting
are two different steps — this section covers both, in the order the feed uses them.

**`tracked_profiles`** is the watch list. Untracking (`DELETE /api/tracked-profiles/:id`) is
soft — `active` goes to 0 — rather than a real delete, because deleting the row would orphan
every post already stored against it. It is capped at `tracked_profile_cap` (default 200);
see the reject table below for what happens at the boundary.

**`posts`** is one row per post ever swept, keyed on the post's URN exactly like
`engagements.post_urn` — `INSERT OR IGNORE` on that key is what makes re-sweeping a profile
idempotent with no cursor to maintain: a post already stored is silently skipped rather than
duplicated. A post is **not** itself a queued action; `engagement_id` links it to a row in
`engagements` (the pipeline documented above) once you ask to engage with it, and everything
about pacing, reactions, comments and retries from that section applies unchanged.

### POST /api/tracked-profiles
Start tracking one or more profiles. Two input shapes:

```json
{ "profile_urls": ["https://www.linkedin.com/in/jane-doe/", "https://www.linkedin.com/in/john-smith/"] }
```
```json
{ "text": "Worth watching: https://www.linkedin.com/in/jane-doe/ and linkedin.com/in/john-smith" }
```

- `profile_urls` — an array (the Connections table's "Track posts" button sends this shape);
  stored with `source: "search"`.
- `text` — a pasted blob; profile URLs are extracted out of it, same extractor as the invite
  paste box. Stored with `source: "urls"`.

Re-adding a URL that was previously untracked **reactivates** it rather than erroring — the
old row, and its post history, comes back instead of a second row being created — and that
reactivation consumes a cap slot exactly like a fresh add.

Always `201`, even when every URL was rejected — like the bulk engagement endpoints, the
per-item verdicts are the payload, not the status code:

```json
{ "added": 2, "ids": [14, 15],
  "rejected": [ { "profile_url": "not a url", "reason": "invalid_url",
                  "message": "not a LinkedIn profile URL: not a url" } ] }
```

| `reason` | Meaning |
|---|---|
| `invalid_url` | not a recognizable LinkedIn profile URL (or empty) |
| `already_tracked` | already active on the watch list; the message names its id |
| `cap_reached` | `tracked_profile_cap` is already met |

**The cap fills partially — it does not reject the whole batch.** Each successful add
consumes a slot before the next item is checked, so a batch straddling the cap stops exactly
there: 180 already tracked plus 50 submitted **adds 20 and rejects the remaining 30** as
`cap_reached`, rather than accepting none or all fifty.

```
curl -s http://localhost:4400/api/tracked-profiles \
  -H 'content-type: application/json' \
  -d '{"profile_urls":["https://www.linkedin.com/in/jane-doe/"]}'
```

### GET /api/tracked-profiles
The watch list, plus how many posts each profile has yielded:

```json
{ "tracked": [ { "id": 14, "profile_url": "https://www.linkedin.com/in/jane-doe",
                  "connection_id": 208, "full_name": null, "headline": null,
                  "source": "search", "active": 1, "last_swept_at": "2026-08-04T06:00:11.000Z",
                  "last_sweep_error": null, "created_at": "…", "post_count": 6 } ],
  "cap": 200, "swept_at": "2026-08-04T06:00:11.000Z" }
```

`post_count` is unconditional — it includes posts already engaged with, not just fresh ones,
because it is a yield figure for the operator, not a work-queue depth. `swept_at` is the
app-wide gate stamp (`app_state.posts_swept_at`), set only on a clean pass; it can trail an
individual profile's own `last_swept_at` if that profile's sweep succeeded while another one
in the same pass failed.

```
curl -s http://localhost:4400/api/tracked-profiles
```

### DELETE /api/tracked-profiles/:id
Untrack. Soft — `active` goes to 0; the row and its posts stay. `404` if unknown.

```
curl -s -X DELETE http://localhost:4400/api/tracked-profiles/14
```

### GET /api/posts?filter=new|queued|engaged&limit=N&before=cursor
One page of the feed, newest post first, plus everything the screen's header needs in one
round trip.

`filter` (default `new`) is a **partition**: every post on an active tracked profile lands in
**exactly one** of the three chips, never none and never two.

- **`engaged`** — the linked engagement has a `reacted_at`. This outranks `status`, because a
  reaction on LinkedIn is a fact and a status is only bookkeeping about the task that produced
  it — the two can disagree, which is exactly the case below.
- **`new`** — no engagement at all, **or** one whose status ended `failed` or `skipped`
  **without** having reacted. That second clause is what makes such a post *retryable from the
  feed* — see `POST /api/posts/:id/engage` below.
- **`queued`** — an engagement that has not reacted and is **not** `failed`/`skipped`. That
  includes `needs_attention`: a human still has to act on it, so it counts as in-flight, not
  as work that has stalled out.

**A post whose reaction landed but whose comment then failed shows as `engaged`, not `new`.**
The reaction is already live on LinkedIn — the feed must not offer to queue it again (doing so
would just `409` on the duplicate URN). Fixing the comment is
`POST /api/engagements/:id/retry` (see Post engagements above), reachable from the Attention
list.

An unrecognized `filter` is `400` rather than silently falling back to `new` — an empty
result from a misspelled filter should look like a mistake, not a real answer.

`limit` defaults to 25, clamps to 100. `before` is the opaque `next_cursor` from the previous
page — keyset pagination, not offset, because the sweep inserts rows between requests and an
offset would skip or repeat posts as the set shifts underneath the reader. **A malformed
`before` is a `400`.**

```json
{ "posts": [ { "id": 37, "post_urn": "urn:li:activity:…", "post_url": "…",
               "tracked_profile_id": 14, "author_name": null, "author_headline": null,
               "content": "…", "posted_at": "2026-08-04T05:40:00.000Z", "is_repost": 0,
               "reaction_count": 12, "comment_count": 3, "engagement_id": null,
               "first_seen_at": "2026-08-04T06:00:11.000Z", "raw_json": "…", "created_at": "…",
               "engagement_status": null, "engagement_reaction": null,
               "engagement_reacted_at": null, "author_display": "Jane Doe",
               "headline_display": "VP Security @ Acme" } ],
  "filter": "new",
  "counts": { "new": 4, "queued": 1, "engaged": 9 },
  "next_cursor": "2026-08-04T05:40:00.000Z|37",
  "tracked": 12,
  "swept_at": "2026-08-04T06:00:11.000Z",
  "halt": { "halted": 0, "reason": null, "detail": null, "at": null },
  "cost_30d": { "posts": 214, "usd": 0.428 } }
```

`counts` is the same total partition as `filter`, computed once and returned alongside the
page so the chip labels don't need a second request. `halt` rides along for the same reason —
the screen renders its red banner without a second round trip. `cost_30d` is **informational
only, with no enforcement** (a spend ceiling was explicitly declined): it is
`{ posts stored in the trailing 30 days } × $0.002`, the conservative end of Apify's
pay-per-result pricing for this actor.

```
curl -s 'http://localhost:4400/api/posts?filter=new&limit=25'
```

### POST /api/posts/:id/engage
Queue one post's reaction (and optional comment) from the feed. `404` if the post is unknown.

```json
{ "reaction": "insightful", "comment": "Useful framing — thanks for writing it up." }
```

Both fields are optional and behave exactly as on `POST /api/engagements`: `reaction`
defaults to `like`; `comment` is literal text, capped at 1250 characters, and an all-
whitespace comment is stored as no comment at all. Every validation judgement — the six
reactions, the comment length — is delegated to the same `createEngagement` the main
engagements endpoint uses, so the two rule sets never drift apart.

Three outcomes:

- **Fresh queue (`201`)** — no engagement existed for this post yet:
  `{ "post_id": 37, "engagement": { "id": 41, "…": "…" } }`.
- **Re-queue (`201`, `requeued: true`)** — the post already had a **retryable** engagement
  (not reacted, and `failed`/`skipped`) — the same condition that put it in the feed's `new`
  chip in the first place. **The original reaction and comment are kept**: a queued task is
  immutable after creation, so this re-drives the existing task rather than overwriting its
  text with whatever (or nothing) this request happened to carry.
  `{ "post_id": 37, "engagement": { … }, "requeued": true }`.
- **Conflict (`409`)** — the post already has a **non-retryable** engagement (reacted, or
  still in flight): `{ "error": "already reacted as engagement 41 (failed) — use retry to
  re-run the comment" }` or `{ "error": "already queued as engagement 41 (scheduled)" }`.

```
curl -s http://localhost:4400/api/posts/37/engage \
  -H 'content-type: application/json' \
  -d '{"reaction":"insightful","comment":"Useful framing."}'
```

### POST /api/posts/engage
Bulk: one reaction across several selected posts.

```json
{ "post_ids": [37, 38, 41], "reaction": "celebrate" }
```

**There is no `comment` field, and it is not an oversight.** Identical comment text stamped
across several posts under your own name is a recognizable spam pattern, and
`engage_comment_daily_cap` defaults to 10/day — one careless bulk click would spend the day's
entire comment budget looking automated. Comments stay per-post, through
`POST /api/posts/:id/engage` above.

`reaction` is validated **once**, up front, for the whole batch — a bad reaction is one
mistake, and half-applying it would leave real queued rows for the operator to undo by hand.
Absent defaults to `like`.

Per post, the same three outcomes as the single-post route apply — a re-selected retryable
post is **re-queued and keeps its own existing reaction**, not switched to whatever this
request asked for:

```json
{ "added": 2, "post_ids": [38], "adopted": [], "requeued": [37], "rejected": [
    { "post_id": 41, "reason": "duplicate", "message": "already reacted as engagement 9 (failed) — use retry to re-run the comment" } ] }
```

`post_ids` is the **freshly created** set only. `adopted` and `requeued` are reported under
separate keys precisely so a caller can tell "created" from "an existing task was linked or
re-driven" — folded together, a re-selected `celebrate` post that comes back re-queued under
a newly-chosen `insightful` would look exactly like a fresh create, and only a feed refetch
would show otherwise. `added` is the one number to read out loud:
`post_ids.length + adopted.length + requeued.length`.

Always `201`; the per-item verdicts are the payload, same contract as `POST /api/engagements`.
No valid post ids in the body is `400`.

```
curl -s http://localhost:4400/api/posts/engage \
  -H 'content-type: application/json' \
  -d '{"post_ids":[37,38,41],"reaction":"celebrate"}'
```

### POST /api/posts/sweep-now
Sweep every tracked profile immediately, ignoring the once-per-day slot and — unlike the
scheduled pass — **ignoring `paused`** too.

**Long on purpose: it answers only after the whole Apify run finishes. Do not retry it.**
Same shape as the per-belt "Run now".

`409` if a sweep is already running (the worker refuses re-entry itself; this is the readable
version of that refusal, so an impatient double-click gets an explanation instead of a raw
500). `400` if nothing is tracked, or if no Apify API key is configured.

**This is also the operator's way out of a latched halt.** A manual sweep is read as "try
again", so it clears `posts_halted` (and its reason/detail) *before* running — a fresh attempt
gets a clean slate rather than immediately re-latching on the strength of the previous
failure.

```json
{ "runs": 1, "profilesSwept": 12, "postsAdded": 6, "postsRejected": 0, "unattributed": 0,
  "unusable": 2, "reshares": 9, "pruned": 3, "clean": true }
```

Three separate counts for three unrelated reasons an item didn't become a post, and only the
last is a fault:

- `reshares` — bare reshares, skipped by design because the words are the original author's
  and not the tracked profile's. Around **31%** of what the actor returns, so this is normally
  the largest of the three. A big number here is the feature working.
- `unusable` — nothing at the top level to react to: a caption-less image or video, or a
  reshare-with-commentary where no commentary was actually added. Around 9%.
- `unattributed` — matched no tracked profile. The only one worth investigating, and the only
  one that hints at a URL-normalization problem.

All three are non-fatal; `clean: false` is what actually means "something needs attention" —
check the log.

```
curl -s -X POST http://localhost:4400/api/posts/sweep-now
```

## Queue

### GET /api/profiles?status=X&kind=Y
Up to 500 profiles, newest first, optionally filtered by status and/or kind
(`invite` | `message`; any other value is ignored rather than erroring):
`[{ "id", "profile_url", "kind", "status", "skip_reason", "scheduled_for", "sent_at", "accepted_at", "replied_at", "last_error", "cohort_name" }]`.

Statuses are `queued` → `scheduled` → `sending` → `sent`, then `accepted` (invites) or
`replied` (messages); plus `expired`, `skipped`, `failed`, `needs_attention`.
`skip_reason` is one of `already_connected`, `email_required`, `unavailable`, `not_found`,
`dismissed`, or — messages only — `not_connected` (the profile turned out not to be a
1st-degree connection, so nothing was sent rather than risk an InMail).

### GET /api/queue?limit=N
Flat upcoming work, both kinds interleaved: `{ "upcoming": [{ "id", "profile_url", "kind", "status", "scheduled_for", "cohort_name", "note" }], "total_remaining": N }`.

### GET /api/queue/grouped
Queue grouped by cohort in send-priority order: `{ "cohorts": [{ "id", "name", "count", "profiles": [{ "id", "profile_url", "kind", "status", "scheduled_for", "note" }] }], "events": [...] }`.
Every profile in a cohort has the cohort's kind, so the first row identifies the group. That
invariant is enforced at every write path: `POST /api/lists`, `POST /api/cohorts` and
`POST /api/profiles` all `409` on a cross-kind add, and a cohort's kind is fixed at creation.

`events` holds at most the ONE armed campaign that will run next — the same one
`status.event.next_run` names — because a run books the browser for a reserved block and
competes with the cohorts below it for the day. Its rows are locations, not profiles:
`[{ "id", "title", "event_url", "status", "pending", "reserved_from", "reserved_to", "locations_left", "buckets": [{ "rank", "label", "target_count", "roster_count" }] }]`.
`reserved_from` is `null` when the day has not yet given it a window. Drafts never appear:
they will not run until somebody arms them. None of the reordering endpoints below apply —
an event run's place in the day belongs to the planner.

### Reordering & removal
- `POST /api/queue/profile/:id/move` — body `{ "to": "top" | "bottom" }`.
- `POST /api/queue/profile/:id/remove` — soft-remove (marks skipped).
- `POST /api/queue/cohort/:id/move` — body `{ "to": "top" | "bottom" }`.
- `POST /api/queue/cohort/:id/remove` — soft-remove all queued/scheduled in the cohort.
- `POST /api/queue/cohorts/reorder` — body `{ "order": [cohortId, …] }`.

## Attention (failures)

Both kinds land here, so every row carries its `kind`. **Two pipelines land here too**, so
every row carries a `source` discriminator as well.

- `GET /api/attention` — failed + needs_attention rows from the profile and engagement
  pipelines, with their errors. Two row shapes in one list:
  - `{ "source": "profile", "id", "profile_url", "kind", "status", "last_error", "attempts", "sent_at", "scheduled_for", "cohort_name" }`
  - `{ "source": "engagement", "id", "post_url", "post_urn", "reaction", "comment_text", "status", "last_error", "attempts", "scheduled_for", "reacted_at", "commented_at" }`

  **Switch on `source` before doing anything with an `id`.** Ids are per-table, so posting an
  engagement's id to `/api/profiles/:id/retry` retries whichever profile happens to share that
  number. The tag is on the profile rows too, not only the new ones — a discriminator only one
  side carries is one every reader has to guess about. Profiles come first, then engagements,
  each newest-first; there is no meaningful order to interleave two id spaces into.
- `POST /api/retry` — requeue every failed / needs_attention **profile**, both kinds. Response
  `{ "ok": true, "retried": N }`. Engagements are not touched: retry them one row at a time
  with `POST /api/engagements/:id/retry`.
- `POST /api/profiles/:id/retry` — requeue one. `404` if unknown. `409` unless its status is
  `failed`, `needs_attention` or `skipped`: retry re-queues for a *fresh* send, so retrying
  a `replied`/`accepted`/`sent` profile would contact the same person twice.
- `POST /api/profiles/:id/dismiss` — give up on one (skipped, reason `dismissed`). `404` if unknown.

## Login

- `POST /api/login` — open the LinkedIn login window. Returns immediately; the window
  opens in the background once the shared browser lock is free.
- `GET /api/login-status` — whether the persisted session is still logged in.

## Ops

- `POST /api/pause`, `POST /api/resume` — halt/continue sending. One pause covers both kinds.
- `POST /api/run-now` — trigger one pipeline's next batch manually. Full detail in
  **POST /api/run-now** below.
- `POST /api/recheck-acceptance` — reconcile acceptances now (read-only; runs even while
  paused). Returns the acceptance-check result.
- `POST /api/recheck-replies` — same contract for the messages funnel: one read of the
  messaging inbox, read-only, runs even while paused. Returns
  `{ "ran", "reason"?, "replied", "ambiguous"?, "unmatched"?, "checkedAt"? }`. `ran: false`
  with a `reason` (`no_pending`, `logged_out`, `login_lost`, `read_error`, `empty_read`,
  `guardrail`) means nothing changed and the day's slot was not consumed. `ambiguous` and
  `unmatched` are counts of profiles (not rows) deliberately left pending — see
  **Reply tracking** below.
- `GET /api/settings`, `POST /api/settings` — pacing/limits (allow-listed keys only). Every
  numeric key is range-checked on write; a `400` applies **nothing** in the patch, not even the
  keys that were fine — see **Ranges** under Settings above. Message-side keys:
  `msg_weekly_cap` (default 250), `msg_batch_size` (5),
  `msg_batches_per_day` (6), `reply_checks_per_day` (2). Engagement-side keys:
  `engage_weekly_cap` (500), `engage_batch_size` (15), `engage_batches_per_day` (6),
  `engage_comment_daily_cap` (10). Values are stored as given — pass numbers, not numeric
  strings.
- `GET /api/logs?tail=N`, `GET /api/logs/download` — run log.

### Lifecycle: restart & update

The app does not restart or update itself — it writes a request to `data/control.json`, drains
the browser lock, and exits with a code `scripts/supervisor.mjs` acts on (`42` restart, `43`
update). **There is no Stop endpoint**, deliberately: with a login-launched service, "stopped"
means "until the next login", and nothing would be left to serve the request that undoes it.
`POST /api/pause` is the reversible equivalent.

- `POST /api/update`, `POST /api/restart` — `202` with `{ ok, action, requested_at }`, then the
  process exits after any in-flight browser work finishes (up to 5 minutes). **Keep
  `requested_at`**: it is how you tell your own request's outcome from a leftover one.
  `409` if a request is already in flight, or if the app was started without a supervisor (in
  which case exiting would simply stop it). Both routes pause sending first, and it stays paused
  after the restart so an operator sees the dashboard before anything goes out.
- `GET /api/update/status` — `{ state, message, action, changes[], requested_at, finished_at,
  supervised }` where `state` is `idle` | `busy` | `done` | `failed`. Backed by
  `data/control.json`, so this is readable **across the restart** — that is the whole point of
  it. `message` is a plain-language sentence intended for the operator; relay it as-is.
  **While waiting, a connection failure is expected**, not an error: it is the window in which
  the process is gone. Poll, ignore transport failures, and only accept a result whose
  `requested_at` matches yours.
- `GET /api/update/check` — `{ available, changes[], checked_at, error? }`. Runs
  `git fetch` + `git log HEAD..origin/main`. Being offline yields `available: 0` with an
  `error`, never a throw — do not surface that as a problem.
- `POST /api/guardrail/acknowledge` — re-check a halt; resumes if logged in and no
  checkpoint on the current page, otherwise re-trips with a `detail` saying which URL
  and pattern is still blocking.
- `GET /api/docs`, `GET /api/docs/:slug` — markdown docs rendered in the **Docs** tab.
- `GET /api/incidents?limit=N` — halt/failure evidence metadata (newest first): what
  page the browser was on, which checkpoint pattern matched, and links to the
  screenshot + HTML snapshot captured at that moment (served under `/incidents/…`,
  stored in `data/incidents/`, newest 60 kept).

### POST /api/run-now

Trigger one pipeline's next batch manually. Body:

```json
{ "belt": "invite" | "message" | "engagement" | "event" }
```

`belt` is optional. Omitting it (or sending `"all"`) means **every sender belt** — invite,
message and engagement together. `event` is never folded into that alias: it has no due-now
queue for `all` to reach into. Each of the four dashboard conveyor cards has its own **Run
now** button posting its own belt; there is no longer one button meaning "invites and
messages together".

A click is two separable steps, reported honestly rather than collapsed into one `{ok:true}`:
**promote** is a durable DB write making that belt's backlog due now, **kick** is a
best-effort attempt to grab the shared browser. `promoted` counts rows now due, not rows
newly moved — a second click at the same instant re-stamps the same rows and reports the same
number. `started` says whether *this* request's kick actually got the browser; losing that
race still leaves the promotion standing, so the next 60s sender tick sends it anyway. That
is the retry rule: on `started: false` you do not need to call again.

```json
{ "ok": true, "belt": "invite", "promoted": 7, "started": true }
{ "ok": true, "belt": "invite", "promoted": 7, "started": false, "deferred": "browser busy" }
{ "ok": true, "belt": "invite", "promoted": 0, "started": false, "deferred": "nothing queued" }
```

`belt: "event"` has no due-now queue at all: "promote" instead rewrites the next armed
campaign's reserved window to start now, and the existing `runEventTick` fires it within 60
seconds. The response deliberately **omits `promoted`** — an event run has no row count to
report, and a hardcoded `1` behind the same field name would mislead a client reading it
uniformly. `started` is always `false` here (there is no synchronous kick to win or lose), so
this shape never carries `deferred` either:

```json
{ "ok": true, "belt": "event", "started": false, "event_id": 3, "from": "…", "to": "…" }
```

Refusals are `409`, checked **before** any promotion — a batch promoted while paused would
all fire the instant the operator resumes, outside the planned spread. Both `code`
(machine-readable) and `error` (the sentence to show) are always present:

```json
{ "ok": false, "belt": "invite", "code": "paused", "error": "Paused — Manual pause" }
```

| `code` | applies to | means |
|---|---|---|
| `paused` | every belt, including `all` | the engine is paused; `error` carries the reason |
| `guardrail` | every belt, including `all` | a checkpoint or failure streak has halted sending |
| `not_logged_in` | every belt, including `all` | no live LinkedIn session |
| `capped` | invite / message / engagement | that belt's weekly cap is spent. Per-belt, so `all` promotes nothing from a capped belt rather than refusing outright |
| `nothing_armed` | `event` only | no armed campaign to run |
| `already_running` | `event` only | a campaign is running right now |
| `daily_cap` | `event` only | `events_per_day` already reached today |

An unrecognised `belt` is `400` (`{ "ok": false, "error": "unknown belt: …" }`) rather than a
silent fallback to `all` — a typo'd belt must never quietly promote every pipeline.

Not a normal outcome, but listed so a client is not surprised by it: `belt: "event"` can
answer `500` with `code: "internal_error"` if the window move fails after pre-flight already
passed. That is unreachable by design — pre-flight and the move are synchronous with nothing
awaited between them — so treat it as a bug to report, not a condition to handle.

Consecutive sends are still paced by `min_delay_ms`/`max_delay_ms`, so a manual batch is not
a fast path: on the three sender belts this call blocks for the whole batch and can
legitimately take minutes. `belt: "event"` is the exception — it returns as soon as the
window is moved, and the campaign itself plays out afterwards in the background. `force: true`
is set on the sender call, so a manual run may fire outside working hours by design.

The older per-campaign `POST /api/events/:id/run-now` (Events tab) is a separate, deliberately
**uncapped** override and is unaffected by any of this.

## Reply tracking

What `replied` / `replied_at` actually mean, since the limits shape how you should read
them. A pass opens the messaging inbox once and, for each conversation row whose last
message is **not** ours, upgrades the matching `sent`/`message` profile to `replied`. It is
upgrade-only: nothing here can un-reply, expire, or otherwise downgrade a profile, and a
failed or empty read changes nothing and does not consume the day's slot
(`reply_checks_per_day`, default 2, one successful pass per equal slot of the day).

Contacts are matched by **display name** — canonicalized (Unicode-normalized,
parentheticals and credential suffixes stripped), plus a looser tier that tolerates one
omitted interior token (a dropped middle name) and nothing looser than that — "Jon A Smith"
never merges into "Jon B Smith". Every ambiguity resolves to "leave it pending", because a
false `replied` is irreversible and permanently strands the real contact. Consequences:

- Two pending contacts whose display names collide are both left pending and counted in
  `ambiguous`. So are two inbox rows that resolve to the same profile.
- A pending contact no row matched at all is counted in `unmatched`. That is a
  matching-health signal, not "hasn't replied yet" — a large `unmatched` means the inbox
  read is not seeing your contacts.
- The inbox is read one page deep with no scrolling, so a reply that has scrolled below the
  loaded slice is missed until it resurfaces (the same top-slice limitation as acceptance
  checking).
- A conversation id would be a stronger key than a name, and the matcher prefers one when a
  row exposes it — but LinkedIn's inbox rows carry no thread href (verified live
  2026-07-29), so in practice name matching does all the work.

A checkpoint hit during the inbox read trips the shared guardrail, which halts both kinds.
