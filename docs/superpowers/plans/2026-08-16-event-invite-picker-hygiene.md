# Event-invite picker hygiene Implementation Plan

**Goal:** Stop the mass bucket failures in event-invite runs (`selection mismatch: ticked 500,
modal shows N`, plus Georgia's `no Invite item in the Share menu`). Buckets with a valid
selection must submit; a dirty picker must be detected and reset instead of silently corrupting
every bucket after it.

**Field evidence:** Dominic Rinaldi's investigation (Slack DM, 2026-08-16), run against his
instance's `data/incidents` HTML captures and `event_run_buckets` rows. Two root causes, both
confirmed by page state rather than inferred:

1. **The picker modal is never verified closed.** `closePicker` clicks Dismiss and sleeps
   900 ms. In the captures the modal simply stays open, so each bucket ADDS a location filter
   to the same modal ("Tennessee" → "2 Locations filters are applied" → "3 Locations…").
   Consequences seen live: result lists become the union of all states so far (every bucket
   hits the 1,000-row cap, ~5 min each), earlier buckets' ticks persist (605 people selected
   under a 500 cap), `event_buckets` stamps the wrong geo URN (Texas recorded Tennessee's
   104629187 — the code reads the *first* checked location), and the still-open modal covers
   the Share button (Georgia's "no Invite item").
2. **The pre-submit check compares two different things.** It counts *rows clicked* against
   *checkboxes checked 800 ms later*. The picker serves duplicate rows for the same person
   (1,000 rows / 821 distinct people in the 21:04 capture), and duplicate rows share the same
   checkbox id (`i18n_checkbox-invitee-suggestion-<memberId>`). A label click on the second
   duplicate resolves `for=` to the FIRST input with that id and **unticks** the person — which
   is exactly how 500 clicks became 483 checked on a clean first bucket.

Side finding, fixed here because it made the whole failure invisible: incident screenshots
time out on this page (~4.7 MB HTML, 1,000 avatars, animated spinners) — all 17 incidents have
`screenshot: null`.

**Architecture:** All behavioural change stays inside `src/browser/event-invite-driver.ts`;
the runner only supplies the event URL so the driver can hard-reset by reloading the event
page. Set-comparison logic moves out of the page-evaluate strings into Node (a pure helper in
`src/core`), so the DOM reads stay dumb and the decision logic is unit-testable.

**Spec anchors:** `src/browser/event-selectors.ts` (row cap / settle constants),
`scripts/verify-event-invite.ts` (live verification path).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/core/event-buckets.ts` **(modify)** | Add pure `selectionDiff(expected, actual)` → `{ missing, extra }`, the single source of truth for "does the page agree with what we ticked". |
| `tests/core/event-buckets.test.ts` **(modify)** | Unit-cover `selectionDiff` (match, missing, extra, duplicates in actual). |
| `src/types.ts` **(modify)** | `BucketRunRequest.eventUrl` — the driver needs it to hard-reset. |
| `src/worker/event-runner.ts` **(modify)** | Pass `eventUrl: event.event_url` into `runEventBucket`. |
| `src/browser/event-invite-driver.ts` **(modify)** | The four fixes below. |
| `src/browser/evidence.ts` **(modify)** | Screenshot: `animations: 'disabled'` + explicit timeout so heavy pages capture instead of timing out. |
| `tests/worker/event-runner.test.ts` **(modify)** | Assert bucket requests carry the event URL. |

## Tasks

### 1. Pure selection diff (`src/core/event-buckets.ts`)
- [x] `selectionDiff(expected: readonly string[], actual: readonly string[])` returns
      `{ missing: string[], extra: string[] }` over Sets (duplicates in `actual` collapse —
      duplicate rows are expected page behaviour, not an error).
- [x] Unit tests in `tests/core/event-buckets.test.ts`.

### 2. Hard close (`closePicker`)
- [x] Keep clicking Dismiss (existing `dismissOverlays`), then also click any *Discard*-style
      confirmation button that appears (LinkedIn confirms before throwing a selection away).
- [x] Poll for `EVSEL.pickerModal` detachment (~8 s), mirroring `submitInvites`.
- [x] If the modal survives: `page.goto(eventUrl)` — the reset that needs no DOM knowledge —
      and log a warning. `closePicker(page, eventUrl)` gains the URL parameter; all call
      sites in `runBucket` pass it.

### 3. Clean-state guards (`runBucket`)
- [x] Before opening the picker: if `EVSEL.pickerModal` is already attached (leftover from a
      previous bucket), reload the event page first. This alone fixes Georgia's
      "no Invite item".
- [x] After the picker opens: if any row checkbox is already checked, hard-close + reopen
      once; if still dirty, fail the bucket with `picker retained a previous selection`.
- [x] Geo gate: read ALL checked location values, not the first. Exactly one must be checked;
      otherwise fail the bucket with `stale location filters: N applied` (this is what wrote
      Tennessee's URN onto Texas).

### 4. Tick people, not rows (`runBucket` tick step)
- [x] Keep a `seen` set of member URNs inside the tick evaluate: a URN is clicked at most
      once, so a duplicate row can never untick its person.
- [x] Resolve the checkbox canonically via `document.getElementById(id)` before reading
      `.checked` — on duplicate ids, only the first node carries the real state.
- [x] `done` counts distinct people; `req.limit` caps people, not rows.

### 5. Verify by URN set, settled (`runBucket` verify step)
- [x] Replace `sleep(800)` + node-count compare with a poll (≤10 × 500 ms): each round reads
      the distinct member URNs of checked row checkboxes (`EVSEL.rowCheckbox`, scoped — the
      old `input[type="checkbox"]:checked` also counted filter checkboxes) and compares with
      `selectionDiff` in Node. Exit early on exact match.
- [x] On timeout, fail with a diagnosable error naming counts and a truncated sample of
      missing/extra URNs. Keep the existing evidence capture.
- [x] `submitInvites` unchanged: its button-label count check now receives a distinct-people
      expectation, which is what the button shows.

### 6. Evidence screenshots on heavy pages (`src/browser/evidence.ts`)
- [x] `page.screenshot({ fullPage: false, animations: 'disabled', caret: 'hide', timeout: 15_000 })`
      — the picker's spinner animations are what keeps the default capture from settling.
      Still best-effort; HTML capture remains independent.

### 7. Wiring + tests
- [x] `BucketRunRequest.eventUrl` (types), runner passes it, runner test asserts it.
- [x] `npm run typecheck` + full `npx vitest run` green.

## Explicitly out of scope
- `invite_cap` is spent (500/500 lifetime) — raising it is an operator decision on the live
  instance, not a code change.
- Re-queuing the four `failed` buckets (TN/TX/MA/FL) on Dom's machine — operational, after
  this fix is deployed.
- DOM-level live verification: `scripts/verify-event-invite.ts` exists for that; the picker
  evaluate strings cannot be exercised by the unit suite (repo convention: live probes prove
  selectors, unit tests prove core logic and wiring).
