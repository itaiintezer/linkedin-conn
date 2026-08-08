# Live probe: relationship signals on false "already connected" skips

**Date:** 2026-08-08
**Context:** companion evidence for the 2026-08-07 false-skips plan
(`2026-08-07-already-connected-false-skips.md`, authored on a second operator's instance
of this same code). This instance shows the same defect: of 18 profiles parked at
`skip_reason='already_connected'`, **8 are absent from the 7,181-row connections roster**
(ids 363, 397, 428, 433, 465, 619, 643, 817), with no `send_log` rows and no alternate
URLs under a surname search.

**Method:** the server holds `.linkedin-profile` (single-instance), so
`scripts/probe-relationship.ts` could not launch a second persistent context. The DOM
facts below were collected read-only through the operator's own logged-in Chrome (same
LinkedIn account) with the equivalent queries. The script probe re-runs at the fix's
restart window — record its output here then.

## Raw observations

### 1. `vince-aimutis` (id 363, logged "skipped: already connected" 2026-07-13)

- `[aria-label*="Pending" i]`: **0 in DOM**.
- Target's own connect affordance present and visible:
  `A[aria-label="Invite Vince Aimutis to connect"][href="/preload/custom-invite/?vanityName=vince-aimutis"]`.
- Neighbour recommendation cards render their own invite controls **inside `<main>`**:
  `BUTTON "Invite Jian Zhao to connect"`, `BUTTON "Invite Mo Zadeh to connect"`.
- True state: **connectable**. The skip was false.

### 2. `tim-lunn-45297534` (id 433, logged "skipped: already connected" 2026-07-16)

- LinkedIn now **redirects the stored slug to `/in/tim-lunn/`** — a vanity rename. URL-keyed
  roster lookups must survive this (the roster holds neither slug, so the cross-check stands).
- `[aria-label*="Pending" i]`: **0 in DOM**.
- Target's connect affordance present **three times** (two visible):
  `A[href="/preload/custom-invite/?vanityName=tim-lunn"]`, labels "Invite Tim Lunn to connect".
- Four+ neighbour invite buttons inside `<main>` (Mo Zadeh, Si Te Feng, Cody Parker
  Opstedal, Mehdi Nazari).
- True state: **connectable**. The skip was false.

### 3. `helge-poel-32ba4791` (id 818, a GENUINE pending invite, sent 2026-08-06)

Probed as the positive control for the badge shape the fix matches on:

- `[aria-label*="Pending" i]`: **3 in DOM**, all
  `"Pending, click to withdraw invitation sent to Helge Poel"` — the label **names the
  target**, exactly as the 2026-08-03 live verification recorded.
- All three sit in a card whose nearest `/in/` ancestor link resolves to
  **`helge-poel-32ba4791`** — the slug attribution the fix's structural test relies on.
- One of the three is **outside `<main>`** (visible, top-of-page duplicate), confirming
  that `<main>`-scoping alone can neither include all target badges nor exclude neighbours.

## Verdict-path attribution for this instance's 8 false skips

All eight were logged `"skipped: already connected"` — none as `"an invite is already
pending"`. Six predate the 2026-08-03 relationship rework (old absence-inference); the two
after it (643 on 08-03, 817 on 08-06) can only have come through `'unknown'` (no signal
read) or a false `'connected'`, since no invite was ever sent to either. This instance's
dominant mechanism is therefore **root cause 3.2** ('unknown' treated as connected), while
the plan's originating instance mostly hit **3.1** (neighbour badge via the page-wide
fallback). Both mechanisms are confirmed structurally: neighbour cards inside `<main>`
carry per-person controls that read "Pending …" once invited, and the two live pages
above show the driver had a clean positive `connectable` signal it ignored in favour of
the skip.

## Gate decision (plan Task 1)

The probe **confirms** the diagnosis: the targets carry no pending badge and do carry
their own connect affordance. Tasks 2–6 proceed unchanged. The name-scoped label and the
ancestor-slug attribution are both live-verified workable; note for Task 3 that the label
must have its **"sent to <name>" tail extracted before canonicalName** — canonicalizing
the whole label can never token-match a bare name (`tokensContained` pins first/last
tokens).
