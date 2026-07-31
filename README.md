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
| **OS** | macOS (Apple Silicon or Intel), Windows 10/11 **x64**, or Linux (x64/arm64). Windows on ARM is not supported — the stealth browser has no arm64 Windows build. |
| **Disk** | ~1.5 GB free: `npm install` downloads a patched Chromium (~1 GB installed) that The Machine drives. |
| **Network** | Needed during install to fetch npm packages and that browser. |

No compiler, no Python, no native build step — `node:sqlite` is built into Node.

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

Then start it:

```bash
npm start
```

Open <http://localhost:4400>. Leave the terminal open — that process *is* the engine.
**Stop it with `Ctrl+C`**, not by closing the terminal window: `Ctrl+C` shuts the browser
down cleanly, while killing the window can orphan the browser and block the next start.

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
| Go to the folder | `cd ~/Downloads/the-machine` | `cd $HOME\Downloads\the-machine` |
| Run on another port | `PORT=4401 npm start` | `$env:PORT=4401; npm start` |
| Browser cache lives in | `~/.cloakbrowser` | `%USERPROFILE%\.cloakbrowser` |

Install into a folder you own (Documents, home, Downloads) — not `/Applications`,
`C:\Program Files`, or another location needing admin rights. The Machine writes its
database (`data/`) and browser profile (`.linkedin-profile/`) next to its own files.

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

## Connections

Separate from the campaigns, The Machine keeps a **roster** of the people you're actually
connected to — one row per person, independent of any cohort. Enrich it once and the whole
network becomes searchable.

Three things fill it:

1. **Your `Connections.csv` export** — in LinkedIn: Settings & Privacy → Get a copy of your
   data → Connections. Import it under **Settings → Connections**, or during first-run
   setup (optional there — you can always do it later). It gives name, company, position
   and the date you connected.
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

### Enrichment

Once the roster exists, **Start enrichment** scrapes each person's profile through
[Apify](https://apify.com) — location, current role, full work history, education and
skills — which is what makes the list searchable. Paste an Apify API key under
**Settings → Connections** first; it's stored locally and the app never hands it back out.

- **Cost:** about **$0.004 per profile** — roughly **$29** for a 7,000-connection roster,
  one time. The button shows the exact count and estimate before you click it.
- **Speed:** ~7 seconds per profile, 8 at a time, so a 7,000-row backfill takes ~1½ hours.
  You can close the page; it keeps going.
- **Safety:** this runs on Apify's servers, not your LinkedIn session — so unlike sending,
  it isn't paced, capped, or able to trip a captcha. Pause and resume freely; it always
  picks up where it stopped.
- **Staying current:** anyone new is enriched automatically, and everyone is re-scraped
  after 180 days (`enrich_ttl_days`) so job changes don't rot the data.

Some people can't be scraped — restricted or deleted profiles come back empty. Those are
marked and never retried automatically (each attempt costs money); **Retry failed** re-arms
them if you want to try again later.

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

Two deliberate limits:

- **Removals aren't tracked.** Nothing here ever deletes a connection, so someone who
  disconnects stays in the roster. If they end up in a message campaign, the send-time check
  skips them as `not_connected`.
- **Discovery reads the top of the list.** Someone who connected while The Machine was off
  for a long stretch is picked up by re-importing the CSV rather than by sync.

## Safety

- If LinkedIn shows a captcha/checkpoint, the queue auto-pauses and the dashboard shows a
  banner linking to a screenshot of the page that tripped it (saved in `data/incidents/`).
  Resolve it in the browser window, then click **Resume**. One checkpoint halts **both**
  engines, whichever pass tripped it — including a checkpoint hit during the inbox read.
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
- Consecutive sends are spaced by `min_delay_ms`/`max_delay_ms` (20–90s by default), in both
  passes and across the boundary between them. That applies to **Run batch now** as well, so
  a manual batch takes minutes rather than seconds — deliberately.

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

Full endpoint reference: [API.md](API.md) (also readable in-app under **Docs**).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `npm install` stops with `[ FAIL ] Node.js: … is too old` | Install Node ≥ 22.13 from [nodejs.org](https://nodejs.org), open a **new** terminal, retry. |
| `Cannot find module 'node:sqlite'` or an `ERR_UNKNOWN_BUILTIN_MODULE` crash on boot | Same cause: Node older than 22.13 (or a build without SQLite). `npm run preflight` confirms it. |
| `[ FAIL ] Platform: win32-arm64 is not supported` | Windows on ARM has no stealth-browser build. Use an x64 Windows machine or a Mac. |
| Install seems to hang after "added N packages" | That's the one-time browser download. Give it a few minutes. |
| **Connect LinkedIn** hangs for minutes on first click | The browser wasn't downloaded at install time. Run `npm run install-browser`. |
| `npm start` warns that port 4400 is in use | Another copy is already running — use it, or start on another port (see platform notes). |
| `npm start` fails to launch the browser, or the window never appears | A previous run was killed instead of `Ctrl+C`, leaving an orphaned browser holding `.linkedin-profile`. Quit any leftover Chromium windows (Task Manager / Activity Monitor: `chrome`/`Chromium`), then start again. |
| A message sits in **Needs attention** saying `interrupted mid-send` | The app stopped (crash, Task Manager, antivirus) while that DM was mid-flight, and nothing in the queue records whether it actually went out — the name, thread link and send log are all written from an outcome that never arrived. Open that conversation on LinkedIn: if the message is there, dismiss the row; if not, retry it. Invites in the same situation recover automatically, because a duplicate invite is harmless and a duplicate DM isn't. |

## Tests

```bash
npm test
```

`npm run typecheck` type-checks without emitting.

## Maintenance

LinkedIn changes its HTML periodically. All selectors live in
`src/browser/linkedin-selectors.ts` — update them there if sends start failing.
