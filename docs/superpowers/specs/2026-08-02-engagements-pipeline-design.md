# Post engagements — design

**Date:** 2026-08-02
**Status:** approved pending user review

## Goal

Add a fourth pipeline: engage with a LinkedIn post. One task carries a post URL, a
reaction, and optionally a comment. Tasks are paced, scheduled and executed by the same
machinery that already drives connection requests and messages, so an engagement can
never collide with a send, a reply check, a roster sync or an event-invite run. Enqueue
and control happen over the HTTP API; the dashboard gets a read-only card.

## Decisions (from brainstorm)

| Question | Decision |
|---|---|
| Pipeline shape | Own tables (like event invites), drained by the existing sender tick (like invites/messages). NOT a `CampaignKind`. |
| Task identity | One row per post, keyed on the post URN — never the URL |
| Comment model | A comment is ALWAYS paired with a reaction on the same post. A task is either reaction-only, or reaction + comment. There is no comment-only task. |
| Comment text | Literal per task. No templates, no variable substitution, no grouping/cohorts. |
| Timing | Same random working-hours slot planning as invites/messages. No priority over other pipelines, no per-task expiry. |
| Pacing | Own caps, with deliberately bigger batches: 15/batch × 6/day, 500/week. Comments separately capped at 10/day. |
| Comment retry | Never automatic. An unverified comment parks for the operator. Reactions retry freely (idempotent). |
| Selector discovery | Survey prior art (GitHub LinkedIn-automation projects) for the algorithm, then a live DOM probe decides the actual selectors. |
| UI | Read-only dashboard card. All writes over the API. |

## Why not a fourth `CampaignKind`

`CAMPAIGN_KINDS` means "a person-directed campaign living in the `profiles` table". Three
things break if a post joins it:

1. `profiles` has `UNIQUE(profile_url, kind)` and person-shaped columns — `first_name`,
   `full_name`, `accepted_at`, `replied_at`, `thread_url`, `skip_reason:
   'already_connected'`. All meaningless for a post.
2. `rosterFirstName()` in the sender, the acceptance checker, and the reply checker all
   iterate `profiles` assuming every row is a person.
3. The event-invite pipeline already set the precedent and documented the reasoning in
   `schema.sql`: separate tables, shared pause / guardrail / working-hours / browser-mutex
   rails.

What engagements take from the invite/message side instead is the *execution* model: a
short per-item browser action, batched and paced. An event-invite-style browser
**reservation** would be wrong here — reservations exist because one event run monopolises
the browser for ~20 minutes, whereas an engagement is a 5–30 second action. Reserving
windows for it would duplicate the planner and have the two pipelines competing for gaps in
the same day.

## Data model

### `engagements`

```sql
-- ============================================================================
-- Post engagements (2026-08-02). The fourth pipeline: react to a LinkedIn post,
-- optionally with a comment.
--
-- Deliberately NOT a CampaignKind: `profiles` is person-shaped (first_name,
-- accepted_at, thread_url, UNIQUE(profile_url, kind)) and a post is not a person.
-- Separate table; shared pause / guardrail / working-hours / browser-mutex rails,
-- and drained by the same sender tick as invites and messages.
-- ============================================================================
CREATE TABLE IF NOT EXISTS engagements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Canonical https://www.linkedin.com/feed/update/<urn>/ — display and navigation only.
  post_url TEXT NOT NULL,
  -- THE identity. The same post is reachable as /feed/update/, /posts/<slug>-activity-…
  -- and ?updateId=…, so deduping on post_url would dedupe nothing.
  post_urn TEXT NOT NULL UNIQUE,
  -- Always present. LinkedIn permits exactly one reaction per member per post, which is
  -- the same rule the UNIQUE on post_urn enforces.
  reaction TEXT NOT NULL,
  -- Optional. When set, it is ALWAYS delivered alongside the reaction above — there is
  -- no comment-only engagement.
  comment_text TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  -- not_found | unavailable | comments_disabled | dismissed
  skip_reason TEXT,
  scheduled_for TEXT,
  -- Partial progress, not one sent_at: the task does two things in sequence and a retry
  -- after a failed comment must not re-drive the reaction.
  reacted_at TEXT,
  commented_at TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_engagements_status ON engagements(status);
CREATE INDEX IF NOT EXISTS idx_engagements_reacted ON engagements(reacted_at);
```

`UNIQUE(post_urn)` gives "one engagement per post, full stop" as a hard constraint. The API
still checks it first and returns a 409 naming the existing row, because a raw SQLite
constraint violation surfaces through the Fastify error handler as an opaque message.

**No event-log table.** `profile_events` exists because invites have an accepted/replied
funnel to reconstruct. An engagement is fire-and-forget: `attempts`, `last_error`,
`reacted_at` and `commented_at` on the row are the whole history, and the weekly cap counts
`reacted_at` directly off the table.

### Types

```ts
/** Derived from the list, exactly as CampaignKind is — the runtime list and the
 *  compile-time type can never drift. */
export const REACTIONS = ['like', 'celebrate', 'support', 'love', 'insightful', 'funny'] as const;
export type Reaction = typeof REACTIONS[number];

/** Its own union, NOT an alias of ProfileStatus: an engagement can never be accepted,
 *  replied or expired, and a shared type would invite code that pretends otherwise. */
export type EngagementStatus =
  | 'queued' | 'scheduled' | 'sending' | 'sent' | 'skipped' | 'failed' | 'needs_attention';

export type EngagementSkipReason =
  | 'not_found' | 'unavailable' | 'comments_disabled' | 'dismissed';

export interface Engagement {
  id: number;
  post_url: string;
  post_urn: string;
  reaction: Reaction;
  comment_text: string | null;
  status: EngagementStatus;
  attempts: number;
  last_error: string | null;
  skip_reason: EngagementSkipReason | null;
  scheduled_for: string | null;
  reacted_at: string | null;
  commented_at: string | null;
  priority: number;
  created_at: string;
}
```

`core/engagement-action.ts` holds `REACTIONS`, `isReaction()` and `parseReaction()`,
mirroring `core/campaign-kind.ts` module-for-module and for the same stated reason:
validate at the boundary, never silently coerce the unknown.

`parseReaction(undefined)` reports `{ ok: true, reaction: undefined }` and the call site
defaults to `'like'`. This is a deliberate divergence from `parseKind`, where absent is
explicitly not a default: mis-defaulting a campaign kind sends an unsendable connection
request, whereas the worst case here is a `like` where the caller wanted an `insightful` —
cosmetic and retractable.

### Settings

| column | default | invite equivalent |
|---|---|---|
| `engage_weekly_cap` | 500 | `weekly_cap` = 100 |
| `engage_batch_size` | 15 | `batch_size` = 5 |
| `engage_batches_per_day` | 6 | `batches_per_day` = 4 |
| `engage_comment_daily_cap` | 10 | — |

15 × 6 = 90 engagements/day, 450/week under the 500 weekly cap. The comment sub-cap exists
because 90 published comments a day under the operator's own name is a materially different
risk from 90 likes.

Each column gets its own guarded `ALTER` in `runMigrations`, per that file's existing
doctrine — one guard apiece so an interruption between ALTERs cannot permanently skip
whichever did not run yet. The `engagements` table itself needs no migration:
`CREATE TABLE IF NOT EXISTS` in `schema.sql` back-fills it. **Any column added to
`engagements` after this ships needs its own guarded ALTER** — the same trap documented for
`event_buckets.geo_candidates`.

## URL and URN normalization

`normalizePostUrl(raw): { url: string; urn: string } | null` joins `normalizeProfileUrl` in
`core/url.ts`. Pure string parsing — no network, no browser.

| input form | extraction |
|---|---|
| `https://www.linkedin.com/feed/update/urn:li:activity:7123…/` | URN is literally in the path |
| `https://www.linkedin.com/posts/<slug>-activity-7123…-AbCd` | numeric id follows `-activity-` in the slug; rebuild as `urn:li:activity:<id>` |
| `…?updateId=urn%3Ali%3Aactivity%3A7123…` | URL-decode the query parameter |
| bare `urn:li:activity:7123…` | accepted as-is |
| `https://lnkd.in/<code>` | **rejected** with reason `shortlink_unsupported` |

The URN type is captured, not assumed: `urn:li:activity:`, `urn:li:ugcPost:` and
`urn:li:share:` are all preserved verbatim in `post_urn`. `post_url` is always rewritten to
the canonical `https://www.linkedin.com/feed/update/<urn>/` form.

Shortlinks are rejected rather than silently followed: resolving one requires an HTTP
redirect, which turns a pure parse into a network call on the enqueue path. The error
message tells the caller to expand the link first.

**Known gap.** For the same post, an `activity` URN and a `ugcPost` URN are different
numbers, so two URLs in different forms could each enqueue. Unlikely in practice — share
links are overwhelmingly the `activity` form. The probe (below) must record whether the
post container exposes a canonical URN attribute; if it does, the driver reconciles at run
time and the gap closes. If it does not, the gap is accepted and documented, because the
alternative is a network round-trip per enqueue.

## Scheduling

### Generalising the planner

`planKind` in `worker/scheduler-service.ts` hard-codes `repos.profiles` in four places. Its
body is extracted to `planQueue`, leaving `planKind` as a thin adapter and adding
`planEngagements` as a second one:

```ts
export interface QueueSpec {
  /** Log label: 'invite' | 'message' | 'engagement'. */
  name: string;
  caps: KindCaps;
  /** Already spent in the rolling weekly window. */
  sentInWindow: number;
  /** Remaining for today. */
  dailyRemaining: number;
  /** Queued row ids in priority order, already clamped by any queue-specific rule. */
  queuedIds: number[];
  setScheduled(id: number, iso: string): void;
}

export function planQueue(
  s: Settings, now: Date, windowEnd: Date, rng: () => number,
  reserved: ReservationWindow[], spec: QueueSpec,
): void
```

Slot generation, reservation filtering, budget clamping and the congested-window fallback
then live in exactly one place rather than two near-copies. `planQueue` takes no `Repos` —
all database access moves into the adapters, which also makes it directly unit-testable.

`capsFor(s, kind)` is typed on `CampaignKind` and stays that way. `core/caps.ts` gains a
sibling `engagementCaps(s): KindCaps` reading the three `engage_*` columns, so both adapters
hand `planQueue` the same shape without engagements being forced into `CampaignKind`.

`planAndAssignToday` calls `planEngagements` after the `CAMPAIGN_KINDS` loop, reusing the
same `reserved` read. Engagements therefore route around event-invite windows with no new
code.

### Capacity

- **Weekly:** `COUNT(*) FROM engagements WHERE reacted_at >= windowStartIso(now)`. The
  reaction always happens, so it is the correct unit.
- **Daily:** `committedToday` equivalent = scheduled rows + rows with `reacted_at` today.
- **Comment budget:** `engage_comment_daily_cap − COUNT(*) WHERE commented_at >= dayStart`.

**The comment budget is applied at planning time, not only at send time.** `planEngagements`
schedules at most `commentBudget` comment-bearing tasks per day. Without this, comment tasks
would be planned every day, deferred every day by the sender, and consume slot capacity that
reaction-only tasks could have used. The sender re-checks the budget as a backstop.

A comment-bearing task held by the budget is held **whole** — never run half-way — so a
single task cannot straddle two days in a partial state.

## Execution

`runSenderOnce` computes `engDue` alongside `invDue`/`msgDue` and returns early only when
all three are empty, so idle ticks still never open the browser. Pass order is invite →
message → engagement, with the existing randomized `delay()` between passes; a pass that
halted still returns before the engagement pass runs.

### One task attempt

```
mark 'sending', attempts += 1

if reacted_at is null:
    outcome = driver.reactToPost(post_url, reaction)
    done        -> reacted_at = clock()
    already     -> reacted_at = clock(); log the pre-existing reaction
    not_found   -> skipped/not_found;      return (no failure streak)
    unavailable -> skipped/unavailable;    return (counts toward the streak)
    checkpoint  -> handleCheckpoint();     halt the pass
    error       -> failed;                 return (counts toward the streak)

if comment_text is not null and commented_at is null:
    delay()                       # two consecutive LinkedIn contacts
    outcome = driver.commentOnPost(post_url, comment_text)
    done              -> commented_at = clock()
    comments_disabled -> skipped/comments_disabled (reacted_at preserved); return
    not_found         -> skipped/not_found; return
    unverified        -> needs_attention; NEVER auto-retry
    checkpoint        -> handleCheckpoint(); halt the pass
    error             -> failed; return (counts toward the streak)

status = 'sent'; recordSuccess()
```

`already` on the reaction means the post already carries a reaction of ours that we never
recorded — a manual reaction, or one orphaned by a crash. We do **not** change it to the
requested one: replacing a reaction the operator placed by hand is a side effect nobody
asked for. The observed reaction goes to the run log rather than a new column; this is an
edge case, and step 2 is guarded on `reacted_at is null` so our own completed reactions
never reach it.

`comments_disabled` is split out from `unavailable` deliberately. An author who restricted
commenting is a per-post terminal fact; folding it into `unavailable` would march a batch of
such posts toward a `repeated_failures` halt. Terminal skip, no failure streak — the same
reasoning that keeps `not_found` and `email_required` off the streak today. Note the row
still ends with `reacted_at` set: the reaction landed and is not misreported as lost.

### Crash recovery

Extends `recoverOrphanedSending`. A row stranded in `sending` is indistinguishable from one
that succeeded, so recovery is decided by what the timestamps prove:

| state | action | why |
|---|---|---|
| `reacted_at` is null | requeue | Nothing published. Clicking Like twice is idempotent, and the driver reports `already` on the second pass. |
| `reacted_at` set, no `comment_text` | mark `sent` | The task's only work provably completed. |
| `reacted_at` set, `comment_text` set, `commented_at` null | **`needs_attention`** | The crash straddled the comment. A duplicate published comment is visible to real people and cannot be cleanly unsent. |

This is the same doctrine that parks interrupted DMs rather than requeuing them.

`requeueOverdue` returns engagements whose `scheduled_for` is more than `OVERDUE_GRACE_MS`
past due to `queued` with a cleared slot, exactly as it does for profiles, using the same
grace constant. `resortSchedule` requeues every `scheduled` engagement before re-planning,
so a backlog of stale slots is re-flowed into policy batches rather than fired as a burst.
Both are extended in place rather than duplicated.

### Collision avoidance

Inherited, not built: the same `browserLock` mutex, the same working-hours and
`weekdays_only` window, the same `paused` and `guardrail_tripped` gates, and the same
reservation routing. There is no path by which an engagement runs concurrently with a send,
a reply check, a roster sync or an event run. A checkpoint hit during an engagement trips
the shared guardrail and halts everything, because the LinkedIn account is the shared
resource.

## Browser driver

Two methods on `BrowserDriver`, not one dispatching method — two signatures make "a comment
requires text" a compile-time guarantee instead of a runtime check:

```ts
reactToPost(postUrl: string, reaction: Reaction): Promise<EngagementOutcome>;
commentOnPost(postUrl: string, text: string): Promise<EngagementOutcome>;

export type EngagementResult =
  | 'done' | 'already' | 'not_found' | 'unavailable'
  | 'comments_disabled' | 'unverified' | 'checkpoint' | 'error';

export interface EngagementOutcome {
  result: EngagementResult;
  /** Set on `already`: the reaction found on the post. Logged, not persisted. */
  existingReaction?: Reaction | string;
  /** Canonical URN read off the post container, when the DOM exposes one. */
  observedUrn?: string;
  error?: string;
  evidence?: SendEvidence;
}
```

**Verification is asymmetric.** After a reaction, confirm the button flipped state; if it
cannot be confirmed, report `error` and let it retry — the action is idempotent. After a
comment, confirm the text appears in the thread under our name; if it cannot be confirmed,
report `unverified`, which parks the row and never auto-retries.

`unverified` is therefore **comment-only**: `reactToPost` never returns it, and
`commentOnPost` never returns a bare `error` for an ambiguous outcome. The two methods share
one result union for uniformity, and the sender's reaction branch treats `unverified` as
`error` defensively should that ever change.

Selectors live in a new `src/browser/post-selectors.ts`, alongside `linkedin-selectors.ts`
and `event-selectors.ts`.

### Discovery, in order

1. **Prior-art survey.** Read how established GitHub LinkedIn-automation projects drive the
   reaction control: hover versus long-press, what they wait on, how they re-find the
   button after the flyout opens, and how they verify. Prior art informs the *algorithm*;
   their selectors are mostly Selenium-era and rot fast, so none are copied verbatim.
2. **Live probe** — `scripts/probe-post-engage.ts`. Captures the real DOM of the reaction
   bar, the reaction flyout, the comment box and the posted-comment thread, plus whether
   the post container exposes a canonical URN attribute. No selector is written from memory.
3. **Live verification** — `scripts/verify-post-engage.ts`, run against **one of the
   operator's own posts**. Same containment rule as the messaging work, where live test
   sends only ever went to a single known-safe target.

The five non-`like` reactions sit behind a hover-driven flyout on the Like button. This is
the single most fragile element in the feature, which is why `unavailable` counts toward the
failure streak: a selector break halts the engine loudly instead of silently no-op'ing.

## API

| method | path | notes |
|---|---|---|
| `POST` | `/api/engagements` | `{ post_url, reaction?, comment? }`, or `{ items: [...] }` for bulk |
| `GET` | `/api/engagements` | `?status=&limit=` |
| `GET` | `/api/engagements/:id` | |
| `POST` | `/api/engagements/:id/retry` | 409 unless the row is `failed` or `needs_attention` |
| `POST` | `/api/engagements/:id/dismiss` | terminal `skipped`/`dismissed`; also the cancel path for a queued row |

Creation calls `planAndAssignToday` immediately, so a task enqueued at 09:05 gets a real
slot instead of sitting until the hourly tick — same reasoning as `/api/profiles`.

Bulk creation returns rejects **by name and reason**, the way `POST /api/events` does:
finding out mid-run that a URL was junk is far too late.

```json
{ "added": 12,
  "rejected": [ { "post_url": "…", "reason": "invalid_url" } ] }
```

Reject reasons: `invalid_url`, `shortlink_unsupported`, `duplicate`, `unknown_reaction`,
`comment_too_long`. Single-item creation returns 400 (or 409 for `duplicate`) instead.

Boundary validation:

- Unknown reaction → 400 naming it, via `parseReaction`.
- Comment longer than `MAX_COMMENT = 1250` → 400. Added beside `MAX_NOTE` / `MAX_MESSAGE`.
- Unparseable or shortened post URL → 400.
- A post that already has an engagement row → 409 naming the existing row's id and status.

`retry` on a parked comment row is explicitly allowed: parking exists so a human can check
the post and decide, and retry is how they say "I checked, it did not post."

The four `engage_*` keys join `ALLOWED_SETTINGS_KEYS`.

`GET /api/status` gains an `engagements` block: counts by status, weekly used/remaining,
comments used today and remaining, and the next scheduled batch.

`GET /api/attention` currently returns profile rows only. It grows a `source:
'profile' | 'engagement'` discriminator so both kinds render in one list. **This changes an
existing response shape** — `src/web/app.js` must be updated in the same change.

## Dashboard

A read-only card, matching the event pipeline's placement:

- Counts by status.
- The next few scheduled tasks: time, reaction, whether it carries a comment, and a link to
  the post.
- Recent failures, and the extended attention list.

No enqueue form. All writes go through the API.

## Testing

| file | covers |
|---|---|
| `tests/core/url.test.ts` | all four post-URL forms, URN-type preservation, shortlink rejection, garbage rejection |
| `tests/core/engagement-action.test.ts` | `parseReaction` — mirrors the existing campaign-kind tests, including the deliberate `undefined → default` divergence |
| `tests/db/engagements.test.ts` | repo CRUD, `UNIQUE(post_urn)`, status transitions, capacity counts |
| `tests/worker/engagement-planning.test.ts` | **regression first**: `planQueue` produces identical plans for invites and messages before anything new is asserted. Then: engagements get slots, route around reservations, and the comment budget limits planning. |
| `tests/worker/sender-engagements.test.ts` | fake driver — every `EngagementResult` maps to the right status / skip reason / failure-streak / guardrail effect; reaction-then-comment ordering and the inter-contact delay; `unverified` parks; the three-way crash recovery |
| `tests/api/engagements.test.ts` | the validation matrix, bulk rejects, both 409s, and `retry` on a parked row |
| `scripts/probe-post-engage.ts` | live DOM capture (not part of the automated suite) |
| `scripts/verify-post-engage.ts` | one live engagement against the operator's own post |

The planner regression test is the gate on the `planQueue` refactor: it touches live
scheduling code that three pipelines depend on, so invite and message behaviour must be
proven unchanged before engagement behaviour is added.

## Out of scope

Reposts and follows. Post discovery of any kind — only explicitly supplied URLs.
`lnkd.in` expansion. Editing or deleting a comment once posted. Comment templates or
variable substitution. Grouping, labels or cohorts for engagements. Reaction replacement
when a post already carries one. Retracting a reaction.

## Risks

1. **The reaction flyout is fragile.** Mitigated by the prior-art survey, the live probe,
   and by `unavailable` counting toward the failure streak so a selector break halts the
   engine loudly rather than silently doing nothing.
2. **URN-type mismatch** (`activity` vs `ugcPost` for the same post) could let one post
   enqueue twice. Mitigated by run-time reconciliation if the probe finds a canonical URN in
   the DOM; otherwise accepted and documented.
3. **`planQueue` is a refactor of live scheduling code.** Mitigated by the regression test
   ordering above.
4. **Comment volume** is the highest-reputation-risk part of the feature. Mitigated by
   `engage_comment_daily_cap`, and by comments never auto-retrying.
5. **The next-batch forecast is known to be wrong when nothing is scheduled** (the
   estimated forecast pins `at = now`). The engagement card must not reproduce that bug —
   it should render "not scheduled" rather than an imminent time when the queue is
   unplanned.
