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
 *  4. A wall-clock `maxRunMs` deadline is checked at the top of every iteration of BOTH the
 *     poll loop and the dataset-paging loop. That keeps both loops within roughly one retry
 *     cycle of the stated budget — a check at the top of a loop can't preempt a retry cycle
 *     already under way inside that iteration — not exactly bounded by it.
 *  5. Dataset paging carries a generous absolute page cap that is NOT derived from `maxItems`
 *     (that's a billing ceiling Apify explicitly does not use to bound dataset size — see
 *     readDataset). Hitting it logs loudly and returns what was already read rather than
 *     throwing: that data is already paid for, and discarding it only guarantees paying for
 *     it again on the next sweep.
 *
 * TOKEN SAFETY: the token travels only in the query string this client itself constructs
 * (never in a `path`, which every error message is free to include). Response bodies and
 * transport-error text come from outside this process — an untrusted proxy or gateway can
 * echo a request URI back in its own error page — so anything built from them is passed
 * through `redact()` before it can reach an Error message and, from there, data/relay.log.
 */
import type { ApifyPost } from '../types.js';
import { log } from './log.js';

const ACTOR_ID = 'harvestapi~linkedin-profile-posts';
// Matches the component tag posts-repos.ts already uses for this feature.
const LOG_COMPONENT = 'posts';

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
// A generous ABSOLUTE guard against a broken pagination loop, not a size prediction — see the
// class doc comment and readDataset for why this must not be derived from maxItems.
const DEFAULT_MAX_DATASET_PAGES = 64;
// Longest error body we'll fold into a thrown message. `preview` (the non-array-shape case)
// already capped at 200; this keeps a verbose gateway/HTML error page from doing the same
// thing at 10x the size.
const MAX_ERROR_BODY_CHARS = 500;

export type PostedLimit = '24h' | 'week' | 'month';

/**
 * THE cost control, and exactly one of the two forms must be sent.
 *
 * `INSERT OR IGNORE` dedupes storage but never the bill, so a window wider than the gap since
 * the last sweep re-bills posts already stored. The two forms exist because they answer
 * different questions:
 *
 *  - `postedLimitDate` — "posts from now back to this instant", exact. What a
 *    previously-swept profile gets, keyed off its own `last_swept_at`.
 *  - `postedLimit` — a fixed RELATIVE window, computed by the actor at *run* time. Only safe
 *    where there is no instant to bound against, i.e. a never-swept profile's first look.
 *
 * Modelled as a union so sending both is a compile error, not a judgement call: the actor's
 * behaviour with both set is unspecified, and either one silently losing to the other is a
 * gap or an over-bill with nothing to show which. `assertExactlyOneWindow` covers the
 * untyped-caller boundary.
 */
export type PostedWindow =
  | { postedLimit: PostedLimit; postedLimitDate?: never }
  | { postedLimitDate: string; postedLimit?: never };

export type FetchPostsOptions = {
  /** Per profile, not per run. Must be a positive integer — see the class doc comment. */
  maxPosts: number;
} & PostedWindow;

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
  /** Absolute page-count guard for dataset reads. See DEFAULT_MAX_DATASET_PAGES. */
  maxDatasetPages?: number;
}

// Apify's actual run-status enum uses hyphens only (e.g. `TIMED-OUT`); there is no
// underscore variant, so don't add one back in even though it looks like a natural alias.
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT']);

interface ApifyResult {
  body: unknown;
  headers: Headers | undefined;
}

function isRetryableHttpStatus(status: number): boolean {
  // 429 (rate limited) and 5xx (server/gateway trouble) are characteristically transient.
  // Everything else (400/401/403/404/...) will not resolve itself by waiting.
  return status === 429 || status >= 500;
}

/**
 * Thrown by request() so callers can tell a transient failure (worth another poll, or another
 * retry attempt) from a permanent one (bad auth, not found, bad request — retrying only delays
 * the inevitable, and on a poll would delay the sweep worker's auth-failure latch for nothing).
 */
export class ApifyRequestError extends Error {
  /**
   * `transport` is true only when NO HTTP response arrived at all — the fetch itself threw
   * (DNS, connection, TLS) or our own client-side timeout fired. It is set where the error is
   * constructed, from facts about the failure, never inferred from message text: an HTTP-level
   * failure's message embeds up to MAX_ERROR_BODY_CHARS of untrusted upstream body, and a
   * gateway page that merely QUOTES "ENOTFOUND" must not be able to impersonate an offline
   * laptop. See isApifyOfflineFailure for who reads it and why.
   */
  constructor(
    message: string,
    public readonly status: number | undefined,
    public readonly retryable: boolean,
    public readonly transport: boolean = false,
  ) {
    super(message);
    this.name = 'ApifyRequestError';
  }
}

/**
 * Node error codes that can ONLY mean this machine cannot reach the network — DNS dead or
 * suspended (the closed-laptop signature), no route, or nothing listening where the OS looked.
 * A live-and-misbehaving Apify cannot produce any of these; they mean the request never got
 * anywhere near being billed. Deliberately NOT included: ECONNRESET / ETIMEDOUT / EPIPE, which
 * a working network can also produce mid-exchange — those stay ambiguous and need the
 * connectivity probe to disambiguate (isApifyAmbiguousNetworkFailure).
 *
 * Matched against the TRANSPORT error's message only (see the `transport` gate), which is
 * Node/undici's own text plus the cause we folded in — never an upstream response body.
 */
const OFFLINE_CODE_RE = /\b(ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ENETDOWN|ECONNREFUSED)\b/;

/**
 * Did this failure definitively happen on OUR side of the wire — an offline machine, not a
 * broken Apify? Same duck-typing rationale as isApifyAuthFailure: holds across a module
 * boundary and for any caller modelling the same shape. The `transport === true` gate is the
 * load-bearing part — it structurally excludes every message that could carry upstream body
 * text, so this is a regex over OUR OWN transport diagnostics, not over untrusted input.
 */
export function isApifyOfflineFailure(err: unknown): boolean {
  const e = err as { transport?: unknown; message?: unknown } | null | undefined;
  return e?.transport === true && typeof e?.message === 'string' && OFFLINE_CODE_RE.test(e.message);
}

/**
 * Network-shaped but not definitive: no HTTP response arrived, yet the cause (a reset, a
 * client-side timeout) is one a working network could also produce. The caller should probe
 * connectivity to decide — offline forgives, online counts as real evidence.
 */
export function isApifyAmbiguousNetworkFailure(err: unknown): boolean {
  const e = err as { transport?: unknown } | null | undefined;
  return e?.transport === true && !isApifyOfflineFailure(err);
}

/**
 * Is this an auth refusal — the one failure class a caller should latch off rather than retry?
 *
 * STRUCTURAL, on `status`, and deliberately not a regex over the message. The message now
 * embeds up to `MAX_ERROR_BODY_CHARS` of untrusted upstream body, so a gateway or WAF error
 * page that merely quotes the string "HTTP 401" inside a 502 would match a textual test and
 * latch automatic sweeping off over a transient blip — a silent stop, which is the failure
 * class this feature keeps working to eliminate.
 *
 * Duck-typed on the property rather than `instanceof`, so it still holds across a module
 * boundary and for any caller that models the same shape.
 *
 * 401 and 403 both qualify, but note 403 is AMBIGUOUS at Apify: it is returned for a bad key
 * AND for "monthly usage hard limit exceeded". Latching is right either way; naming the cause
 * is not, which is why the message is passed through rather than interpreted.
 */
export function isApifyAuthFailure(err: unknown): boolean {
  const status = (err as { status?: unknown } | null | undefined)?.status;
  return status === 401 || status === 403;
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
  private readonly maxDatasetPages: number;

  constructor(private readonly token: string, opts: HttpApifyPostsClientOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
    this.maxPolls = opts.maxPolls ?? DEFAULT_MAX_POLLS;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRunMs = opts.maxRunMs ?? DEFAULT_MAX_RUN_MS;
    this.retryAttempts = opts.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS;
    this.retryBackoffMs = opts.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
    this.maxDatasetPages = opts.maxDatasetPages ?? DEFAULT_MAX_DATASET_PAGES;
  }

  async fetchPosts(urls: string[], opts: FetchPostsOptions): Promise<ApifyPost[]> {
    // Guarded here rather than at the call site: an empty targetUrls array is a billable run
    // that can only return nothing.
    if (urls.length === 0) return [];
    this.assertValidMaxPosts(opts.maxPosts);
    this.assertExactlyOneWindow(opts);
    const deadline = Date.now() + this.maxRunMs;
    const { runId, datasetId } = await this.startRun(urls, opts);
    const finalDatasetId = await this.awaitRun(runId, datasetId, deadline);
    return this.readDataset(finalDatasetId, deadline);
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

  /**
   * Exactly one window form, enforced at runtime as well as in the type.
   *
   * The union makes both-at-once a compile error, but this client is also reachable from
   * untyped JS and from a settings-derived object, and BOTH failure directions are silent and
   * expensive: with neither field the actor applies its own default window (an unbounded
   * over-fetch, billed per post), and with both its precedence is unspecified, so a gap or an
   * over-bill would be indistinguishable from a correct run. Throwing here costs one unstarted
   * run; guessing costs money on every sweep, forever.
   */
  private assertExactlyOneWindow(opts: FetchPostsOptions): void {
    const hasLimit = opts.postedLimit !== undefined;
    const hasDate = opts.postedLimitDate !== undefined;
    if (hasLimit === hasDate) {
      throw new Error(
        'fetchPosts needs exactly one of postedLimit or postedLimitDate '
        + `(got ${hasLimit ? 'both' : 'neither'})`,
      );
    }
  }

  private async startRun(
    urls: string[], opts: FetchPostsOptions,
  ): Promise<{ runId: string; datasetId: string }> {
    const body = {
      targetUrls: urls,
      maxPosts: opts.maxPosts,
      // Spread so exactly ONE of the two ever appears in the input at all. Setting the other
      // to `undefined` would be equivalent today (JSON.stringify drops undefined values) but
      // relies on that staying true of however this body is serialized later.
      ...(opts.postedLimitDate !== undefined
        ? { postedLimitDate: opts.postedLimitDate }
        : { postedLimit: opts.postedLimit }),
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
    let lastPollError: unknown;
    for (let i = 0; i < this.maxPolls; i++) {
      if (Date.now() > deadline) {
        throw new Error(`Apify run ${runId} exceeded the ${this.maxRunMs}ms run budget while polling`);
      }
      // Guarded by i > 0 so the first poll happens immediately after run-start (no need to
      // wait before the very first check) and the loop never sleeps once more right before
      // giving up on the last iteration.
      if (i > 0) await this.sleep(this.pollMs);

      let payload: unknown;
      try {
        ({ body: payload } = await this.requestWithRetry(
          `/v2/actor-runs/${runId}`, { method: 'GET', headers: { Accept: 'application/json' } }, 'poll',
        ));
      } catch (e) {
        // A retryable failure (5xx, network blip, our own client-side timeout) shouldn't be
        // fatal to a loop that may still have most of its poll/time budget left — treat it
        // like a non-terminal status and let maxPolls/deadline keep bounding us. A
        // non-retryable failure (401/403/404) will never resolve, so fail fast instead of
        // spending the rest of the budget re-asking the same question.
        if (e instanceof ApifyRequestError && e.retryable) {
          lastPollError = e;
          continue;
        }
        throw e;
      }

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
    const detail = lastPollError instanceof Error ? `; last poll error: ${lastPollError.message}` : '';
    throw new Error(`Apify run ${runId} did not finish within ${this.maxPolls} polls${detail}`);
  }

  private async readDataset(datasetId: string, deadline: number): Promise<ApifyPost[]> {
    const out: ApifyPost[] = [];
    let pages = 0;
    for (let offset = 0; ; offset += PAGE_SIZE) {
      if (Date.now() > deadline) {
        throw new Error(`Apify dataset ${datasetId} read exceeded the ${this.maxRunMs}ms run budget`);
      }
      if (pages++ >= this.maxDatasetPages) {
        // NOT derived from maxItems: Apify's docs are explicit that maxItems bounds what we
        // are CHARGED for, not what the dataset holds, so deriving a page cap from it would
        // throw away a legitimately large, already-paid-for result. This is a generous
        // absolute guard against a broken pagination loop (offset ignored, param renamed)
        // instead. Returning what was read — rather than throwing — matters because that
        // data is already paid for: discarding it only guarantees paying for it again when
        // the next sweep re-fetches these profiles.
        log.error(LOG_COMPONENT, 'dataset pagination hit the absolute page cap; returning partial data', {
          datasetId, pages, itemsRead: out.length,
        });
        return out;
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
        const preview = this.redact(JSON.stringify(page) ?? 'undefined').slice(0, 200);
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
      // A present-but-empty/unparseable header must NOT be treated as "total 0" (Number('')
      // is 0), which would truncate the whole dataset after the first page.
      const total = Number(headers?.get?.('X-Apify-Pagination-Total'));
      if (Number.isFinite(total) && total > 0 && offset + page.length >= total) return out;
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
        // Non-retryable (permanent) failures get no benefit from another attempt — stop now
        // rather than spending retryAttempts x retryBackoffMs finding out again.
        if (!(e instanceof ApifyRequestError) || !e.retryable) throw e;
      }
    }
    throw lastErr;
  }

  /** Untrusted upstream text (a response body, or a transport error's own message) may echo
   *  our request URI — which carries the token — back at us, e.g. a WAF or gateway error page
   *  quoting "the request to <url> failed". Strip both the raw and URL-encoded token forms. */
  private redact(s: string): string {
    if (!this.token) return s;
    let out = s.split(this.token).join('[token redacted]');
    const encoded = encodeURIComponent(this.token);
    if (encoded !== this.token) out = out.split(encoded).join('[token redacted]');
    return out;
  }

  /**
   * One HTTP call. The token travels in the query string and MUST NEVER reach an error
   * message: those land in data/relay.log, which the operator downloads and shares when
   * troubleshooting. Every throw below is built from the label/path/status (always
   * token-free by construction) plus redact()ed upstream text — never the URL itself.
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
      const err = e as (Error & { cause?: { message?: string; code?: string } });
      if (err?.name === 'AbortError') {
        // Our own client-side timeout: the server may just be slow, not down, so worth
        // another poll/attempt. `transport: true` because no response arrived — but the
        // message carries no error code, so it classifies as AMBIGUOUS (a dead network and a
        // slow Apify look identical from here) and the sweep's probe decides which it was.
        throw new ApifyRequestError(
          `Apify ${label} timed out client-side after ${this.timeoutMs}ms (path ${path})`,
          undefined, true, true,
        );
      }
      // A raw transport failure (DNS, connection refused/reset, TLS) is an error we did not
      // construct. Node/undici's own message and cause were verified token-free for DNS
      // failure and abort (they report reason/host, never a full request URL) — redact()ed
      // anyway as defense in depth against a fetch polyfill or proxy that behaves differently.
      // Some transport causes (undici's AggregateError for a refused connection) carry their
      // error code on `code` with an empty `message` — fold whichever says something, so the
      // offline classifier above has the code to look at.
      const cause = [err?.cause?.code, err?.cause?.message].filter(Boolean).join(' ');
      throw new ApifyRequestError(
        this.redact(
          `Apify ${label} transport failure at ${path}: ${err?.message ?? String(e)}`
          + (cause ? ` (${cause})` : ''),
        ),
        undefined, true, true,
      );
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      // Reading the body releases the connection instead of leaving it to GC, and — more
      // importantly — Apify's own error body distinguishes cases an opaque status can't: it
      // returns HTTP 403 for both a bad API key and a spent monthly usage cap, and only the
      // body says which. The body is untrusted upstream text, though — a proxy/WAF/gateway
      // page can echo our request URI (token included) back at us — so it is redact()ed and
      // length-capped before it can reach an Error message.
      let bodyText = '';
      try { bodyText = await res.text(); } catch { /* unreadable body; fall back to status only */ }
      bodyText = this.redact(bodyText).slice(0, MAX_ERROR_BODY_CHARS);
      throw new ApifyRequestError(
        `Apify ${label} failed (HTTP ${res.status}) at ${path}` + (bodyText ? `: ${bodyText}` : ''),
        res.status, isRetryableHttpStatus(res.status),
      );
    }
    const body = await res.json();
    return { body, headers: res.headers };
  }
}
