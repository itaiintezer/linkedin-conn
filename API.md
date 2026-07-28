# The Machine API

Local HTTP API for The Machine LinkedIn outreach console. Base URL: `http://localhost:4400`.
All request/response bodies are JSON. No authentication (localhost, single user).

## For agents: the two you need

### POST /api/profiles
Enqueue one profile. Creates the cohort if it does not exist.

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
Queue snapshot + weekly usage + forecast.

Response (abridged): `{ "paused": 0, "weekly_sent": 12, "weekly_cap": 100, "counts": { "queued": 30, "scheduled": 5, "sent": 12, "accepted": 4 }, "loggedIn": true, "forecast": { "queue_remaining": 35, "eta": { "sendingDays": 7, "finishDate": "…" }, "next_batch": { "estimated": true, "at": "…", "count": 5 } } }`

## Bulk & cohorts

### POST /api/lists
Bulk-enqueue from pasted text. Request: `{ "cohort": "Security VPs", "text": "url1\nurl2", "message_template": "Hi {firstName}" }`. Response: `{ "added": 2, "found": 2 }`.

### GET /api/cohorts
List active (non-archived) cohorts: `[{ "id", "name", "message_template", "allow_no_note", "created_at" }]`.

### POST /api/cohorts
Create or update by name. Request: `{ "name": "Security VPs", "message_template": "Hi {firstName}" }`.

### Archiving
- `GET /api/cohorts/archived` — same shape, archived cohorts only.
- `POST /api/cohorts/:id/archive` — hide the cohort from metrics/dropdowns and skip its
  remaining queue. History stays in the database. `404` if the cohort doesn't exist.
- `POST /api/cohorts/:id/unarchive` — restore it.

### GET /api/metrics
Per-cohort acceptance metrics: `[{ "cohort_name", "sent", "accepted", "pending", "expired", "acceptance_rate", "median_time_to_accept_days" }]`.

## Queue

### GET /api/profiles?status=X
Up to 500 profiles, newest first, optionally filtered by status:
`[{ "id", "profile_url", "status", "skip_reason", "scheduled_for", "sent_at", "accepted_at", "last_error", "cohort_name" }]`.

### GET /api/queue?limit=N
Flat upcoming work: `{ "upcoming": [{ "id", "profile_url", "status", "scheduled_for", "cohort_name", "note" }], "total_remaining": N }`.

### GET /api/queue/grouped
Queue grouped by cohort in send-priority order: `{ "cohorts": [{ "id", "name", "count", "profiles": [{ "id", "profile_url", "status", "scheduled_for", "note" }] }] }`.

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

- `POST /api/pause`, `POST /api/resume` — halt/continue sending.
- `POST /api/run-now` — send one batch immediately, even outside working hours. Response
  `{ "ok": true, "promoted": N }`.
- `POST /api/recheck-acceptance` — reconcile acceptances now (read-only; runs even while
  paused). Returns the acceptance-check result.
- `GET /api/settings`, `POST /api/settings` — pacing/limits (allow-listed keys only).
- `GET /api/logs?tail=N`, `GET /api/logs/download` — run log.
- `POST /api/guardrail/acknowledge` — re-check a halt; resumes if logged in and no
  checkpoint on the current page, otherwise re-trips with a `detail` saying which URL
  and pattern is still blocking.
- `GET /api/docs`, `GET /api/docs/:slug` — markdown docs rendered in the **Docs** tab.
- `GET /api/incidents?limit=N` — halt/failure evidence metadata (newest first): what
  page the browser was on, which checkpoint pattern matched, and links to the
  screenshot + HTML snapshot captured at that moment (served under `/incidents/…`,
  stored in `data/incidents/`, newest 60 kept).
