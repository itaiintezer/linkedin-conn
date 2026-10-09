# Links into The Machine

**For whoever writes the links** — a colleague, a script, an agent. You don't need to know how The
Machine works to use this page.

A link opens a screen in the operator's The Machine **already filled in**. Opening it sends
nothing and queues nothing: the operator looks it over and presses the button on that screen
themselves. So a wrong link wastes a click, not a connection request.

There are two kinds:

| You want the operator to… | Link |
|---|---|
| Send **connection requests** to some people | `http://localhost:4400/add?p=<slug>,<slug>,…` |
| Invite their connections to a **LinkedIn event** | `http://localhost:4400/add-event?event=<event id>` |

---

## Where links work, and where they don't

- **Only on the operator's own computer, while The Machine is running there.** `localhost` means
  "this computer", so the link goes to whoever clicks it. You send links *to the operator*. If you
  click your own link and The Machine isn't running on your machine, the browser says the site
  can't be reached. That is expected.
- The port is `4400` unless the operator changed it. If they did, use their port.
- A link can be clicked as many times as you like. Each click just fills the screen again.

---

## Connection-request link

```
http://localhost:4400/add?p=jane-doe,john-smith,ana-lee
```

Opens **Add to Queue** with these people listed and set up as:

- **Connection requests** (never direct messages).
- A **new cohort named after today's date**. The operator can pick an existing cohort instead.
- **No note.** The request goes out bare unless the operator types one.
- **Not prioritized.** They join the back of the queue unless the operator ticks *Send these first*.

The link can't set the cohort, the note or the priority. Those are the operator's choice, made on
the page.

### `p`: the people

A **slug** is the part of a profile URL after `/in/`:

```
https://www.linkedin.com/in/jane-doe-4a1b2c/      →  jane-doe-4a1b2c
https://www.linkedin.com/in/jane-doe-4a1b2c?utm=x →  jane-doe-4a1b2c
```

Rules:

- Separate people with commas: `p=jane-doe,john-smith`. You can also repeat `p`
  (`p=jane-doe&p=john-smith`), which is handy when a script builds the link.
- Leave out the `/` at the end and anything from `?` onward.
- Full profile URLs also work in place of a slug (`p=https://www.linkedin.com/in/jane-doe/`),
  but they make the link much longer.
- **Non-Latin names.** Some slugs come out like `%D7%93%D7%A0%D7%94-12` when copied from the
  browser's address bar. Copy them **exactly as shown**, with the `%` codes. Don't decode them,
  and don't encode them a second time (`%25D7…` is wrong).
- Case doesn't matter, and listing someone twice is harmless.
- Anything that isn't a valid slug (spaces, dots, `!`…) is left out. The operator sees a red note
  naming each entry that was dropped, so mistakes don't vanish silently.

### What the operator sees afterwards

When they press **Enqueue**, the page reports how many were added and how many were **already
in the queue** from an earlier campaign. Those people are not contacted again. If the operator
asks "why did only 12 of 14 go in", that is the usual reason.

### How many people per link

A few hundred is fine. At about 20 characters per slug, 300 people is a ~6,000-character link,
and both Slack and browsers handle that. For larger lists, split them across several links. Each
one adds to whatever the operator has already queued.

---

## Event link

```
http://localhost:4400/add-event?event=7486088214579982336
```

Opens **Connections** with a purple banner: *"Inviting to [event]"*. The operator searches their
connections, ticks the people to invite, and presses **Invite to event**. That form already
points at this event. The link carries **no people**: choosing them is the operator's job, on
the search screen.

Pressing it builds (or adds to) a **draft** for the event. Nothing is sent until the operator
**arms** the draft on the **Events** tab, the same as when they start an event campaign by hand.

### `event`: which event

The simplest form is just the **event id**, the long number in the event's URL:

```
https://www.linkedin.com/events/7486088214579982336/                 →  7486088214579982336
https://www.linkedin.com/events/aisoclivewheredoes7493353085235343360/ →  7493353085235343360
```

The second form is what LinkedIn's *Share* button gives: the event name is joined straight onto
the number. The id is the run of digits at the end.

You can pass the whole URL instead, but then **percent-encode it**
(`event=https%3A%2F%2Fwww.linkedin.com%2Fevents%2F7486088214579982336%2F`). Otherwise an `&`
from LinkedIn's tracking parameters cuts it short. The id form avoids the issue.

### What the operator sees

| The event… | Banner says |
|---|---|
| has no campaign yet | *Inviting to linkedin.com/events/…*. Invite to event starts a new draft. |
| has a **draft** | *Inviting to [event title]*. Invite to event adds to that draft. |
| has a campaign that is **armed, running or finished** | Red: it can't take more people now. Once a campaign is armed its plan is fixed. |
| isn't a LinkedIn event at all | Red: *This link doesn't point at a LinkedIn event*. |

Only **1st-degree connections** can be invited to an event. That is a LinkedIn rule, and it's why
the operator picks from their connections and not from a list you send.

---

## Posting links in Slack

A long link pasted as-is is ugly and easy to break. Put it behind short text instead:

- **In the Slack app:** type the label (e.g. *Add 14 security VPs*), select it, and paste the link
  over it, or use the link button in the formatting bar.
- **From a bot or the API** (mrkdwn): `<http://localhost:4400/add?p=jane-doe,john-smith|Add 2 people>`

Slack can't preview these links, because its servers can't reach the operator's computer. A link
with no preview card is normal.

---

## Building links in a script

JavaScript:

```js
// URL.pathname keeps LinkedIn's own %-codes, which is exactly what the link wants.
const people = ['https://www.linkedin.com/in/jane-doe/', 'https://www.linkedin.com/in/john-smith?utm=x'];
const p = people.map((u) => new URL(u).pathname.split('/in/')[1].replace(/\/+$/, '')).join(',');
const addLink = `http://localhost:4400/add?p=${p}`;

const eventId = 'https://www.linkedin.com/events/7486088214579982336/'.match(/(\d{6,})\/?(?:[?#]|$)/)[1];
const eventLink = `http://localhost:4400/add-event?event=${eventId}`;
```

Python:

```python
import re
from urllib.parse import urlsplit

def slug(url: str) -> str:
    # The path keeps LinkedIn's own %-codes, which is exactly what the link wants.
    return urlsplit(url).path.split("/in/", 1)[1].strip("/")

people = ["https://www.linkedin.com/in/jane-doe/", "https://www.linkedin.com/in/john-smith?utm=x"]
add_link = "http://localhost:4400/add?p=" + ",".join(slug(u) for u in people)

event_id = re.search(r"(\d{6,})/?(?:[?#]|$)", "https://www.linkedin.com/events/7486088214579982336/").group(1)
event_link = f"http://localhost:4400/add-event?event={event_id}"
```

---

## Quick reference

| | Connection requests | Event invite |
|---|---|---|
| Path | `/add` | `/add-event` |
| Parameter | `p`: slugs, comma-separated (or repeated `p`) | `event`: event id (or encoded URL) |
| Opens | Add to Queue | Connections, with an event banner |
| Defaults | new dated cohort, no note, not prioritized | draft for that event |
| Operator presses | **Enqueue** | **Invite to event**, then arms on **Events** |
| Not supported | messages/DMs, cohort, note, priority | people in the link, arming |
