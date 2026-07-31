import type { Repos } from '../db/repositories.js';
import type { ApifyClient } from '../core/apify-client.js';
import { extractProfile, isEmptyProfile } from '../core/apify-extract.js';
import { log } from '../core/log.js';

const DEFAULT_MAX_ATTEMPTS = 3;
/** Rows taken per claim. Small enough that a pause loses little, large enough to amortise. */
const CLAIM_CHUNK = 20;

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
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        repos.connections.markEnrichFailure(row.id, error, maxAttempts);
        // Only count a terminal park as a failure; a row returned to `pending` will be
        // retried by a later claim in this same run.
        const after = repos.connections.findByUrl(row.profile_url);
        if (after?.enrich_status === 'failed') result.failed++;
        log.warn('enrich', 'profile failed', { url: row.profile_url, error });
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
  } finally {
    opts.signal?.removeEventListener('abort', onExternalAbort);
    result.stopped = controller.signal.aborted;
    // Hand back anything claimed-but-unprocessed, plus any row a crash left behind.
    const requeued = repos.connections.requeueEnriching();
    active = null;
    log.info('enrich', 'run finished', { ...result, requeued });
  }
  return result;
}
