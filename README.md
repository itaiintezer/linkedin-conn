# The Machine — LinkedIn Connector

Local, paced LinkedIn connection-request sender with cohorts, per-contact messages,
acceptance tracking, and per-cohort metrics. Runs entirely on your machine against your
own LinkedIn account.

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
2. Go to **Add List**, name a cohort, set a message template (use `{firstName}`), paste
   URLs or upload a CSV/TXT.
3. The app schedules sends at randomized times within your working hours (default
   8am–8pm weekdays), 5 per batch, up to 4 batches a day, max 100 per rolling 7 days.

## Safety

- If LinkedIn shows a captcha/checkpoint, the queue auto-pauses and the dashboard shows a
  banner linking to a screenshot of the page that tripped it (saved in `data/incidents/`).
  Resolve it in the browser window, then click **Resume**.
- If LinkedIn reports its own weekly invitation limit, The Machine pauses (amber banner)
  and requeues the profile it was about to send.
- Acceptance tracking reads the Recent connections page twice a day by default
  (`acceptance_checks_per_day`, one successful pass per equal slot of the day) and marks
  anyone found there accepted. Absence never marks anything — "expired" comes only from the
  optional `expiry_days` age backstop. This read does not consume your weekly cap.

## API (localhost)

- `POST /api/profiles` `{ url, cohort, message? }` — enqueue one profile (for AI agents).
- `GET /api/status` — queue + weekly count.

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

## Tests

```bash
npm test
```

`npm run typecheck` type-checks without emitting.

## Maintenance

LinkedIn changes its HTML periodically. All selectors live in
`src/browser/linkedin-selectors.ts` — update them there if sends start failing.
