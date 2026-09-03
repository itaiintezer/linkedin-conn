# Messaging campaign: false "not a 1st-degree connection" skips

**Date:** 2026-09-03
**Trigger:** a bug report from a second operator's instance (Jacob Pickard, via Slack DM):
every profile that instance's messaging engine had ever skipped as `not_connected` — 8 of 8,
across three cohorts — was present in its LinkedIn-exported connections roster. That is
~20% of the completed message attempts silently discarded. This instance shows the same
defect at smaller scale: profile 731 (`philmiller4`, cohort *Bay Area AI SOC Live - Aug
2026*) is the one `not_connected` skip here, and it too is in the roster.

## What the report got right

**The timing fingerprint.** From `data/relay.log`, every one of the eight verdicts landed
inside `page.goto` + the fixed `sleep(rand(1500, 3500))` — a spread that matches that single
random sleep and nothing else. They returned before the overflow expansion and before the
compose-route navigation. The exit is therefore `classifyRelationship` resolving on its
first top-card read, i.e. one of `unreadable` / `pending` / `connectable`.

**Root cause 3.1 (primary): an unreadable page was a terminal verdict.** `readFullName`
reads only `document.title` with no wait and no retry. LinkedIn's SPA sets the title from
the model *after* `domcontentloaded`, so on a slow load it still reads "LinkedIn" when the
sleep ends → `nameRead: false` → `unreadable` → `mayReceiveDirectMessage` refuses → the
driver returned `not_connected` → the sender wrote a terminal skip. A failure to observe
was recorded as an observation about the relationship. Corroborating detail from the
report: one profile failed on `net::ERR_NETWORK_CHANGED` mid-goto and produced the false
skip on the retry 12h later — the machine had page-load trouble in exactly that window.

**Root cause 3.3: a missing compose anchor was also `not_connected`.** Selector rot or a
Message control demoted into the Sales Navigator "More" overflow surfaced as "not a
1st-degree connection", with no `relationship` field at all.

**Root cause 3.4: the verdict carried no evidence.** Every other judged verdict calls
`captureEvidence`; this one captured nothing, logged a bare string and set
`last_error = null`. That is why 3.1 could not be separated from 3.2 after the fact.

## What the report got wrong (stale view of `main`)

**§3.2 — "the Pending badge is still read page-wide".** It is not. PR #26
(`46febd0 fix(driver): only trust a Pending badge that belongs to the target profile`)
removed the page-wide fallback; `pendingForTarget` attributes every badge through
`pendingBadgeMatchesTarget` (label names the target, or the badge's card links to their
slug), and `linkedin-selectors.ts` deliberately no longer exports a bare `pendingBadge`
locator. A neighbour card's badge cannot refuse a DM on `main`.

**§3.5 — "the 2026-08-07 plan never landed".** It landed in PR #26 (`5288a01`, `46febd0`,
`a0a25c8`, `b2df5c4`): `relationship_unknown` outcome, `readPendingBadges`, the roster
tie-breaker for the invite side, and `scripts/probe-relationship.ts` all exist. What that
plan did **not** cover was the DM path — and that is exactly the gap this fix closes.

So of the two candidate mechanisms for the eight skips, only 3.1 (unreadable page) is
live on `main`, and it alone explains the timing fingerprint.

## The fix (this change)

Mapped onto the report's recommendations F1–F6:

| # | Recommendation | Done |
|---|---|---|
| F1 | An unreadable page is never terminal | `sendMessage` returns `relationship_unknown` (retryable, `needs_attention`, evidence) when the page carries no name after the wait; a checkpoint scan runs first, since an authwall renders the same way. |
| F2 | Wait for the name instead of trusting one title read | `classifyRelationship` now calls `awaitFullName`: polls `readFullName` every 500ms for up to 6s (`NAME_WAIT_MS`). Both the invite and DM pre-visits benefit. |
| F3 | Scope the Pending read to the target | Already on `main` (PR #26). No change. |
| F4 | Split `not_connected` into distinct facts | `not_connected` now requires a positive signal (`pending`/`connectable`). No compose anchor on a connection → `unavailable` with evidence (after trying the overflow, where Sales Navigator demotes the control). Unreadable → `relationship_unknown`. No new `skip_reason` values were needed. |
| F5 | Attach evidence | `notConnectedOutcome` captures a `not-connected` screenshot with the relationship and the four signal booleans; the sender's verdict line carries `(page read: <relationship>)` and the screenshot link. |
| F6 | Cross-check the roster before skipping | `confirmsNotConnected(relationship, inRoster)` in `core/relationship.ts`: a refusal for someone PRESENT in the roster parks as `needs_attention` ("…but they are in your connections list — check before retrying") instead of skipping. A present row is positive evidence at any age, as in `confirmsExistingConnection`. It is still never a send — the DOM gate keeps the InMail fail-safe. |

Tests: DM-path cases in `tests/browser/driver.test.ts` against `FakeProfilePage` (which
gained `last()` and a `titles` sequence to model a late-arriving SPA title), the
`confirmsNotConnected` truth table in `tests/core/relationship.test.ts`, and the sender's
roster-disagreement and `relationship_unknown` handling in `tests/worker/sender.test.ts`.

## Operator recovery

The rows are `skipped`, which `POST /api/profiles/:id/retry` accepts — it clears
`skip_reason` and returns them to `queued`. Do it **after** this fix is installed (otherwise
a slow load can re-skip them the same way), and confirm the cohort's message text first:
these are real sends. On this instance that is profile 731; on the reporting instance, ids
1544 1545 1546 1553 1558 1564 1566 1572.

## Open question, unchanged

Which of the eight hit 3.1 versus a genuinely misattributed control cannot be resolved from
stored data — the verdict recorded neither. F5 makes the next occurrence self-diagnosing.
