# Skipped bucket + email-required detection — design

**Date:** 2026-07-03
**Status:** approved by user

## Problem

Some LinkedIn profiles require the sender to know the member's email: the invite
composer opens normally, but submitting pops a dialog — *"To verify this member
knows you, please enter their email to connect."* — and the invite never
registers. The driver ignores that dialog, re-visits the profile, finds no
Pending badge, and records the generic `send not confirmed: no Pending state
after submit` error. The profile lands in `failed`, which the dashboard counts
under **Needs attention** — but retrying can never succeed, so it pollutes a
bucket that should be reserved for genuinely retryable problems.

Live evidence: profiles 368 (`parkforeman`) and 372 (`abdulsamadhussain`), both
`failed` with 3 attempts and the generic error; the incident screenshots show
the profile still offering a bare Connect button after "submit".

## Design

### 1. Detect the email-verification gate (browser layer)

- **`linkedin-selectors.ts`**: add a locator for the email-verification dialog.
  Two signals, either sufficient:
  - text match on the dialog copy: `/enter their email to connect/i`
    (en-US is forced at launch, so English wording is stable);
  - an `input[type="email"]` inside the invite dialog.
- **`linkedin-driver.ts`**: new `SendResult` value **`email_required`**.
  Checked at two points in `sendConnectionRequest`:
  1. **Immediately after clicking the send button, before navigating away**
     to the confirm step — this is where the dialog actually appears. If
     present: capture evidence (screenshot now shows the modal itself) and
     return `{ result: 'email_required', firstName, evidence }`.
  2. In the composer-not-usable branch (no "Send without a note" / "Add a
     note"): if the email dialog is what's showing, return `email_required`
     instead of `unavailable`.

### 2. Generalize terminal skips (data model)

- **New column** `profiles.skip_reason TEXT` (nullable), added via the existing
  idempotent-migration pattern in `database.ts` + `schema.sql`.
- **`SkipReason`** type: `'already_connected' | 'email_required' |
  'unavailable' | 'dismissed'`.
- **Drop the `already_connected` status.** Migration rewrites existing rows:
  `status='already_connected'` → `status='skipped', skip_reason='already_connected'`.
  (Production DB currently holds 2 such rows.) Pre-existing `skipped` rows keep
  a NULL reason (rendered as “—”). No CHECK constraint exists on `status`, so
  this is a plain `UPDATE`.
- **`EventType`**: `already_connected` stays valid for historical rows in
  `profile_events`, but new events record `skipped`.

### 3. Sender mapping (`worker/sender.ts`)

| Driver result    | Status    | skip_reason         | Failure streak | Notes |
|------------------|-----------|---------------------|----------------|-------|
| `already`        | `skipped` | `already_connected` | untouched      | was `already_connected` status |
| `email_required` | `skipped` | `email_required`    | **untouched**  | per-profile verdict, not an automation failure; terminal, never retried |
| `unavailable`    | `skipped` | `unavailable`       | increments (unchanged) | |

`last_error` stays NULL for skips (they aren't errors); the human-readable
reason lives in `skip_reason`. Verdict log lines name the real reason
(e.g. `skipped: LinkedIn requires their email to connect`).

### 4. API + UI

- **Dashboard outcome card**: "Already connected" → **"Skipped"**, count =
  `counts.skipped` (which now includes the migrated already-connected rows).
  Drill-down drawer lists profiles with a per-row reason label:
  `already connected`, `requires their email`, `composer unavailable`,
  `dismissed`, `—` (legacy NULL).
- `/api/profiles?status=...` returns `skip_reason` so the drawer can render it.
- **Needs attention** stays `failed + needs_attention` only.
- **Dismiss** (`/api/profiles/:id/dismiss`) and queue-remove endpoints keep
  setting `skipped` and now stamp `skip_reason='dismissed'`, so dismissed
  profiles land visibly in the Skipped bucket.
- `web/app.js`: remove `already_connected` from `DRILL_DATE`/pill styling;
  drawer for `skipped` shows the reason column.
- `core/metrics.ts`: `already_connected` count field becomes `skipped`
  (the metrics table in the UI doesn't render it today; keep the field for
  API consumers but base it on `status='skipped'`).

### 5. The two stuck profiles

After the fix lands, requeue 368 and 372 (single-profile Retry). The driver
re-attempts for real, hits the email dialog, and classifies them
`skipped / email_required` — doubling as the end-to-end verification of the
new detection before merge.

## Error handling

- The email-dialog check is best-effort (`.catch(() => false)` like every other
  probe); if the dialog is missed, behavior degrades to today's `failed` path.
- Evidence capture at the post-submit check happens **before** navigation, so
  the screenshot finally shows the blocking modal.

## Testing

- Unit (vitest, fake driver): sender maps `email_required` → `skipped` +
  reason, no failure-streak increment, event recorded; `already` → skipped +
  reason; dismiss endpoint stamps `dismissed`.
- Migration test: DB with `already_connected` rows opens → rows become
  `skipped/already_connected`; idempotent on re-open.
- API test: `/api/attention` excludes skipped; `/api/profiles?status=skipped`
  includes `skip_reason`.
- E2E: retry the two stuck profiles through the live driver (per §5).
