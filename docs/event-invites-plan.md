# Event Invites — third pipeline

Invite a list of 1st-degree connections to a LinkedIn event, sharded by location.

Design settled with the operator 2026-08-01; every DOM claim below is live-verified (see
`scripts/probe-event*.ts` and the `event-invite-flow-discovery` memory), not taken from the
pre-research spec — which was wrong about three things (the iframe root, whether Attend is
optional, and the absence of a result cap).

---

## 1. Decisions

| Decision | Choice |
|---|---|
| Stop rule | Buckets descending, ceiling 10 (configurable); exit early when the input list is exhausted |
| Lifecycle | Resumable across days; bucket cursor advances; 500 lifetime cap per event; terminal stop once the event has started |
| Scheduling | Reserve a 20-minute window in the largest gap in today's schedule; the planner must not assign send slots inside a reservation |
| Approval | `draft` → review/edit buckets → `armed`. Nothing irreversible without an explicit arm |
| List input | REST API (list of profile URLs), paste, and from a Connections search |
| Fallback | None — location buckets only. No name-search pass |
| Submit | Per bucket: filter → exhaust → tick → Invite → next. Time ceiling checked *between* buckets only |
| RSVP tracking | Out of scope for v1; `responded_at` reserved in the schema |
| Observability | Live per-bucket progress, persisted and polled |
| Data model | Separate tables. Deliberately NOT a `CampaignKind` |
| Testing | First-class dry-run mode; one live run inviting only Keren Tevet and Or Fridman |

## 2. What the live probes established

- **Attend gates everything.** Not attending → the Share menu has no Invite item at all. Attending
  pops a "Next steps" dialog that must be dismissed or it is mistaken for the picker.
- **The result list is hard-capped at 1000 rows, in stable order.** Israel returned exactly 1000 of
  2017. Because the order is deterministic, rows past 1000 are *permanently* unreachable under that
  filter. Only one bucket in the current roster exceeds this (Israel); California is 519.
- **The country filter rolls up child geos**, so sub-sharding a large bucket by district is valid.
- **URN is an exact join key.** 1000/1000 of the scraped rows matched `connections.linkedin_id`.
  Match on URN, never name — 37 full names in the roster are duplicated.
- **A mis-resolved geo cannot cause a wrong invite**, only lost coverage, because only URNs in the
  input list are ever ticked. This is the safety property the whole design leans on.
- Pagination is button-driven: 50 rows per `.scaffold-finite-scroll__load-button` click, ~1.3s
  settle, 1000 rows ≈ 141s. Per-bucket early exit measured at ~55% saving.
- Exact-text geo matching is mandatory: "Georgia" ranks the *country* first, `Georgia, United States`
  second.

## 3. Coverage, honestly

Bucketing the roster (US by state, else by country) the top 10 reach **65.8%**; 297 rows are
unbucketable (no country, or US with no state) and are permanently unreachable. Multi-day bucket
advancement recovers most of the remainder for events far enough out. The UI must state projected
reach and the unreachable count *before* arming — this is a best-effort pipeline and it should
never look like a complete one.

## 4. Schema

New tables; additive migrations only (`data/app.db` is production).

```
events            id, event_url UNIQUE, event_urn, title, starts_at, status,
                  invite_cap, bucket_ceiling, bucket_cursor, attended,
                  created_at, armed_at, closed_at, close_reason
event_invitees    id, event_id, connection_id, member_urn, profile_url,
                  bucket_id, status, invited_at, responded_at, note
event_buckets     id, event_id, rank, label, geo_label, geo_urn, kind,
                  target_count, roster_count, parent_bucket_id, status
event_runs        id, event_id, mode(dry|live), started_at, ended_at,
                  reserved_from, reserved_to, outcome, error
event_run_buckets id, run_id, bucket_id, rows_loaded, matched, ticked,
                  submitted, outcome, updated_at
reservations      id, from_ts, to_ts, purpose, ref_id
```

Settings: `events_per_day` (1), `event_invite_cap` (500), `event_bucket_ceiling` (10),
`event_run_budget_minutes` (20), `event_shard_threshold` (900).

`event_invitees.status`: `pending | invited | unreachable | failed`.
`events.status`: `draft | armed | running | done | stopped | failed`.

## 5. Bucketing

Rank by **how many of the input list** fall in a bucket (that is what maximises yield), but decide
sharding by the **roster count** in that bucket (that is what the 1000-cap acts on).

1. Bucket each input profile: `location_country_code = 'US'` → `location_region`, else
   `location_country`. No region on a US row, or no country at all → `unreachable`, reported.
2. Any bucket whose *roster* count exceeds `event_shard_threshold` expands into its child geos
   (regions/districts present in the roster) **plus the parent itself** — the parent is the only way
   to reach members whose LinkedIn location is just the country (651 of Israel's visible 1000).
3. Rank all resulting targets by input-list count, take `bucket_ceiling`.
4. Resolve each to a geo: type the query, exact-text match `.search-typeahead-v2__hit-text` against
   the canonical label (`<State>, United States` for US states), cache the `geoUrn`. No exact match
   → skip the bucket and say so; never guess.

## 6. Run loop

```
acquire browser lock
navigate event; parse starts_at from the top card (scoped — sidebar cards match the same shape)
if starts_at is in the past -> close campaign, terminal
if not attending -> click Attend; dismiss the Next-steps dialog and the toast
open Share -> Invite; wait for .invitee-picker__results-container li[role="option"]
for each bucket from bucket_cursor:
    if past the time ceiling -> stop (do not start another bucket)
    if remaining cap == 0 -> stop
    if no targets left unfound -> stop
    apply the single-location filter (exact geo)
    paginate until: all this bucket's targets found | plateau | 1000-row cap
    tick matched rows by URN via the label, up to the remaining cap
    verify: checked count, "N selected", submit label "Invite N"
    live mode -> click Invite, confirm the toast, mark invitees invited
    dry mode  -> record what would have been sent, dismiss
    advance cursor
```

A bucket already in flight runs to completion past the ceiling; worst-case overrun is one bucket
(~2.5 min at the 1000-row cap). Checkpoint detection feeds the existing guardrail. Respects pause,
working hours and weekday rules.

## 7. Scheduling

`reservations` is generic. `planKind` must filter out any candidate slot inside a reservation, so an
invite/message batch is never assigned into the event window. Reservation placement picks the
largest gap between today's already-scheduled slots within working hours. `events_per_day` caps how
many event runs start per day; a resumed day-2 run counts against it.

## 8. UI

New **Events** tab (`frontend-design`):
- Create: event URL + list input; validation errors name the profiles that are not connections.
- Draft: ranked bucket table (label, targets, roster count, sharded?), projected reach, unreachable
  count, drop/reorder, **Arm**. Dry-run button.
- Armed: the reserved window, the bucket cursor, days remaining before the event.
- Running: live per-bucket progress rows.
- History: per-run report and per-invitee status.

## 9. Build order

1. Schema + repositories
2. Histogram/bucketing + sharding (pure, unit-tested)
3. Reservations + `planKind` change (unit-tested; must not regress existing scheduling)
4. Event browser driver (selectors already proven by the probes)
5. Run worker + orchestrator tick
6. API endpoints
7. Events tab
8. Dry run against a large list; then the live two-person run

## 10. Verified end to end

Run against the real event on 2026-08-01 with `scripts/verify-event-invite.ts`.

**Dry run** — attended, title and start time scraped (`2026-09-10T15:15:00Z`), geo resolved to
`Israel`, 520 rows paged, `early_exit`, 2 matched, 2 ticked, **0 submitted**; both invitees left
`pending` and the cursor left at 0.

**Live run** — same path, **2 submitted**, both marked `invited`, cursor advanced, campaign
auto-closed `done`.

**Independent confirmation** — the two targets sat at rows 305 and 515 before the submit and were
absent across all 1000 rows after. LinkedIn removes already-invited people from the picker, so a
resumed run wastes no slots on them, and a target vanishing is itself evidence the invite landed.

Still unknown: whether LinkedIn imposes a per-event invite quota. No quota text appears anywhere in
the modal, and a 2-invite submit surfaced none. Detection is therefore defensive — a submit whose
modal fails to detach is reported as a probable failed POST rather than blindly re-clicked.

One flaw the dry run exposed and fixed: it was marking buckets `done` while (correctly) not
advancing the cursor, which would have made a campaign look partly worked when nothing had happened.
