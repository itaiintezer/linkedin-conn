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

## Discovery findings (live-verified 2026-08-02)

Captured against the real logged-in session with `scripts/probe-post-engage.ts`, read-only
(navigate + hover + one non-publishing keystroke probe of the composer). Two posts were
probed: an **individual member's post** (`urn:li:activity:7489401096851906561`, reached from
a `lnkd.in` shortlink) and a **company-page post** (`urn:li:activity:7488617458552070144`).
Raw HTML dumps live under `data/incidents/2026-08-02T08-2*-post-engage/` (gitignored).

**All three authorized engagements were subsequently performed live** (Like + `👀` comment on
the individual post; the company post turned out to be already Liked, and the script's
read-state-first guard correctly refused to click, which would have *removed* the reaction).
Findings 3, 4 and 5 are therefore true before/after observations on a single post, not
inferences. **Three findings were wrong on the first pass and are corrected in place below —
1, 2 and 4.** Findings 1 and 2 were disproved during implementation by re-reading these same
saved dumps rather than by a fresh probe, which is worth noting: the evidence to catch both
was already on disk at the time the first pass was written. Every correction is marked
**CORRECTED** and states what the wrong version would have cost.

The surface is the **classic Ember/artdeco feed UI**, not the hashed-class React UI the
profile top card uses. Class names here are readable BEM (`react-button__trigger`,
`comments-comment-box__form`), and `ember####` ids are per-render — never select on them.
Both posts rendered `<html lang="en">`, so the `lang`-cookie pin is holding.

1. **Like button.** Post-level react trigger:

   ```
   button[aria-pressed][aria-label^="React "], button[aria-pressed][aria-label^="Unreact "]
   ```

   Scope it to the post container `div[data-urn][role="article"]`. Two collisions the
   scoping and the `aria-pressed` predicate exist to defeat:
   - every **comment** has its own like button, labelled
     `React Like to <Name>’s comment` / `Unreact Like to <Name>’s comment` — excluded
     because the post-level label is the bare form;
   - the **flyout entry** for Like carries the identical bare `aria-label="React Like"` but
     has **no `aria-pressed`** — excluded by the attribute-presence predicate.

   Also present but *not* the target: a zero-size
   `button[aria-label="Open reactions menu"][aria-expanded]` (the keyboard affordance for
   the flyout) and the identity toggle, `aria-label="Open menu for switching identity when
   interacting with this post"`. The latter matters — see finding 9.

   **CORRECTED (during implementation, from the saved dumps).** The claim above that scoping
   to `div[data-urn][role="article"]` separates post-level controls from comment-level ones is
   **wrong**. Walking the post-comment dump shows that `article.comments-comment-entity`,
   `form.comments-comment-box__form`, the `ql-editor` and **each comment's own react button**
   are all descendants of that container. Worse, a comment's button carries the *same*
   `react-button__trigger` class and the *same* `span.reactions-react-button` wrapper as the
   post trigger, so neither of those distinguishes them either. The only thing absent from a
   comment's social bar is **`div.feed-shared-social-action-bar`**, so that is the actual
   discriminator, and it is what `src/browser/post-selectors.ts` scopes on:

   ```
   div.feed-shared-social-action-bar span.reactions-react-button button[aria-pressed]
   ```

   That path is also language-independent, which the label form is not. **What the wrong
   version would have cost:** the bare-vs-suffixed label distinction only holds while LinkedIn
   renders English, and an `[aria-label^="Unreact "]` prefix match resolves to a *comment's*
   like button — inside the scope, `aria-pressed` present, indistinguishable by class. Clicking
   it would have **removed somebody's reaction from their own comment**. A destructive
   mis-click, dressed as a scoping shortcut.

2. **The flyout opens on hover of the Like trigger.** No click, no long-press. It settles
   well within 2.5 s. It is a sibling `span` that is always in the DOM and becomes visible
   by class (`reactions-menu reactions-menu--active reactions-menu--v2-visible`); it is
   **not** a `role="menu"` and its items are **not** `role="menuitem"` — plain
   `<button type="button" tabindex="-1">`. Each of the six is addressable by exact
   aria-label, and each contains an `<img>` carrying LinkedIn's own enum:

   | reaction | selector | `data-test-reactions-icon-type` | `alt` |
   |---|---|---|---|
   | like | `button[aria-label="React Like"]` | `LIKE` | `like` |
   | celebrate | `button[aria-label="React Celebrate"]` | `PRAISE` | `celebrate` |
   | support | `button[aria-label="React Support"]` | `APPRECIATION` | `support` |
   | love | `button[aria-label="React Love"]` | `EMPATHY` | `love` |
   | insightful | `button[aria-label="React Insightful"]` | `INTEREST` | `insightful` |
   | funny | `button[aria-label="React Funny"]` | `ENTERTAINMENT` | `funny` |

   Prefer `data-test-reactions-icon-type` as the *identity* (a `data-*` attribute, and
   language-independent) and the aria-label as the *click target*. Note the enum names do
   not match the display names — `PRAISE`/`APPRECIATION`/`EMPATHY`/`INTEREST`/`ENTERTAINMENT`
   — so the driver needs an explicit map, not a case transform. Each button also holds a
   redundant `span.reactions-menu__reaction-description` with the plain display name.

   The flyout entries do **not** reflect current state: on the already-reacted post, the
   Like entry still read `React Like`. Only the trigger knows.

   **CORRECTED (during implementation, from the saved dumps).** "A sibling `span` that is
   always in the DOM and becomes visible by class" is **wrong** — it is not always in the DOM.
   `reactions-menu` appears in **no** page dump: not the pre-hover capture, and not the
   post-hover captures taken once the pointer had moved away, where only
   `reactions-menu__trigger` is present. It appears solely in the capture taken while the
   pointer was still on the trigger. The flyout **mounts on hover and unmounts when the hover
   ends**.

   So `reactions-menu--active` / `reactions-menu--v2-visible` are not state to be polled on a
   persistent node, and waiting on them would be waiting on an element that does not exist yet.
   The driver instead hovers and waits for the flyout **entry** it intends to click to become
   visible — the thing it actually needs, and the only signal that survives a remount.
   `PSEL.reactionFlyout` is kept for diagnostics and for this note, not as a gate.

3. **`REACTED_STATE` — the trigger flips three things at once** (VERIFIED as a live
   before/after on one post: the social-count line went from
   `6 | Jamie Garrison and 5 others` to `7 | You and 6 others`):

   | | not reacted | reacted (Like) |
   |---|---|---|
   | `aria-pressed` | `"false"` | `"true"` |
   | `aria-label` | `React Like` | `Unreact Like` |
   | class | `… react-button__trigger` | `… react-button__trigger react-button--active` |
   | icon | `data-test-icon="thumbs-up-outline-small"` | (filled variant) |

   **`aria-pressed` is the signal to use** — semantic, boolean, and unambiguous. The
   aria-label doubles as the *which* reaction (`Unreact <Reaction>`), which is exactly what
   `EngagementOutcome.existingReaction` needs on an `already` result. Note the consequence:
   clicking the trigger when `aria-pressed="true"` **removes** the reaction. The driver must
   read state first and return `already` rather than clicking — a blind click is destructive,
   not idempotent.

4. **Comment box and submit control.** On a `/feed/update/` detail page the composer is
   rendered inline, no click needed (the `button[aria-label="Comment"]` in the action bar is
   only required from the feed):
   - form: `form.comments-comment-box__form`
   - box: `div.ql-editor[contenteditable="true"][role="textbox"]`, with
     `aria-label="Text editor for creating content"`,
     `data-placeholder="Add a comment…"` and `data-test-ql-editor-contenteditable="true"`.
     It is a Quill editor, so content is `<p>…</p>`; drive it with `insertText`, not
     per-key typing (the `👀` target is astral-plane).
   - **submit: the button does not exist in the DOM until the editor has text.** Its
     presence *is* the armed signal — there is no disabled-then-enabled transition to wait
     on. When it appears it carries **no `aria-label`**.

     **Select it by class: `button.comments-comment-box__submit-button--cr`.**

     This corrects the first pass, which proposed locating it by accessible name scoped to
     `form.comments-comment-box__form`. That **provably does not work** and cost a failed
     live attempt: artdeco pads the button's `textContent` with newlines, so Playwright's
     `hasText: /^Comment$/` matched zero elements even with the button plainly in the DOM.
     Dropping the anchors would then collide with the action bar's own `Comment` button.
     The BEM class exists only on the composer's submit control, so it is both unambiguous
     and immune to the whitespace problem. This is a case where the usual
     "prefer accessible names over classes" instinct is simply wrong for this element.

   This one was worth the probe: the plausible-from-memory selector (`button` named `Post`)
   matches nothing at all.

5. **Confirming a posted comment.** Each comment in the thread is
   `article.comments-comment-entity[data-id="urn:li:comment:(activity:<postId>,<commentId>)"]`
   — the post URN is embedded in the comment's own id, so a comment can be attributed to its
   post without trusting page context. Inside: author name in
   `.comments-comment-meta__description-title`, author profile URL on the
   `.comments-comment-meta__actor` anchor's `href`, body in
   `span.comments-comment-item__main-content`, age in a `<time>`.

   The verification signal is therefore: an `article[data-id^="urn:li:comment:(activity:<postUrn>"`
   whose actor href is our own profile and whose main-content text equals the sent text —
   plus the composer having cleared.

   **VERIFIED** on a live `👀` comment. The posted row came back as
   `data-id="urn:li:comment:(activity:7489401096851906561,7489611829028102144)"` with text
   `Itai Tevet | • You | Premium • You | Co Founder and CEO at Intezer | 2s | 👀 | Like | Reply`,
   and the editor read `""` immediately after. Two details for the driver:
   - the own-comment row carries a **`• You` badge** in the meta line — a cheaper author
     match than resolving the actor href, though the href remains the exact signal;
   - the composer clearing is a **reliable** second signal, confirmed here.

   The astral-plane emoji survived intact, which confirms `insertText` is the right way to
   drive the Quill editor — per-key typing would have mangled it.

6. **Comments-disabled posts: not tested.** Neither probed post had comments off, and none
   was hunted down. The structural difference is therefore **unknown** — not guessed here.
   The likely shape (composer absent while the action bar's Comment button remains, or the
   whole `comments-comment-box__form` missing) must be confirmed against a real restricted
   post before `comments_disabled` is implemented. Until then the driver should treat
   "composer absent after clicking Comment" as `comments_disabled` only provisionally, and
   log the DOM.

7. **Yes — the post exposes its canonical URN.** The post container is
   `div[data-urn="urn:li:activity:…"][role="article"]`, wrapped by
   `div[aria-label="Update container"]` inside `main[aria-label="Feed detail update"]`.
   The attribute name is **`data-urn`**, and it was present and correct on both posts.
   **The activity-vs-ugcPost gap can therefore be closed at run time**: the driver reads
   `data-urn` off the container and returns it as `observedUrn`, and the caller reconciles.
   This is not theoretical — see finding 8, where the URL and the container disagree.

8. **Shortlink resolution — `lnkd.in` is a plain HTTP 301, and the URL lies about the URN.**
   `https://lnkd.in/p/dkTR-yYF` answered `301` straight to
   `https://www.linkedin.com/posts/lolly-andreoli-075684b2_youre-invited-to-preview-what-sai-can-do-share-7489401095899770880-VbZT/?utm_source=share&…`.
   One hop, no JS, no interstitial — so a server-side `fetch(..., { redirect: 'manual' })`
   could resolve shortlinks later without a browser, if we ever decide the network call on
   the enqueue path is worth it.

   The far more important half: that slug's token is **`-share-`, not `-activity-`**, and
   its id (`7489401095899770880`) is **a different number** from the `data-urn` the page
   actually rendered (`urn:li:activity:7489401096851906561`). Two consequences for
   `normalizePostUrl`:
   - the current `/\/posts\/[^/?#]*-activity-(\d+)/i` returns `null` for a perfectly ordinary
     share link. The character class must accept `-(activity|share|ugcPost)-`;
   - even once it does, the URN it builds (`urn:li:share:7489401095899770880`) will **not**
     equal the canonical activity URN, so the same post enqueued from a share link and from
     a `/feed/update/` link dedupes as two rows. The "known gap" in *URL and URN
     normalization* below is **observed, not hypothetical** — and finding 7 is its fix:
     write `observedUrn` back and dedupe on it after the first visit.

9. **Individual vs company-page post: the action bar is identical** — same
   `div.feed-shared-social-action-bar`, same four controls (`React Like` / `Comment` /
   Repost / `Send in a private message`), same flyout, same `data-urn` container. **No
   driver branching is required.**

   One shared hazard, unrelated to which post it is: both bars begin with
   `button[aria-label="Open menu for switching identity when interacting with this post"]`,
   because this account administers pages. It renders the *member's* photo, so reactions
   and comments currently go out as the member — but a stray click there would switch the
   authoring identity to a company page for subsequent actions. The driver must never touch
   it, and should assert the trigger it clicks is the react button, not the first button in
   the bar.

### Known gaps — what these findings do NOT cover

Recorded so nobody reads "live-verified" as broader than it is. Everything here is implemented
and unit-tested; none of it has been exercised against the real page.

- **Only `like` has ever been placed live.** The other five reactions are implemented, mapped
  to LinkedIn's enum and covered by tests, but no `celebrate`/`support`/`love`/`insightful`/
  `funny` has been clicked on a real post. The hover-flyout path they all depend on was
  observed, but only the trigger itself was ever pressed. This is the least-proven part of the
  feature, which is exactly why `unavailable` counts toward the failure streak.
- **No comments-disabled post was ever found**, so finding 6's structure is inferred, not
  observed, and `PSEL.commentsDisabledText` is a wording probe. Every `comments_disabled`
  verdict captures evidence so the real structure can be read off an incident later. Because
  the verdict is inferred AND is a terminal skip that never touches the failure streak, the
  structural branch demands two language-independent signals before it fires: the action bar
  rendered, and `PSEL.reactTrigger` resolves inside it (proving our selectors can still find
  that bar's controls). `PSEL.commentButton` is itself matched on the BEM class
  `comment-button` first and the English `aria-label="Comment"` only as a fallback — an
  English-only probe would have read a Hebrew cold-load render as "the author disabled
  comments". Anything short of both signals falls through to `unavailable`, which counts.
- **Findings 3, 4 and 5 rest on one post.** The comment confirmation (`• You` badge, cleared
  composer, `article[data-id]` row) and the reaction-state flip (`aria-pressed`,
  `react-button--active`, social-count line) were each observed as a single before/after on the
  same individual member's post. Finding 9 says an individual and a company post render the
  same action bar, but the *comment thread* on a company post was never posted into.

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
| `https://www.linkedin.com/posts/<slug>-share-7489…-VbZT` | **the common real-world form**; id follows `-share-`; rebuild as `urn:li:share:<id>` |
| `…?updateId=urn%3Ali%3Aactivity%3A7123…` | URL-decode the query parameter |
| bare `urn:li:activity:7123…` | accepted as-is |
| `https://lnkd.in/<code>` | expanded by `resolveShortlink` before parsing (see below) |

The URN type is captured, not assumed: `urn:li:activity:`, `urn:li:ugcPost:` and
`urn:li:share:` are all preserved verbatim in `post_urn`. `post_url` is always rewritten to
the canonical `https://www.linkedin.com/feed/update/<urn>/` form.

### Shortlinks are expanded, not rejected (revised 2026-08-02)

The original design rejected `lnkd.in` links to keep the enqueue path free of network
calls. That did not survive contact with reality: the very first URL supplied in testing was
a shortlink, and a mobile share sheet produces one by default. The probe settled the
feasibility question — `lnkd.in` answers a **plain HTTP 301, one hop, no JS interstitial** —
so expansion costs one cheap unauthenticated request, not a browser.

The pure/impure split is preserved rather than abandoned:

- `normalizePostUrl` stays pure and synchronous, and still returns `null` for a shortlink.
- `isShortlink(raw)` and `resolveShortlink(raw, { fetchImpl })` are separate. The resolver is
  bounded (5s timeout, ≤3 redirects), refuses to follow to a non-`linkedin.com` host, and
  returns `null` rather than throwing, so a dead link degrades to a named reject.
- The API expands before validating. `fetchImpl` is injected through `buildServer`, the same
  way `apifyClientFactory` is, so no test ever reaches the network.

`isShortlink` matches the host the way `hostOf` does rather than with a scheme-anchored
regex — a bare `lnkd.in/p/…` with no scheme is exactly what gets pasted, and a
scheme-anchored test would miss it and produce a misleading "not a LinkedIn post URL".

### The URL's id is not the post's id (observed 2026-08-02)

**This is no longer a hypothetical gap.** For one real post, the share-link slug carried
`7489401095899770880` while the post's own `data-urn` read
`urn:li:activity:7489401096851906561` — different numbers for the same post. So the URN
parsed from any URL is a **best-effort identity**, and two URL forms of one post will
enqueue as two rows.

The probe confirmed the post container exposes `data-urn` on `div[role="article"]`, so the
resolution is **run-time reconciliation**: `reactToPost` returns the canonical URN as
`observedUrn`, and the sender calls `EngagementRepo.reconcileUrn` before doing anything
else. If another row already holds that canonical URN, this row is the redundant one and is
retired rather than engaged with a second time.

Enqueue stays offline and cheap; the duplicate is transient and self-heals on first
execution. The alternative — opening every post in the authenticated browser at enqueue —
would take the single browser lock and fight the sender for it.

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
  `commented_at` is stamped on a **submitted** comment, not only a confirmed one (see the
  `unverified` line below): the submit click is irreversible, so the budget has to assume
  the worst. `POST /api/engagements/:id/retry` clears it — the operator's "I checked, it
  did not post" is the one statement that refunds the slot.

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
    unverified        -> commented_at = clock(); needs_attention; NEVER auto-retry
                         # the submit click already happened: the comment may be live, so
                         # it costs a comment-budget slot until a human says otherwise
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
| `POST` | `/api/engagements/:id/retry` | 409 unless the row is `failed`, `needs_attention` or `skipped`; clears `commented_at` |
| `POST` | `/api/engagements/:id/dismiss` | terminal `skipped`/`dismissed`; also the cancel path for a queued row |

`skipped` is in the retryable set on purpose, and it is what makes **dismiss undoable**:
dismiss produces `skipped`/`dismissed`, so retry is the way back. It also covers the two
skips a human may disagree with — a `not_found` that was really a transient 404, and a
`comments_disabled` inferred from structure rather than wording.

Retry clears `commented_at` along with `scheduled_for`, `last_error` and `skip_reason`, and
deliberately leaves `reacted_at`: see the comment-budget note under Capacity for why the
column is set on an unverified comment in the first place.

Creation calls `planAndAssignToday` immediately, so a task enqueued at 09:05 gets a real
slot instead of sitting until the hourly tick — same reasoning as `/api/profiles`.

Bulk creation returns rejects **by name and reason**, the way `POST /api/events` does:
finding out mid-run that a URL was junk is far too late.

```json
{ "added": 12,
  "rejected": [ { "post_url": "…", "reason": "invalid_url" } ] }
```

Reject reasons: `invalid_url`, `shortlink_unresolvable`, `duplicate`, `unknown_reaction`,
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
Editing or deleting a comment once posted. Comment templates or
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

## Live verification of the production driver (2026-08-02)

The findings above were captured with `scripts/probe-post-engage.ts`, which drives Playwright
directly. This section records the separate exercise of the **shipped** code path —
`LinkedInDriver.reactToPost` / `.commentOnPost` via `src/browser/post-selectors.ts` — through
`scripts/verify-post-engage.ts`, against four real posts.

**Confirmed working:**

- Shortlink expansion end to end. Two `lnkd.in/p/…` links resolved through `resolveShortlink`
  (previously only ever exercised against an injected fake).
- The **hover flyout**, driven for real: `celebrate` and `insightful` both placed. This was the
  most fragile part of the feature and had never been executed.
- The **destructive-click guard**: on a post already carrying our Like, the driver reported
  `already` and did not click. A click would have removed the reaction.
- `observedUrn` extraction, and detail-shell container scoping (`div.update-outlet`) resolving
  to exactly one post container per page.
- Comment publication and confirmation through `readCommentConfirmation`.

**The URN divergence is the normal case, not the exception.** Three of four posts disagreed
between the URL and the page, across two different URN types:

| URL URN | page `data-urn` |
|---|---|
| `urn:li:share:7489401095899770880` | `urn:li:activity:7489401096851906561` |
| `urn:li:ugcPost:7488993474344845314` | `urn:li:activity:7488993475170861056` |
| `urn:li:share:7488905647124590592` | `urn:li:activity:7488905647955263488` |
| `urn:li:activity:7487584764410019841` | *(same)* |

Run-time reconciliation is therefore load-bearing, not a safety net.

### NEW FINDING — comment attribution by post URN does not work

A comment's `data-id` does **not** carry the container's URN. On the one post whose URL and
`data-urn` agreed (`urn:li:activity:7487584764410019841`), the comment we posted came back as:

```
urn:li:comment:(ugcPost:7487584763386560512,7489660459537788928)
```

A `ugcPost` URN, with a different id, on a post the container calls `activity`. So the
attribution signal proposed in finding 5 — match `article[data-id^="urn:li:comment:(activity:<postUrn>"` —
**fails even in the case it was designed for**, and the live run reported `attributedToPost=false`.

Confirmation succeeded only because the driver was built to degrade: it falls back to the
body-text match plus the composer having cleared, and treats attribution as advisory. That
fallback was written defensively against a case nobody had observed. It is now the primary path.

**Consequence to keep in mind:** comment confirmation currently rests on "a comment containing
our text appeared, and the composer cleared" — not on proof the comment is ours on this post.
Two operators commenting identical text on the same post within the confirmation window could
in principle cross-confirm. The `• You` badge is read and logged but is English-only, so it is
not load-bearing. Tightening this needs a language-independent ownership signal; the actor
`href` on `.comments-comment-meta__actor` is the obvious candidate and was not tested.

### Still unverified

- The remaining three reactions (`support`, `love`, `funny`). The flyout mechanism is proven,
  so these are low-risk, but the exact aria-labels are untested.
- `comments_disabled` — no post with commenting restricted was ever available.
- The `unverified` comment path. By its nature it only appears when confirmation fails, which
  it did not.
