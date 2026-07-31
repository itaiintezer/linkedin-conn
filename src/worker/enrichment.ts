import type { Repos } from '../db/repositories.js';
import type { ApifyClient } from '../core/apify-client.js';
import { extractProfile, isEmptyProfile } from '../core/apify-extract.js';
import { classifyEnrichError, isAccountLevel } from '../core/enrich-failure.js';
import type { EnrichHaltReason } from '../types.js';
import { log } from '../core/log.js';

const DEFAULT_MAX_ATTEMPTS = 3;
/** Rows taken per claim. Small enough that a pause loses little, large enough to amortise. */
const CLAIM_CHUNK = 20;
/**
 * Consecutive profile-level failures before the run gives up. Five is comfortably more than
 * the clusters of restricted profiles that occur naturally in a real roster, and far fewer
 * than it takes to do damage — a failure mode nobody predicted stops after five rows rather
 * than after seven thousand.
 */
const CONSECUTIVE_FAILURE_LIMIT = 5;

export interface EnrichmentDeps {
  client: ApifyClient;
  concurrency: number;
  /** Attempts before a row is parked as `failed`. Default 3. */
  maxAttempts?: number;
  /** Injectable clock, so tests do not depend on wall time. */
  clock?: () => Date;
}

export interface EnrichmentResult {
  enriched: number;
  empty: number;
  failed: number;
  /** True when the run ended because it was paused rather than because the queue drained. */
  stopped: boolean;
  /** Set when the run stopped itself because something bigger than one profile was wrong. */
  haltReason?: EnrichHaltReason;
}

export interface EnrichmentProgress {
  running: boolean;
  total: number;
  enriched: number;
  pending: number;
  enriching: number;
  empty: number;
  failed: number;
  startedAt: string | null;
}

/** In-flight run, so the API can report progress and pause it. One at a time by design. */
let active: { startedAt: string; controller: AbortController } | null = null;

export function isEnrichmentRunning(): boolean {
  return active !== null;
}

export function pauseEnrichment(): boolean {
  if (!active) return false;
  active.controller.abort();
  return true;
}

export function enrichmentProgress(repos: Repos): EnrichmentProgress {
  const c = repos.connections.countsByEnrichStatus();
  return {
    running: active !== null,
    total: repos.connections.count(),
    enriched: c.enriched,
    pending: c.pending,
    enriching: c.enriching,
    empty: c.empty,
    failed: c.failed,
    startedAt: active?.startedAt ?? null,
  };
}

/**
 * Drain the pending enrichment queue.
 *
 * Deliberately unlike every other worker in this app: **no pacing, no guardrail, no browser
 * mutex**. Apify runs on third-party infrastructure and never touches the LinkedIn session,
 * so the only real limits are money and the operator's Apify plan concurrency.
 *
 * Resumable by construction — all state lives in `connections.enrich_status`, so a pause, a
 * crash or a restart loses at most the in-flight requests. A failing profile is data, not an
 * outage: it is recorded and the pool moves on, because one restricted profile must never
 * abort a 7,000-row backfill.
 *
 * A failing ACCOUNT is the opposite case, and the run stops for it. Since the drain tick made
 * this worker unattended, an error that is not the profile's fault (rejected key, no credit,
 * rate limit, Apify 5xx) must not be charged to the row: three attempts would park it as
 * `failed`, which only an operator can undo. Those errors abort the run with the row left in
 * `enriching`, so the finally-block hands it back to `pending` untouched, and latch a halt
 * that the dashboard shows and the drain tick honours.
 */
export async function runEnrichment(
  repos: Repos,
  deps: EnrichmentDeps,
  opts: { signal?: AbortSignal } = {},
): Promise<EnrichmentResult> {
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const clock = deps.clock ?? (() => new Date());
  const concurrency = Math.max(1, Math.floor(deps.concurrency) || 1);

  const controller = new AbortController();
  const onExternalAbort = (): void => controller.abort();
  opts.signal?.addEventListener('abort', onExternalAbort, { once: true });

  const startedAt = clock().toISOString();
  active = { startedAt, controller };

  const result: EnrichmentResult = { enriched: 0, empty: 0, failed: 0, stopped: false };
  // Rows claimed but not yet resolved. Anything left here when we stop must go back to
  // pending, or it is stranded in `enriching` and nothing will ever claim it again.
  const queue: { id: number; profile_url: string }[] = [];

  const takeNext = (): { id: number; profile_url: string } | undefined => {
    if (queue.length === 0 && !controller.signal.aborted) {
      queue.push(...repos.connections.claimForEnrichment(CLAIM_CHUNK));
    }
    return queue.shift();
  };

  // Consecutive failures across the whole pool, not per worker: the signal we care about is
  // "nothing is succeeding right now", and any success anywhere disproves that.
  let consecutiveFailures = 0;

  /** Stop the run and record why. Idempotent — whichever worker trips first wins. */
  const halt = (reason: EnrichHaltReason, detail: string): void => {
    if (result.haltReason) return;
    result.haltReason = reason;
    repos.appState.haltEnrichment(reason, detail, clock().toISOString());
    log.error('enrich', 'halted', { reason, detail });
    controller.abort();
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      if (controller.signal.aborted) return;
      const row = takeNext();
      if (!row) return;
      try {
        const raw = await deps.client.fetchProfile(row.profile_url);
        if (isEmptyProfile(raw)) {
          repos.connections.markEnrichEmpty(row.id);
          result.empty++;
        } else {
          repos.connections.applyEnrichment(row.id, extractProfile(raw), clock().toISOString());
          result.enriched++;
        }
        consecutiveFailures = 0;
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        const kind = classifyEnrichError(error);
        if (isAccountLevel(kind)) {
          // Not this profile's fault. Leave the row in `enriching` — the finally-block
          // requeues it to `pending` with its attempt count untouched.
          halt(kind, error);
          return;
        }
        repos.connections.markEnrichFailure(row.id, error, maxAttempts);
        // Only count a terminal park as a failure; a row returned to `pending` will be
        // retried by a later claim in this same run.
        const after = repos.connections.findByUrl(row.profile_url);
        if (after?.enrich_status === 'failed') result.failed++;
        log.warn('enrich', 'profile failed', { url: row.profile_url, error });
        if (++consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
          halt('repeated_errors', `${consecutiveFailures} profiles failed in a row; last error: ${error}`);
          return;
        }
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
  } finally {
    opts.signal?.removeEventListener('abort', onExternalAbort);
    result.stopped = controller.signal.aborted;
    // Evidence beats a stale latch: a run that actually enriched somebody proves Apify is
    // reachable and the key works. A run that enriched nothing proves nothing, so it leaves
    // any recorded halt standing.
    if (result.enriched > 0 && !result.haltReason) repos.appState.clearEnrichHalt();
    // Hand back anything claimed-but-unprocessed, plus any row a crash left behind.
    const requeued = repos.connections.requeueEnriching();
    active = null;
    log.info('enrich', 'run finished', { ...result, requeued });
  }
  return result;
}
