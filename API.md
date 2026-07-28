# The Machine API

Local HTTP API for The Machine LinkedIn outreach console. Base URL: `http://localhost:4400`.
All request/response bodies are JSON. No authentication (localhost, single user).

## Campaign kinds

Two kinds of campaign run on the same engine:

- `invite` — connection requests (the default, and everything that existed before).
- `message` — direct messages to people you are already connected to.

A cohort's `kind` is fixed at creation and every profile in it inherits that kind. Pacing
is independent per kind (`weekly_cap`/`batch_size`/`batches_per_day` vs
`msg_weekly_cap`/`msg_batch_size`/`msg_batches_per_day`); working hours, weekday rule,
send delays, pause state and the guardrail are shared. Kind-specific fields are called
out per endpoint below.

## For agents: the two you need

### POST /api/profiles
Enqueue one profile. Creates the cohort if it does not exist. Invite-only — this endpoint
takes no `kind`, and the cohort it creates is an `invite` cohort. Use `POST /api/lists`
for a message campaign.

Request: `{ "url": "https://www.linkedin.com/in/jane-doe/", "cohort": "Security VPs", "message": "Hi {firstName}, …" }`
- `url` (required) — a LinkedIn profile URL; normalized server-side.
- `cohort` (optional) — cohort name; defaults to today's date.
- `message` (optional) — per-profile note; `{firstName}` is substituted at send time.

Response: `{ "id": 42, "profile_url": "https://www.linkedin.com/in/jane-doe" }`

```
curl -s http://localhost:4400/api/profiles \
  -H 'content-type: application/json' \
  -d '{"url":"https://www.linkedin.com/in/jane-doe/","cohort":"Security VPs"}'
```

### GET /api/status
Queue snapshot + weekly usage + forecast, per campaign kind.

Response (abridged): `{ "paused": 0, "weekly_sent": 12, "weekly_cap": 100, "counts": { "queued": 30, "scheduled": 5, "sent": 12, "accepted": 4 }, "msg_counts": { "queued": 8, "sent": 3, "replied": 1 }, "msg_weekly_sent": 3, "msg_weekly_cap": 250, "loggedIn": true, "acceptance_checked_at": "…", "replies_checked_at": "…", "forecast": { "queue_remaining": 35, "eta": { "sendingDays": 7, "finishDate": "…" }, "next_batch": { "estimated": true, "at": "…", "count": 5 }, "msg_next_batch": { "estimated": true, "at": "…", "count": 5 } } }`

- `counts`, `weekly_sent`, `weekly_cap`, `forecast.queue_remaining`, `forecast.eta` and
  `forecast.next_batch` are **invite-only** — they mean exactly what they meant before
  messages existed.
- `msg_counts` (same status keys, plus `replied`), `msg_weekly_sent`, `msg_weekly_cap` and
  `forecast.msg_next_batch` are the message side.
- `replies_checked_at` is the last successful reply pass (`acceptance_checked_at` the last
  acceptance pass); `null` until one succeeds.
- `paused`, `guardrail` and `sending` are shared: there is one pause and one halt for both
  kinds.

## Bulk & cohorts

### POST /api/lists
Bulk-enqueue from pasted text. Request: `{ "cohort": "Security VPs", "text": "url1\nurl2", "message_template": "Hi {firstName}", "kind": "invite" | "message" }`. Response: `{ "added": 2, "found": 2 }`.

- `kind` (optional) — defaults to `invite`. Anything other than `"message"` is treated as
  `invite`.
- `message_template` is **required** when `kind` is `message` (`400` without it) — a DM has
  nothing to send without a body. Max length 2000 for messages, 300 for invite notes;
  over that is `400`.
- `409` if a cohort with that name already exists with the other kind.

### GET /api/cohorts
List active (non-archived) cohorts: `[{ "id", "name", "kind", "message_template", "allow_no_note", "created_at" }]`.

### POST /api/cohorts
Create or update by name. Request: `{ "name": "Security VPs", "kind": "message", "message_template": "Hi {firstName}" }`.
`kind` (optional) defaults to `invite` and only applies at creation — a cohort's kind can
never change. `409` if the name exists with the other kind **and** the request stated a
`kind`; an edit that omits `kind` is not rejected by the default.

### Archiving
- `GET /api/cohorts/archived` — same shape, archived cohorts only.
- `POST /api/cohorts/:id/archive` — hide the cohort from metrics/dropdowns and skip its
  remaining queue. History stays in the database. `404` if the cohort doesn't exist.
- `POST /api/cohorts/:id/unarchive` — restore it.

### GET /api/metrics
Per-cohort funnel metrics, both kinds in one list:
`[{ "cohort_id", "cohort_name", "kind", "total", "sent", "pending", "accepted", "expired", "skipped", "acceptance_rate", "median_time_to_accept_days", "replied", "reply_rate", "median_time_to_reply_days" }]`.

Every row carries every field; which ones mean anything depends on `kind`. Filter on
`kind` and read the acceptance triplet for `invite` rows, the reply triplet for `message`
rows. Two shape notes:

- `sent` is "attempted, still countable": for invites `accepted + pending + expired`, for
  messages `replied + pending` (messages never expire).
- `pending` is status `sent` in both cases — an invite awaiting acceptance, or a message
  awaiting a reply. `median_time_to_reply_days` is `null` until something replies.

## Queue

### GET /api/profiles?status=X&kind=Y
Up to 500 profiles, newest first, optionally filtered by status and/or kind
(`invite` | `message`; any other value is ignored rather than erroring):
`[{ "id", "profile_url", "kind", "status", "skip_reason", "scheduled_for", "sent_at", "accepted_at", "replied_at", "last_error", "cohort_name" }]`.

Statuses are `queued` → `scheduled` → `sending` → `sent`, then `accepted` (invites) or
`replied` (messages); plus `expired`, `skipped`, `failed`, `needs_attention`.
`skip_reason` is one of `already_connected`, `email_required`, `unavailable`, `not_found`,
`dismissed`, or — messages only — `not_connected` (the profile turned out not to be a
1st-degree connection, so nothing was sent rather than risk an InMail).

### GET /api/queue?limit=N
Flat upcoming work, both kinds interleaved: `{ "upcoming": [{ "id", "profile_url", "kind", "status", "scheduled_for", "cohort_name", "note" }], "total_remaining": N }`.

### GET /api/queue/grouped
Queue grouped by cohort in send-priority order: `{ "cohorts": [{ "id", "name", "count", "profiles": [{ "id", "profile_url", "kind", "status", "scheduled_for", "note" }] }] }`.
Every profile in a cohort has the cohort's kind, so the first row identifies the group.

### Reordering & removal
- `POST /api/queue/profile/:id/move` — body `{ "to": "top" | "bottom" }`.
- `POST /api/queue/profile/:id/remove` — soft-remove (marks skipped).
- `POST /api/queue/cohort/:id/move` — body `{ "to": "top" | "bottom" }`.
- `POST /api/queue/cohort/:id/remove` — soft-remove all queued/scheduled in the cohort.
- `POST /api/queue/cohorts/reorder` — body `{ "order": [cohortId, …] }`.

## Attention (failures)

- `GET /api/attention` — failed + needs_attention profiles with their errors:
  `[{ "id", "profile_url", "status", "last_error", "attempts", "sent_at", "scheduled_for", "cohort_name" }]`.
- `POST /api/retry` — requeue every failed / needs_attention profile. Response
  `{ "ok": true, "retried": N }`.
- `POST /api/profiles/:id/retry` — requeue one. `404` if unknown.
- `POST /api/profiles/:id/dismiss` — give up on one (skipped, reason `dismissed`). `404` if unknown.

## Login

- `POST /api/login` — open the LinkedIn login window. Returns immediately; the window
  opens in the background once the shared browser lock is free.
- `GET /api/login-status` — whether the persisted session is still logged in.

## Ops

- `POST /api/pause`, `POST /api/resume` — halt/continue sending. One pause covers both kinds.
- `POST /api/run-now` — send one batch immediately, even outside working hours. Promotes up
  to one batch **per kind** (each against its own `batch_size`), then runs the invite pass
  and the message pass. Response `{ "ok": true, "promoted": N }` counts both.
  The response is sent after the whole batch completes, and consecutive sends are paced by
  `min_delay_ms`/`max_delay_ms` here too — so this call can legitimately take several
  minutes.
- `POST /api/recheck-acceptance` — reconcile acceptances now (read-only; runs even while
  paused). Returns the acceptance-check result.
- `POST /api/recheck-replies` — same contract for the messages funnel: one read of the
  messaging inbox, read-only, runs even while paused. Returns
  `{ "ran", "reason"?, "replied", "ambiguous"?, "unmatched"?, "checkedAt"? }`. `ran: false`
  with a `reason` (`no_pending`, `logged_out`, `login_lost`, `read_error`, `empty_read`,
  `guardrail`) means nothing changed and the day's slot was not consumed. `ambiguous` and
  `unmatched` are counts of profiles (not rows) deliberately left pending — see
  **Reply tracking** below.
- `GET /api/settings`, `POST /api/settings` — pacing/limits (allow-listed keys only).
  Message-side keys: `msg_weekly_cap` (default 250), `msg_batch_size` (5),
  `msg_batches_per_day` (6), `reply_checks_per_day` (2). Values are stored as given — pass
  numbers, not numeric strings.
- `GET /api/logs?tail=N`, `GET /api/logs/download` — run log.
- `POST /api/guardrail/acknowledge` — re-check a halt; resumes if logged in and no
  checkpoint on the current page, otherwise re-trips with a `detail` saying which URL
  and pattern is still blocking.
- `GET /api/docs`, `GET /api/docs/:slug` — markdown docs rendered in the **Docs** tab.
- `GET /api/incidents?limit=N` — halt/failure evidence metadata (newest first): what
  page the browser was on, which checkpoint pattern matched, and links to the
  screenshot + HTML snapshot captured at that moment (served under `/incidents/…`,
  stored in `data/incidents/`, newest 60 kept).

## Reply tracking

What `replied` / `replied_at` actually mean, since the limits shape how you should read
them. A pass opens the messaging inbox once and, for each conversation row whose last
message is **not** ours, upgrades the matching `sent`/`message` profile to `replied`. It is
upgrade-only: nothing here can un-reply, expire, or otherwise downgrade a profile, and a
failed or empty read changes nothing and does not consume the day's slot
(`reply_checks_per_day`, default 2, one successful pass per equal slot of the day).

Contacts are matched by **display name** — canonicalized (Unicode-normalized,
parentheticals and credential suffixes stripped), plus a looser tier that tolerates one
omitted interior token (a dropped middle name) and nothing looser than that — "Jon A Smith"
never merges into "Jon B Smith". Every ambiguity resolves to "leave it pending", because a
false `replied` is irreversible and permanently strands the real contact. Consequences:

- Two pending contacts whose display names collide are both left pending and counted in
  `ambiguous`. So are two inbox rows that resolve to the same profile.
- A pending contact no row matched at all is counted in `unmatched`. That is a
  matching-health signal, not "hasn't replied yet" — a large `unmatched` means the inbox
  read is not seeing your contacts.
- The inbox is read one page deep with no scrolling, so a reply that has scrolled below the
  loaded slice is missed until it resurfaces (the same top-slice limitation as acceptance
  checking).
- A conversation id would be a stronger key than a name, and the matcher prefers one when a
  row exposes it — but LinkedIn's inbox rows carry no thread href (verified live
  2026-07-29), so in practice name matching does all the work.

A checkpoint hit during the inbox read trips the shared guardrail, which halts both kinds.
