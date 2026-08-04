# Posts feed — design

Date: 2026-08-04
Status: approved (brainstorm complete, awaiting implementation plan)

## Goal

Track a set of LinkedIn profiles, scrape their recent posts periodically via Apify, and present
them as a feed the operator can act on — reacting (optionally with a comment) per post, or
reacting to several selected posts at once. Every action enters the **existing** engagement
pipeline rather than sending anything directly.

This feature is mostly a front end for machinery that already exists. `POST /api/engagements`,
the URN-keyed `engagements` table, its own caps, and the sender tick that drains it were all
built on 2026-08-02 and have no UI for *creating* rows. The Posts screen becomes that UI, plus
the discovery mechanism (tracking + sweeping) that keeps it fed.

## Decisions (from brainstorm)

1. **200 tracked profiles**, as a setting (`tracked_profile_cap`), not a constant. The build is
   identical for 50 or 200; a rotation queue only becomes necessary past ~1000.
2. **Daily sweep**, `maxPosts: 3` per profile.
3. **No spend ceiling.** Explicitly declined. An *error* halt latch (`posts_halted`) is still
   included — it exists so a bad key does not produce 1,440 failed Apify calls a day and bury
   the alert, which is the same reason `enrich_halted` exists. It is not a cost control.
4. **Bulk action is reaction-only.** Comments are per-post, typed individually. Identical
   comment text across several posts is a recognizable spam pattern published under the
   operator's own name, and `engage_comment_daily_cap` defaults to 10/day regardless.
5. **Feed is an inbox with filter chips** — `New` / `Queued` / `Engaged`, newest first, default
   `New`. **No dismiss action**; the feed is not a list every post must be cleared from.
6. **No backfill mechanism.** Explicitly declined as a separate concept. New profiles get their
   recent posts from the staleness-derived window instead (see below), which needs no setting,
   column, or code path of its own.
7. **Feed cards (LinkedIn-shaped)** over a dense table or a two-pane triage view. The screen
   exists to judge whether a post is worth engaging with, and that judgment needs the post's
   actual words.
8. **One actor run per sweep** via Apify's async run + poll API, not `run-sync`.

## Apify findings (documented 2026-08-04)

Actor: `harvestapi~linkedin-profile-posts` (the second actor already used by the reference
implementation at `C:\Projects\prospecting\apify_linkedin.py`, whose `_run_posts_actor_multi`
proves the batched call shape works).

| Fact | Source |
|---|---|
| `targetUrls` is an **array**; no documented maximum. 6 profiles scraped concurrently inside a run | actor input schema |
| `maxPosts` is **per profile**, default 10, `0` = all | actor input schema |
| `postedLimit` ∈ `'24h' \| 'week' \| 'month'`; `postedLimitDate` takes an ISO date | actor input schema |
| Pricing is **pay-per-result**, $1.50–2.00 per 1,000 posts | actor pricing page |
| `scrapeReactions` / `scrapeComments` bill as **additional posts** | actor pricing page |
| Items carry `id`, `linkedinUrl`, `content`, `author`, `postedAt`, `engagement`, `postImages`, and `query.targetUrl` echoing the input URL | actor API page |
| `run-sync-get-dataset-items` fails at **300s with HTTP 408**, and the timeout kills only the HTTP request — the run itself continues | Apify API docs |

Two consequences drive the design:

**`postedLimit` is the cost model, not a filter.** `INSERT OR IGNORE` dedupes *storage*, never
the *bill*. A `'week'` window on a daily sweep re-returns and re-bills the same 3 posts every
day — 200 profiles × 3 × 30 ≈ 18,000 posts ≈ **$36/mo**. A `'24h'` window returns nothing for a
profile that did not post ≈ **$1.60/mo**. Twentyfold difference for one input field.

**`scrapeReactions` and `scrapeComments` stay off.** Permanently. They multiply the bill.

## Data model

Both tables follow local conventions: URN as identity, fixed-width `toISOString()` timestamps,
and — per the warning already in `schema.sql` — any column added *after* this ships needs its
own guarded `ALTER` in `runMigrations`, because `CREATE TABLE IF NOT EXISTS` is a no-op once the
table exists.

### `tracked_profiles`

```sql
CREATE TABLE IF NOT EXISTS tracked_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_url TEXT NOT NULL UNIQUE,     -- normalizeProfileUrl(), same form as connections
  connection_id INTEGER REFERENCES connections(id),  -- nullable: tracking is not being connected
  full_name TEXT,                       -- display fallback when connection_id IS NULL
  headline TEXT,                        -- filled from the first sweep's author payload
  source TEXT NOT NULL,                 -- search | urls
  active INTEGER NOT NULL DEFAULT 1,
  last_swept_at TEXT,
  last_sweep_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tracked_active ON tracked_profiles(active);
```

`connection_id` is nullable on purpose: the paste box accepts any profile URL, and a person
worth watching need not be a 1st-degree connection. When it is set, the connection row is the
source of truth for name and headline; `full_name` / `headline` here are only the fallback, and
a sweep never overwrites a connection's own fields with scraped ones.

### `posts`

```sql
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_urn TEXT NOT NULL UNIQUE,        -- THE identity, same rule as engagements.post_urn
  post_url TEXT NOT NULL,
  tracked_profile_id INTEGER NOT NULL REFERENCES tracked_profiles(id),
  author_name TEXT,
  author_headline TEXT,
  content TEXT,
  posted_at TEXT,                       -- ISO, from postedAt.timestamp
  is_repost INTEGER NOT NULL DEFAULT 0,
  reaction_count INTEGER,
  comment_count INTEGER,
  engagement_id INTEGER REFERENCES engagements(id),
  first_seen_at TEXT NOT NULL,
  raw_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_posts_feed ON posts(posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_profile ON posts(tracked_profile_id);
CREATE INDEX IF NOT EXISTS idx_posts_engagement ON posts(engagement_id);
```

Four decisions worth defending, because each one has an obvious wrong alternative:

**`engagement_id` is a direct FK, not a URN join.** Joining `posts.post_urn =
engagements.post_urn` would store nothing extra and be wrong. API.md documents that an
engagement's `post_urn` is *provisional*: the driver reads the canonical URN off the live post on
first execution and rewrites the row, and if another row already holds that URN, this row is
retired as `skipped`/`dismissed`. A URN join would silently lose the post→engagement link
exactly when reconciliation fires. A direct id survives it. A test asserts this.

**Untracking sets `active = 0`; it does not delete.** A delete strands `posts.tracked_profile_id`,
and cascading it would destroy the record of posts already engaged with. Soft-delete drops the
profile from sweeps and its posts from the feed, keeps history, and means re-adding someone
previously removed neither duplicates the row nor re-bills their first sweep.

**`INSERT OR IGNORE` on `post_urn` makes re-sweeping idempotent.** No cursor, no
have-I-seen-this bookkeeping; overlapping or repeated sweeps simply no-op on stored posts. This
is what lets the sweep be dumb.

**`is_repost` is stored and labelled, not filtered.** A tracked person's repost is a legitimate
engagement target and the DOM handles it — reshares render one engageable container and all
selectors resolve. The discriminator is the item's `type` field plus the presence of a nested
original-post object; the exact shape is confirmed against a live payload during implementation
and **defaults to `0` when indeterminate**, so an unrecognized shape under-labels rather than
mislabels. Note a **pre-existing** limitation, not one this feature introduces: on
reshares, comment `data-id`s key on the ugcPost URN, which disables comment attribution.
Reacting is unaffected.

### Settings

```sql
posts_sweep_per_day    INTEGER NOT NULL DEFAULT 1,
posts_max_per_sweep    INTEGER NOT NULL DEFAULT 3,    -- maxPosts, per profile
posts_sweep_batch_size INTEGER NOT NULL DEFAULT 200,  -- safety valve; one run in practice
posts_retention_days   INTEGER NOT NULL DEFAULT 30,
tracked_profile_cap    INTEGER NOT NULL DEFAULT 200
```

### `app_state`

```sql
posts_swept_at    TEXT,
posts_halted      INTEGER NOT NULL DEFAULT 0,
posts_halt_reason TEXT,
posts_halt_detail TEXT,
posts_halted_at   TEXT
```

## The sweep worker

New: `src/worker/posts-sweep.ts` (the pass), `src/core/apify-posts-extract.ts` (payload → row,
pure).

### A second client interface, deliberately separate

`ApifyClient` is `{ fetchProfile }` today, and every test fake implements it. Adding a required
`fetchPosts` would break all of them for reasons unrelated to this feature. So:

```ts
export interface ApifyPostsClient {
  fetchPosts(
    urls: string[],
    opts: { maxPosts: number; postedLimit: '24h' | 'week' | 'month' },
  ): Promise<ApifyPost[]>;
}
```

`HttpApifyClient` implements both; `posts-sweep.ts` only ever sees `ApifyPostsClient`. Same
injection discipline as enrichment — **no test can spend money.**

### Async run + poll, not `run-sync`

The existing client uses `run-sync-get-dataset-items`, which dies at 300s. That ceiling — not
any actor limit — is the only thing that would force small batches. Since the actor documents no
maximum on `targetUrls`, the posts client instead:

1. `POST /v2/acts/{actorId}/runs` with the full input.
2. Poll `GET /v2/actor-runs/{runId}` until the status is terminal, with backoff and an overall
   deadline.
3. `GET /v2/datasets/{defaultDatasetId}/items`, paged with `limit`/`offset` so a large response
   is never silently truncated.

One run covers all 200 profiles. Cost is unchanged — billing is per post, not per run.

The token travels in the query string and **must never reach an error message**: those land in
`data/relay.log`, which the operator downloads and shares when troubleshooting. Same rule the
existing client already documents.

### One sweep pass

1. **Slot gate** — `daySlot(now, posts_sweep_per_day)` against `app_state.posts_swept_at`,
   exactly as `runRosterSync` does. The stamp is written **only on a clean pass**, so a failed
   sweep retries on the next tick instead of being recorded as done. This is the
   acceptance-checker lesson and it is load-bearing.
2. **Load** `active = 1` tracked profiles.
3. **Bound the window by the last sweep's timestamp**, which is what replaces the rejected
   backfill concept. Note the two timestamps do different jobs: `app_state.posts_swept_at`
   gates the *pass*, while per-profile `last_swept_at` bounds that profile's *window* and
   bounds retries.
   - `last_swept_at` is set → `postedLimitDate: <last_swept_at>` — "posts from now back to
     this instant", exactly.
   - `last_swept_at` is `NULL` (never swept) → `postedLimit: 'week'`, a bounded first look.

   Send one or the other, never both.

   **REVISED 2026-08-04 during implementation, and the reason matters.** The original design
   compared elapsed time against a fixed relative window: `age <= 24h → postedLimit: '24h'`,
   else `'week'`. That is broken, because the *cadence* is also a day. The tick gate is
   `daySlot(now, 1)`, which keys on the local calendar date, so a sweep fires on the first
   30-minute tick after midnight and consecutive sweeps land 24h **+ δ** apart, with δ > 0
   essentially always (stable tick phase, plus the sweep runs synchronously inside the tick).
   So `age > 24h` nearly always held, `'week'` became the steady-state window, and the design's
   own twentyfold cost difference — $1.60/mo against $36/mo — landed on the wrong side. A test
   pinning the idealized zero-drift boundary passed happily.

   A tolerance (`age <= 24h + one tick`) would fix the cost and silently lose posts: a relative
   `'24h'` is computed at *run* time, so the δ sliver between the previous sweep and 24h-before-now
   is fetched by neither pass. Small per day, permanent, invisible. `postedLimitDate` removes
   the guess entirely — no over-fetch, no gap, and no dependence on when the tick happens to fire.

   Batching survives: `markSwept` stamps every profile in a pass with the *same* `nowIso`, so
   profiles swept together share an identical `last_swept_at` and naturally form one group.
   Group by that value, plus a null group for the never-swept.

   Two consequences worth recording, because both look like they need handling and don't:

   - **DST is a non-issue, and this is why.** `daySlot` works in local time, so a 23- or 25-hour
     day shifts the cadence. Under the old elapsed-time threshold that would have flipped the
     window; now the window derives from a stored instant and never from elapsed time, so a
     short or long day changes nothing at all.
   - **A months-old stamp is not an unbounded catch-up bill.** `maxItems = profiles × maxPosts`
     is Apify's server-enforced charge ceiling regardless of how wide the window is. The window
     decides *which* posts are candidates; `maxPosts` decides how many are returned and billed.
     So no staleness ceiling on `postedLimitDate` is required.
4. **Attribute** each returned item to its profile by `query.targetUrl`, falling back to
   `author.linkedinUrl`. An item matching neither is logged and dropped, never guessed at.
5. **`INSERT OR IGNORE`** each post on `post_urn`. Stamp `last_swept_at` per profile. On a
   failure, stamp `last_sweep_error` on **only the affected profiles**, so the next pass retries
   those without re-billing the rest.
6. **Prune** posts where `engagement_id IS NULL` and `posted_at` is older than
   `posts_retention_days`.

Step 6 is load-bearing, not hygiene. With no dismiss action, aging out is the **only** way a
post leaves the `New` chip; without the prune, `New` grows without bound and stops meaning
anything. Anything engaged with is kept regardless of age.

### Gates

- **`paused` stops the sweep.** It is the operator's "stop doing things" switch, and that must
  include unattended spending. `Sweep now` still works while paused — that is the override.
- **`guardrail_tripped` does NOT gate it.** The guardrail means the LinkedIn session is in
  trouble; Apify never touches that session. This mirrors what `runEnrichDrainTick` already
  documents. A comment in place says so, so nobody "fixes" it.
- **`posts_halted` latches** on a missing/bad key or repeated failures, surfaced on the
  dashboard with the same treatment as `enrich_halted`, and stops the tick from retrying.

### Orchestrator wiring

One timer, mirroring the roster-sync cadence:

```ts
this.timers.push(setInterval(() => { void this.runPostsSweepTick(); }, 30 * 60 * 1000));
```

`runPostsSweepTick` must never throw — it routes failures through `handleTickError`, like every
other tick.

## API

Seven endpoints. `POST /api/posts/:id/engage` calls the **existing** `createEngagement` closure in
`server.ts` plus `planAndAssignToday`, so URL/URN normalization, reaction validation, comment
length limits and duplicate detection are shared rather than reimplemented.

| Endpoint | Behaviour |
|---|---|
| `GET /api/tracked-profiles` | list with per-profile post counts, `last_swept_at`, `last_sweep_error` |
| `POST /api/tracked-profiles` | `{ profile_urls: [...] }`. Bulk-shaped, reporting rejects **by URL and reason** like `/api/events`. Serves both the Connections button and the paste box. Re-adding an inactive URL reactivates it. |
| `DELETE /api/tracked-profiles/:id` | sets `active = 0` |
| `GET /api/posts?filter=new\|queued\|engaged&limit=&before=` | newest first, keyset-paginated on `posted_at` |
| `POST /api/posts/:id/engage` | `{ reaction?, comment? }` → creates the engagement, stamps `posts.engagement_id` |
| `POST /api/posts/engage` | bulk `{ post_ids: [...], reaction }`. **No `comment` field exists**, so bulk-commenting is unreachable even by hand. |
| `POST /api/posts/sweep-now` | one sweep immediately, bypassing the slot gate |

Reject reasons for `POST /api/tracked-profiles`: `invalid_url`, `already_tracked`, `cap_reached`.
The bulk form always answers `201` — per-item verdicts are the payload, not the status code —
matching `/api/engagements`.

**The cap fills partially rather than refusing the batch.** With 180 tracked and 50 submitted,
the first 20 are added and the remaining 30 come back as `cap_reached`. Refusing all 50 would
make a large paste unusable near the cap, and silently accepting all of them would break the
setting.

`filter` semantics, defined once so the UI and API cannot drift:

- `new` — `engagement_id IS NULL`
- `queued` — engagement exists and its status is not terminal (`queued`/`scheduled`/`sending`)
- `engaged` — engagement exists and `reacted_at IS NOT NULL`

A post whose engagement ended `failed` or `skipped` returns to `new`, so it can be retried from
the feed rather than becoming invisible.

## Dashboard and UI

**A new `src/web/posts.js`**, loaded as a third classic script after `app.js`. `app.js` is
already 2,971 lines; a feed with filters, selection state and a tracking manager would add
several hundred more. Classic scripts share one global scope, so `posts.js` calls the existing
`api()` / `el()` / `$()` helpers directly — no build step, no module system, no refactor of
`app.js`. The only change there is one line in `init()` (app.js:2948). This is a
don't-make-it-worse fix, not a speculative refactor.

`tests/web/helpers/load-app.ts` is extended to load `posts.js` too, and its `AppInternals`
interface gains the new functions.

**Nav:** a `Posts` tab after `Connections`, panel `#tab-posts`.

**Screen, top to bottom:**

- Status strip: `N tracked · last swept 40m ago · [Sweep now] · [Manage tracking ▾]`, plus an
  informational `N posts scraped in 30d (≈$X)` from one `COUNT` and a price constant. No
  enforcement — it exists so the cost question becomes a number to watch rather than a guess.
- **Manage tracking**, collapsed by default: a paste textarea (mirroring Add List's existing
  box) and a table of tracked profiles with per-row `Remove` and any `last_sweep_error`.
- Filter chips `New` / `Queued` / `Engaged` with counts. Default `New`.
- The bulk bar, **hidden until something is selected** — copying the reasoning already written
  into the Connections selection bar, that a permanently-visible send affordance is how people
  queue things they did not mean to. It offers a reaction picker and `Queue reaction`, nothing
  else.
- Feed cards, newest first, `Load more`. Each card: checkbox, author line with status badge,
  headline and relative age, post text clamped to 2 lines with expand, and an action row —
  reaction select, `Comment` toggle revealing a textarea, `Queue`, and `Open ↗`.

**Connections tab:** a third button in the existing `.selection-bar` — `Track posts` — beside
`Invite to event` and `Add to message campaign`. It reports how many were added, how many were
already tracked, and how many were rejected.

## Testing

| File | Covers |
|---|---|
| `tests/core/apify-posts-extract.test.ts` | `postedAt` as dict / ISO string / unix-ms / garbage; missing content; repost detection; missing author; attribution by `query.targetUrl` with `author.linkedinUrl` fallback |
| `tests/db/posts-repo.test.ts` | `INSERT OR IGNORE` dedupe on URN; soft-delete hides from sweep **and** feed; retention prune deletes un-engaged and keeps engaged; `engagement_id` survives a URN reconcile |
| `tests/worker/posts-sweep.test.ts` | `FakeApifyPostsClient`: slot gate; stamp only on a clean pass; window derived from `last_swept_at`; per-profile error stamping; `paused` blocks; `guardrail_tripped` does not; halt latch on a bad key |
| `tests/api/posts.test.ts` | feed filters and pagination; single engage stamps `engagement_id`; bulk ignores any `comment` field; cap enforcement; per-URL rejects; `failed` engagement returns the post to `new` |
| `tests/web/posts-feed.test.ts` | jsdom via `load-app.ts`: chips filter, bulk bar hidden until selection, bulk queue hits the right endpoint |

`vitest.config.ts` pins `TZ=UTC`; the relative-age and window-derivation tests depend on that.
No test touches `data/app.db` — it is production data.

## Docs

- `API.md` — the seven endpoints, reject reasons, and `filter` semantics.
- `RUNBOOK.md` — plain-language "watching people's posts": what tracking costs, why a new
  profile's feed starts nearly empty, and that queueing from the feed still sends on the
  pipeline's own schedule rather than immediately.
- `README.md` — the five new settings.

## Known residual risks, accepted (added 2026-08-04 during implementation)

**`maxItems` caps what Apify CHARGES, not what the dataset holds.** Apify's docs are explicit:
it "does NOT guarantee that the Actor will return only this many items — it only ensures you
won't be charged for more than this number." So it is a genuine spend ceiling (which is why it
is passed on every run start) but it must never be used to predict dataset size. An early
implementation derived the pagination page cap from it, which meant an over-delivering run hit
the cap and **discarded posts already billed for** — turning a cost overrun into total loss plus
a re-bill on the next pass. The page cap is now a generous absolute constant, and hitting it
returns what was read with a loud log rather than throwing, because the data is already bought.

**A prolonged Apify outage can still discard a run we paid for.** The client retries the two
idempotent GETs three times with backoff, and a *retryable* poll failure no longer kills the
run — it is treated like a non-terminal status, so the poll loop's full ~20-minute budget
absorbs a correlated outage (a deploy, a rate limit, an LB flap) instead of only ~4 seconds of
it. A non-retryable failure (401/403/404) still fails fast, which is correct: those never
recover, and failing fast is what lets the sweep latch its halt promptly.

What remains uncovered is an outage lasting longer than the whole poll budget. The fix would be
to persist the run id and dataset id at run start so a later tick can read a dataset already
paid for, rather than starting a new run. That needs a column and a resume path, and was judged
out of proportion mid-implementation. Two things bound the damage: `maxItems` caps the charge
regardless, and the sweep is daily rather than hourly, so the worst case is one duplicated day.

**Reading Apify's error body improved diagnostics and re-opened the token risk from the other
side.** Surfacing the response body is what distinguishes a bad key from a spent monthly budget
(both are 403). But untrusted upstream text can echo our request URI, and the token travels in
the query string — proxies, WAFs and API gateways do this routinely, and it was reproduced with
a 502 gateway page. Every interpolated body is therefore redacted against the token and
truncated before it can reach `data/relay.log`, which is a file the operator downloads and
shares. **Any future change that puts upstream text into an error message must redact it.**

## Out of scope

- AI-drafted or templated comments. Comments are literal text the operator types.
- Reacting to posts from anyone not on the tracked list (the feed is the tracked set).
- Per-profile sweep cadence. `last_swept_at` exists, so this stays a small change later.
- A spend ceiling (declined).
- Dismissing posts (declined).
- Scraping reactions or comment threads on a post — they bill as extra posts.
- Company pages. The actor accepts them in `targetUrls`, but nothing else here is
  company-shaped; profiles only.

## Risks

1. **`postedLimit` may not reduce billing.** Pay-per-result strongly implies a profile that
   posted nothing pushes no dataset items and bills nothing, but this is inference from the
   pricing model, not a documented guarantee. If the real bill comes back closer to
   `profiles × maxPosts × sweeps`, the mitigations are already settings:
   `posts_sweep_per_day` down, `posts_max_per_sweep` down. The 30-day cost readout on the Posts
   screen is what makes this visible in week one. **Verify against the real Apify bill after
   the first week.**
2. **A tracked profile whose URL changes** (LinkedIn slug change) silently stops returning
   posts. `connections` already solves this with `linkedin_id` merging and
   `connection_aliases`; `tracked_profiles` does not participate. Detectable via a profile whose
   `last_swept_at` advances while it never yields posts. Accepted for now, listed so it is not
   a surprise.
3. **Actor payload drift.** `harvestapi` can change field names. `apify-posts-extract.ts`
   isolates every field read, so drift is one file and its test — the same containment
   `apify-extract.ts` already provides.
4. **A large single run** could hit a dataset response size limit. Mitigated by paging the
   dataset fetch with `limit`/`offset`; `posts_sweep_batch_size` is the fallback if a run ever
   needs splitting.
5. **Reshare comment attribution is already broken** (comment `data-id`s key on the ugcPost
   URN). Reposts will appear in the feed and are reactable; commenting on one inherits the
   existing defect. Labelled in the UI so the operator can choose.
