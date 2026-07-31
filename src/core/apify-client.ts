import type { ApifyProfile } from '../types.js';

/** harvestapi/linkedin-profile-scraper. Same actor and mode as the proven reference
 *  implementation in C:\Projects\prospecting\apify_linkedin.py. */
const ACTOR_ID = 'LpVuK3Zozwuipa5bp';
const SCRAPER_MODE = 'Profile details no email ($4 per 1k)';

/** ~$0.004 per profile, for the cost estimate shown before a backfill. */
export const COST_PER_PROFILE_USD = 0.004;

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BACKOFF_MS = 5_000;

/** Injected everywhere so no test ever spends money. */
export interface ApifyClient {
  /** Resolve the first dataset item for a profile URL, or throw. Never returns undefined. */
  fetchProfile(profileUrl: string): Promise<ApifyProfile>;
}

export interface HttpApifyClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  backoffMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Apify REST client. One profile URL per actor run.
 *
 * Batching several URLs into one run is possible — `originalQuery.query` echoes the input,
 * so results are mappable — but it is not worth it: a single-URL run measured 5.2s live, so
 * concurrency alone covers a 7k roster in ~77 minutes, and one-per-run removes any chance of
 * the index-misalignment bug that batching invites (a private profile returns NO item, which
 * would silently shift every result after it).
 *
 * This client never touches the LinkedIn browser session, so it needs no guardrail, no
 * pacing and no browser mutex — unlike every other outbound path in this app.
 */
export class HttpApifyClient implements ApifyClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly backoffMs: number;

  constructor(private readonly token: string, opts: HttpApifyClientOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  }

  async fetchProfile(profileUrl: string): Promise<ApifyProfile> {
    let lastError = 'unknown error';
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await sleep(this.backoffMs);
      try {
        const payload = await this.runActor(profileUrl);
        if (!Array.isArray(payload)) throw new Error('Apify returned an unexpected payload shape (not a dataset array)');
        if (payload.length === 0) throw new Error('Apify returned an empty dataset');
        return payload[0] as ApifyProfile;
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        // An empty/!array dataset is deterministic — retrying costs money for the same
        // answer. Only transport and HTTP failures are worth another attempt.
        if (/empty dataset|unexpected payload/i.test(lastError)) throw e;
      }
    }
    throw new Error(lastError);
  }

  private async runActor(profileUrl: string): Promise<unknown> {
    // The token travels in the query string. It must NEVER reach an error message: those
    // land in data/relay.log, which the operator downloads and shares when troubleshooting.
    const url = `https://api.apify.com/v2/acts/${ACTOR_ID}/run-sync-get-dataset-items?token=${encodeURIComponent(this.token)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ profileScraperMode: SCRAPER_MODE, queries: [profileUrl] }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Apify run failed (HTTP ${res.status})`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }
}
