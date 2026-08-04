# Settings validation — design

**Date:** 2026-08-04
**Status:** implemented

> The implementation makes two conscious simplifications against this document, both recorded
> in `docs/superpowers/plans/2026-08-04-settings-validation.md`. A value the rules already
> reject at load time shows the same range sentence as any other failure rather than a bespoke
> "is now capped at 4 (currently 6)" one, and the form does not render the server's `fields[]`
> — it applies the same rules locally, so a server rejection is unreachable from the dashboard.
> `fields[]` is still in the 400 body for API consumers. Both are deliberate; neither is
> missing work.

## Problem

Nothing validates a settings value anywhere between the operator's keyboard and the row the
scheduler reads every tick.

The Settings form (`src/web/index.html:733`) has 18 numeric inputs. Four carry a `max`
(`reply_checks_per_day` 24, `events_per_day` 10, `event_bucket_ceiling` 50,
`event_run_budget_minutes` 120); the other fourteen carry only a `min`, so `weekly_cap` of
100000 is accepted. The submit handler (`src/web/app.js:2540`) reads each field, calls
`Number()`, and POSTs — no checks of its own. `POST /api/settings`
(`src/api/server.ts:1005`) filters keys against `ALLOWED_SETTINGS_KEYS` and writes the rest
straight through. The `settings` table has no `CHECK` constraints.

Three consequences:

1. **A bad value is durable and silent.** It lands in the row `capsFor()` and the planner
   read on every tick. Nothing surfaces it later.
2. **`workday_start_hour: 18` with `workday_end_hour: 9` saves fine.** Both values are
   individually legal. The result is an empty send window: the planner schedules nothing,
   says nothing, and the operator watches a queue that never drains.
3. **The API is the surface that actually gets used.** The bundled `relay-*` skills and any
   agent following API.md POST settings directly, never touching the form. Client-only
   validation would not cover them.

## Scope

In: the 18 numeric Settings fields, plus five numeric keys that are API-writable but have no
form input. Per-field integer and range rules, one cross-field rule for the workday window,
enforced on both the client and the server from one shared table.

Out: `paused`, `onboarded`, `note_quota_exhausted`, `weekdays_only` (0/1 flags),
`pause_reason` (free text) and `apify_api_key` (a secret) — none of them are ranges, and they
continue to pass through unvalidated.

`expiry_days` is the one deliberate omission that *is* numeric. It is an age-based expiry
backstop where `0` means disabled (`schema.sql:100`), it has no form input, and it was not
part of the approved set. It stays unruled; adding it later is a one-line change to the
table.

Also out, deliberately: warning tiers for risky-but-legal values, and any rule relating
`batch_size × batches_per_day` to a weekly cap. That combination is not broken — the weekly
cap simply binds first and the day stops early — so a rule would block a working
configuration.

## The rule table

`src/core/settings-rules.ts` is the single definition. The server imports it; the client
receives it over HTTP (see below). It is never duplicated.

```ts
export interface SettingRule {
  /** Operator-facing name, used verbatim in error text. */
  label: string;
  min: number;
  max: number;
}

export const SETTING_RULES: Record<string, SettingRule> = { /* … */ };
```

`label` is what the operator reads, so a message says *"Batch size (invites) must be between
1 and 25"* rather than naming a database column. Every ruled key is a whole count, an hour,
or a millisecond count, so the integer check is universal and no rule needs a `step`.

### Connection requests

| Key | Label | Default | Min | Max | Reasoning |
|---|---|---|---|---|---|
| `weekly_cap` | Weekly cap (invites) | 100 | 0 | 150 | LinkedIn's invite limit sits near 100/week. Past ~150 the outcome is a restriction, not a faster campaign. |
| `batch_size` | Batch size (invites) | 5 | 1 | 25 | Sends are spaced 20–90s, so 25 is already ~35 min of unbroken automation in one session. |
| `batches_per_day` | Batches / day (invites) | 4 | 0 | 12 | One per hour across a 12-hour workday. |

### Messages

| Key | Label | Default | Min | Max | Reasoning |
|---|---|---|---|---|---|
| `msg_weekly_cap` | Weekly cap (messages) | 250 | 0 | 700 | 1st-degree DMs are cheaper than invites; 100/day sustained is the realistic top. |
| `msg_batch_size` | Batch size (messages) | 5 | 1 | 10 | |
| `msg_batches_per_day` | Batches / day (messages) | 6 | 0 | 12 | |
| `reply_checks_per_day` | Reply checks / day | 2 | 1 | 4 | Tightened from the current HTML `max="24"`. |

### Event invites

| Key | Label | Default | Min | Max | Reasoning |
|---|---|---|---|---|---|
| `events_per_day` | Events / day | 1 | 0 | 2 | Tightened from the current HTML `max="10"`. |
| `event_invite_cap` | Invites / event | 500 | 1 | 1000 | The LinkedIn picker hard-caps at 1000 rows (`schema.sql:109`), so a larger number can never be reached. |
| `event_bucket_ceiling` | Locations / run | 10 | 1 | 50 | Unchanged from the current HTML. |
| `event_run_budget_minutes` | Run budget (minutes) | 20 | 1 | 120 | Unchanged from the current HTML. |

### Post engagements

| Key | Label | Default | Min | Max | Reasoning |
|---|---|---|---|---|---|
| `engage_weekly_cap` | Weekly cap (reactions) | 500 | 0 | 1000 | A reaction is the cheapest action; ~140/day is the plausible top. |
| `engage_batch_size` | Batch size (reactions) | 15 | 1 | 50 | No composer and no page dwell, so a bigger batch is fine. |
| `engage_batches_per_day` | Batches / day (reactions) | 6 | 0 | 12 | |
| `engage_comment_daily_cap` | Comments / day | 10 | 0 | 50 | Public and attributable, so deliberately an order of magnitude below reactions. |

### Both engines

| Key | Label | Default | Min | Max | Reasoning |
|---|---|---|---|---|---|
| `workday_start_hour` | Workday start hour | 8 | 0 | 23 | Unchanged from the current HTML. |
| `workday_end_hour` | Workday end hour | 20 | 0 | 23 | Unchanged from the current HTML. |
| `roster_sync_per_day` | Connection syncs / day | 2 | 1 | 24 | Unchanged from the current HTML. |

### API-only (no form input)

Ruled server-side because leaving them open is an odd half-guard: a negative `min_delay_ms`
removes the inter-send pacing that protects the account, and rejecting `batch_size: 0` while
accepting that would be incoherent. These get no form fields and no client-side treatment.

| Key | Label | Default | Min | Max | Reasoning |
|---|---|---|---|---|---|
| `min_delay_ms` | Minimum send delay (ms) | 20000 | 5000 | 600000 | Below 5s the spacing stops being pacing. |
| `max_delay_ms` | Maximum send delay (ms) | 90000 | 5000 | 600000 | |
| `enrich_ttl_days` | Enrichment TTL (days) | 180 | 1 | 3650 | |
| `enrich_concurrency` | Enrichment concurrency | 8 | 1 | 32 | No LinkedIn risk — bounded by the Apify plan (`schema.sql:91`). |
| `event_shard_threshold` | Event shard threshold | 900 | 1 | 1000 | Above the picker's 1000-row cap the threshold could never trigger. |

## Cross-field rules

Two. The first has form fields on both sides, so it is enforced on the client and the server.
The second involves keys with no form input, so it is server-side only.

1. **`workday_end_hour` must be strictly greater than `workday_start_hour`.** Equal hours is
   an empty window, so it is rejected alongside an inverted one. Reported against the end-hour
   field: *"Workday end hour must be after the start hour (currently 18)."*
2. **`max_delay_ms` must be greater than or equal to `min_delay_ms`.** Equal is a valid fixed
   delay — deterministic rather than broken — so only `max < min` is rejected. Server-side
   only; neither key has a form input.

Both resolve **effective** values: the value in the patch when present, otherwise the value
currently stored. A patch that changes only the start hour is still checked against the
stored end hour.

## Server behaviour

`POST /api/settings` validates the complete patch **before** calling
`repos.settings.update()`, so a rejected request writes nothing at all — no partial
application.

For each key in the patch:

- no entry in `SETTING_RULES` → passes through unchanged, exactly as today
- not an integer (`Number.isInteger`) → collected as a failure
- outside `[min, max]` → collected as a failure

Then the cross-field rules run against effective values. If anything failed, respond `400`:

```json
{
  "error": "Reply checks / day must be between 1 and 4.",
  "fields": [
    { "key": "reply_checks_per_day", "message": "Reply checks / day must be between 1 and 4." }
  ]
}
```

Both shapes are load-bearing. `error` is the single readable sentence that curl, API.md
readers and the `relay-*` skills already expect from a 400 — CLAUDE.md instructs agents to
translate it into plain language for the operator. `fields[]` is what lets the form mark
every bad input in one pass instead of one per round trip.

When several rules fail, `fields[]` carries all of them and `error` repeats the first. "First"
means first in `SETTING_RULES` declaration order, with the cross-field rules last — not
`Object.keys(patch)` order, which varies with how the caller built the body. The same patch
must always produce the same `error` sentence.

`GET /api/settings` gains a `rules` property carrying the table verbatim. `publicSettings()`
is otherwise untouched — the Apify key is still stripped and masked on both the GET and the
POST echo.

## Client behaviour

### One field map

The input-id↔setting-key mapping is currently spelled out twice, in `loadSettings()`
(`app.js:1771`) and in the submit handler (`app.js:2545`). Validation would make it three
copies. It collapses to one module-level array:

```js
const SETTINGS_FIELDS = [
  { key: 'weekly_cap', id: 'setWeeklyCap' },
  // …18 total
];
```

Load, validate and submit all iterate it. This is a prerequisite for per-field validation,
not incidental cleanup.

### Loading

`loadSettings()` stamps `min`, `max` and `step="1"` onto each input from `s.rules`, so the
HTML stops hardcoding limits and the four existing `max` attributes become data. It then
validates the values it just loaded.

That last step is what handles **stale stored values**. Two ceilings tighten in this change
(`reply_checks_per_day` 24→4, `events_per_day` 10→2), so a live database can already hold a
value the new rules reject. Without the on-load pass the operator would edit an unrelated
field, hit Save, and get a rejection naming a field they never touched. Instead the offending
input is marked the moment Settings opens:

> Reply checks / day is now capped at 4 (currently 6). Pick a new value to save.

### Submitting

The handler validates locally first. On failure it marks every bad field, moves focus to the
first, toasts *"Fix 2 settings before saving"*, and **issues no request**. On a server `400`
carrying `fields[]`, those render through the same function — one error-rendering path, two
sources, so a server-only rule and a client rule look identical to the operator.

### Error presentation

Each `.field` gains a `<p class="field-error">` for its message, referenced by
`aria-describedby` on the input, plus an error class on the input for the red border. New
rules in `styles.css` matching the existing form styling.

The form gets `novalidate`. With our own messages in place, native browser bubbles would
compete with them and would only surface one field at a time. The `min`/`max` attributes stay
regardless — they drive the spinner and are read by assistive technology.

## Testing

`tests/core/settings-rules.test.ts`
- every one of the 18 form fields has a rule
- **every default in `schema.sql` falls inside its own rule's range**. Worth a permanent test:
  a max accidentally set below a shipped default would make every fresh install start in an
  invalid state, and nothing else would catch it.
- `min`/`max` are integers and `min <= max` for every rule

`tests/api/settings-validation.test.ts`
- 400 for out-of-range, non-integer, and inverted workday window
- the stored row is unchanged after a rejected patch
- a patch failing several rules returns all of them in `fields[]`
- unruled keys (`paused`, `pause_reason`, `apify_api_key`) still pass through
- a valid patch still saves and echoes back the masked settings

`tests/web/settings-validation.test.ts` (jsdom)
- rules from the fetch are stamped onto the inputs as `min`/`max`/`step`
- a loaded out-of-range value is flagged immediately, before any submit
- a blocked submit issues zero fetches
- a server `400` with `fields[]` renders against the right inputs
- a clean submit posts the expected body

`tests/web/helpers/load-app.ts` needs the new internals added to its `AppInternals` interface
and to the `return {…}` list in the `new Function` factory.

## Docs

API.md's settings section gains the full range table and the `400` body shape, since that is
the contract agents work against.

## Risks

- **`GET /api/settings` grows a property.** Any existing assertion doing an exact-shape match
  on that response will need updating. Checked during implementation.
- **Form validation depends on the settings fetch.** If `/api/settings` fails, `loadSettings()`
  already swallows the error and the form keeps whatever attributes the HTML shipped with.
  Degraded, not broken — and the server still rejects anything invalid, which is the guarantee
  that actually matters.
- **The two tightened ceilings are a behaviour change for existing installs.** Handled
  explicitly by the on-load validation pass above.
