# Relay — UX Simplification Pass

**Date:** 2026-06-30
**Status:** Approved, proceeding to implementation

## Context

Relay is a LinkedIn outreach automation tool: a vanilla-JS frontend (served as static
files by Fastify) over a Node/SQLite backend with a browser-automation sender loop. This
pass addresses five usability issues raised after the recent light-mode redesign.

## Goals

1. Fix the "Engine paused" banner showing when the engine is not paused.
2. Guide new users through first-run setup (connect LinkedIn + set account type).
3. Remove the confusing "Allow sending without a note" checkbox.
4. Simplify and modernize the Add List screen.
5. Confirm/enable adding a single profile with a bespoke message via the API.

Non-goals: changes to the sender/automation core, acceptance checking, metrics, or
scheduling beyond what these five items require.

---

## ① Pause-banner bug — DONE

**Root cause:** `.pause-banner { display: flex }` has equal specificity to the UA
`[hidden] { display: none }` rule and wins by cascade order, so toggling the `hidden`
property had no visual effect — the banner was permanently visible, and because
`applyPauseUi` only fills `#pauseReason` when paused, it read "Engine paused." with no
reason even at `paused=0`.

**Fix (applied):** Global guard in `styles.css`:

```css
[hidden] { display: none !important; }
```

This keeps the `hidden` attribute authoritative for every JS-toggled element (banner,
Connect/Retry buttons, toasts, empty states, panels), not just the pause banner. Re-verify
live during implementation.

---

## ② First-run setup wizard

**Trigger:** a new `settings.onboarded` integer column (default `0`). The wizard renders as
a modal overlay on load whenever `onboarded = 0`; on completion it sets `onboarded = 1` and
never shows again.

**Steps (modal overlay):**

1. **Connect LinkedIn.** Button fires `POST /api/login` (opens the login window). The modal
   polls `GET /api/login-status` every ~2s; when `loggedIn` becomes true it marks the step
   done and enables advancing. Shows live "waiting for login… / connected" state.
2. **Account type.** Select among Free / Premium / Sales Navigator (no "Unknown" — a real
   choice is required to advance). Saved via `POST /api/settings`.

**Finish:** `POST /api/settings { account_type, onboarded: 1 }`, close modal, land on
dashboard.

**Migration (important):** `CREATE TABLE IF NOT EXISTS` will not add a column to an existing
`settings` table. Add an idempotent migration in `database.ts` that:
- checks `PRAGMA table_info(settings)` for `onboarded`;
- if missing, `ALTER TABLE settings ADD COLUMN onboarded INTEGER NOT NULL DEFAULT 0`;
- sets `onboarded = 1` for the existing row when `account_type != 'unknown'`, so already-
  configured users (e.g. current Premium user) don't see the wizard.

`schema.sql` also gets the `onboarded` column for fresh DBs. `onboarded` is added to
`SETTINGS_COLUMNS` (repositories) and `ALLOWED_SETTINGS_KEYS` (server) so it can be patched.

---

## ③ Remove "Allow sending without a note"

The checkbox is removed from both the Add List and Cohorts forms. Intent is derived from the
template, server-side:

- **Blank template** → `allow_no_note = 1` (bare requests are intended/fine).
- **Non-blank template** → `allow_no_note = 0` (the note matters). On LinkedIn note-quota
  exhaustion the profile goes to `needs_attention` rather than silently sending a bare
  request.

The `allow_no_note` DB column and the sender's quota logic are unchanged — the sender already
routes to `needs_attention` when `!allow_no_note` ([sender.ts](../../../src/worker/sender.ts)).
We simply stop exposing the flag and compute it from template presence in `POST /api/lists`
and `POST /api/cohorts`. The Cohorts list view drops the "no-note ok / note req" tag; the
existing "No template (bare request)" indicator already conveys the blank-template state.

---

## ④ Add List redesign (layout B)

Two-column layout, rebuilt with the frontend-design skill to preserve the light/emerald theme.

**Left column — Profiles (primary):**
- A single `textarea` that accepts **paste and drag-drop**. Dropping a `.csv`/`.txt` onto it
  reads the file's text into the textarea (replacing the manual file `<input>` button; an
  optional small "browse" affordance inside the drop zone may remain for accessibility).
- Live parsing on `input`/drop using the existing `extractProfileUrls` logic mirrored client-
  side (or a debounced call); shows "N profiles detected" and a small preview.
- Drag-over visual state on the drop zone.

**Right column — config rail:**
- **Cohort dropdown** ("Add to cohort"): lists existing cohorts (from `GET /api/cohorts`) plus
  a "New (auto-dated)" option.
  - Selecting an existing cohort prefills and locks the name field, and prefills its template
    (editable; editing updates that cohort's template on enqueue, matching current behavior).
  - Selecting "New" leaves the name field optional and clears the template.
- **Cohort name** (optional): blank defaults to today's date, e.g. `Jun 30, 2026`
  (placeholder shows the default).
- **Message template** with `{firstName}` hint and the existing char counter.
- **Enqueue** button showing the detected count.

**Backend:** `POST /api/lists` accepts an optional `cohort`; when absent/blank it uses the
date default via a shared helper (below). `allow_no_note` is derived per ③.

**JS↔DOM contract:** preserve existing element IDs where reused; any new IDs are wired in
`app.js`. The dashboard/queue/metrics/settings panels are untouched structurally.

---

## ⑤ Single profile + bespoke message via API

Already supported: `POST /api/profiles { url, cohort, message }` stores `message` as the
profile's `custom_message`, which takes precedence over the cohort template at send time
([message.ts](../../../src/core/message.ts)). `{firstName}` substitution still applies, so an
agent may hardcode the name or leave the token for the driver.

**Only change:** make `cohort` **optional** — when absent, default to the date via the shared
helper. No UI. Document the endpoint shape for agent use.

---

## Cross-cutting

- **`defaultCohortName(date: Date): string`** — a small pure helper (e.g. `src/core/cohort-name.ts`)
  formatting the date as `Mon D, YYYY`, reused by `/api/lists` and `/api/profiles`. Unit-tested.
- **`deriveAllowNoNote(template)`** logic lives where the endpoints compute it; covered by tests.
- Frontend work uses the frontend-design skill (wizard + Add List). Verify end-to-end before
  considering the work done.

## Files touched

| File | Change |
|------|--------|
| `src/db/schema.sql` | add `onboarded` column to `settings` |
| `src/db/database.ts` | idempotent `onboarded` migration for existing DBs |
| `src/db/repositories.ts` | add `onboarded` to `SETTINGS_COLUMNS`; `Settings` type |
| `src/api/server.ts` | optional cohort + date default; derive `allow_no_note`; allow `onboarded` |
| `src/core/cohort-name.ts` (new) | `defaultCohortName` helper |
| `src/types.ts` | `onboarded` on `Settings` |
| `src/web/index.html` | wizard modal; Add List rebuild; remove checkboxes |
| `src/web/app.js` | wizard logic; cohort dropdown; drop-zone + live parse; remove flag wiring |
| `src/web/styles.css` | wizard + Add List two-column styles (hidden-guard already added) |

## Testing

- Unit: `defaultCohortName`, `deriveAllowNoNote`, optional-cohort behavior on both endpoints.
- Migration: opening an existing DB without `onboarded` adds it and back-fills correctly.
- E2E (manual, before done): wizard appears on fresh DB and not for configured user; pause
  banner hidden at `paused=0`; Add List paste + drop + existing-cohort select + date default;
  single-profile API add with custom message.
