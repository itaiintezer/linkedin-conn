---
name: relay-add-profiles
description: Append LinkedIn profile URLs to the self-hosted Relay outreach queue via its local API. Use when the user wants to add one or more LinkedIn profiles (paste URLs, "add these to Relay", "queue these people", "send connection requests to…") to their running Relay instance. Supports an optional cohort name and message template.
---

# Add profiles to Relay

Relay runs locally and exposes an HTTP API. This skill POSTs LinkedIn profile URLs to it.

## Base URL
Default `http://localhost:4400`. If `RELAY_URL` is set in the environment, use that instead.
Relay must be running (`npm start` in its folder) for these calls to succeed.

## Decide which endpoint
- **Exactly one** profile URL → `POST /api/profiles`
  body: `{ "url": "<profile url>", "cohort": "<optional>", "message": "<optional template>" }`
- **Two or more** URLs → `POST /api/lists`
  body: `{ "text": "<all urls, newline-separated>", "cohort": "<optional>", "message_template": "<optional template>" }`

`{firstName}` in a message/template is substituted by Relay at send time. Omit the
message entirely to send bare requests (no note).

## Steps
1. Collect the LinkedIn profile URL(s) from the user. Validate each looks like
   `https://www.linkedin.com/in/<slug>`.
2. Determine `BASE = ${RELAY_URL:-http://localhost:4400}`.
3. If exactly one URL, run:
   ```bash
   curl -sS -X POST "$BASE/api/profiles" \
     -H 'Content-Type: application/json' \
     -d '{"url":"<URL>","cohort":"<COHORT or omit>","message":"<MESSAGE or omit>"}'
   ```
4. If multiple URLs, join them with newlines into TEXT and run:
   ```bash
   curl -sS -X POST "$BASE/api/lists" \
     -H 'Content-Type: application/json' \
     -d '{"text":"<URL1\nURL2\n…>","cohort":"<COHORT or omit>","message_template":"<TEMPLATE or omit>"}'
   ```
5. Report the result. `/api/lists` returns `{ added, found }` — tell the user how many were
   added vs found (duplicates already in the queue are not re-added). `/api/profiles`
   returns the created `{ id, profile_url }`.

## Errors
- Connection refused / cannot reach `$BASE` → Relay isn't running. Tell the user to start
  it (`npm start` in the Relay folder) or check `RELAY_URL`.
- `400 invalid linkedin profile url` → the URL wasn't a recognizable `/in/<slug>` link.
