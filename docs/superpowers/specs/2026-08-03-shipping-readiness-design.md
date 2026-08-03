# Shipping readiness: getting, running and updating The Machine

**Date:** 2026-08-03
**Status:** approved, ready for planning

## Problem

The Machine works and is well documented for someone who already has the folder. It is not
documented for someone who doesn't, and it is not documented at all for someone who has an
older copy and wants a newer one.

Three concrete gaps, all confirmed by reading the current docs:

1. **No instructions for getting the code.** `README.md` opens at `npm install`.
   `RUNBOOK.md` §1 step 2 says "ask whoever shared it for the zip or repo link." Neither
   contains a `git clone` command, so the repo URL exists nowhere in the repo.
2. **No instructions for updating.** There is no `git pull` anywhere. The nearest thing is
   `RUNBOOK.md` §1 step 5, a one-off warning about backing up `data/app.db` before the
   invite/message migration — written as though every reader is mid-that-specific-upgrade,
   which stopped being true several releases ago. It now misleads both audiences: a fresh
   installer is told to protect a file they don't have, and someone taking a later update
   gets no advice at all.
3. **Stale and inconsistent naming.** The docs say "The Machine" throughout, "Relay" twice
   (`README.md` enrichment section, `RUNBOOK.md` §10), and the folder a clone actually
   produces is `linkedin-conn`. `README.md`'s platform-notes table instructs
   `cd ~/Downloads/the-machine`, a path no clone creates.

## What is already fine

Worth recording, because it constrains the design — most of the risky work is already done:

- `data/` and `.linkedin-profile/` are both gitignored. A `git pull` cannot touch a
  colleague's queue, login session, settings or Apify key.
- Schema migrations run automatically and idempotently on boot (`src/db/database.ts`), and
  the one historically destructive migration already snapshots the database before running.
- `scripts/preflight.mjs` gates install and start with per-prerequisite pass/fail lines and
  a fix for each. It is the model this design follows.
- Baseline verified 2026-08-03: `npm run typecheck` clean, `npm test` 84 files / 1121 tests
  passing. No secrets or personal data are tracked (220 tracked files, scanned).

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Distribution | Public GitHub repo, `git clone` + `git pull` | Already public; colleagues need no GitHub account, no SSH keys, no access grants. One command to get it, one to update it. |
| Update mechanism | `npm run update` script | A hand-run sequence with a backup in the middle is a sequence people skip parts of. One command that refuses rather than half-does is safer than a documented checklist. |
| Product name | "The Machine" | Already dominant in both docs; smallest diff. Stray "Relay" mentions get corrected. |
| Licence | Internal use only | Public repo, restricted licence: the code is readable by anyone, usable by colleagues. Deliberate. |
| CI | Not now | Explicitly declined. |
| In-app version stamp | Not building | `git log -1` answers it, and the update script prints what changed. |

## Part 1 — `scripts/update.mjs`, exposed as `npm run update`

### Conventions to follow

Match `scripts/preflight.mjs`: plain ESM, zero dependencies, no TypeScript, pure decision
functions exported so they can be unit-tested without side effects, and a plain-English fix
attached to every refusal. Tests join the existing `tests/scripts/`.

### Sequence

Each step stops the run on failure. Nothing after a failed step executes.

1. **Not a git checkout** — if there's no `.git`, stop. Someone working from a zip cannot
   pull; tell them to clone instead, and give the command.
2. **Git not installed** — hard stop with the per-OS install pointer. (Contrast with
   preflight, below, where it is only a warning.)
3. **The Machine is running** — probe `http://localhost:$PORT/api/status`. If our own server
   answers, stop with "press Ctrl+C in that terminal first."

   This one is non-negotiable, for three independent reasons: `npm install` under a live
   process can swap files out from under it; a database copy taken while the process holds
   an un-checkpointed WAL is not a usable backup; and killing the process instead of
   Ctrl+C orphans the browser holding `.linkedin-profile` and blocks the next start.

   Probing `/api/status` rather than just testing whether the port binds distinguishes our
   server from an unrelated process on 4400, which deserves a different message.
4. **Working tree dirty, or branch is not `main`** — stop and list the offending files or
   name the branch. This protects the maintainer more than colleagues, but an unresolvable
   merge conflict is precisely the failure a non-technical operator cannot get out of.
5. **Back up the database.** If `data/app.db` exists: open it, `PRAGMA
   wal_checkpoint(TRUNCATE)`, close, then copy to `data/backups/app.db.<timestamp>`. Prune
   to the newest 5 backups. Checkpoint-then-copy is the pattern `src/db/database.ts`
   already uses for its own snapshots — a bare file copy misses the WAL. Skipped silently
   on a fresh clone. `data/` is gitignored, so backups never enter git.
6. **`git pull --ff-only`.** Fast-forward only: a diverged local history fails loudly
   instead of producing a merge commit or a conflict. On failure, report what happened and
   state explicitly that their data is untouched.
7. **`npm install`.** Picks up new dependencies, and re-runs preflight (`preinstall`) and
   the idempotent browser check (`postinstall`) for free.
8. **Report.** Print `git log --oneline <old>..<new>`, capped at 20 lines with a count of
   any remainder, then "Now run `npm start`."

   It deliberately does **not** start the server. Starting is the operator's action, and
   Ctrl+C semantics through a wrapper process are murkier than they look.

### Change to `scripts/preflight.mjs`

Add a `git` check to the `install` and `all` stages at **warn** severity, not fail. The app
runs perfectly well without git — you just can't `npm run update`. The message says exactly
that, and links the per-OS install.

### Tests — `tests/scripts/update.test.mjs`

Unit-test the exported predicates directly, with no git invocation and no filesystem
mutation outside a temp dir:

- Refusal when the working tree is dirty (message names the files).
- Refusal when the branch is not `main`.
- Refusal when `/api/status` answers.
- The distinct message when port 4400 is occupied by something that is *not* us.
- Refusal when `.git` is absent.
- Backup filename generation, and pruning to the newest 5.
- Fast-forward-refused message.

## Part 2 — Documentation

### `README.md`

- **New "Get the code" section**, ahead of Install: `git clone
  https://github.com/itaiintezer/linkedin-conn.git`, then `cd linkedin-conn`. Note that this
  creates a `linkedin-conn` folder, and to put it somewhere they own.
- **New "Updating" section**, after First run: `npm run update`, one line per thing it does,
  and the manual step-by-step equivalent for anyone who prefers it. State the thing that
  most needs stating: queue, login, settings and Apify key all live in `data/` and
  `.linkedin-profile/`, neither of which git tracks, so a pull cannot touch them. Say where
  backups land and how many are kept.
- **Fix the platform-notes table** — `cd ~/Downloads/the-machine` becomes the path a clone
  actually produces.
- **Fix the two "Relay" mentions** to "The Machine".
- **Add git to the Requirements table.**

### `RUNBOOK.md`

Written for non-technical operators, so it carries more hand-holding than the README.

- **Rewrite §1 step 2** from "ask whoever shared it for the zip or repo link" into the real
  clone command, with a one-line note per OS on getting git (macOS: ships with the Xcode
  command line tools; Windows: git-scm.com).
- **Delete §1 step 5**, the stale invite/message migration warning, and replace it with a
  pointer to the new updating section.
- **New "Getting updates" section**: Ctrl+C, `npm run update`, `npm start`. What gets backed
  up and where, and that a failed update leaves them exactly where they were.

## Part 3 — `LICENSE`

Internal-use-only terms: the copyright holder grants colleagues the right to use and modify
their own copy for internal purposes, with no grant to redistribute, and no warranty. Not an
OSI licence, and intentionally so — the repo being public makes the code *readable* by
anyone, which is not the same as usable by anyone. Referenced in one line at the foot of the
README.

## Out of scope

- GitHub Actions CI (declined).
- Any in-app version display or update-available banner.
- Any rename of the repository, the product, or the log file.
- Any change to the app's runtime behaviour. Parts 1–3 add one script, one preflight check,
  one licence file, and documentation. No `src/` file changes.

## Success criteria

1. A colleague with a clean machine can go from nothing to a running Machine using only
   `RUNBOOK.md`, without asking anyone a question.
2. That colleague can take an update with one command, and their queue, login and settings
   survive it.
3. Running `npm run update` while The Machine is running refuses, and says why.
4. An update that fails at any step leaves a working install at the previous commit.
5. `npm run typecheck` and `npm test` stay green, with the new script covered.
6. No occurrence of "Relay" or `~/Downloads/the-machine` remains in either doc.
