# The Machine — LinkedIn Connector

Local, paced LinkedIn outreach sender with cohorts, per-contact messages, and per-cohort
metrics. It runs two kinds of campaign on one engine: **connection requests** to people you
aren't connected to (with acceptance tracking), and **direct messages** to people you
already are (with reply tracking). Runs entirely on your machine against your own LinkedIn
account.

Non-technical operators: use [RUNBOOK.md](RUNBOOK.md) instead — it covers the same setup
without the terminal detail.

## Requirements

| | |
|---|---|
| **Node.js** | **22.13 or newer** (22.13 is the first release where the built-in `node:sqlite` works without a command-line flag — 22.5–22.12 install fine and then crash on boot). Get it from [nodejs.org](https://nodejs.org). |
| **git** | To clone the repo and to take updates with `npm run update`. macOS: `xcode-select --install`. Windows: [git-scm.com](https://git-scm.com/download/win). Linux: your package manager. The app itself runs without it; only updating needs it. |
| **OS** | macOS (Apple Silicon or Intel), Windows 10/11 **x64**, or Linux (x64/arm64). Windows on ARM is not supported — the stealth browser has no arm64 Windows build. |
| **Disk** | ~1.5 GB free: `npm install` downloads a patched Chromium (~1 GB installed) that The Machine drives. |
| **Network** | Needed during install to fetch npm packages and that browser. |

No compiler, no Python, no native build step — `node:sqlite` is built into Node.

## Get the code

```bash
git clone https://github.com/itaiintezer/linkedin-conn.git
cd linkedin-conn
```

That creates a `linkedin-conn` folder wherever you ran it. Clone it somewhere you own —
Documents, your home folder, Downloads — not `/Applications` or `C:\Program Files`, because
The Machine writes its database (`data/`) and browser profile (`.linkedin-profile/`) next to
its own files. Everything below is run from inside that folder.

Cloning rather than downloading a zip is what makes [Updating](#updating) a single command
later.

## Install

```bash
npm install
```

`npm install` does three things, in order:

1. **Checks prerequisites** (`preinstall`) — refuses to continue with a clear message if
   your Node is too old, npm is missing, the platform is unsupported, or the folder isn't
   writable.
2. Installs dependencies.
3. **Downloads the stealth Chromium** (`postinstall`) — a one-time ~1 GB download that
   takes a few minutes. Leave it running; it prints progress and finishes with
   `[browser] ready: …`.

Then make it start at login — the way a non-technical operator should run it:

```bash
npm run service:install
```

That registers a **per-user LaunchAgent** (macOS) or a **logon-triggered Scheduled Task**
(Windows) running `node scripts/supervisor.mjs` in this folder, **and starts it immediately**
(unless a copy is already running, which it says). Open <http://localhost:4400>; there is no
terminal to keep open, and the dashboard's **Restart** and **Update** buttons work from then on.

`npm run service:status` / `service:uninstall` / `service:doctor` are the other three verbs.
**Run `service:doctor` first whenever anything is wrong**: it checks the registration, verifies
`node`/`npm`/`git` at the absolute paths baked in at install time, says whether the running copy
is supervised, and prints the tail of `data/service.out.log` — which, because the login launch is
windowless by design, is the only place a start-up failure is recorded.

Or run it in the foreground, which is the dev path:

```bash
npm start
```

`npm start` runs the **supervisor**, not the app — see [Architecture](#the-supervisor). `Ctrl+C`
stops it cleanly; don't close the terminal window instead, as killing it can orphan the browser
and block the next start.

### The supervisor

The app never manages its own lifecycle. `scripts/supervisor.mjs` spawns it, waits, and reads
the exit code: `0` stop, `42` restart, `43` update, anything else crash (backoff and respawn).
That is what makes the dashboard's Restart/Update buttons possible — a process cannot respawn
itself, and `npm install` cannot rewrite `node_modules` while tsx and esbuild hold their
binaries open. It also means the OS only has to know one thing ("run this at login"), so restart
policy, the single-instance lock, updating and rollback behave identically on both platforms.

**Why not a real Windows service?** Session 0 has no interactive desktop, and The Machine drives
a *visible* Chromium a human must be able to click (LinkedIn login, checkpoints). A service's
selling point — running with nobody logged in — is useless here for the same reason. A
logon-triggered per-user task is the mechanism that matches the app's actual lifetime. The
two-line `wscript.exe` shim exists because `node.exe` is a console-subsystem binary and Node
ships no `nodew.exe`; a visible console is also a window an operator can close.

### Checking prerequisites on their own

```bash
npm run preflight
```

Prints one line per prerequisite with a fix for anything that fails — safe to run any time,
before or after installing.

### If the browser download failed or was skipped

```bash
npm run install-browser
```

Idempotent: it exits immediately if the browser is already there. A failed download does
**not** fail `npm install` (a flaky network shouldn't cost you the whole install), so read
the tail of the install output — a failure is printed as a boxed `DOWNLOAD FAILED` warning.

Two environment variables opt out, for CI and offline machines:

- `SKIP_BROWSER_DOWNLOAD=1` — skip the download entirely.
- `CLOAKBROWSER_BINARY_PATH=/path/to/chrome` — use a Chromium you already have.

### Platform notes

|  | macOS | Windows |
|---|---|---|
| Terminal | Terminal or iTerm | PowerShell (or Windows Terminal) |
| Go to the folder | `cd ~/linkedin-conn` | `cd $HOME\linkedin-conn` |
| Run on another port | `PORT=4401 npm start` | `$env:PORT=4401; npm start` |
| Browser cache lives in | `~/.cloakbrowser` | `%USERPROFILE%\.cloakbrowser` |

## Updating

**Normally: the dashboard.** Settings → Maintenance → Update, or the pill in the top bar when
something is available. The app pauses, waits for any in-flight browser work, writes
`data/control.json` and exits `43`; the supervisor runs the update and starts it again. The
dashboard polls `/api/update/status` — which is backed by that file, the only state that survives
the restart — and reports the outcome. A refused connection during the gap is expected and
rendered as progress.

**From a terminal**, with the app stopped:

```bash
npm run update
```

It:

1. Refuses if The Machine is still running (reinstalling under a live app leaves files locked),
   if git is missing, if this folder wasn't cloned, or if you're not on `main`.
2. Copies `data/app.db` to `data/backups/app.db.<timestamp>`, keeping the newest 5.
3. **Discards local changes rather than refusing.** `git diff HEAD` is saved to
   `data/backups/discarded-<timestamp>.patch`, then `git reset --hard HEAD` and
   `git clean -fd -e data -e .linkedin-profile`. `reset` not `checkout -- .`, because staged
   changes survive the latter and would still be merged; `clean` without `-x` so ignored paths
   are skipped, plus explicit excludes so the operator's queue and login don't depend on
   `.gitignore` staying correct.
4. `git pull --ff-only`, then `npm install`. Diverged local **commits** still refuse — that's the
   one thing not recoverable from the remote.

**Your data is never at risk from an update.** The queue, the connection roster, your settings,
your Apify key and your LinkedIn login live in `data/` and `.linkedin-profile/` — neither is
tracked by git. Schema changes are applied automatically on the next boot.

**Rollback is automatic.** If the newly installed version fails to start three times in a row,
the supervisor resets to the previous sha, reinstalls, and records the failure in
`data/control.json` so the dashboard says so. It stays on `main` deliberately: detaching HEAD
would make the branch check refuse every future update and permanently wedge the install.

## Where things live

Install into a folder you own (Documents, home, Downloads) — not `/Applications`,
`C:\Program Files`, or another location needing admin rights. The Machine writes its
database (`data/`) and browser profile (`.linkedin-profile/`) next to its own files.

| Path | What it is | In git? |
|---|---|---|
| `data/app.db` | Queue, cohorts, roster, settings, Apify key | no |
| `data/backups/app.db.*` | Pre-update database copies (newest 5) | no |
| `data/backups/discarded-*.patch` | Local edits an update discarded, in case they mattered | no |
| `data/incidents/` | Screenshots of pages that tripped a checkpoint | no |
| `data/relay.log` | The run log. Named for the product's old name, kept so existing installs keep their history | no |
| `data/control.json` | The supervisor↔app handover: what was asked for and what happened. The only state that survives a restart | no |
| `data/supervisor.lock` | The pid holding the single-instance lock. A stale one (power cut) is taken over automatically | no |
| `data/service.out.log` | Everything the login-launched supervisor printed. **The only diagnostic when it starts hidden** — there is no console to read | no |
| `data/start-hidden.vbs` | Windows only: the generated windowless launcher the Scheduled Task runs | no |
| `.linkedin-profile/` | Your logged-in browser session | no |

Neither `git reset --hard` nor `git clean` during an update can reach any of these — `data/` and
`.linkedin-profile/` are gitignored, and the clean also passes them as explicit excludes so this
does not depend on `.gitignore` staying correct.

## First run

1. Click **Connect LinkedIn** — a browser window opens; log in manually. Your session
   persists in `.linkedin-profile/`. (The browser itself was already downloaded during
   install, so this opens in seconds.) Click **Finish setup** once the dot turns green.
2. Go to **Add List**, pick **Invites** or **Messages**, name a cohort, set a message
   template (use `{firstName}`), paste URLs or upload a CSV/TXT.
3. The app schedules sends at randomized times within your working hours (default
   8am–8pm weekdays), 5 per batch, up to 4 batches a day, max 100 per rolling 7 days.
   Message campaigns get their own, higher limits — see below.

## Invites and messages

A cohort is either an **invite** cohort or a **message** cohort, chosen when it's created
and never changeable afterwards — the schedulers, caps and metrics all key off it, so mixing
kinds in one cohort would mis-pace both. Adding a profile to a cohort of the other kind is
rejected (`409`) — by every write path, including a single-profile add that just names the
cohort without saying which kind it means.

|  | Invites | Messages |
|---|---|---|
| Sent to | anyone | 1st-degree connections only |
| Template | optional (blank = bare request) | **required** — a DM with no body is meaningless |
| Template limit | 300 chars | 2000 chars |
| Weekly cap | `weekly_cap` = 100 | `msg_weekly_cap` = 250 |
| Batches | `batch_size` 5 × `batches_per_day` 4 | `msg_batch_size` 5 × `msg_batches_per_day` 6 |
| Funnel | queued → scheduled → sending → sent → accepted | queued → scheduled → sending → sent → replied |
| Tracked by | connection roster (`roster_sync_per_day`) | messaging inbox read (`reply_checks_per_day`) |

`{firstName}` works in both. Working hours, the weekdays-only rule, `min_delay_ms` /
`max_delay_ms`, the pause state and the guardrail are **shared** — pausing pauses both, and a
captcha halts both.

The message defaults are higher than the invite ones on purpose: published vendor limits
consistently rate messaging existing 1st-degree connections as lower-risk than sending
invites. 6 batches × 5 is ~30 messages a day; there's headroom to raise
`msg_batches_per_day` to 8 (~40/day) after a few clean weeks, and no reason to rush it.

If a profile turns out not to be a 1st-degree connection at send time, The Machine skips it
(**Skipped**, reason `not_connected`) rather than send an InMail.

## Event invites

The third pipeline, and the one that works differently from the other two: instead of one
action per person, a single browser session invites many people at once through LinkedIn's
invitee picker. It uses its own tables and its own caps — an event invite is a different
LinkedIn quota from a connection request, and 500 of them would swallow five weeks of
`weekly_cap` if they were pooled.

Give it an event URL and a list of 1st-degree connections — pasted on the Events tab, or
selected on **Connections** and sent over with *Invite to event*, which can also add to a
campaign you are still drafting so a list can be assembled from several searches. It
buckets them by location
(US by state, everything else by country), ranks the buckets by how many of *your list*
each holds, and shows you that plan as a **draft**. You review it and arm it; nothing
irreversible happens before that. A run then works up to `event_bucket_ceiling` (10)
buckets, filtering to one location at a time, paging the invitee list, ticking every match
by member URN, and submitting per bucket. Whoever is left rolls into the next day's run,
until the list is exhausted or the event starts.

**It is best effort, and the UI says so before you arm.** LinkedIn hard-caps the invitee
list at 1000 rows in a stable order, so a bucket larger than that is only partly listable
(oversized buckets get sub-sharded by child geo to claw some of it back). Anyone with no
country on record — or in the US with no state — can never be reached at all.

Matching is on the member URN embedded in each row, which equals `connections.linkedin_id`
exactly. Only URNs on your list are ever ticked, so a mis-resolved location can lose
coverage but can never invite the wrong person.

A run needs the browser to itself for a while, so an armed campaign reserves
`event_run_budget_minutes` (20) in the largest free gap of the working day, and the send
planner routes invite and message batches around that window instead of colliding with it.
`events_per_day` (1) caps live runs per day; the time budget gates *starting* another
bucket, so a bucket already in flight always finishes.

**Dry run** does everything except the submit — resolves the geo, pages the list, ticks the
matches, checks the counter, then throws the selection away. Use it to see real reach
before committing.

On the **dashboard** it gets a conveyor of its own beside the others, with two honest
departures: the gauge counts today's *runs* against `events_per_day` rather than sends, and
there are three stations instead of four — LinkedIn tells us nothing about who accepted an
event invitation, so there is no fourth number to fill. The locations that will not fit
today's window, and the people no filter can reach, sit beneath the track as chips rather
than being rounded away. The armed campaign also appears under **Up next**, listed by
location, because it competes with the cohorts for the same browser and the same day.

| Setting | Default | What it does |
|---|---|---|
| `events_per_day` | 1 | Live runs started per day |
| `event_invite_cap` | 500 | Lifetime invites per event |
| `event_bucket_ceiling` | 10 | Locations worked per run |
| `event_run_budget_minutes` | 20 | Window reserved per run |
| `event_shard_threshold` | 900 | Roster size above which a bucket is sub-sharded |

## Post engagements

The fourth pipeline, and the only one whose target is a **post** rather than a person: react
to a LinkedIn post, optionally with a comment. Like event invites it uses its own table and
its own caps rather than cohorts and campaign kinds — a post is not a person, and `profiles`
is person-shaped down to `first_name` and `accepted_at`. What it *does* share is everything
that keeps the account safe: the same working hours, the same weekday rule, the same send
delays, the same pause, the same guardrail, and the same single browser. An engagement can
never run while a send, a reply check, a roster sync or an event run is using the browser.

Work arrives over the API — `POST /api/engagements` with a post URL, an optional reaction
(`like`, `celebrate`, `support`, `love`, `insightful` or `funny`; `like` if you don't say) and
an optional comment. A `lnkd.in` shortlink is expanded for you. There is no enqueue form: the
dashboard card is read-only and states rather than asks.

One row per post, keyed on the post's **URN** rather than its URL, so the same post pasted as
a `/feed/update/` link and as a share link is one task and not two. LinkedIn allows exactly
one reaction per person per post, which is the same rule.

Three things it deliberately will not do:

- **A comment always rides with a reaction.** There is no comment-only engagement.
- **A reaction is never replaced.** If the post already carries one of yours, The Machine says
  so and leaves it alone — the Like control is a toggle, so "switching" a reaction means
  clicking it off first, and removing a reaction you placed by hand is not a side effect
  anybody asked for.
- **A comment never retries itself.** If the comment cannot be confirmed in the thread under
  your name, the task parks in **Needs attention** for you to look at, because a duplicate
  published comment is visible to real people and cannot be cleanly unsent. Reactions retry
  freely — the driver reads the button's state before touching it, so a second pass reports
  "already reacted" instead of undoing the first.

Its pacing is much looser than the invite pacing, because a reaction is a far cheaper action
than a connection request: 15 per batch × 6 batches a day (~90/day), capped at 500 per rolling
7 days. **Comments are capped separately at 10 a day** — 90 published comments a day under
your own name is a materially different reputational risk from 90 likes, and the comment
budget is applied when the day is planned rather than only at send time, so comment-bearing
tasks don't sit occupying slots they can never use.

On the **dashboard** it gets the fourth conveyor: this week's reactions against
`engage_weekly_cap`, today's comments against their own cap, and three stations rather than
four — LinkedIn tells you nothing about how a reaction was received, so there is no funnel to
fill. Parked and failed rows show as amber chips beneath the track, and **Up next** lists the
posts themselves so you can open one and check it.

| Setting | Default | What it does |
|---|---|---|
| `engage_weekly_cap` | 500 | Reactions per rolling 7 days |
| `engage_batch_size` | 15 | Engagements per batch |
| `engage_batches_per_day` | 6 | Batches per day |
| `engage_comment_daily_cap` | 10 | Published comments per day |

## Posts feed

The fifth pipeline, and the only one that finds its own work: track a set of profiles and
their recent posts arrive automatically, ready to react to (and, per-post, comment on) through
the same engagement pipeline described above. `tracked_profiles` and `posts` are their own
tables, soft-deleted and URN-keyed respectively, the same reasoning as `engagements` — a
tracked profile and a post are not people or campaign kinds either.

A background sweep (default once a day) pulls each tracked profile's posts through
[Apify](https://apify.com)'s `harvestapi~linkedin-profile-posts` actor — the same credential
as connection enrichment, pasted once under **Settings**. **Billing is per post returned, so
the sweep window is bounded by each profile's last sweep — widening it re-bills posts already
stored.** A never-swept profile gets a bounded first look instead of a full history import;
there is no backfill.

Reacting from the feed queues into the very same pacing, caps and pause/guardrail rails as
every other pipeline — it does not send anything immediately. Bulk selection only ever places
a reaction, never a comment, for the same reason bulk comments are refused everywhere else in
this app: identical text across several posts under your own name reads as automated, and the
comment budget (`engage_comment_daily_cap`, 10/day by default) is small enough that one click
could spend the whole day's allowance.

Posts you never engage with age out after `posts_retention_days` — anything you did react to
or comment on is kept regardless of age, as the record of what was done.

| Setting | Default | Range | What it does |
|---|---|---|---|
| `posts_sweep_per_day` | 1 | 0–4 | Sweep passes per day; **0 means never sweep automatically** |
| `posts_max_per_sweep` | 3 | 1–25 | Posts fetched per profile per sweep |
| `posts_retention_days` | 30 | 1–365 | Un-engaged posts older than this are dropped from the feed |
| `tracked_profile_cap` | 200 | 1–1000 | Maximum active tracked profiles |

Those ranges are enforced on save — the Settings form and `POST /api/settings` both reject an
out-of-range value, and reject the **whole** patch rather than half-applying it. They exist
because these four multiply into a pay-per-result Apify bill that nothing downstream re-checks:
the sweep runs unattended. `posts_max_per_sweep` in particular cannot be 0, because it reaches
the actor as `maxPosts` where 0 means *all posts, ever* — which is also what you would type to
mean "off". To turn sweeping off, set `posts_sweep_per_day` to 0. Full table of every setting's
range: [API.md](API.md).

`posts_sweep_batch_size` (default 200, range 1–1000) also exists, but it is **not a dial** — it
is a safety valve that splits one sweep into multiple Apify runs only if the tracked-profile cap
is ever raised well past its default; in ordinary use one run covers every tracked profile and
this setting has no visible effect.

## Connections

Separate from the campaigns, The Machine keeps a **roster** of the people you're actually
connected to — one row per person, independent of any cohort. Enrich it once and the whole
network becomes searchable.

Three things fill it:

1. **Your `Connections.csv` export** — in LinkedIn, on a desktop browser: Settings & Privacy
   → Data privacy → Get a copy of your data → the larger archive that includes connections.
   LinkedIn used to offer a Connections-only file that arrived in minutes; it no longer does,
   so this is a **~24 hour** wait — request it before you start and import it the next day.
   Import it under **Settings → Connections**, or during first-run setup (optional there —
   you can always do it later). It gives name, company, position and the date you connected.
2. **A bare list of profile URLs** — same box, same button; the format is detected.
3. **Automatic discovery** — twice a day (`roster_sync_per_day`) The Machine reads your
   connections page and adds anyone new. This read is free of the weekly cap.

On first start, the roster is also back-filled from campaign history: everyone whose invite
you accepted, plus everyone you successfully messaged (a DM only goes out after the live
1st-degree check passes, so it's proof of connection). A pending invite is *not* counted —
that's a request, not a connection.

Re-importing the same file is safe and cheap: it updates existing rows rather than
duplicating them. **Sync now** on the Settings panel forces a read immediately and tells you
what it found — or why it declined to run.

**Names.** `{firstName}` in a note or message uses the *cleaned* roster name, not the raw one
LinkedIn shows. Honorifics, credentials, emoji, invisible characters and nicknames-in-brackets
are stripped when the row is written, so `"Dr. Chidhanandham Arunachalam"` is greeted as
`Chidhanandham` and `"🪐 Leonardo Pizarro"` as `Leonardo` — while the name displayed in the UI
stays exactly as LinkedIn renders it. When a name has nothing usable in it (`"M. G."`), the
message falls back to `there` rather than guessing.

### Enrichment

Each person's profile is scraped through [Apify](https://apify.com) — location, current role,
full work history, education and skills — which is what makes the list searchable. Paste an
Apify API key under **Settings → Connections**; it's stored locally and the app never hands it
back out. From then on this looks after itself: anything not yet enriched is picked up within
a minute, so the roster converges on fully-searchable without you asking. **Start enrichment**
is there for when you want a run to begin this second.

- **Cost:** about **$0.004 per profile** — roughly **$29** for a 7,000-connection roster,
  one time. The button shows the exact count and estimate before you click it.
- **Speed:** ~7 seconds per profile, 8 at a time, so a 7,000-row backfill takes ~1½ hours.
  You can close the page; it keeps going.
- **Safety:** this runs on Apify's servers, not your LinkedIn session — so unlike sending,
  it isn't paced, capped, or able to trip a captcha. Pause and resume freely; it always
  picks up where it stopped.
- **Staying current:** anyone new is enriched automatically, and everyone is re-scraped
  after 180 days (`enrich_ttl_days`) so job changes don't rot the data. Steady state is a few
  cents a day.
- **While paused:** automatic enrichment stands down, so a paused Machine never spends money on
  its own. **Start enrichment** still works if you want a run anyway.

Some people can't be scraped — restricted or deleted profiles come back empty. Those are
marked and never retried automatically (each attempt costs money); **Retry failed** re-arms
them if you want to try again later.

If something bigger breaks — an expired API key, an Apify plan out of credit, or several
profiles failing in a row — enrichment **stops and says so** in an amber banner rather than
grinding through your roster racking up failures. Fix the cause, then press **I've fixed it —
try again**. Nothing is lost: the affected people stay queued, with no attempts spent against
them.

### Searching

The **Connections** tab searches the enriched roster by title, location, company and free
text. Each box takes a comma-separated list of alternatives, and the boxes combine: *(CISO
**or** SOC **or** appsec) **and** (Seattle **or** Bellevue)*. The **Exclude** box drops
anyone whose profile mentions a term anywhere — which is how you get "security people" from
a network that also contains physical-security and asset-protection roles.

Two things worth knowing:

- Matching is by substring, so `CISO` will not find someone whose title is spelled out as
  "Chief Information Security Officer". List both spellings.
- The header always shows how much of your roster is searchable. If enrichment is still
  running, an empty result may just mean those people haven't been scraped yet — the app
  says so rather than pretending nobody matched.

The same query is available to AI agents at `POST /api/connections/search` — see
[API.md](API.md).

### From search to a campaign

Tick the people you want and **Add to message campaign** appears. Pick an existing message
campaign or create one, and they're queued — subject to the same pacing as anything else
(`msg_weekly_cap`, default 250/week), so the dialog tells you roughly how long the send will
take before you commit.

Three deliberate guards, because this is the one place a search box turns into outbound mail:

- The header checkbox selects **only the rows on screen**. If more match, a separate line
  offers to select all of them and states the number — it can't happen by reflex.
- **Changing the search clears the selection.** You can build a selection across pages of one
  result set, but never queue people picked under a filter you've since changed.
- An existing campaign's message is shown but **not editable here** — editing it would rewrite
  the message for everyone already queued in that campaign. Change it in the Cohorts tab.

Anyone already in a message campaign is skipped rather than queued twice, and the result tells
you how many that was. Invites aren't offered: everyone in the roster is already a connection.

Two deliberate limits:

- **Removals aren't tracked.** Nothing here ever deletes a connection, so someone who
  disconnects stays in the roster. If they end up in a message campaign, the send-time check
  skips them as `not_connected`.
- **Discovery reads the top of the list.** Someone who connected while The Machine was off
  for a long stretch is picked up by re-importing the CSV rather than by sync.

## Safety

- If LinkedIn shows a captcha/checkpoint, the queue auto-pauses and the dashboard shows a
  banner linking to a screenshot of the page that tripped it (saved in `data/incidents/`).
  Resolve it in the browser window, then click **Resume**. One checkpoint halts **every**
  conveyor, whichever pass tripped it — including a checkpoint hit during the inbox read.
- If LinkedIn reports its own weekly invitation limit, The Machine pauses (amber banner)
  and requeues the profile it was about to send. The message pass doesn't get to run
  standalone after that either: the account was just rate-limited, so both wait for your
  **Resume**.
- Acceptance tracking works off the connection roster: the connections page is read twice a
  day (`roster_sync_per_day`) and anyone found there is added to your roster, then any
  pending invite to that person is marked accepted within a minute. Absence never marks anything — "expired" comes only from the
  optional `expiry_days` age backstop. This read does not consume your weekly cap.
- Reply tracking works the same way for messages (`reply_checks_per_day`, default 2, also
  free of the weekly cap): one read of the messaging inbox, and a messaged contact whose
  conversation's last message isn't yours is marked **replied**. Upgrade-only — a failed or
  empty read changes nothing and doesn't consume the day's slot.
- Consecutive sends are spaced by `min_delay_ms`/`max_delay_ms` (20–90s by default), within
  every sender pass and across the boundaries between them — the gap is about consecutive
  contacts with LinkedIn, not about which pipeline they came from, so adding a pipeline never
  opens a hole in it. That applies to each conveyor's **Run now** button as well, so a manual
  batch takes minutes rather than seconds — deliberately. (Event invites are the exception:
  that button only moves the run's window to now and returns immediately; the invitations
  follow over the next few minutes.)

### Reply matching, and what it can't do

Contacts are matched to inbox rows by **display name**, canonicalized (Unicode-normalized,
parentheticals and credential suffixes stripped, one omitted middle name tolerated).
LinkedIn's inbox rows expose no conversation id (verified live 2026-07-29), so there is no
stronger key available. Every ambiguity resolves to "leave it pending", because a false
**replied** is irreversible and permanently strands the real contact:

- Two pending contacts with the same display name are both left pending, not guessed at.
- The inbox is read one page deep, no scrolling — a reply that has scrolled below the loaded
  slice is missed until it resurfaces. Same top-slice limitation as acceptance checking.

Net effect: **replied** undercounts rather than overcounts. **Recheck now** on the Replied
card forces a pass immediately.

## API (localhost)

- `POST /api/profiles` `{ url, cohort, message? }` — enqueue one invite (for AI agents).
- `POST /api/lists` `{ cohort, text, message_template?, kind? }` — bulk enqueue; the only
  endpoint that can create a message campaign.
- `GET /api/status` — queue + weekly counts, per kind.
- `POST /api/connections/import` `{ text }` — ingest a `Connections.csv` export or a URL list.
- `GET /api/connections/stats` — roster size and enrichment breakdown.
- `POST /api/events` `{ event_url, profile_urls }` — plan an event-invite campaign as a
  draft; `POST /api/events/:id/arm` to commit it, `/dry-run` to rehearse it.
- `POST /api/events/:id/invitees` `{ profile_urls }` — add people to a draft and re-rank
  its locations. `409` once armed.
- `POST /api/engagements` `{ post_url, reaction?, comment? }` — queue a post engagement (or
  `{ items: [...] }` for many); `GET /api/engagements` to read them back.
- `POST /api/tracked-profiles` `{ profile_urls }` or `{ text }` — track profiles for the posts
  feed; `GET /api/tracked-profiles` to list them, `DELETE /api/tracked-profiles/:id` to untrack.
- `GET /api/posts?filter=new|queued|engaged` — the posts feed; `POST /api/posts/:id/engage`
  or `POST /api/posts/engage` `{ post_ids, reaction? }` to queue reactions from it.
- `POST /api/posts/sweep-now` — sweep tracked profiles immediately (long-running, like
  `run-now`; also clears a latched posts halt).

Full endpoint reference: [API.md](API.md) (also readable in-app under **Docs**).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `npm install` stops with `[ FAIL ] Node.js: … is too old` | Install Node ≥ 22.13 from [nodejs.org](https://nodejs.org), open a **new** terminal, retry. |
| `Cannot find module 'node:sqlite'` or an `ERR_UNKNOWN_BUILTIN_MODULE` crash on boot | Same cause: Node older than 22.13 (or a build without SQLite). `npm run preflight` confirms it. |
| `[ FAIL ] Platform: win32-arm64 is not supported` | Windows on ARM has no stealth-browser build. Use an x64 Windows machine or a Mac. |
| Install seems to hang after "added N packages" | That's the one-time browser download. Give it a few minutes. |
| **Connect LinkedIn** hangs for minutes on first click | The browser wasn't downloaded at install time. Run `npm run install-browser`. |
| `npm start` says **The Machine is already running (process N)** | The supervisor's single-instance lock. It's the login-launched copy — use <http://localhost:4400>. `data/supervisor.lock` holds the pid; a stale one from a power cut is taken over automatically. |
| `npm start` warns that port 4400 is in use | Another copy is already running — use it, or start on another port (see platform notes). |
| The LinkedIn browser never appears | A previous run was force-killed while the browser was open, leaving it holding `.linkedin-profile`. Quit any leftover Chromium (Task Manager / Activity Monitor: `chrome`/`Chromium` — check the command line for `linkedin-profile` so you don't close your own browser), then hit **Restart** on the dashboard. |
| It starts hidden at login and something is wrong, but there's no console to read | That's what `data/service.out.log` is for; `npm run service:doctor` prints its tail. Send that plus `data/relay.log` when asking for help. |
| Dashboard's **Restart**/**Update** buttons are disabled | The app was started directly (`npm run start:app`, or a `tsx` dev session) so there's no supervisor to bring it back — exiting would just stop it. Start via `npm start` or the installed service. |
| Nothing starts at login | `npm run service:doctor`. Most often the absolute `node`/`npm`/`git` paths baked in at install time have moved (an nvm or Homebrew upgrade); re-run `npm run service:install` to re-record them. |
| It starts but **updating** fails from the service | Same cause, narrower: a LaunchAgent gets a minimal `PATH`, so `git`/`npm` weren't found. `service:doctor` reports each of the three by absolute path. |
| `npm run update` says **The Machine: still running on port 4400** | Use the dashboard's Update button instead — it stops, updates and restarts for you. The terminal command can't: reinstalling under a live app leaves files locked. |
| `npm run update` says **Local changes** and lists files | Informational now, not a refusal. Those files are reset to the published version and the diff is saved to `data/backups/discarded-<timestamp>.patch`. |
| `npm run update` says **git refused to fast-forward** | This copy has commits the published version doesn't. Nothing was changed. Easiest fix: clone fresh into a new folder and copy your old `data/` across. |
| `npm run update` says **this folder was not cloned with git** | You have a zip copy. Clone the repo, then copy your old `data/` folder into the new one. |
| A message sits in **Needs attention** saying `interrupted mid-send` | The app stopped (crash, Task Manager, antivirus) while that DM was mid-flight, and nothing in the queue records whether it actually went out — the name, thread link and send log are all written from an outcome that never arrived. Open that conversation on LinkedIn: if the message is there, dismiss the row; if not, retry it. Invites in the same situation recover automatically, because a duplicate invite is harmless and a duplicate DM isn't. |

## Tests

```bash
npm test
```

`npm run typecheck` type-checks without emitting.

## Maintenance

LinkedIn changes its HTML periodically. All selectors live in
`src/browser/linkedin-selectors.ts` (with the event picker's in `event-selectors.ts` and the
post reaction bar and comment box in `post-selectors.ts`) — update them there if sends start
failing.

## Licence

Internal use only — see [LICENSE](LICENSE). The source is public so colleagues can clone it;
that is not a grant to redistribute it.
