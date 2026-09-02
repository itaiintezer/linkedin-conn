# Message send confirmation — false negative, unconfirmed verdict, retry safety

**Date:** 2026-09-02
**Status:** implemented (branch `claude/message-send-confirmation`)
**Source:** two independent investigation reports, 2026-09-01, from Dominic Rinaldi's and
Jacob Pickard's machines (both macOS, US). Same bug, same day, same root cause.

## What happened

Direct messages were sending fine. The **post-send confirmation** in
`LinkedInDriver.sendMessage` then reported `message send not confirmed (composer/thread
state)`, so a delivered DM was recorded as `failed`, cost a failure-streak point, and grew a
Retry button.

- 16 false failures, 4 `repeated_failures` guardrail halts (which also stopped the invite
  engine — 1,317 profiles queued behind it on Jacob's machine).
- 2 prospects got the identical DM twice: "Retry all profiles" re-queued rows whose first
  send had landed.
- ~16 real sends missing from `send_log`, so the weekly message cap under-counted.

## Root cause

The check compared the text we typed against the thread's `textContent`, with `\s+ → ' '`
applied to both sides. LinkedIn renders a template's line breaks as `<br>`, which
contributes **no character** to `textContent`:

```
ours   "Hi Philip, I am directly messaging and s"   (collapse: "\n\n" → " ")
page   "Hi Philip,I am directly messaging and sh"   (<br><br> → "")
```

Collapsing whitespace is not the inverse of how a browser flattens `<br>`. Any template with
a line break inside its first 40 characters — i.e. every `Hi {firstName},\n\n…` template —
failed on 100% of sends. It surfaced only in late August because LinkedIn's rendering
changed (or an A/B bucket flipped): the 2026-08-26 captures show a whitespace-bearing
separator (`<span class="white-space-pre"> </span>`) at the break, the 08-28 and 08-31
captures show bare `<br><br>`. Itai's machine (Windows, Israel) never hit it, which is
consistent with a per-account rollout. The lesson is that the confirmation depended on
LinkedIn's whitespace rendering at all.

Two secondary findings from the same reports:

- **Misspelled placeholders go out verbatim.** `applyFirstName` substitutes `{firstName}`
  case-sensitively and nothing validated the template. Four people got "Hi {FirstName},"
  (cohort 8, 08-26); two got "Hey [First name]," (Toronto event, 09-01).
- **Screenshots silently stopped.** Every incident from 08-31 has `screenshot: null`; the
  capture's `catch {}` swallowed the reason.

## Changes

### P0 — the verdict is pure, whitespace-free, and novelty-guarded (`src/core/message-confirm.ts`)

- `squeeze()` removes **all** whitespace and the zero-width / bidi format characters a
  right-to-left UI can inject (U+200B–200F, U+202A–202E, U+2060, U+2066–2069, U+FEFF) from
  both sides. `<br>`, `white-space-pre` spans, `\r\n`, NBSP and Hebrew-chrome isolates all
  agree after that. This is the "support every rendering variant" requirement — it must
  not matter which one LinkedIn picks for a given account.
- `confirmSentMessage(read, sentText, eventsBefore)` returns `sent | unconfirmed | error`.
  **Novelty is the proof**: the count of thread elements carrying the needle must have
  *grown* since a snapshot taken before clicking Send. Matching any row would "confirm" a
  previous attempt's copy — the exact state a retried row is in. Counting rather than
  diffing text is deliberate: a duplicate has identical text.
- Verdicts: LinkedIn's failed banner or a composer still holding the text → `error`
  (nothing left the account). Composer cleared + new copy in thread → `sent`. Composer
  cleared, no new copy → `unconfirmed`.
- The driver reads the surface in one `page.evaluate` (`readMessageSurface`, verbatim
  texts, no named inner binding — esbuild keep-names), then polls the pure verdict for up
  to 12 s. A timeout is `unconfirmed`, never `error`.
- Tests: `tests/core/message-confirm.test.ts`, with the thread body reconstructed from the
  markup Dominic's capture showed, plus the 08-26 variant, CRLF, bidi, novelty and the
  genuine-failure shapes.

### P1 — an unconfirmed message is unconfirmed, not failed (`src/worker/sender.ts`)

`attemptMessage` gains the `unconfirmed` case the invite path already had: `needs_attention`
with `last_error = "message submitted but not confirmed — check the conversation before
retrying"`, `recordSend` (the cap must not under-count), `recordSuccess` (we reached
LinkedIn and submitted), `halted: false`. This alone would have prevented every halt and
both duplicates even with the P0 bug in place.

### P1 — bulk retry never re-sends a DM that may have landed (`src/core/retry-safety.ts`)

`POST /api/retry` skips message rows whose `last_error` says the send may already have been
delivered — the new unconfirmed park, the offline-mid-send and interrupted-mid-send parks
(all now share `CHECK_THREAD_HINT`), **and the legacy** `message send not confirmed
(composer/thread state)` string, so the rows already sitting as `failed` on Dominic's and
Jacob's machines stay protected after they update. Response gains `skipped` and
`skipped_reason`; the dashboard toast names them and points at per-row Retry, which now asks
for confirmation on such a row. Individual retry is unchanged — a deliberate per-person
decision after looking at the conversation.

### P2 — placeholders are validated at write time (`validatePlaceholders`, `src/core/message.ts`)

`POST /api/cohorts`, `/api/lists` and `/api/profiles` return `400` for `{FirstName}`,
`{first_name}`, `{ firstName }`, `{{firstName}}`, `[First name]`, `<firstName>`, or any other
word-like `{token}`, naming `{firstName}`. Braces inside ordinary prose are left alone.
Stored templates are never re-validated, so existing cohorts keep working.

### P2 — evidence capture logs why a screenshot failed (`src/browser/evidence.ts`)

Still best-effort, HTML still never lost; the reason now reaches `data/relay.log`.

## Not done, on purpose

- **Per-engine guardrail scoping** (Jacob's #5). A design change to the guardrail contract;
  with `unconfirmed` no longer feeding the streak the trigger is gone. Worth its own spec.
- **Send preview in the dashboard** (Jacob's #3). Validation at write time closes the hole
  that mattered; a preview is a UI feature to brainstorm separately.
- **The `--sent` delivered-marker selector** as a second positive signal. Not observed in any
  capture on this machine; not adding an unverified selector.
- **Backfilling `send_log`** for the ~16 uncounted sends. Operator decision; usage is far
  under the cap and the window closes 2026-09-07.

## Operator notes (for Dominic and Jacob)

1. Update, then **do not** press "Retry all profiles" expecting it to touch the parked
   message rows — it will now leave them alone and say so. Dismiss them individually; they
   were all delivered.
2. Templates spelled `{FirstName}` or `[First name]` will be rejected on save from now on
   with the correct spelling in the error. Existing cohorts are untouched — fix cohort 8 and
   the Toronto template by hand.
3. Multi-line `Hi {firstName},\n\n…` templates are fine again; no need to flatten them.
