/**
 * One posts-sweep pass: derive each profile's window, run the actor, store what comes back,
 * then prune.
 *
 * Shape borrowed from runRosterSync (slot-gated by the caller, stamps only on a clean pass)
 * and runEnrichment (injected Apify client, halt latch). Like enrichment, this never touches
 * the LinkedIn browser session — so no guardrail, no pacing, no browser mutex.
 */
import type { Repos } from '../db/repositories.js';
import type { ApifyPostsClient, PostedLimit } from '../core/apify-posts-client.js';
import { attribute } from '../core/apify-posts-extract.js';
import { normalizeProfileUrl } from '../core/url.js';
import { log } from '../core/log.js';

const DAY_MS = 86_400_000;

/** One run at a time per process. A sweep can outlast the 30-minute tick interval. */
let running = false;
export function isPostsSweepRunning(): boolean { return running; }

export interface PostsSweepOptions {
  client: ApifyPostsClient;
  now?: Date;
  maxPosts: number;
  batchSize: number;
  retentionDays?: number;
}

export interface PostsSweepResult {
  runs: number;
  profilesSwept: number;
  postsAdded: number;
  /** Posts the schema refused — a malformed posted_at from Apify. Billed but unusable, so
   *  this must be visible rather than swallowed by INSERT OR IGNORE. */
  postsRejected: number;
  /** Matched no tracked profile — an attribution problem worth investigating. */
  unattributed: number;
  /** Carried no text anywhere, so there is nothing to judge. ~9% of real payloads; a
   *  content policy rather than a fault, which is why it is counted separately. */
  unusable: number;
  pruned: number;
  /** True when every run succeeded. Only a clean pass stamps posts_swept_at. */
  clean: boolean;
}

/**
 * Which postedLimit this profile gets.
 *
 * THE cost decision, and the thing that replaced a separate backfill mechanism. A profile
 * swept within the last day only needs the last day — and because billing is per post
 * RETURNED, that is what makes the steady state cheap. A stale or never-swept profile gets a
 * week, which both self-heals downtime and gives a newly-tracked profile immediate content.
 */
export function windowFor(lastSweptAt: string | null, now: Date): PostedLimit {
  if (lastSweptAt === null) return 'week';
  const age = now.getTime() - new Date(lastSweptAt).getTime();
  if (!Number.isFinite(age) || age < 0) return 'week';   // an unparseable stamp is not "fresh"
  return age <= DAY_MS ? '24h' : 'week';
}

/** Split into chunks of at most `size`. */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += Math.max(1, size)) out.push(items.slice(i, i + Math.max(1, size)));
  return out;
}

/**
 * Should this failure latch the halt rather than be retried next tick?
 *
 * 401/403 will not fix themselves on a retry, so both latch. But note 403 is AMBIGUOUS at
 * Apify: it is returned both for a bad key AND for "monthly usage hard limit exceeded"
 * (confirmed in a real 403 body: `{"type":"insufficient-permissions","message":"monthly usage
 * hard limit exceeded"}`). Halting is right either way — neither resolves by retrying — but
 * the REASON shown to the operator must not assert a bad key when the key is fine and the
 * account is simply out of budget. The client surfaces Apify's own message, so pass it through
 * rather than overwriting it with an interpretation.
 */
function isAuthFailure(message: string): boolean {
  return /HTTP 40[13]/.test(message);
}

export async function runPostsSweep(repos: Repos, opts: PostsSweepOptions): Promise<PostsSweepResult> {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const result: PostsSweepResult = {
    runs: 0, profilesSwept: 0, postsAdded: 0, postsRejected: 0, unattributed: 0,
    unusable: 0, pruned: 0, clean: true,
  };

  // `batchSize` comes from operator-editable settings, and a settings write is not
  // type-checked — the same hazard PostRepo.prune refuses `days` for. Guarded here because a
  // non-finite value slipped past chunk()'s `Math.max(1, size)` in the worst possible
  // direction: `i += NaN` makes the loop exit after producing ONE EMPTY batch, so the pass
  // fetched nothing, marked nobody swept, and still stamped itself CLEAN — a sweep that
  // silently stops working, with only "profiles: 0" in the log to say so. Falling back to a
  // single batch is safe on cost: batching decides how many runs a window takes, never the
  // bill, which is per post returned.
  let batchSize = Math.floor(opts.batchSize);
  if (!Number.isFinite(batchSize) || batchSize < 1) {
    log.warn('posts', 'ignoring an out-of-range sweep batch size; using one batch per window', {
      batchSize: opts.batchSize,
    });
    batchSize = Number.MAX_SAFE_INTEGER;
  }

  running = true;
  try {
    const profiles = repos.trackedProfiles.activeProfiles();

    // Group by window, so each window costs exactly one run per batch rather than one per
    // profile. Keys are normalized the same way attribute() normalizes what comes back.
    const groups = new Map<PostedLimit, { url: string; id: number }[]>();
    for (const p of profiles) {
      const key = normalizeProfileUrl(p.profile_url);
      if (key === null) {
        // Stored un-normalizable: nothing can be attributed back to it, so say so rather
        // than paying for a run whose results would be silently dropped.
        repos.trackedProfiles.markSweepError(p.id, 'profile_url could not be normalized');
        result.clean = false;
        continue;
      }
      const w = windowFor(p.last_swept_at, now);
      const list = groups.get(w) ?? [];
      list.push({ url: key, id: p.id });
      groups.set(w, list);
    }

    for (const [postedLimit, members] of groups) {
      for (const batch of chunk(members, batchSize)) {
        const byUrl = new Map(batch.map((m) => [m.url, m.id]));
        result.runs++;
        try {
          const items = await opts.client.fetchPosts(batch.map((m) => m.url),
            { maxPosts: opts.maxPosts, postedLimit });
          // Two DIFFERENT causes, reported separately on purpose: `unattributed` means the
          // item matched no tracked profile (an attribution or normalization problem worth
          // investigating), while `unusable` means it carried no text anywhere (a content
          // policy, ~9% of real payloads). Folding them together sends whoever debugs a
          // lossy sweep hunting through URL normalization that is working fine.
          const { rows, unattributed, unusable } = attribute(items, byUrl);
          result.unattributed += unattributed;
          result.unusable += unusable;
          if (unattributed > 0) {
            log.warn('posts', 'items matched no tracked profile', { count: unattributed, postedLimit });
          }
          if (unusable > 0) {
            // Expected and routine, hence info not warn: this is mostly bare reshares, which
            // are deliberately out of scope. A large number here is normal, not a fault.
            log.info('posts', 'items carried no text of the profile\'s own (bare reshares) — skipped',
              { count: unusable, postedLimit });
          }
          // upsertMany returns { added, rejected }: `rejected` is a post the CHECK constraints
          // refused (a malformed posted_at from Apify), which OR IGNORE would otherwise
          // discard indistinguishably from a duplicate — and we would re-bill for it every
          // sweep, forever, with nothing to show the operator.
          //
          // Do NOT wrap this call in a transaction of your own: upsertMany opens its own
          // unconditionally, and SQLite refuses a nested BEGIN ("cannot start a transaction
          // within a transaction"). Same constraint as ConnectionRepo.upsertMany.
          const stored = repos.posts.upsertMany(rows, nowIso);
          result.postsAdded += stored.added;
          result.postsRejected += stored.rejected;
          if (stored.rejected > 0) {
            log.warn('posts', 'posts rejected by the schema', { count: stored.rejected, postedLimit });
          }
          for (const m of batch) repos.trackedProfiles.markSwept(m.id, nowIso);
          result.profilesSwept += batch.length;
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          result.clean = false;
          // Only THIS batch's profiles are marked, so the next pass retries them without
          // re-billing everyone else.
          for (const m of batch) repos.trackedProfiles.markSweepError(m.id, error);
          log.error('posts', 'sweep batch failed', { count: batch.length, postedLimit, error });
          if (isAuthFailure(error)) {
            // Pass Apify's own message through rather than asserting a cause: a 403 means
            // either a bad key or a spent monthly budget, and telling an operator their key
            // is wrong when it isn't sends them down the wrong path.
            repos.appState.haltPosts('auth', `Apify refused the request — ${error}`, nowIso);
            return result;   // every remaining batch would fail the same way
          }
        }
      }
    }

    // Prune regardless of whether the runs succeeded: ageing out is the only way a post
    // leaves the New chip, and a failed Apify call is no reason to let the feed grow forever.
    const retention = opts.retentionDays ?? repos.settings.get().posts_retention_days;
    result.pruned = repos.posts.prune(retention, now);

    // Stamped only on a clean pass — the acceptance-checker lesson. A bailed-out pass leaves
    // the stamp untouched so the next tick retries within the same slot.
    if (result.clean) repos.appState.markPostsSwept(nowIso);

    log.info('posts', 'sweep finished', {
      runs: result.runs, profiles: result.profilesSwept, added: result.postsAdded,
      rejected: result.postsRejected, pruned: result.pruned, clean: result.clean,
    });
    return result;
  } finally {
    running = false;
  }
}
