# The Machine — Sales Team Runbook

The Machine sends LinkedIn connection requests for you, slowly and safely, from your own
LinkedIn account on your own machine. This guide gets you from zero to running.

## 1. One-time setup

Works the same on **Mac** and **Windows**. You need Windows 10/11 on a 64-bit Intel/AMD
machine (Windows on ARM won't work), or any Mac from the last several years.

1. Install **Node.js 22.13 or newer** from https://nodejs.org — take the big green **LTS**
   button. If you already have Node, check the version with `node -v`; anything below
   22.13 must be updated, or The Machine won't start.
2. Get The Machine folder onto your machine (ask whoever shared it for the zip or repo
   link). Put it somewhere you own — Documents, Downloads or your home folder. Not
   `Program Files` or `Applications`.
3. Open a terminal **in The Machine folder**:
   - **Mac:** right-click the folder → *Services* → *New Terminal at Folder*.
   - **Windows:** open the folder in File Explorer, right-click empty space →
     *Open in Terminal* (or type `powershell` in the address bar).
4. Run:
   ```
   npm install
   ```
   This checks your machine first and stops with a plain-English message if something is
   missing (wrong Node version, no npm, unsupported computer). Then it downloads the
   browser The Machine drives — **about 1 GB, a few minutes, once ever**. It's not stuck;
   wait for it to finish.
5. Run:
   ```
   npm start
   ```
6. Open your browser to **http://localhost:4400**.

Leave the terminal window open — that's the engine. To stop sending, click into that
window and press **Ctrl+C**. Don't just close the window: that can leave the hidden
LinkedIn browser running and block the next start.

If anything above fails, run `npm run preflight` — it lists every requirement with a
one-line fix for whatever is wrong.

## 2. Connect your LinkedIn (first run)
A setup wizard appears the first time.
1. Click **Open LinkedIn login**. A browser window opens — log in to LinkedIn normally.
   The Machine never sees or stores your password; it just borrows the logged-in window.
   (The window should appear within seconds. If it takes minutes on the very first click,
   the install-time browser download didn't happen — stop, run `npm run install-browser`,
   then try again.)
2. When the wizard shows **Connected** (green dot), click **Finish setup**. That's it —
   there is nothing else to configure to start sending.

Sending limits default to 100 per rolling 7 days, 5 per batch, up to 4 batches a day —
deliberately conservative. Change them under **Settings** if your LinkedIn plan allows
more.

## 3. Add people to contact
1. Go to **Add List**.
2. Paste LinkedIn profile URLs (one per line), or drag a `.csv` / `.txt` file into the box.
3. (Optional) Give the cohort a name and a **message template**. Use `{firstName}` to
   personalize, e.g. `Hi {firstName}, loved your post on…`. Leave it blank to send a bare
   request with no note.
4. Click **Enqueue**. A confirmation ("Added X of Y found.") appears right under the button.

The Machine then schedules sends at random times inside your working hours, a few per batch,
never exceeding your weekly cap.

## 4. Reading the dashboard
Each card:
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
  unavailable, or dismissed by you.
- **Needs attention** — anything that failed. Click it to open the **Attention** tab.

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
compares it against **every** profile still sitting in **Pending**. Anyone who shows up
there is marked **accepted**. That's the only way a profile leaves Pending.

Absence proves nothing, so absence never marks anything: a pending request that isn't in
recent connections just stays pending. (Inferring "expired" from absence is what used to
mislabel still-valid invites.) **Expired** now comes only from the optional age backstop —
`expiry_days`, off by default.

**How often:** `acceptance_checks_per_day` (default **2**). The day is split into that many
equal slots and one successful check runs per slot — so 2 means roughly one in the morning
and one in the afternoon, not two in a row. If a check can't complete (logged out, LinkedIn
read error, page rendered empty) nothing is recorded and it simply retries on the next
30-minute tick, still inside the same slot. The "checked …" time on the Accepted card tells
you when a check last succeeded.

This read is lightweight and does **not** count against your weekly send cap. **Recheck now**
on the Accepted card forces a pass immediately, ignoring slots and even a pause.

## 7. Safety
- If LinkedIn shows a **captcha or security check**, The Machine pauses itself and shows a red
  banner. The banner says exactly which page tripped it and links to a **screenshot** taken at
  that moment (also saved under `data/incidents/`). Solve the challenge in the LinkedIn browser
  window, then click **"I've fixed it — re-check & resume."** If the screenshot shows a normal
  page (no challenge), it was a false alarm — just re-check to resume.
- You can **Pause** / **Resume** anytime from the dashboard.
- The Machine caps sends per week (default 100) and per day to stay well within safe limits.
- If LinkedIn itself says the **weekly invitation limit** is reached, The Machine pauses with
  that reason (amber banner, not red) and requeues the profile it was about to send. Click
  **Resume** once the limit resets (LinkedIn lifts it about a week after it was hit).

## 8. Troubleshooting
- **Dashboard says "not logged in"** → click **Connect LinkedIn** and log in again.
- **Nothing is sending** → check you're not Paused, that it's within working hours
  (default 8am–8pm, weekdays), and that the queue isn't empty.
- **Lots of failures in Attention** → LinkedIn may have changed its page layout; contact
  whoever maintains The Machine. Pause until it's fixed.
- **`npm install` stopped with a `[ FAIL ]` line** → it tells you exactly what to fix
  (almost always: Node is older than 22.13 — install the LTS from https://nodejs.org and
  open a *new* terminal). Run `npm run preflight` to re-check.
- **"port 4400 is in use" when starting** → The Machine is already running in another
  terminal window; use that one at http://localhost:4400.
- **The LinkedIn browser window won't open** → a previous run was closed without Ctrl+C
  and the old browser is still holding the login profile. Close any leftover Chromium
  windows (Windows: Task Manager → end `chrome`; Mac: Activity Monitor → quit
  `Chromium`), then `npm start` again.
- **Stop everything** → click the terminal running `npm start` and press **Ctrl+C**. Wait
  for it to return to a prompt. Only then close the window.
