# The Machine — Sales Team Runbook

The Machine does two things for you, slowly and safely, from your own LinkedIn account on
your own machine: it sends **connection requests** to people you're not connected to, and
**direct messages** to people you already are. This guide gets you from zero to running.

## 1. One-time setup

Works the same on **Mac** and **Windows**. You need Windows 10/11 on a 64-bit Intel/AMD
machine (Windows on ARM won't work), or any Mac from the last several years.

1. Install **Node.js 22.13 or newer** from https://nodejs.org — take the big green **LTS**
   button. If you already have Node, check the version with `node -v`; anything below
   22.13 must be updated, or The Machine won't start.
2. Install **git**, if you don't have it. Check with `git --version`.
   - **Mac:** run `xcode-select --install` and accept the prompt.
   - **Windows:** download it from https://git-scm.com/download/win and click through the
     installer, accepting every default.

   You need it for step 3, and again later every time you want the newest version.
3. Open a terminal — **Mac:** Terminal (in Applications → Utilities); **Windows:** search
   the Start menu for *PowerShell*. Then get your own copy of The Machine by running:
   ```
   git clone https://github.com/itaiintezer/linkedin-conn.git
   cd linkedin-conn
   ```
   The first line downloads a folder called `linkedin-conn`; the second moves you into it.
   Run it from somewhere you own — your home folder, Documents or Downloads is fine, and
   that's where a plain terminal starts you. Not `Program Files` or `Applications`.

   Every command from here on is typed into that same terminal window, in that folder.
4. Run:
   ```
   npm install
   ```
   This checks your machine first and stops with a plain-English message if something is
   missing (wrong Node version, no npm, unsupported computer). Then it downloads the
   browser The Machine drives — **about 1 GB, a few minutes, once ever**. It's not stuck;
   wait for it to finish.
5. Run this once, and never think about starting The Machine again:
   ```
   npm run service:install
   ```
   Two things happen: it starts **right now**, and it will start by itself every time you turn
   your computer on and log in. No terminal, no black window. (If it says it's *already*
   running, that's fine — it means it was already going.)
6. Give it a few seconds, then open your browser to **http://localhost:4400** and **bookmark
   it**. That page is how you use and control The Machine.

You can close the terminal window. Nothing depends on it any more.

**To stop sending**, use the **Pause** button on the dashboard — not the terminal. Pause is
reversible from the same button; it's the one you want in almost every situation.

> If `npm run service:install` doesn't work on your machine, you can still run `npm start` in
> the terminal and leave that window open. Everything works the same, Restart and Update
> included — the only differences are that closing that window stops The Machine, and it won't
> come back on its own when you next log in.

If anything above fails, run `npm run preflight` — it lists every requirement with a
one-line fix for whatever is wrong.

You only ever do this once. When a newer version comes out, you don't repeat any of it —
see **§13, Getting a newer version**.

## 2. Connect your LinkedIn (first run)
A setup wizard appears the first time.
1. Click **Open LinkedIn login**. A browser window opens — log in to LinkedIn normally.
   The Machine never sees or stores your password; it just borrows the logged-in window.
   (The window should appear within seconds. If it takes minutes on the very first click,
   the install-time browser download didn't happen — stop, run `npm run install-browser`,
   then try again.)
2. When the wizard shows **Connected** (green dot), click **Finish setup**. That's it —
   there is nothing else to configure to start sending.

Connection requests default to 100 per rolling 7 days, 5 per batch, up to 4 batches a day —
deliberately conservative. Messages have their own, slightly higher limits (250 a week,
5 per batch, 6 batches a day — about 30 a day), because messaging people you're already
connected to is treated as lower-risk than sending invites. Change any of them under
**Settings** if your LinkedIn plan allows more; if the message numbers have run clean for a
few weeks, raising **Batches / day (messages)** from 6 to 8 is the safe next step.

## 3. Add people to contact
1. Go to **Add to Queue**.
2. Choose what you're sending:
   - **Invites** — connection requests, for people you're not connected to.
   - **Messages** — direct messages, for people you're **already connected to**.
3. Paste LinkedIn profile URLs (one per line), or drag a `.csv` / `.txt` file into the box.
4. (Optional for invites, **required** for messages) Give the cohort a name and a **message
   template**. Use `{firstName}` to personalize, e.g. `Hi {firstName}, loved your post on…`.
   For invites you can leave it blank to send a bare request with no note; for messages you
   can't — a message with nothing in it makes no sense, so The Machine won't accept one.
   Invite notes are capped at 300 characters, messages at 2000.
5. Click **Enqueue**. A confirmation ("Added X of Y found.") appears right under the button.

**What `{firstName}` turns into.** The person's given name, cleaned up first — so
`Dr. Chidhanandham Arunachalam` is greeted as `Hi Chidhanandham,` and `🪐 Leonardo Pizarro`
as `Hi Leonardo,`. Titles, letters after the name, emoji and nicknames-in-brackets are all
dropped, and an apostrophe inside a name is kept (`Ze'ev`). Nothing to configure.

Occasionally a LinkedIn profile has no real first name on it at all — just initials, like
`M. G.` In that case the message reads `Hi there,` rather than guessing. That's deliberate,
not a fault: about 8 people out of 7,000 land there.

The Machine then schedules sends at random times inside your working hours, a few per batch,
never exceeding your weekly cap.

A cohort is invites **or** messages, decided when you first create it and fixed from then on.
If you try to add people to a cohort of the other type, The Machine refuses and tells you —
make a second cohort with a different name instead.

**Need some people to go out first?** Tick **Send these first** in the rail, just above the
Enqueue button. They jump to the front of the queue **and** take today's next send times —
the times themselves don't move and today still sends the same total; whoever they bumped
simply goes out tomorrow morning, first. If it's evening or a weekend and nothing is
planned, they'll simply lead the next sending day.

The confirmation tells you exactly when the first of them goes out ("first ones go out at
11:40 today"), so you never have to guess whether it worked. The tick box resets itself
after each batch — it's for the exceptional list, not a setting you leave on. You can also
just ask your assistant ("add these people first in line") and it does the same thing.

## 4. Reading the dashboard
There are two conveyors: **invites** on top, and **messages** below it. The messages one
stays folded away as a single slim row until you actually have a message campaign, so an
invites-only account never sees it.

On the invites conveyor:
- **This week** — how many requests went out in the last 7 days vs your cap.
- **Queued / Scheduled** — waiting to be scheduled / already given a send time.
- **Time to finish** — rough estimate of how long the current queue will take to clear.
- **Next batch** — how many go out next and at what time.
- **Sent** — requests delivered.
- **Accepted** — people who accepted. "checked …" shows when acceptance was last verified
  (The Machine checks twice a day by default — see §6).
- **Skipped** — terminal skips that will never be retried, with a reason each:
  already connected, requires their email to connect, profile no longer exists
  (the LinkedIn URL 404s — deleted account or renamed slug), composer
  unavailable, not a 1st-degree connection, or dismissed by you.
- **Needs attention** — anything that failed. Click it to open the **Attention** tab.

**Skipped** and **Needs attention** are shared: they count invites *and* messages, and each
row — in the Skipped list and in the Attention tab alike — is tagged with which it was.
**Expired** is invites-only: a delivered message never expires, it just goes unanswered.

The messages conveyor reads the same way, with its own **This week**, **Queued**,
**Scheduled** and **Sent** — and **Replied** where invites have Accepted, showing when
replies were last checked (§7).

The one skip reason that only ever comes from a message campaign is **not a 1st-degree
connection**: The Machine opened the profile, found you aren't actually connected, and stopped.
Sending anyway would have gone out as an InMail — a separate, metered LinkedIn product — so it
leaves the person alone. Send them an invite instead.

It doesn't take the page's word for that lightly. If the profile page never finished loading,
or if it says you aren't connected while your connections list says you are, the person goes
to **Needs attention** with a screenshot instead — look at the profile, and if you are
connected, hit Retry.

**Up next** lists the next 10 profiles to be processed. **View more** shows the rest.

## 5. The Attention tab
If something fails (LinkedIn UI hiccup, a profile that can't receive requests, etc.) it
lands here with the reason — so you can see exactly **who** and **what** failed. For each
row you can:
- **Retry** — put it back in the queue to try again.
- **Dismiss** — give up on it (moves it to **Skipped** with reason "dismissed").
Or use **Retry all** to requeue everything at once.

## 6. How acceptance tracking works
The Machine opens **one** LinkedIn page in the background — **Recent connections** — and
adds everyone it finds to your **connection list** (see section 10). Any profile sitting in
**Pending** who turns up on that list is marked **accepted**. That's the only way a profile
leaves Pending.

Absence proves nothing, so absence never marks anything: a pending request that isn't yet a
connection just stays pending. (Inferring "expired" from absence is what used to mislabel
still-valid invites.) **Expired** now comes only from the optional age backstop —
`expiry_days`, off by default.

**How often:** the connections page is read `roster_sync_per_day` times a day (default
**2**) — roughly one read in the morning and one in the afternoon, not two in a row. If a
read can't complete (logged out, LinkedIn error, page rendered empty) nothing is recorded and
it retries on the next 30-minute tick. Matching pending invites against the list is free, so
that happens every minute; the "checked …" time on the Accepted card shows when it last ran.

This read is lightweight and does **not** count against your weekly send cap. **Recheck now**
on the Accepted card forces a pass immediately, even during a pause.

## 7. How reply tracking works
Same idea, for messages. The Machine opens **one** LinkedIn page in the background — your
**messaging inbox** — and looks at every conversation with someone you've messaged and are
still waiting on. If the last message in that conversation isn't yours, they replied, and
the profile moves to **Replied**.

**How often:** `reply_checks_per_day` (default **2**), under **Settings** as
**Reply checks / day**. Same slot mechanism as acceptance: the day is split into that many
equal parts and one successful check runs per part. If the read fails or the page comes back
empty, nothing is recorded and it retries on the next tick — a failed check never costs you
the day's check. This read doesn't count against your weekly cap either, and **Recheck now**
on the Replied card forces a pass immediately, ignoring slots and even a pause.

**What it can't do.** The inbox doesn't tell The Machine *which* conversation belongs to
*which* profile — there's no id to go on, only the person's name as the inbox displays it. So
matching is by name, and whenever the name isn't decisive The Machine leaves the profile in
**Sent** rather than guess:

- **Two people with the same display name.** If two contacts you're waiting on show the same
  name in the inbox, neither is marked replied. You'll see the reply in LinkedIn; The Machine
  won't claim it.
- **Old conversations.** Only the conversations currently loaded on the inbox page are read —
  it doesn't scroll back. If someone replies and their conversation has since been pushed far
  down by newer chatter, that reply can be missed until it comes back up. (Acceptance
  tracking has the same blind spot.)

The bias is deliberate and one-directional: **Replied** may be lower than reality, never
higher. A wrongly-marked reply can't be undone and would leave you thinking you'd heard back
from someone you hadn't. Treat **Replied** as a floor, and your LinkedIn inbox as the truth.

## 8. Safety
- If LinkedIn shows a **captcha or security check**, The Machine pauses itself and shows a red
  banner. The banner says exactly which page tripped it and links to a **screenshot** taken at
  that moment (also saved under `data/incidents/`). Solve the challenge in the LinkedIn browser
  window, then click **"I've fixed it — re-check & resume."** If the screenshot shows a normal
  page (no challenge), it was a false alarm — just re-check to resume.
- **One pause, one halt, every conveyor.** Invites, messages, post engagements and event
  invites are paced separately but they all go through the same LinkedIn account, so a captcha
  or a lost login stops *everything* — including a captcha hit while reading the messaging
  inbox. Pause and Resume work on all of them together; there is no way to pause just one.
- You can **Pause** / **Resume** anytime from the dashboard.
- The Machine caps sends per week (default 100 invites, 250 messages, 500 reactions) and per
  day to stay well within safe limits. Each pipeline is metered against its own cap — a
  reaction is a far cheaper act than a connection request, which is why the numbers differ so
  widely.
- If LinkedIn itself says the **weekly invitation limit** is reached, The Machine pauses with
  that reason (amber banner, not red) and requeues the profile it was about to send. Messages
  stop too until you resume — the account was just told off, so it's not the moment to keep
  going. Click **Resume** once the limit resets (LinkedIn lifts it about a week after it was
  hit).
- Sends are spaced 20–90 seconds apart, and that includes each conveyor's **Run now**
  button — a manual batch takes a few minutes to finish. That's the point; it isn't stuck.
  The **Event invites** conveyor is the exception: its button says "Starting…" straight away
  because all it does is move the run's window to now — the invitations themselves go out
  over the following minutes, and the card's own pill shows the run in progress.

## 9. Troubleshooting
- **Dashboard says "not logged in"** → click **Connect LinkedIn** and log in again.
- **Nothing is sending** → check you're not Paused, that it's within working hours
  (default 8am–8pm, weekdays), and that the queue isn't empty.
- **A message campaign is skipping everyone as "not a 1st-degree connection"** → that list is
  people you aren't connected to yet. Enqueue them as **Invites** instead, and message them
  once they accept.
- **They replied on LinkedIn but the profile still shows in Sent** → normal, and covered in §7:
  same-name contacts and conversations that have scrolled out of the inbox's first page are
  left alone rather than guessed at. **Recheck now** on the Replied card if the conversation is
  back near the top.
- **Lots of failures in Attention** → LinkedIn may have changed its page layout; contact
  whoever maintains The Machine. Pause until it's fixed.
- **`npm install` stopped with a `[ FAIL ]` line** → it tells you exactly what to fix
  (almost always: Node is older than 22.13 — install the LTS from https://nodejs.org and
  open a *new* terminal). Run `npm run preflight` to re-check.
- **"The Machine is already running"** → it is, and that's fine — it starts itself at login.
  Open http://localhost:4400 and use it. Only one copy can run at a time.
- **The dashboard page won't load at all** → it didn't start. Run `npm run service:doctor`,
  which checks the setup and prints what's wrong in plain language.
- **The LinkedIn browser window won't open** → an old browser is still holding the login
  profile. Close any leftover Chromium windows (Windows: Task Manager → end `chrome`; Mac:
  Activity Monitor → quit `Chromium`), then use **Restart** on the dashboard.
- **Something's wrong and you want to try the simplest thing first** → **Restart**, in
  Settings → Maintenance. It's the equivalent of turning it off and on again, it finishes any
  send in progress first, and it can't lose anything.
- **Stop sending** → the **Pause** button on the dashboard. It's reversible from the same
  button, and it's what you want in almost every case.
- **Stop it completely** → `npm run service:uninstall`, then restart your computer. Worth
  saying plainly: there is deliberately no Stop button, because a stopped Machine can't serve
  the page with the button that would start it again.

### Asking for help

Because The Machine starts up invisibly, there's no window with an error message in it. Two
files hold everything needed to work out what happened — send **both**:

1. Run this and copy the whole output:
   ```
   npm run service:doctor
   ```
2. From the dashboard: **Settings → Download** (next to the run log).

The first says whether it's set up and running correctly; the second is what it's been doing.
Neither contains your LinkedIn password.

## 10. Your connection list
Separate from campaigns, The Machine keeps a list of everyone you're actually connected to,
and can make it searchable.

**Getting it in.** Go to **Settings → Connections**. Either paste your LinkedIn
`Connections.csv` export or paste a plain list of profile URLs. Re-importing the same file
later is safe: it updates people rather than duplicating them. From then on, the twice-daily
read of your connections page adds anyone new automatically.

**Asking LinkedIn for that export** — do this on a computer, not your phone, and do it a day
before you need it. On LinkedIn: *Settings & Privacy → Data privacy → Get a copy of your
data*, choose the larger archive (the one whose description mentions connections), then
*Request archive* and confirm your password. LinkedIn emails you a download link in **about
24 hours**. Unzip what arrives and the file you want is `Connections.csv`. Nothing else about
The Machine has to wait on it — set everything up now, import the file when it lands.

**Making it searchable.** The list starts with just names, companies and job titles from the
export. To search by *location* or by someone's full history, The Machine has to look each
person up — it does that through a service called Apify.

1. Make an account at `apify.com`, copy your API key from *Settings → Integrations*.
2. Paste it into **Settings → Connections → Apify API key** and press **Save key**.

That's the whole setup. Looking people up starts on its own within a minute and keeps going
from then on — every new connection your connections page turns up gets looked up without you
asking. **Start enrichment** just begins a run this second instead of waiting; the button tells
you how many people and roughly what it will cost — about **$0.004 each**, so ~$29 for 7,000
connections, once.

It takes a couple of hours for a large list. You can close the page; it keeps going, and
**Pause** stops it safely — restarting picks up exactly where it left off. This does not use
your LinkedIn session at all, so it can't get your account flagged and isn't slowed down for
safety like sending is. Pausing The Machine also pauses looking people up, so it never spends
money while you're away.

A few people can't be looked up (deleted accounts, locked-down profiles). They're marked and
not retried, since each attempt costs money. **Retry failed** tries them again if you want.

**If looking people up stops.** An amber banner appears across the top saying why — usually
the Apify key stopped working or the account ran out of credit. It also stops itself if several
people in a row fail, rather than working through your whole list collecting failures. Nobody
is written off: the people it hadn't got to stay queued with nothing spent against them. Fix
the cause (usually: paste a fresh key), then press **I've fixed it — try again**. To test
without committing to a full run, open one person from the **Connections** tab and press
**Refresh** — that works even while it's stopped.

**Searching.** The **Connections** tab. Each box takes a comma-separated list, and the boxes
combine — *(CISO **or** SOC **or** appsec)* **and** *(Seattle **or** Bellevue)*. The
**Exclude** box removes anyone whose profile mentions a word anywhere, which is how you get
security *practitioners* without every physical-security guard in your network.

Two things that will otherwise surprise you:

- It matches on the letters you type. `CISO` will **not** find someone whose title is written
  out as "Chief Information Security Officer" — put both in the box.
- The line above the results says how much of your list is searchable. If enrichment is still
  running, "no matches" may just mean those people haven't been looked up yet — it tells you
  so rather than pretending nobody matched.

## 11. Checking post engagements against the real LinkedIn
Reactions and comments are the one pipeline whose actions are **public and irreversible** — a
comment appears under your name to real people. `scripts/verify-post-engage.ts` runs the exact
code the engine runs, one post at a time, with you watching. Do this after LinkedIn changes
its layout, after anyone touches the engagement selectors, and before trusting the pipeline
with a queue.

**Stop The Machine first.** The LinkedIn browser profile only opens in one place at a time.
Run `npm run service:uninstall` and restart your computer, or ask whoever maintains The Machine
to stop it for you. The script refuses to start while the app is answering on port 4400, and it
never kills anything for you.

**1. Dry run — the safe one. Always start here.**

```
npx tsx scripts/verify-post-engage.ts "<post URL>" --dry
```

Opens the post and reports what a live run *would* do. It clicks nothing and doesn't even
hover, so it publishes nothing. Look for `PASS the post, its action bar and its react trigger
all resolve`, and for an `observedUrn` — that's the post's own id, and it's normal for it to
differ from the id in a share link.

**2. Place a reaction.**

```
npx tsx scripts/verify-post-engage.ts "<post URL>" --reaction celebrate
```

`--reaction` takes `like`, `celebrate`, `support`, `love`, `insightful` or `funny`, and
defaults to `like`. A misspelling is refused by name rather than quietly becoming a `like`.
Anything other than `like` has to open the hover flyout, which is the most fragile part of the
feature — it's worth verifying with a non-`like` reaction rather than a `like`.

**3. Run the same command again.** It should report:

```
PASS already — the post carries celebrate and the driver did not click
```

That is the intended, tested behaviour, not a failure. LinkedIn's reaction control is a
**toggle**: clicking it a second time would *remove* the reaction you just placed. The driver
reads the button's state before touching it and stops. This is the guard that lets reactions
retry safely.

**4. Post a comment.** This publishes. Use a post you own, or one where a test comment is
harmless, and delete it afterwards by hand.

```
npx tsx scripts/verify-post-engage.ts "<post URL>" --reaction celebrate --comment "👀"
```

The reaction runs first (reporting `already` if step 2 landed), then the comment.

**Reading the result.** Every step prints the raw outcome and then one plain line. The script
exits non-zero if any line says FAIL, so it can be run from another script.

- **PASS reaction placed** / **PASS already** — the reaction path works.
- **PASS comment posted AND confirmed** — the comment was found in the thread under your name.
- **FAIL … got unavailable** — a control we expected wasn't on the page. Usually LinkedIn moved
  something; re-run `scripts/probe-post-engage.ts` against the same post and compare what it
  dumps with `src/browser/post-selectors.ts`.
- **FAIL comment could not be confirmed** — the comment **may still be live**. Open the post and
  look before you run anything again; a second run would publish it twice. (The engine does the
  same thing: it parks the task in **Needs attention** rather than retrying.)
- **CHECKPOINT** — LinkedIn challenged the account. The script stops immediately and never goes
  on to the comment. Solve the challenge in the browser window and treat the run as telling you
  nothing.

Click any row to see everything The Machine knows about that person.

## 12. Tracking people's posts

Beyond invites, messages and reacting to a post you paste in yourself, The Machine can watch a
set of people and automatically pull in their recent posts for you to react to (and, one at a
time, comment on). This is the **Posts** tab.

**What tracking is.** You give it a list of LinkedIn profiles — paste URLs, or select people
from your connection list and click **Track posts**. From then on, The Machine periodically
checks those profiles for new posts (once a day by default) and drops what it finds into the
Posts feed. **Each post it pulls in costs a small amount of money** — a fraction of a cent —
because fetching them uses a paid scraping service (Apify), the same one that enriches your
connection list. You can watch the running total on the Posts tab.

**There is no history import.** When you first track someone, their feed starts **nearly
empty** — The Machine does not go back and fetch everything they've ever posted, only what
they post from here on. It fills in gradually as they post. If you were hoping to see last
month's posts from someone you just started tracking, that's expected: there's nothing to
see yet.

**Reacting from the feed doesn't send anything immediately.** Clicking **like** (or
**celebrate**, **support**, **love**, **insightful**, **funny**) on a post — one at a time or
in bulk across several selected posts — puts that reaction in the **same paced queue** as
everything else The Machine sends. It goes out later, spaced out through the day, capped the
same way invites and messages are (reactions default to 500/week, ~90/day). It is **not**
instant.

**Comments are different, and slower.** You can add a comment to a post one at a time (not in
bulk), and it's published under **your own name**, visible to everyone. Because that carries
real reputational weight, comments are capped far lower than reactions — **10 a day by
default** — which is also why the bulk "react to several posts at once" action only ever
places reactions, never comments.

**Old posts disappear on their own.** Anything The Machine pulled in that's older than 30
days and that you never reacted to gets quietly dropped from the feed — it isn't worth storing
forever, and it keeps the "New" list meaningful rather than growing without end. Anything you
did react to or comment on stays, as a record of what was done.

**Bare reshares don't show up, on purpose.** If someone reshares another person's post without
adding a comment of their own, The Machine skips it — there's no text of *theirs* to react to,
so it isn't the kind of post this feature is for. This is usually **around a third** of
everything it checks, so expect the feed to hold noticeably fewer posts than the number of
posts those people appear to have. That's the filter doing its job, not a fault.

**If you see a red "post sweeping is halted" banner** on the Posts tab, something stopped the
automatic checking — usually a missing or invalid Apify key, or several checks in a row that
failed the same way. Fix the underlying cause (add/replace the key under **Settings**, check
the log if it's unclear), then press **Sweep now**. That button does two things at once: it
runs a check immediately, and it's how you tell The Machine "I've fixed it, try again" —
pressing it clears the halt regardless of whether the next check succeeds.

Being offline doesn't count. If the laptop was asleep or off the internet when a check came
due, that check simply waits — it isn't treated as a failure and won't trip this banner. So if
the banner *does* appear, it's about the checks themselves, not your connection.

## 13. Getting a newer version
No terminal. It's a button.

**How you'll know.** When there's something new, a green **"N updates available"** pill appears
in the top-right of the dashboard, next to the LinkedIn status light, with an **Update** button
right beside it. If there's no pill, there's nothing to install. The Machine checks quietly on
its own.

1. Click **Update** right there in the top bar, then confirm. That's it — walk away.
2. Or, if you'd like to see what's new first: click the pill itself to open
   **Settings → Maintenance**, read the list of changes, and click **Install N updates** there.

The Machine closes itself, installs the update and starts itself again. It takes a minute or
two. The page will say **"Updating The Machine…"** and then tell you when it's done. **The page
going blank or failing to load during this is normal** — it's the part where The Machine isn't
running yet. Don't reload repeatedly and don't click anything; it comes back on its own.

**Anything mid-send finishes first.** If The Machine is in the middle of sending a connection
request when you click Update, it waits for that request to complete before closing. This
matters: interrupting it half-way is how someone would end up getting the same invitation twice.

**Nothing you've built up is lost.** Your queue, your cohorts, your connection list, your
settings, your Apify key and your LinkedIn login are all stored outside the part that gets
updated. An update cannot touch them. It also copies your database to `data/backups/` first,
keeping the five most recent copies.

**Sending stays paused after an update.** That's deliberate — you get to look at the dashboard
before anything goes out. Click **Resume** when you're ready.

**If something goes wrong:**

- **"The update did not finish"** — The Machine is still running the version it had before, and
  it still works. Nothing was lost. Try again later, or tell whoever maintains it.
- **If the new version won't start at all**, The Machine notices after a few tries and puts the
  previous version back by itself. You may see it disappear and come back; that's the recovery
  working.
- **"Lost track of that one"** — the update may well have worked. Wait a minute and reload the
  page. If the page won't load at all after a few minutes, ask for help.

**The Restart button**, next to Update, is the thing to try if The Machine seems stuck — the
LinkedIn browser won't open, or sending has quietly stopped. Same behaviour: it finishes any
send in progress, closes, and comes back within a minute or two.

> **Editing files in the folder.** If you (or an editor, or your Mac's Finder) changed anything
> inside The Machine's folder, an update simply puts it back the way the published version has
> it. It won't stop and ask. A copy of whatever was discarded is kept in `data/backups/` in case
> it mattered.
