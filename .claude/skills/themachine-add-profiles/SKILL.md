---
name: themachine-add-profiles
description: Append LinkedIn profile URLs to the self-hosted The Machine outreach queue via its local API. Use when the user wants to add one or more LinkedIn profiles (paste URLs, "add these to The Machine", "queue these people", "send connection requests to…", "DM these connections") to their running The Machine instance. Supports an optional cohort name, campaign kind (connection request vs direct message) and message template.
---

# Add profiles to The Machine

The Machine runs locally and exposes an HTTP API. This skill POSTs LinkedIn profile URLs to it.

## Base URL
Default `http://localhost:4400`. If `THEMACHINE_URL` is set in the environment, use that
instead; `RELAY_URL` is still honoured as a fallback for installs that set it under the old name.
The Machine must be running for these calls to succeed — it normally starts itself at login.

## Decide which endpoint
- **Exactly one** profile URL → `POST /api/profiles`
  body: `{ "url": "<profile url>", "cohort": "<optional>", "kind": "<optional>", "message": "<optional template>" }`
- **Two or more** URLs → `POST /api/lists`
  body: `{ "text": "<all urls, newline-separated>", "cohort": "<optional>", "kind": "<optional>", "message_template": "<optional template>" }`

`{firstName}` in a message/template is substituted by The Machine at send time. Omit the
message entirely to send bare requests (no note).

## Campaign kind
`kind` is `"invite"` (default) or `"message"`:
- `invite` — a connection request to someone the user is **not** connected to.
- `message` — a direct message to an **existing 1st-degree connection**.

A cohort is one kind or the other, fixed when it's created. Sending the wrong `kind` at an
existing cohort is rejected (`409`) rather than guessed at — so if the user is adding to a
cohort they already have, pass the `kind` that cohort actually is. **Do not omit `kind`
when the target is a message cohort**: omitting it means `invite`, which is exactly what
the 409 catches.

A `message` add needs a body: pass a non-blank `message`, or target a cohort that already
has a template. Invites may go note-less.

## Steps
1. Collect the LinkedIn profile URL(s) from the user. Validate each looks like
   `https://www.linkedin.com/in/<slug>`.
2. Determine `BASE = ${THEMACHINE_URL:-${RELAY_URL:-http://localhost:4400}}`.
3. Decide the `kind` (see above). If it isn't obvious from the request — the user said
   "message these people" vs "connect with these people", or named a cohort you can check
   with `curl -sS "$BASE/api/cohorts"` — ask rather than defaulting.
4. If exactly one URL, run:
   ```bash
   curl -sS -X POST "$BASE/api/profiles" \
     -H 'Content-Type: application/json' \
     -d '{"url":"<URL>","cohort":"<COHORT or omit>","kind":"<invite|message, or omit for invite>","message":"<MESSAGE or omit>"}'
   ```
5. If multiple URLs, join them with newlines into TEXT and run:
   ```bash
   curl -sS -X POST "$BASE/api/lists" \
     -H 'Content-Type: application/json' \
     -d '{"text":"<URL1\nURL2\n…>","cohort":"<COHORT or omit>","kind":"<invite|message, or omit for invite>","message_template":"<TEMPLATE or omit>"}'
   ```
6. Report the result. `/api/lists` returns `{ added, found }` — tell the user how many were
   added vs found (duplicates already in the queue are not re-added). `/api/profiles`
   returns the created `{ id, profile_url, kind }`.

## Errors
- Connection refused / cannot reach `$BASE` → The Machine isn't running. Tell the user to
  open the dashboard at `$BASE`; if that fails too it did not start at login, and the fix is
  `npm start` in its folder. Also check `THEMACHINE_URL`.
- `400 invalid linkedin profile url` → the URL wasn't a recognizable `/in/<slug>` link.
- `409 cohort "X" is a message cohort` (or `… is a invite cohort`) → the `kind` doesn't match
  the cohort that already exists. Retry with the matching `kind`, or use a different cohort
  name. Do **not** work around it by renaming the campaign kind the user asked for.
- `400 message campaigns require a message template …` → a `message` add with no body. Get
  the message text from the user.
- `400 message too long (max N characters)` → 2000 for messages, 300 for invite notes. Ask
  the user to shorten it; don't truncate it yourself.
