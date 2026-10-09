# Deep links: open a pre-filled screen from a URL

Date: 2026-10-09 · Status: approved in conversation, implemented on `claude/deep-links`

## Problem

Someone other than the operator (a colleague, a script, an agent) wants to hand the operator a
list of people to send connection requests to, or an event to invite connections to — typically
by posting in Slack. Today that means pasting URLs into a message and the operator copying them
into the dashboard by hand.

## Decision

Two plain URLs on the operator's own instance. **Opening one never writes anything**: it opens an
existing dashboard screen with the fields filled in, and the operator finishes with the button
they already use.

| Link | Opens | Pre-filled |
|---|---|---|
| `/add?p=<slug>,<slug>,…` | **Add to Queue** | profiles; *Connection requests*; new auto-dated cohort; empty note; not prioritized |
| `/add-event?event=<event URL or id>` | **Connections** | an "inviting to *event*" banner; **Invite to event** then targets that event |

### What was decided, and why

- **Connection requests only.** No DM link. A DM needs a body, and the operator writes DMs with
  each person's literal first name — a shared link body would force `{firstName}` templates.
- **People as slugs**, comma-separated (`p` may also repeat). Short enough for a few hundred
  people per link. Full profile URLs are accepted too, because someone will paste them.
- **No message, no cohort, no prioritize in the link.** The note defaults to empty and the
  campaign to today's auto-dated cohort; anything else is chosen on the page. Keeps the link
  format to one parameter that cannot be got wrong in an interesting way.
- **The event link carries no people.** The best way to choose who to invite is the
  Connections search, so the link opens *that* screen in "inviting to X" mode rather than a new
  page that duplicates it.
- **Existing UI, not a new confirmation page.** Nothing to keep in sync; the operator confirms on
  the screen they already know. The links are thin server redirects into the dashboard.
- **Same event concept as today.** Invite to event builds/extends a *draft*; arming stays on the
  Events tab. If the event already has an armed/running/finished campaign the banner says up
  front that it cannot take more people (the modal only ever offered drafts).
- **No "Copy link" button.** Links are authored outside The Machine; [LINKS.md](../../../LINKS.md)
  is written for that author.
- **No security layer.** It is a single-user internal tool on `127.0.0.1`, and a link only fills a
  form — nothing is queued without a click on the page.

## Mechanics

- `GET /add` and `GET /add-event` (server.ts) 302 to `/?link=add&…` / `/?link=event&…`, carrying
  the query string through untouched. The static plugin only serves `index.html` at `/`, and
  redirecting keeps every parsing rule in one place (app.js).
- On load, `applyDeepLink()` (app.js) reads `link`, then `history.replaceState`s the query away so
  a reload does not refill a form the operator has since edited.
- Slug → URL: a token containing `linkedin.com/in/` is used as given (scheme added if missing);
  otherwise a leading `in/` and slashes are stripped, the slug is percent-encoded, and it must
  match the server's slug charset `[A-Za-z0-9\-_%]`. Rejects are named in the Add-to-Queue toast.
- Event: bare digits become `https://www.linkedin.com/events/<id>/`; otherwise the URL must carry
  the same "digit run ending the segment" `normalizeEventUrl` uses. The banner looks the event up
  in `GET /api/events` by that id for its title and campaign status. The **Invite to event**
  modal then preselects that event's draft, or "New event campaign" with the URL filled in.

## Out of scope

DM links; arming from a link; adding people to an armed/running event campaign; links that work
from any machine but the operator's.
