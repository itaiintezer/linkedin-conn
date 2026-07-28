# Message campaigns — design

**Date:** 2026-07-28
**Status:** approved pending user review

## Goal

Add automated message-sending to existing 1st-degree connections as a second campaign
type alongside connection requests: same queue/batch/cohort/scheduling machinery, a
second funnel on the dashboard, and reply tracking analogous to acceptance tracking.

## Decisions (from brainstorm)

| Question | Decision |
|---|---|
| Recipients | Any existing 1st-degree connection (pasted/imported lists) — independent of the invite funnel |
| Message model | Single message per contact (no sequences; schema must not preclude them later) |
| Outcome tracking | Track replies; check frequency configurable, default 2/day (same slot mechanism as acceptance checks) |
| Pacing | Separate caps for messages (weekly cap / batch size / batches per day); shared working hours, weekdays rule, delays, pause state, and guardrails |
| Not a 1st-degree | Skip with reason `not_connected` — never auto-convert to an invite, never risk InMail |
| Dashboard UX | Two stacked conveyors on the one dashboard (invites: Queued → Scheduled → Pending → Accepted; messages: Queued → Scheduled → Sent → Replied); idle engine collapses to a slim summary row |

## Discovery findings (live-verified 2026-07-28)

Verified against the real logged-in session with a consented test send
(`keren-tevet-3453a079`). Evidence scripts kept in the repo: `scripts/inspect-messaging.ts`,
`scripts/probe-topcard.ts`, `scripts/probe-compose.ts`, `scripts/inspect-message-send.ts`.

1. **Profile top card is the new obfuscated-class React UI.** No `h1` on the page; the
   profile name is an `h2` with hashed classes. Do not rely on any hashed class name.
2. **1st-degree gate:** the primary gate is the invite driver's production-proven
   `isAlreadyConnected` signal — profile rendered (name readable) + no Pending badge +
   no Connect affordance anywhere (top card, custom-invite anchor, or under "More") —
   AND the `/messaging/compose/` deep link must be present. The `· 1st` badge `<p>`
   (verified live via capped ancestor walk from the name `h2`) exists but the invite
   driver documents degree text as unreliable across page variants (both tokens can
   render), so it is not load-bearing. Gate fails ⇒ **skip `not_connected`**
   (fail-safe direction: refusing wrongly costs one skip, sending wrongly risks InMail).
3. **Compose deep link:** the Message control is an
   `<a href="/messaging/compose/?profileUrn=…&recipient=…">`. Navigating to that URL
   (like the invite flow's `custom-invite` route) opens the **classic messaging UI with
   stable semantic selectors** — no clicks on hashed-class elements anywhere:
   - box: `div.msg-form__contenteditable[contenteditable="true"][role="textbox"]`
     (aria-label "Write a message…")
   - send: `button.msg-form__send-button[type="submit"]` — **disabled until text is
     typed**, re-disabled after send
   - prior thread history renders as `[class*="msg-s-event"]` items
   - InMail composers are distinguishable (none seen on 1st-degree; overlay text carries
     "InMail" markers otherwise)
4. **Send confirmation is structural** (three independent signals): composer cleared +
   send button disabled again + sent text present as the last `msg-s-event` in the thread.
5. **Inbox scan for replies:** `https://www.linkedin.com/messaging/` renders a
   conversation list (`ul.msg-conversations-container__conversations-list` with
   `li.msg-conversation-listitem` rows) with stable classes. Each row exposes the
   participant display name and a snippet prefixed **`You:`** when we sent the last
   message. A reply = a messaged contact's row whose snippet does not start with `You:`.
   Filter chips (Focused / Unread / Connections) exist if needed. One page load per pass —
   same cost and same *top-slice* limitation as the acceptance check.

## Data model

- `cohorts.kind TEXT NOT NULL DEFAULT 'invite'` — `'invite' | 'message'`. A message
  campaign *is* a cohort of kind `message`; no new entity.
- `profiles.kind` — denormalized from the cohort at enqueue.
  Uniqueness becomes `UNIQUE(profile_url, kind)` (someone invited last quarter is a
  legitimate message target; today's `UNIQUE(profile_url)` would block them). SQLite
  requires a table rebuild for this; migration copies data, keyed writes unaffected.
- `profiles.full_name TEXT` — display name captured from the profile page at send time;
  needed to match inbox rows during reply checks.
- `profiles.thread_url TEXT` — the conversation URL captured after a successful send;
  targeted fallback when a display name is ambiguous in the inbox scan.
- `profiles.replied_at TEXT` — message-funnel analog of `accepted_at`.
- New `skip_reason`: `'not_connected'`.
- Settings additions: `msg_weekly_cap` (default 200), `msg_batch_size` (default 5),
  `msg_batches_per_day` (default 4), `reply_checks_per_day` (default 2).
  `app_state.replies_checked_at` mirrors `acceptance_checked_at`.
- Statuses reused verbatim; `replied` is a new terminal status reached only from `sent`,
  only by upgrade (a reply can never be un-detected — same one-way principle the
  acceptance checker follows).

Message cohorts **require** a template or per-contact custom message (blank = "send
nothing" is valid for invites, meaningless for messages). Template limit 2,000 chars
(invite notes stay at 300). `{firstName}` substitution unchanged.

## Engine behavior

**Scheduler** (`scheduler-service`): plans per kind with that kind's caps — two
independent slot plans sharing working hours/weekday rules and randomized in-window
times. Re-sort on startup, overdue requeue, and orphaned-`sending` recovery apply per
kind unchanged.

**Sender**: the orchestrator's minute tick runs the invite pass then the message pass
under the same browser mutex. The message pass mirrors `runSenderOnce`:

1. Capacity from `msg_weekly_cap` minus message sends in the rolling window (message and
   invite send counts are tracked separately in `send_log`/events).
2. For each due profile: goto profile URL → 404 ⇒ skip `not_found` → run the 1st-degree
   gate (`isAlreadyConnected` must be true) ⇒ otherwise skip `not_connected` → read name
   (`full_name`, `{firstName}`) →
   extract compose href (absent ⇒ skip `not_connected`) → navigate → type template →
   verify send-button enablement → send → verify the three structural signals →
   status `sent`, record event, stamp `sent_at`, capture `thread_url`.
3. Verdict handling identical in spirit to invites: `checkpoint` trips the shared red
   guardrail (halts BOTH engines); repeated failures feed the same failure streak;
   `unavailable`/`error` save incident evidence to `data/incidents`.

**Reply checker** (`reply-checker`, sibling of `acceptance-checker`): slot-gated pass
(default 2/day) — one navigation to `/messaging/`, scan the conversation list, match
rows to `sent` message-profiles by `full_name`; a matching row whose snippet lacks the
`You:` prefix ⇒ status `replied`, stamp `replied_at`. Ambiguous names (two pending
contacts sharing a display name) are logged and left pending — fail-safe, no state
change; the stored `thread_url` enables a per-thread fallback later if it ever matters
in practice. Stamp `replies_checked_at` only after a clean,
non-empty read (the acceptance-checker lesson: a failed pass must not burn the slot).

## UX

**Dashboard** — two stacked conveyors (approved option B):

- Invites conveyor exactly as today; messages conveyor beneath: Queued → Scheduled →
  Sent → Replied, its own fuel bar ("38 / 200 messages this week"), its own visual
  accent, drill-downs per station.
- An engine with zero non-archived profiles collapses to a slim one-line summary row.
- Shared "Up next" list interleaves both kinds, each row tagged with a small type icon.
- Outcome cards (Expired / Skipped / Needs attention) stay shared; the skipped drawer
  shows the `not_connected` reason; "Needs attention" and banners are global (one pause
  state, one guardrail).
- "Run batch now" runs the due batch of both kinds (each respecting its own caps).
- The acceptance "recheck now" affordance gets a sibling on the Replied station.

**Add List** — a two-option kind toggle (Connect / Message) above the cohort picker.
Cohort dropdown filters to cohorts of the selected kind. Template field adapts: label
("Message" vs "Invitation note"), 2,000-char counter, and required-ness for messages.

**Cohorts** — metrics table gains kind-appropriate columns: invite cohorts unchanged;
message cohorts show Total / Sent / Replied / Reply rate / Median days to reply. A small
kind badge on each cohort card and metrics row. Cohort editor: kind fixed at creation
(existing cohorts are all invites), template rules per kind.

**Settings** — a "Messages" pacing block (weekly cap, batch size, batches/day, reply
checks/day) beside the existing invite block; shared hours/weekday fields labeled as
applying to both.

**API** — `POST /api/lists` accepts `kind`; cohort/metrics/status endpoints return
kind-aware fields; settings endpoint round-trips the new knobs; drill-down endpoints
accept the `replied` status.

## Error handling

- Checkpoint/captcha on any messaging surface ⇒ same URL/title-based detection, same
  red guardrail, incident screenshot, both engines halt. Resume re-checks once.
- Login lost ⇒ shared trip, unchanged.
- Send verification fails (composer didn't clear / text absent) ⇒ `failed` + incident
  evidence + failure streak. No retry loop inside a batch.
- Not-connected and 404 are terminal skips that never touch the failure streak (stale
  imports must not halt the engine).
- LinkedIn has no known weekly cap on 1st-degree DMs; our own `msg_weekly_cap` is the
  only throttle. If LinkedIn ever interposes a limit dialog, the generic
  `unavailable`/checkpoint paths catch it and evidence tells us what to special-case.

## Testing

- Unit: scheduler per-kind planning, per-kind capacity math, reply-checker matching
  (You:-prefix parsing, name ambiguity fallback), template validation per kind,
  migration (uniqueness rebuild preserves rows).
- Driver: verdict mapping with recorded DOM fixtures from the discovery evidence
  (degree gate present/absent, compose link absent, send-button state machine).
- E2E (manual, against the test profile only): one scheduled message send end-to-end +
  a reply-check pass, before merge — per repo practice.

## Out of scope (explicit)

- Message sequences / drips, reply-content capture, auto-convert `not_connected` to an
  invite, per-thread reply scanning beyond the ambiguity fallback, InMail of any kind.
