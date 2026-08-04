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
 * guardrail, no pacing and no browser mutex — unlike every other outbound path in this app.
 *
 * SPENDING SAFEGUARDS, layered because any one of them alone can fail:
 *  1. `maxPosts` is validated (positive integer) before anything is sent — the actor treats 0
 *     as "all posts, no limit", which is the natural way an operator would type "off".
 *  2. `maxItems` on the run-start call is Apify's own billing ceiling for pay-per-result
 *     actors, enforced server-side regardless of whether the actor code honours `maxPosts`.
 *  3. `timeout` (seconds) on the same call asks the run to self-terminate once our own poll
 *     budget would give up on it anyway, so an abandoned run stops billing instead of running
 *     to completion nobody reads. Both are documented query params on this endpoint:
 *     https://docs.apify.com/api/v2/act-runs-post
 *  4. A wall-clock `maxRunMs` deadline is enforced independently in BOTH the poll loop and the
 *     dataset-paging loop, so neither can run longer than the stated budget regardless of how
 *     `maxPolls`/`pollMs`/page counts interact.
 *  5. Dataset paging carries its own page cap tied to the same billing ceiling, so a pagination
 *     bug that never returns an empty page throws instead of looping — and eventually
 *     OOM-ing — forever.
 */
import type { ApifyPost } from '../types.js';

const ACTOR_ID = 'harvestapi~linkedin-profile-posts';

/** $1.50–2.00 per 1,000 posts, pay-per-result. The conservative end, for the cost readout. */
export const COST_PER_POST_USD = 0.002;

/** Apify pages dataset items; 1000 is its usual maximum page size. */
const PAGE_SIZE = 1000;
const DEFAULT_POLL_MS = 5_000;
const DEFAULT_MAX_POLLS = 240;
// Wall-clock cap across BOTH polling and dataset paging, checked directly against Date.now() —
// not derived from maxPolls * pollMs, which would only describe the best case (every poll
// answering instantly) and silently stop being true the moment either default changes.
const DEFAULT_MAX_RUN_MS = 20 * 60 * 1000; // 20 minutes
const DEFAULT_TIMEOUT_MS = 60_000;         // per HTTP request, not per run
// Idempotent GETs only (poll, dataset page). The run-start POST is never retried: a retry
// after an ambiguous 5xx risks starting a second billable run for the same work.
const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_BACKOFF_MS = 2_000;

export type PostedLimit = '24h' | 'week' | 'month';

export interface FetchPostsOptions {
  /** Per profile, not per run. Must be a positive integer — see the class doc comment. */
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
  /** Wall-clock ceiling for one fetchPosts() call, across polling AND paging. */
  maxRunMs?: number;
  /** Attempts (including the first) for each idempotent GET. Never applied to run-start. */
  retryAttempts?: number;
  retryBackoffMs?: number;
}

// Apify's actual run-status enum uses hyphens only (e.g. `TIMED-OUT`); there is no
// underscore variant, so don't add one back in even though it looks like a natural alias.
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT']);

interface ApifyResult {
  body: unknown;
  headers: Headers | undefined;
}

export class HttpApifyPostsClient implements ApifyPostsClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollMs: number;
  private readonly maxPolls: number;
  private readonly timeoutMs: number;
  private readonly maxRunMs: number;
  private readonly retryAttempts: number;
  private readonly retryBackoffMs: number;

  constructor(private readonly token: string, opts: HttpApifyPostsClientOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
    this.maxPolls = opts.maxPolls ?? DEFAULT_MAX_POLLS;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRunMs = opts.maxRunMs ?? DEFAULT_MAX_RUN_MS;
    this.retryAttempts = opts.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS;
    this.retryBackoffMs = opts.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  }

  async fetchPosts(urls: string[], opts: FetchPostsOptions): Promise<ApifyPost[]> {
    // Guarded here rather than at the call site: an empty targetUrls array is a billable run
    // that can only return nothing.
    if (urls.length === 0) return [];
    this.assertValidMaxPosts(opts.maxPosts);
    const deadline = Date.now() + this.maxRunMs;
    const { runId, datasetId } = await this.startRun(urls, opts);
    const finalDatasetId = await this.awaitRun(runId, datasetId, deadline);
    return this.readDataset(finalDatasetId, deadline, urls.length * opts.maxPosts);
  }

  /**
   * The actor's own input schema documents 0 as "no limit — return every post". That's the
   * natural way an operator types "off", so it must be rejected rather than passed through.
   * A non-integer (e.g. NaN from a malformed settings write) JSON.stringifies to `null`, which
   * the actor silently replaces with its own default of 10 — also not what was asked for.
   */
  private assertValidMaxPosts(maxPosts: number): void {
    if (!Number.isInteger(maxPosts) || maxPosts < 1) {
      throw new Error(
        `maxPosts must be a positive integer (got ${maxPosts}); 0 means "all posts" to this actor`,
      );
    }
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
    // maxItems is Apify's server-enforced billing ceiling for pay-per-result actors — the
    // number of dataset items we will ever be charged for, independent of whether the actor
    // code honours maxPosts. timeout (seconds) asks Apify to kill the run once our own poll
    // budget (maxRunMs) would give up on it anyway, so an abandoned run stops billing instead
    // of running to completion that nothing ever reads.
    const query = new URLSearchParams({
      maxItems: String(urls.length * opts.maxPosts),
      timeout: String(Math.max(1, Math.ceil(this.maxRunMs / 1000))),
    });
    // Never retried: a retry after an ambiguous 5xx (the request may already have landed)
    // risks starting a second billable run for the same work.
    const { body: payload } = await this.request(
      `/v2/acts/${ACTOR_ID}/runs?${query}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      },
      'run start',
    );
    const data = (payload as { data?: { id?: string; defaultDatasetId?: string } })?.data;
    if (!data?.id || !data?.defaultDatasetId) {
      throw new Error('Apify did not return a run id and dataset id from run start');
    }
    return { runId: data.id, datasetId: data.defaultDatasetId };
  }

  /** Poll until terminal. Returns the dataset id the finished run reports. */
  private async awaitRun(runId: string, fallbackDatasetId: string, deadline: number): Promise<string> {
    for (let i = 0; i < this.maxPolls; i++) {
      if (Date.now() > deadline) {
        throw new Error(`Apify run ${runId} exceeded the ${this.maxRunMs}ms run budget while polling`);
      }
      // Guarded by i > 0 so the first poll happens immediately after run-start (no need to
      // wait before the very first check) and the loop never sleeps once more right before
      // giving up on the last iteration.
      if (i > 0) await this.sleep(this.pollMs);
      const { body: payload } = await this.requestWithRetry(
        `/v2/actor-runs/${runId}`, { method: 'GET', headers: { Accept: 'application/json' } }, 'poll',
      );
      const data = (payload as { data?: { status?: unknown; defaultDatasetId?: string } })?.data;
      const status = data?.status;
      // Shape drift (the field renamed, or missing entirely) must not silently burn all
      // maxPolls polls and then blame "did not finish" on a run that may have completed —
      // and been billed in full — minutes ago.
      if (typeof status !== 'string') {
        throw new Error(`Apify actor-run ${runId} response is missing a string status field`);
      }
      if (TERMINAL.has(status)) {
        if (status !== 'SUCCEEDED') throw new Error(`Apify run ${runId} ${status}`);
        return data?.defaultDatasetId ?? fallbackDatasetId;
      }
      // Any other string — including a status value Apify adds later that isn't in TERMINAL —
      // is treated as "still running", for forward compatibility.
    }
    // Deliberately does not abort the run: it may still be doing billable work, and a second
    // sweep would pay for it again. The next pass reaches these profiles via their unchanged
    // last_swept_at, and INSERT OR IGNORE makes any overlap free.
    throw new Error(`Apify run ${runId} did not finish within ${this.maxPolls} polls`);
  }

  private async readDataset(
    datasetId: string, deadline: number, expectedMaxItems: number,
  ): Promise<ApifyPost[]> {
    const out: ApifyPost[] = [];
    // Tied to the same maxItems ceiling we asked Apify to bill against, so a pagination bug
    // (offset ignored, param renamed) that keeps returning full pages throws instead of
    // paging — and eventually OOM-ing — forever. +2 pages of slack: one for the terminating
    // empty page, one because skipHidden-style filtering can shave a page down without that
    // meaning the dataset actually ended.
    const maxPages = Math.max(1, Math.ceil(expectedMaxItems / PAGE_SIZE)) + 2;
    let pages = 0;
    for (let offset = 0; ; offset += PAGE_SIZE) {
      if (Date.now() > deadline) {
        throw new Error(`Apify dataset ${datasetId} read exceeded the ${this.maxRunMs}ms run budget`);
      }
      if (pages++ >= maxPages) {
        throw new Error(`Apify dataset ${datasetId} pagination did not terminate after ${maxPages} pages`);
      }
      // skipHidden strips `#`-prefixed fields (none of which this client reads) without
      // filtering rows out of the page. skipEmpty (the other half of `clean=true`) does the
      // latter, which is exactly what makes a page look shorter than PAGE_SIZE without the
      // dataset having ended — so it is deliberately left off.
      const path = `/v2/datasets/${datasetId}/items`
        + `?skipHidden=true&format=json&limit=${PAGE_SIZE}&offset=${offset}`;
      const { body: page, headers } = await this.requestWithRetry(
        path, { method: 'GET', headers: { Accept: 'application/json' } }, `dataset page (offset=${offset})`,
      );
      if (!Array.isArray(page)) {
        const preview = JSON.stringify(page)?.slice(0, 200);
        throw new Error(
          `Apify dataset ${datasetId} returned an unexpected shape (${typeof page}) instead of an array: ${preview}`,
        );
      }
      out.push(...(page as ApifyPost[]));
      // An empty page is the only fully reliable "no more items" signal — a short-but-nonempty
      // page can happen when filtering shaves rows out of a slice that isn't actually last.
      if (page.length === 0) return out;
      // When Apify reports the authoritative total, trust it instead of waiting for an empty
      // page: it ends pagination one request earlier and isn't subject to the ambiguity above.
      const total = headers?.get?.('X-Apify-Pagination-Total');
      if (total != null && offset + page.length >= Number(total)) return out;
    }
  }

  /** Retry wrapper for idempotent GETs only (poll, dataset page) — see the module doc comment. */
  private async requestWithRetry(path: string, init: RequestInit, label: string): Promise<ApifyResult> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < this.retryAttempts; attempt++) {
      if (attempt > 0) await this.sleep(this.retryBackoffMs);
      try {
        return await this.request(path, init, label);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  }

  /**
   * One HTTP call. The token travels in the query string and MUST NEVER reach an error
   * message: those land in data/relay.log, which the operator downloads and shares when
   * troubleshooting. So every throw below names the label/path/status/body, never the URL.
   */
  private async request(path: string, init: RequestInit, label: string): Promise<ApifyResult> {
    const sep = path.includes('?') ? '&' : '?';
    const url = `https://api.apify.com${path}${sep}token=${encodeURIComponent(this.token)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (e) {
      const err = e as (Error & { cause?: { message?: string } });
      if (err?.name === 'AbortError') {
        throw new Error(`Apify ${label} timed out client-side after ${this.timeoutMs}ms (path ${path})`);
      }
      // A raw transport failure (DNS, connection refused/reset, TLS) is an error we did not
      // construct. Node/undici's own message and cause are already token-free (verified: they
      // report reason/host, never a full request URL for these failure modes) — wrap rather
      // than rethrow raw so the label/path give the operator context Node's message lacks.
      const cause = err?.cause?.message;
      throw new Error(
        `Apify ${label} transport failure at ${path}: ${err?.message ?? String(e)}`
        + (cause ? ` (${cause})` : ''),
      );
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      // Reading the body releases the connection instead of leaving it to GC, and — more
      // importantly — Apify's own error body distinguishes cases an opaque status can't: it
      // returns HTTP 403 for both a bad API key and a spent monthly usage cap, and only the
      // body says which. The body carries no token (the token is only ever in our own URL).
      let bodyText = '';
      try { bodyText = await res.text(); } catch { /* unreadable body; fall back to status only */ }
      throw new Error(
        `Apify ${label} failed (HTTP ${res.status}) at ${path}` + (bodyText ? `: ${bodyText}` : ''),
      );
    }
    const body = await res.json();
    return { body, headers: res.headers };
  }
}
