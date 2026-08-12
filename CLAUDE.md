# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local, paced LinkedIn outreach engine — connection requests, direct messages, event invites,
post engagements, and a searchable enriched connection roster. One Node process: Fastify API +
scheduler + a real stealth browser, all state in local SQLite. Repo is `linkedin-conn`; the
product is **The Machine** everywhere it is named. (It used to be called **Relay** in the skills
and the log — the log file is still `data/relay.log`, deliberately, so existing installs keep
their history.)

Docs: [API.md](API.md) (endpoints), [README.md](README.md) (technical operator),
[RUNBOOK.md](RUNBOOK.md) (non-technical operator). Per-feature design specs and plans are dated
under `docs/superpowers/specs/` and `docs/superpowers/plans/` — the fastest way to recover why a
subsystem works the way it does.

## Most sessions are an operator asking for an action, not a code change

The app is usually already running while you're talking to the user, and the user is often
non-technical (see RUNBOOK.md for the vocabulary they use). They will ask in plain language —
"add these people", "who do I know at Stripe", "like this post", "how's the queue doing" — and
they mean *do it against the live instance*, now.

**Do not explore the codebase to answer these. Read [API.md](API.md) and call the API.**
Base URL `http://localhost:4400` (`PORT` overrides; the skills also honour `THEMACHINE_URL`,
falling back to the older `RELAY_URL`).
API.md opens with a "For agents: the two you need" section — start there.

Prefer the bundled skills over hand-rolled requests:

| They want to… | Use |
|---|---|
| Queue profiles for invites or DMs | skill `themachine-add-profiles` |
| Find people in their network | skill `themachine-search-connections` |
| Anything else | [API.md](API.md) — engagements, events, status, pause/resume, settings |

How to behave with a non-technical operator:

- **Operator requests never touch git.** Adding people, queueing campaigns, engagements,
  status, settings — those are API calls; they must not create a branch, a commit, or a
  checkout change. When a session DOES produce a code fix, do the git work on a branch but
  **always leave the checkout back on `main` before finishing** — the dashboard's Update
  button self-heals a stray branch only when it carries no commits of its own
  (scripts/update.mjs `checkBranch`), and an operator cannot run git to recover from
  anything more than that.
- **Sends are real and irreversible.** Queueing puts messages in front of actual people. Confirm
  the list, the cohort and the message text before writing, and never widen the scope you were
  given.
- **Answer in plain language.** Summarize what happened — "queued 12 people to *Security VPs*,
  first batch goes out tomorrow morning" — rather than pasting JSON.
- **Read errors for them.** A `409` means the cohort is the other campaign kind; a `400` usually
  means a malformed URL or an over-long message. Say that, don't surface the status code alone.
- Long calls are long on purpose: `run-now` returns only after the whole batch, since sends are
  spaced 20–90s apart. Don't retry it.
- `data/app.db` is production data — never seed test rows into it.
- Never force-kill the server: only one process can hold `.linkedin-profile`, so a hard kill
  orphans the browser and blocks the next start. `Ctrl+C` in the `npm start` terminal, or
  `POST /api/pause` if it was started detached.

## Commands

```bash
npm start            # the SUPERVISOR, which spawns the app (server + scheduler on :4400)
npm run start:app    # the app alone — no supervisor, so Restart/Update are disabled
npm test             # vitest run
npm run typecheck    # tsc --noEmit
npm run preflight    # verify Node >= 22.13, platform, browser install
npm run service:install    # start at login (LaunchAgent / Scheduled Task); …:status, …:uninstall
npm run service:doctor     # the per-machine checks the suite cannot make
```

Single test: `npx vitest run tests/worker/sender.test.ts`, or `-t "<name>"`. Node **>= 22.13** is
required (the DB layer uses built-in `node:sqlite`). `vitest.config.ts` pins `TZ=UTC` for the
suite — read the comment there before changing it.

## Code layout

`scripts/supervisor.mjs` (**the only thing ever launched** — spawns the app and reads its exit
code: 0 stop, 42 restart, 43 update, else crash-and-backoff; this is why Restart/Update can exist
at all, since a process cannot respawn itself and `npm install` cannot rewrite `node_modules`
under a live tsx) · `scripts/update.mjs` + `scripts/service.mjs` + `scripts/control-file.mjs`
(zero-dep ESM, must run on a bare Node; `control-file.d.mts` is how `src/` imports the last one) ·
`src/api/server.ts` (all routes + static `src/web/` dashboard, no build step) ·
`src/worker/` (all the doing — **start at `orchestrator.ts`**, it's the map) ·
`src/browser/` (Playwright; **every DOM selector lives in `*-selectors.ts`** — that's what to fix
when LinkedIn changes its HTML) · `src/db/` (`schema.sql` + repositories) · `src/core/` (pure
logic, where most unit tests point).

Invariants that aren't obvious from any single file: one shared `Mutex` serializes all browser
work; tick handlers must never throw; acceptance/reply detection is upgrade-only and never
downgrades or infers from absence; a cohort's `kind` (`invite`/`message`) is fixed at creation and
mismatched writes are rejected; the guardrail latches on a checkpoint and halts both engines;
crash recovery runs at startup, not on a timer. `orchestrator.ts` documents each in place.

Two more that span the supervisor boundary: an update **must** drain the browser mutex before
exiting (dying between "clicked Connect" and "recorded the send" gets someone invited twice —
`src/core/lifecycle.ts`), and `git clean` during an update runs without `-x` **and** with explicit
`-e data -e .linkedin-profile`, so the operator's queue and login never depend on `.gitignore`
staying correct.

- **Never force-kill the server.** Only one process can hold `.linkedin-profile`. Use the
  dashboard's Restart, `POST /api/pause`, or `Ctrl+C` in a foreground `npm start`.
