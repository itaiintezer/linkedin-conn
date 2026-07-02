# The Machine — Sales Team Runbook

The Machine sends LinkedIn connection requests for you, slowly and safely, from your own
LinkedIn account on your own machine. This guide gets you from zero to running.

## 1. One-time setup
1. Install **Node.js 22.5 or newer** from https://nodejs.org (the "LTS" build is fine if
   it's ≥ 22.5; otherwise pick "Current").
2. Get The Machine folder onto your machine (ask whoever shared it for the zip or repo link).
3. Open a terminal **in The Machine folder** and run:
   ```
   npm install
   npm start
   ```
4. Open your browser to **http://localhost:4400**.

Leave the terminal window open — that's the engine. Closing it stops sending.

## 2. Connect your LinkedIn (first run)
A setup wizard appears the first time.
1. Click **Open LinkedIn login**. A browser window opens — log in to LinkedIn normally.
   The Machine never sees or stores your password; it just borrows the logged-in window.
2. When the dashboard shows **linked** (green dot, top right), click **Continue**.
3. Pick your **account type** (Free / Premium / Sales Navigator) so limits match your plan.
   Click **Finish setup**.

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
  (The Machine checks about once a day — see §6).
- **Already connected** — people you were *already* connected to (skipped, not re-sent).
- **Needs attention** — anything that failed. Click it to open the **Attention** tab.

**Up next** lists the next 10 profiles to be processed. **View more** shows the rest.

## 5. The Attention tab
If something fails (LinkedIn UI hiccup, a profile that can't receive requests, etc.) it
lands here with the reason — so you can see exactly **who** and **what** failed. For each
row you can:
- **Retry** — put it back in the queue to try again.
- **Dismiss** — give up on it (marks it skipped).
Or use **Retry all** to requeue everything at once.

## 6. How acceptance tracking works
About once a day, The Machine opens two LinkedIn pages in the background:
1. **Sent invitations** — anything still listed here is **pending** (not yet accepted).
2. **Recent connections** — anyone here that you sent a request to is marked **accepted**.

A sent request that is no longer pending and not found in recent connections is marked
**expired**. This read is lightweight and does **not** count against your weekly send cap.
The "checked …" time on the Accepted card tells you when this last ran.

## 7. Safety
- If LinkedIn shows a **captcha or security check**, The Machine pauses itself and shows a red
  banner. Solve the challenge in the LinkedIn browser window, then click
  **"I've fixed it — re-check & resume."**
- You can **Pause** / **Resume** anytime from the dashboard.
- The Machine caps sends per week (default 100) and per day to stay well within safe limits.

## 8. Troubleshooting
- **Dashboard says "not logged in"** → click **Connect LinkedIn** and log in again.
- **Nothing is sending** → check you're not Paused, that it's within working hours
  (default 8am–8pm, weekdays), and that the queue isn't empty.
- **Lots of failures in Attention** → LinkedIn may have changed its page layout; contact
  whoever maintains The Machine. Pause until it's fixed.
- **Stop everything** → close the terminal window running `npm start`.
