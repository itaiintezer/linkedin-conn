# Supervisor, Login Service & Update Button — Implementation Plan

**Goal:** A sales rep never opens a terminal after day one. The Machine starts itself at login,
is reachable at `http://localhost:4400`, and can be restarted or updated from the dashboard.
Local edits in the folder stop being a reason an update fails.

**Architecture:** One idea — *the app never manages its own lifecycle.* A tiny zero-dependency
`scripts/supervisor.mjs` is the only thing ever launched; it spawns the app, waits, and reads the
exit code to decide what happens next.

| App exits | Supervisor does |
|---|---|
| `0` | exits too (real stop) |
| `42` | respawns |
| `43` | runs `update.mjs`, then respawns |
| anything else | backoff, respawn (crash recovery) |

`data/control.json` is the only state that survives a restart, so it carries both the request and
its outcome — that is what lets the browser report "updated, 5 changes" after the server it asked
has died and come back. The OS is responsible for exactly one thing: run the supervisor at login
(Scheduled Task on Windows, LaunchAgent on macOS). Restart policy, locking, updating and rollback
all live in the supervisor, so both platforms behave identically.

**Tech Stack:** Zero-dep ESM `.mjs` for supervisor/update/service scripts (they must run on a bare
Node — an update may be what repairs a broken `node_modules`), TypeScript for the server, vanilla
JS for `src/web/app.js`, vitest + jsdom.

---

## The one enabling refactor

`scripts/update.mjs` currently derives `ROOT` from `import.meta.url` and hardcodes `data/`.
Both it and the new supervisor must instead accept **root, data dir, and the app command** from
argv/env, defaulting to today's values.

Nothing else in the plan is testable without this. It is also the fix for a hazard we have already
been bitten by: module-constant paths mean a test harness writes into the production `data/`.
**No test in this plan may touch the real `data/app.db` or `data/relay.log`.**

## How this is tested — no human in the loop

Four layers, all `npm test`, all fast:

**A. Pure functions (milliseconds).** Exit-code → action mapping, crash backoff, control-file state
transitions, rollback trigger, and the clean-tree *reporter*. Also the service adapters: split
"render the artifact" (pure — plist XML, Scheduled Task XML) from "hand it to `launchctl`/
`schtasks`" (impure, not unit tested). We assert the generated XML contains the absolute node path,
the working directory and the baked `PATH`; that is where these installs actually break.

**B. Supervisor loop with injected fakes (milliseconds).** `runSupervisor()` takes
`{ spawnApp, runUpdate, sleep }`. Tests queue exit codes and assert the resulting action sequence —
no processes spawned. Covers: clean stop, restart, update-then-respawn, growing backoff on repeated
crashes, rollback after N post-update failures, self-re-exec when the supervisor's own file changed.

**C. One disposable-repo integration test (a few seconds).** The test builds a throwaway git
"remote" (bare repo) and clones it into a temp dir. The clone contains a **10-line fake app** that
exits with whatever code a file tells it to, and a `package.json` with no dependencies (so a real
`npm install` is ~1s). Then it runs the *real* `supervisor.mjs` and *real* `update.mjs` against
that temp root and asserts the whole loop: dirty file → reset → pull → new version running.

This is the test that proves the mechanism, and it needs no network, no browser, no LinkedIn and
no human. Everything expensive about this project is absent from it because the app under
supervision is a fake.

**D. API + dashboard (milliseconds).** `buildServer` gains an injectable `requestExit`, so
`POST /api/update` can be tested without killing the test runner. The dashboard's "Updating…"
state machine is driven in jsdom with mocked fetch: `202` → poll → connection refused → `200` →
outcome, reusing the existing `tests/web/helpers/load-app.js`.

**E. What cannot be automated — and the honest boundary.** Whether a Scheduled Task actually
registers, whether the `wscript` launch really hides the console, whether a LaunchAgent survives a
real logout, and whether headful Chromium comes back after a restart. These need the OS, and can't
run on the other platform at all. Covered by `npm run service:doctor`, a one-time per-platform
check in the existing `scripts/verify-*` style. One-time per platform, not per change.

---

### Task 1: Rename "Relay" → "The Machine"

Independent of everything else; do it first so new code is born with the right name.

**Files:** `.claude/skills/relay-*` → `themachine-*` (dirs + `name:` + prose), `CLAUDE.md`,
`src/web/app.js:1320-1321` (the one string a rep can see), ~20 comments and test names.

- [ ] `RELAY_URL` → `THEMACHINE_URL`, with the skills falling back to `RELAY_URL` when set.
- [ ] **Leave `data/relay.log` as-is** — renaming orphans the log on every installed machine and
      the "download the log and send it" instruction is live.
- [ ] **Leave `docs/superpowers/` as-is** — dated historical records; rewriting them makes the
      archive lie about what it was called at the time.
- [ ] **Do not** touch `API.md:808` or `src/api/server.ts:1387` — those are the English verb
      "relay", not the product. A blind find-and-replace mangles them.

### Task 2: `update.mjs` resets instead of refusing

**Files:** `scripts/update.mjs`, `tests/scripts/update.test.mjs`

- [ ] Accept `root`/`dataDir` from argv/env (the enabling refactor).
- [ ] Before pulling: dump `git diff HEAD` and the untracked list to
      `data/backups/discarded-<ts>.patch`, then `git reset --hard HEAD` and `git clean -fd`.
      `reset --hard` not `checkout -- .`, because staged changes survive the latter and still
      merge. `clean -fd` (never `-x`) closes the untracked-collision dead end — and `.gitignore`
      covers `data/`, `*.db*` and `.linkedin-profile/`, so the queue, roster and login are
      unreachable by either command.
- [ ] `checkCleanTree` becomes a reporter, not a gate: it prints what was reset as information.
      Its existing tests assert the old failure behaviour and get flipped.
- [ ] Keep the `--ff-only` refusal. Diverged local *commits* are the one thing not recoverable
      from the remote, and stay a call-the-maintainer case.
- [ ] Delete the port/`Ctrl+C` precondition — the supervisor owns stopping now.
- [ ] Test in a temp git repo (real git, milliseconds): unstaged edit, staged edit and stray
      untracked file are all cleared; an ignored `data/` file survives; the patch dump exists.

### Task 3: `scripts/supervisor.mjs`

**Files:** create `scripts/supervisor.mjs`, `tests/scripts/supervisor.test.mjs`

- [ ] Export a pure `decideNextAction(exitCode)` and `backoffMs(consecutiveFailures)`.
- [ ] Export `runSupervisor({ root, dataDir, spawnApp, runUpdate, sleep })` — the injectable loop
      (layer B). The `main()` wrapper below it is thin and untested.
- [ ] Single-instance lockfile in `dataDir`, so a rep who also runs `npm start` by hand gets a
      plain-English refusal instead of a cryptic browser-profile error.
- [ ] On start, if `control.json` says `requested`, act on it; the supervisor sets `running` then
      `done`/`failed` with `from_sha`, `to_sha`, the change list, and any error.
- [ ] `npm start` runs the supervisor in the foreground (dev path, Ctrl+C works). The app entry
      moves to an internal script. Set `THEMACHINE_SUPERVISED=1` on the child.

### Task 4: Exit protocol, control file, and the routes

**Files:** `src/api/server.ts`, `src/index.ts`, `src/core/control-file.ts` (new),
`tests/api/server.test.ts`, `tests/core/control-file.test.ts`

- [ ] `src/core/control-file.ts`: read/write/transition, taking a dir. Pure transitions tested.
- [ ] `buildServer` gains an injectable `requestExit(code)`, defaulting to the real graceful
      shutdown wired in `src/index.ts`. This is the seam that makes the routes testable.
- [ ] `POST /api/update` and `POST /api/restart`: set `paused`, write the control file, reply
      `202` immediately, then **drain the browser mutex before exiting**.
      `await browserLock.run(async () => {})` queues behind all in-flight and queued work and
      needs no change to `Mutex` — race it against a bounded timeout.
      *This is the load-bearing safety detail:* exiting between "clicked Connect" and "recorded
      the send" means LinkedIn has an invite we don't know about and that person gets a second one.
- [ ] `GET /api/update/status` reads the control file. On boot, if it says `requested`/`running`
      and `THEMACHINE_SUPERVISED` is unset, mark it `failed` ("no supervisor") so the dashboard
      never shows a pending update nothing will act on.
- [ ] No auth — the server binds `127.0.0.1` only, same as every other mutating route.
- [ ] Add `GET /api/update/check`: `git fetch` + rev-list count, so the UI stays silent when
      there is nothing to install.

### Task 5: Dashboard controls

**Files:** `src/web/index.html`, `src/web/app.js`, `tests/web/update-controls.test.ts`

- [ ] Settings gains **Restart** and **Update**. **No Stop** — with a login-launched service,
      "stopped" means "until next login", and there would be no server left to serve the button
      that undoes it. Pause already covers what reps actually want, and every remaining button
      leaves the system in a state the dashboard can still reach.
- [ ] Topbar badge from `/api/update/check`: silent normally, "Update available — N changes"
      otherwise.
- [ ] The "Updating…" state must treat a refused connection as **expected** for ~90s, not as an
      error, then report the outcome from `/api/update/status`.

### Task 6: Service install

**Files:** `scripts/service.mjs`, `scripts/service-doctor.mjs`, `tests/scripts/service.test.mjs`

- [ ] `npm run service:install` / `:uninstall` / `:status`, branching on `process.platform`.
- [ ] macOS: `~/Library/LaunchAgents/com.intezer.themachine.plist`, `RunAtLoad`,
      stdout/stderr → `data/service.out.log`, loaded with `launchctl bootstrap gui/$(id -u)`.
- [ ] Windows: per-user Scheduled Task `TheMachine`, `-AtLogOn`, principal **interactive** (a
      non-interactive principal has no desktop, so the LinkedIn browser could never be seen or
      clicked). Action is `wscript.exe` + a 2-line hidden-launch shim, because `node.exe` is a
      console-subsystem binary and there is no `nodew.exe`.
- [ ] **Bake absolute paths for node, npm *and* git** into the plist/task environment. A
      LaunchAgent gets a minimal `PATH`, so a service that starts fine will fail to *update*.
      This is the single most likely failure of the whole task.
- [ ] Print the dashboard URL on successful install. No desktop shortcut.
- [ ] Unit-test the rendered artifacts only (layer A); `service:doctor` covers the rest (layer E).

### Task 7: Rollback and supervisor self-update

**Files:** `scripts/supervisor.mjs`, `tests/scripts/supervisor.test.mjs`

- [ ] If the app fails to start 3 times after an update, `git reset --hard <from_sha>`, reinstall,
      respawn, and record it in the control file. Turns a bad release from "the rep is dead until
      someone SSHes in" into a self-healing blip; nearly free, since the restart loop exists.
- [ ] After a successful update, if `supervisor.mjs`'s own hash changed, re-exec self — the
      running supervisor is still executing the old file from memory. Keep this file small and
      near-frozen: it is the one thing an update cannot hot-fix.

---

## Sequencing

Tasks 1 and 2 ship independently and are useful immediately. 3 → 4 → 5 is the button. 6 is the
service. 7 is hardening and can trail. Each task's tests must be green before the next starts.
