# Enrichment auto-drain + halt alerting

**Date:** 2026-07-31
**Problem:** the connection-directory design spec says the enrichment trigger *"Auto-starts
on import"* ([design:33](../specs/2026-07-31-connection-directory-design.md)), and budgets a
steady state of *"~44 profiles/day ≈ $5/month"* for TTL refresh. Neither happens: nothing in
the codebase ever calls `runEnrichment` except the Start button. The phase-2 plan reasoned
about *enqueue* ("newly imported/scraped rows already default to `pending`, so no extra
enqueue is needed") and never added a *consumer*. So roster-discovered connections and
TTL-stale rows accumulate as `pending` forever, invisible to search.

**Goal:** every connection in the roster ends up enriched, without a human clicking anything —
and when automatic enrichment cannot proceed, the dashboard says so instead of failing quietly.

## Decisions

| Question | Decision |
|---|---|
| Trigger | One periodic tick, every 60 s, that drains whatever is `pending` regardless of where it came from. No per-source kicks — a source-agnostic consumer cannot be bypassed by a future enqueue path, which is exactly how this bug happened |
| Pause | Respected. Pause is the operator's "stop doing things" switch, so it stops unattended spending. Manual Start still works while paused, making the button the override |
| Guardrail trip | **Ignored.** The guardrail is LinkedIn session health; Apify never touches that session |
| Spend ceiling | None. $4/1k is cheap enough that "everything is enriched" beats "everything is enriched, eventually" |
| Account-level failure (bad key, billing, rate limit, Apify outage) | Halt the run immediately, do **not** charge the row an attempt, latch a halt state, alert on the dashboard |
| Repeated profile-level failures | 5 consecutive failures with no success in between → halt and alert. Protects against a mode nobody predicted |
| Recovering from a halt | Operator-driven: a "Try again" button clears the latch and starts a run. A run that enriches anything also clears it |

The halt latch is what keeps the 60 s tick from hammering a broken key 1,440 times a day, and
it is what makes the failure *visible* rather than a line in `relay.log`.

## Why a halt must not charge attempts

`markEnrichFailure` parks a row as `failed` after 3 attempts, and `failed` is manual-re-arm-only
by design (a restricted profile will not spontaneously become scrapeable). A rotated API key
fails *every* fetch, so without classification three auto-drain cycles would silently convert
the entire roster into `failed` rows needing manual rescue. Account-level errors therefore
leave the row untouched in `enriching`, and `runEnrichment`'s existing `finally` block requeues
it to `pending`.

## Steps

Each step is TDD: failing test → implement → run → commit.

- [ ] **1. Failure classification** — `src/core/enrich-failure.ts`: `classifyEnrichError(msg)`
  → `'auth' | 'billing' | 'rate_limit' | 'upstream' | 'profile'`. Reads the HTTP status out
  of the client's `Apify run failed (HTTP nnn)` message: 401/403 → auth, 402 → billing,
  429 → rate_limit, 5xx → upstream, everything else (empty dataset, unexpected payload,
  timeouts) → profile. Tests cover each mapping plus an unrecognised message.

- [ ] **2. Halt state** — `app_state` columns `enrich_halted`, `enrich_halt_reason`,
  `enrich_halt_detail`, `enrich_halted_at`; `ALTER TABLE` migration in `database.ts` following
  the existing additive pattern. `AppStateRepo.haltEnrichment(reason, detail, atIso)` /
  `clearEnrichHalt()`, mirroring `trip()` / `clearGuardrail()`. Halt reasons:
  `no_api_key | auth | billing | rate_limit | upstream | repeated_errors`.

- [ ] **3. Circuit breaker in the worker** — `runEnrichment` gains a consecutive-failure
  counter (reset by any success) and:
  - account-level error → abort the run without charging the row an attempt;
  - 5 consecutive profile-level errors → abort;
  - either way write the halt state and return `haltReason` on `EnrichmentResult`;
  - a run that enriched ≥1 profile clears any existing halt.
  Tests: bad key on the first fetch leaves every row `pending` with `enrich_attempts = 0`;
  5 failures in a row halt with `repeated_errors`; 4 failures with a success between them do
  not halt; a successful run clears a pre-existing halt.

- [ ] **4. The drain tick** — `Orchestrator.runEnrichDrainTick(now)`, 60 s interval, plus an
  `apifyClientFactory` constructor param defaulted to `new HttpApifyClient(t)` (same injection
  shape as `buildServer`). Guard order: `paused` → skip; `enrich_halted` → skip; already
  running → skip; `pending === 0` → skip (the steady state, so it costs one indexed
  `COUNT(*)` and builds no client); no `apify_api_key` → halt `no_api_key` and skip.
  Then fire-and-forget `runEnrichment` with `.catch` logging, as the Start endpoint does.
  `guardrail_tripped` is deliberately unchecked — with a comment saying so, so it does not
  get "fixed" later. Tests: one per guard, plus "runs while the guardrail is tripped".

- [ ] **5. TTL sweep runs at startup too** — `runEnrichRefreshTick` currently only fires on a
  6-hour interval, so a Relay restarted more often than that never sweeps. Call it once in
  `start()`. Now that a consumer exists this is the other half of "all connections enriched".

- [ ] **6. API** — `GET /api/enrichment/status` returns `halt: { reason, detail, at } | null`;
  `GET /api/status` returns the same under `enrich_halt` so the dashboard banner can render
  without a second poll; `POST /api/enrichment/resume` clears the latch and starts a run.
  Manual `POST /api/enrichment/start` clears the latch first — clicking Start *is* the
  operator saying "I fixed it".

- [ ] **7. Dashboard alert** — an amber `#enrichBanner` beside the existing pause/guardrail
  banners, with a reason-code → sentence map (`REASON_TEXT`) and a "Try again" button wired to
  `/api/enrichment/resume`. The enrichment panel in Settings → Connections shows the same
  reason inline. Web tests assert the banner appears on halt, names the reason, and hides
  after a successful resume.

- [ ] **8. Docs** — `API.md` (new endpoint + two response fields), `README.md` / `RUNBOOK.md`
  (enrichment is automatic; how to clear a halt), and the design spec's trigger row updated
  from "Auto-starts on import" to what actually exists.

## Out of scope

Auto-re-arming `failed`/`empty` rows (still manual, still for the original reason), removal
tracking, and any change to enrichment pacing or concurrency.
