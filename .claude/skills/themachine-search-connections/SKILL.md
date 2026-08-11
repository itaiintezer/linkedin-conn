---
name: themachine-search-connections
description: Search the user's enriched LinkedIn connection list in their self-hosted The Machine instance, and pull the full profile of one connection. Use when the user asks who they know matching some criteria ("who do I know in Seattle doing security", "find CISOs in my network", "do I know anyone at Stripe", "who in my network has a CISSP", "what do we know about <person>") or wants to look someone up among their connections. Read-only.
---

# Search The Machine connections

The Machine keeps a roster of the user's LinkedIn connections, enriched with each person's
headline, location, current role, full work history and skills. This skill queries it.

Read-only: nothing here sends a message or queues outreach. To act on results, hand them to
`themachine-add-profiles`.

## Base URL
Default `http://localhost:4400`; use `THEMACHINE_URL` if set (`RELAY_URL` is still honoured as
a fallback under the old name). The Machine must be running.

## The query model

`POST /api/connections/search` with a JSON body. **OR within a field, AND across fields.**
Every array is a group of alternatives; the groups are ANDed together.

```jsonc
{
  "name_any":     ["ada"],
  "title_any":    ["CISO", "Chief Information Security", "SOC", "appsec"],
  "location_any": ["Seattle", "Bellevue"],
  "company_any":  ["Amazon"],
  "exclude_any":  ["physical security"],
  "q":            "CISSP",
  "include_past_roles": false,
  "limit": 25, "offset": 0
}
```

Omit any field you don't need. An empty body returns everyone enriched.

## How to build a good query

**Expand the concept into keywords yourself — that is the whole point of `*_any`.** The user
says "security practitioners"; you supply the vocabulary. Matching is **substring**, so
`"CISO"` does *not* match a title written out as "Chief Information Security Officer". List
both the acronym and the spelled-out form, plus the adjacent job titles:

> security → `["CISO", "Chief Information Security", "security engineer", "security architect", "SOC", "appsec", "application security", "threat", "incident response", "vulnerability", "infosec", "SecOps"]`

**Use `exclude_any` for near-miss noise.** Almost every "security" search drags in physical
security, asset protection and loss prevention. Excluding those is usually right, and
`exclude_any` drops anyone whose profile mentions the term *anywhere*, so keep the terms
specific (`"physical security"`, not `"physical"`).

**Location.** `location_any` matches city, region and country as substrings, so `"Seattle"`
also finds "Seattle Metropolitan Area". For a metro, pass the nearby cities too
(`["Seattle","Bellevue","Redmond","Kirkland"]`). A **two-letter** term is treated as an ISO
country code and matched exactly — `"US"`, `"GB"`, `"IL"`.

**Past roles.** Default is present-tense: today's title and headline. Set
`include_past_roles: true` for "who *used to* work at X" or "who has *ever* done Y" — it
widens both `title_any` and `company_any` to the full history.

**`q`** is free text over the whole profile: certifications, technologies, schools.

## Always read `coverage`

Every response carries one:

```jsonc
"coverage": { "total": 7147, "enriched": 6140, "pending": 986, "unresolvable": 21 }
```

Search only covers **enriched** rows. If `pending` is large, a small or empty result set may
mean the corpus is still filling, not that nobody matches — say so rather than reporting a
confident "you don't know anyone like that". `unresolvable` are profiles that can't be
scraped (deleted or locked down) and never will be.

## Reading results

Each row has `full_name`, `headline`, `current_title`, `current_company`, `location_raw`,
`profile_url`, `connected_on`, and `matched` — which of *your* supplied terms hit which
field. Use `matched` to judge hit quality: a `title_any` hit is stronger than a lone
`location_any` hit.

`total` is the unpaginated count; page with `limit`/`offset` (limit max 200, default 25).

## One person in full

`GET /api/connections/<slug>` — where `<slug>` is the bit after `/in/` in their profile URL.
Returns every roster column plus `profile`: about, full experience, education, skills,
certifications. Use this after a search when the user wants depth on someone. `404` if that
person isn't in the roster.

## Steps

1. `BASE = ${THEMACHINE_URL:-${RELAY_URL:-http://localhost:4400}}`.
2. Turn the user's description into keyword groups (see above). Prefer more keywords over
   fewer — recall costs nothing here, and `exclude_any` cleans up the noise.
3. Run:
   ```bash
   curl -sS -X POST "$BASE/api/connections/search" \
     -H 'Content-Type: application/json' \
     -d '{"title_any":["CISO","SOC"],"location_any":["Seattle"],"exclude_any":["physical security"],"limit":25}'
   ```
4. Summarize: name, current role, company, location. Mention `total` when it exceeds what you
   listed, and flag coverage if `pending` is significant.
5. For depth on one person: `curl -sS "$BASE/api/connections/<slug>"`.

## Errors

- Connection refused → The Machine isn't running (it normally starts at login; `npm start` in
  its folder if not), or `THEMACHINE_URL` is wrong.
- Empty results with a large `coverage.pending` → enrichment is still running. Tell the user
  to check back, don't conclude the network has nobody.
- Empty results with `coverage.enriched: 0` → the roster was never enriched. Point them at
  **Settings → Connections → Start enrichment**.
- `404` from the detail endpoint → that slug isn't a connection.
