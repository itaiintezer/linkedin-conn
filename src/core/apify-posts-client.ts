/**
 * Apify client for harvestapi~linkedin-profile-posts — the second actor, alongside the
 * profile scraper in apify-client.ts.
 *
 * WHY A SEPARATE INTERFACE rather than a method on ApifyClient: every existing test fake
 * implements `{ fetchProfile }`, and adding a required `fetchPosts` would break all of them
 * for reasons unrelated to this feature. HttpApifyPostsClient can implement both if that ever
 * becomes useful; the sweep worker only ever sees ApifyPostsClient.
 *
 * WHY ASYNC RUN + POLL rather than the run-sync endpoint the profile client uses: run-sync
 * fails at 300s with HTTP 408, and that timeout kills only the HTTP request — the run keeps
 * going, so retrying would bill twice for the same work. The actor documents no maximum on
 * targetUrls, so polling lets ONE run cover every tracked profile.
 *
 * Like the profile client, this never touches the LinkedIn browser session, so it needs no
 * guardrail, no pacing and no browser mutex.
 */
import type { ApifyPost } from '../types.js';

const ACTOR_ID = 'harvestapi~linkedin-profile-posts';

/** $1.50–2.00 per 1,000 posts, pay-per-result. The conservative end, for the cost readout. */
export const COST_PER_POST_USD = 0.002;

/** Apify pages dataset items; 1000 is its usual maximum page size. */
const PAGE_SIZE = 1000;
const DEFAULT_POLL_MS = 5_000;
const DEFAULT_MAX_POLLS = 240;        // 240 x 5s = 20 minutes
const DEFAULT_TIMEOUT_MS = 60_000;    // per HTTP request, not per run

export type PostedLimit = '24h' | 'week' | 'month';

export interface FetchPostsOptions {
  /** Per profile, not per run. */
  maxPosts: number;
  /**
   * THE cost control. INSERT OR IGNORE dedupes storage but never the bill, so a wide window
   * on a frequent sweep re-bills posts already stored. Derived from per-profile staleness by
   * the sweep worker; never widened casually.
   */
  postedLimit: PostedLimit;
}

/** Injected everywhere so no test ever spends money. */
export interface ApifyPostsClient {
  fetchPosts(urls: string[], opts: FetchPostsOptions): Promise<ApifyPost[]>;
}

export interface HttpApifyPostsClientOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  maxPolls?: number;
  timeoutMs?: number;
}

const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT', 'TIMED_OUT']);

export class HttpApifyPostsClient implements ApifyPostsClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollMs: number;
  private readonly maxPolls: number;
  private readonly timeoutMs: number;

  constructor(private readonly token: string, opts: HttpApifyPostsClientOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
    this.maxPolls = opts.maxPolls ?? DEFAULT_MAX_POLLS;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async fetchPosts(urls: string[], opts: FetchPostsOptions): Promise<ApifyPost[]> {
    // Guarded here rather than at the call site: an empty targetUrls array is a billable run
    // that can only return nothing.
    if (urls.length === 0) return [];
    const { runId, datasetId } = await this.startRun(urls, opts);
    const finalDataset = await this.awaitRun(runId, datasetId);
    return this.readDataset(finalDataset);
  }

  private async startRun(
    urls: string[], opts: FetchPostsOptions,
  ): Promise<{ runId: string; datasetId: string }> {
    const body = {
      targetUrls: urls,
      maxPosts: opts.maxPosts,
      postedLimit: opts.postedLimit,
      // Both bill as ADDITIONAL posts. Never enable them.
      scrapeReactions: false,
      scrapeComments: false,
    };
    const payload = await this.request(`/v2/acts/${ACTOR_ID}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    }) as { data?: { id?: string; defaultDatasetId?: string } };
    const runId = payload?.data?.id;
    const datasetId = payload?.data?.defaultDatasetId;
    if (!runId || !datasetId) throw new Error('Apify did not return a run id and dataset id');
    return { runId, datasetId };
  }

  /** Poll until terminal. Returns the dataset id the finished run reports. */
  private async awaitRun(runId: string, fallbackDatasetId: string): Promise<string> {
    for (let i = 0; i < this.maxPolls; i++) {
      const payload = await this.request(`/v2/actor-runs/${runId}`, { method: 'GET' }) as
        { data?: { status?: string; defaultDatasetId?: string } };
      const status = payload?.data?.status ?? 'UNKNOWN';
      if (TERMINAL.has(status)) {
        if (status !== 'SUCCEEDED') throw new Error(`Apify run ${status}`);
        return payload?.data?.defaultDatasetId ?? fallbackDatasetId;
      }
      await this.sleep(this.pollMs);
    }
    // Deliberately does not abort the run: it may still be doing billable work, and a second
    // sweep would pay for it again. The next pass reaches these profiles via their unchanged
    // last_swept_at, and INSERT OR IGNORE makes any overlap free.
    throw new Error(`Apify run did not finish within ${this.maxPolls} polls`);
  }

  private async readDataset(datasetId: string): Promise<ApifyPost[]> {
    const out: ApifyPost[] = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const page = await this.request(
        `/v2/datasets/${datasetId}/items?clean=true&limit=${PAGE_SIZE}&offset=${offset}`,
        { method: 'GET' },
      );
      if (!Array.isArray(page)) throw new Error('Apify returned an unexpected dataset shape');
      out.push(...(page as ApifyPost[]));
      // A short page is the last page. Paged rather than fetched whole because a large run's
      // response would otherwise be silently truncated.
      if (page.length < PAGE_SIZE) return out;
    }
  }

  /**
   * One HTTP call. The token travels in the query string and MUST NEVER reach an error
   * message: those land in data/relay.log, which the operator downloads and shares when
   * troubleshooting. So every throw below names the path or status, never the URL.
   */
  private async request(path: string, init: RequestInit): Promise<unknown> {
    const sep = path.includes('?') ? '&' : '?';
    const url = `https://api.apify.com${path}${sep}token=${encodeURIComponent(this.token)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, { ...init, signal: controller.signal });
      if (!res.ok) throw new Error(`Apify request failed (HTTP ${res.status})`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }
}
