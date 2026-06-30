# LinkedIn Connector

Local, paced LinkedIn connection-request sender with cohorts, per-contact messages,
acceptance tracking, and per-cohort metrics. Runs entirely on your machine against your
own LinkedIn account.

## Requirements
- Node.js >= 22.5 (uses the built-in `node:sqlite` — no native build step).

## Setup
```bash
npm install
npm start
```
Open http://localhost:4400.

Non-technical operators: see [RUNBOOK.md](RUNBOOK.md).

## First run
1. Click **Connect LinkedIn** — a browser window opens; log in manually. Your session
   persists in `.linkedin-profile/`.
2. Go to **Add List**, name a cohort, set a message template (use `{firstName}`), paste
   URLs or upload a CSV/TXT.
3. The app schedules sends at randomized times within your working hours (default
   8am-8pm weekdays), 5 per batch, max 100 per rolling 7 days.

## Safety
- If LinkedIn shows a captcha/checkpoint, the queue auto-pauses and the dashboard shows a
  banner. Resolve it in the browser window, then click **Resume**.
- Acceptance tracking reads two list pages ~once/day; it does not consume your weekly cap.

## API (localhost)
- `POST /api/profiles` `{ url, cohort, message? }` — enqueue one profile (for AI agents).
- `GET /api/status` — queue + weekly count.

## Tests
```bash
npm test
```

## Maintenance
LinkedIn changes its HTML periodically. All selectors live in
`src/browser/linkedin-selectors.ts` — update them there if sends start failing.
