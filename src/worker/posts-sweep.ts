/**
 * One posts-sweep pass: derive each profile's window, run the actor, store what comes back,
 * then prune.
 *
 * Shape borrowed from runRosterSync (slot-gated by the caller, stamps only on a clean pass)
 * and runEnrichment (injected Apify client, halt latch). Like enrichment, this never touches
 * the LinkedIn browser session — so no guardrail, no pacing, no browser mutex.
 */
import type { Repos } from '../db/repositories.js';
import type { ApifyPostsClient, PostedWindow } from '../core/apify-posts-client.js';
import {
  isApifyAuthFailure, isApifyOfflineFailure, isApifyAmbiguousNetworkFailure,
} from '../core/apify-posts-client.js';
import { probeOnline } from '../core/offline.js';
import { attribute } from '../core/apify-posts-extract.js';
import { normalizeProfileUrl } from '../core/url.js';
import { log } from '../core/log.js';

/** The exact shape `toISOString()` produces, and the one `schema.sql` GLOBs on `last_swept_at`.
 *  Stated here too because this module forwards that column to a paid actor as its run bound —
 *  see windowFor. Same shape apify-posts-extract.ts pins for `posted_at`. */
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** One run at a time per process. A sweep can outlast the 30-minute tick interval. */
let running = false;
export function isPostsSweepRunning(): boolean { return running; }

export interface PostsSweepOptions {
  client: ApifyPostsClient;
  now?: Date;
  maxPosts: number;
  batchSize: number;
  /** Overrides `settings.posts_retention_days` when given. Only a caller that already knows
   *  better than settings should pass it; production leaves it unset so an operator's edit
   *  takes effect on the next pass. */
  retentionDays?: number;
  /** Connectivity check used to disambiguate a network-shaped run failure — offline forgives,
   *  online counts. Injected by tests; production leaves it unset and gets a DNS lookup of
   *  api.apify.com, the host the failed request actually needed. */
  probe?: () => Promise<boolean>;
}

export interface PostsSweepResult {
  /** Actor runs ATTEMPTED, including any that failed — one per batch per window. Attempted
   *  rather than succeeded because this is the number that tracks what Apify was asked to
   *  bill for; `profilesSwept` is the one that says what came back usable. */
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
  /** Bare reshares — the profile passed on someone else's post without adding words of their
   *  own. Out of scope by decision, and ~31% of real payloads, so this is normally the
   *  largest number in the result. Counted apart from `unusable` because it is a scope
   *  decision, not a property of the text: these items DO carry content, it just belongs to
   *  the original author. See `isBareReshare`. */
  reshares: number;
  pruned: number;
  /** Batches that failed because THIS MACHINE was offline (DNS dead, no route — the closed-
   *  laptop signature), not because Apify failed a run. Counted apart because these are
   *  exempt from the run_failed halt: the start POST never reached Apify, so nothing was
   *  billed and there is nothing for that latch to contain — the failure heals itself the
   *  moment the machine is back online. Between 2026-08-07 and 2026-08-16 every run_failed
   *  halt in the log was one of these. */
  offlineFailures: number;
  /** True when every run succeeded. Only a clean pass stamps posts_swept_at. */
  clean: boolean;
}

/**
 * Which window this profile's run asks for. THE cost decision, and what replaced a separate
 * backfill mechanism.
 *
 * A previously-swept profile is bounded by its own `last_swept_at`: "posts from now back to
 * this instant", exactly. No gap, no over-fetch, and no dependence on when the tick fires.
 *
 * WHY NOT AN ELAPSED-TIME THRESHOLD, which is what this originally did
 * (`age <= 24h → postedLimit: '24h'`, else `'week'`) — the trap is worth stating because it
 * looks correct and its test passed:
 *
 *  - The sweep's CADENCE is also a day. `daySlot(now, 1)` keys on the local calendar date, so
 *    a pass fires on the first 30-minute tick after midnight and consecutive passes land
 *    24h **+ δ** apart, δ > 0 essentially always (stable tick phase, plus the pass runs
 *    synchronously inside the tick). So `age > 24h` nearly always held, `'week'` became the
 *    steady state, and the design's own twentyfold cost gap — $1.60/mo against $36/mo — landed
 *    on the wrong side. Comparing an elapsed-time threshold against a cadence of the same
 *    nominal length means the answer is decided by drift, and drift only goes one way.
 *  - A tolerance (`age <= 24h + one tick`) fixes the cost and silently LOSES posts instead:
 *    `postedLimit` is relative to *run* time, so the δ sliver between the last sweep and
 *    24h-before-now is fetched by neither pass. Small per day, permanent, invisible.
 *
 * `postedLimit: 'week'` survives only where there is no instant to bound against — a
 * never-swept profile's first look — and as the fallback for a `last_swept_at` that cannot be
 * read as an instant, since sending garbage as a date would bound the run on nothing. Both are
 * a BOUNDED first look, not a cost risk: the bill for any run is capped server-side by
 * `maxItems = urls.length * maxPosts` regardless of how wide the window is, so a long
 * downtime cannot turn into an unbounded catch-up bill. That is also why no staleness ceiling
 * is applied to `postedLimitDate`.
 */
export function windowFor(lastSweptAt: string | null, now: Date): PostedWindow {
  if (lastSweptAt === null) return { postedLimit: 'week' };
  // Shape-gated, not merely Date-parseable, because this string is forwarded VERBATIM to a paid
  // actor as its run bound. `new Date` accepts plenty of shapes that would bound the run on
  // something other than what we mean: '2026-08-04 09:00:00' and '2026-08-04T09:00:00' carry no
  // zone, so we read them as LOCAL for the age check below while the actor reads them in ITS
  // zone — a silent multi-hour gap for any operator who isn't on UTC — and '2026-08-04' silently
  // means midnight. markSwept only ever writes toISOString(), and schema.sql now GLOBs this same
  // shape, so a value failing here is already a corrupted row; the bounded look is the safe
  // answer for it rather than a window derived from a string we cannot interpret.
  if (!ISO_MS.test(lastSweptAt)) return { postedLimit: 'week' };
  const age = now.getTime() - new Date(lastSweptAt).getTime();
  // The shape check does NOT subsume this: ISO_MS admits impossible dates ('2026-13-45T...'),
  // which parse to NaN. `age < 0` catches a stamp in the future, which cannot bound a run either.
  if (!Number.isFinite(age) || age < 0) return { postedLimit: 'week' };
  return { postedLimitDate: lastSweptAt };
}

/** The grouping key for a window: profiles sharing one can share a single run. */
function windowKey(w: PostedWindow): string {
  return w.postedLimitDate !== undefined ? `date:${w.postedLimitDate}` : `limit:${w.postedLimit}`;
}

/** For logs and errors — the whole point is that the two forms stay distinguishable. */
function windowLabel(w: PostedWindow): string {
  return w.postedLimitDate !== undefined ? `since ${w.postedLimitDate}` : `last ${w.postedLimit}`;
}

/** Split into chunks of at most `size`. `size` must already be a positive integer — see the
 *  batch-size guard in runPostsSweep, which is where a bad value is caught and reported. */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function runPostsSweep(repos: Repos, opts: PostsSweepOptions): Promise<PostsSweepResult> {
  // Refuse re-entry instead of letting two passes overlap. Two concurrent sweeps bill twice for
  // the same profiles, and it is worse than the double bill: whichever finishes first would
  // clear `running` in its finally while the other is still going, so isPostsSweepRunning()
  // starts lying and the API's own 409 guard silently stops working. Thrown rather than returned
  // as an empty result so a caller can tell "refused" from "swept nothing" — the manual
  // sweep-now route turns this into a 409, and the scheduled tick's guard means it never
  // arrives here. Checked BEFORE the flag is taken and outside the try, so the refused call
  // cannot run the finally that belongs to the pass that owns the flag.
  if (running) throw new Error('a posts sweep is already running');

  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const result: PostsSweepResult = {
    runs: 0, profilesSwept: 0, postsAdded: 0, postsRejected: 0, unattributed: 0,
    unusable: 0, reshares: 0, pruned: 0, offlineFailures: 0, clean: true,
  };
  const probe = opts.probe ?? (() => probeOnline(3000, 'api.apify.com'));

  // `batchSize` comes from operator-editable settings, and a settings write is not
  // type-checked — the same hazard PostRepo.prune refuses `days` for. Validated HERE, once, so
  // chunk() can take a positive integer as a precondition: a non-finite step makes `i += size`
  // exit that loop after producing ONE EMPTY batch, and the pass then fetches nothing, marks
  // nobody swept, and still stamps itself CLEAN — a sweep that silently stops working, with
  // only "profiles: 0" in the log to say so. Falling back to a single batch is safe on cost:
  // batching decides how many runs a window takes, never the bill, which is per post returned.
  // (Unlike `maxPosts`, where 0 means "all posts" and the client rightly throws, a 0 here has
  // no cost consequence at all, so it is reported and corrected rather than refused — this
  // runs inside a scheduler tick, where a throw is the more disruptive answer.)
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

    // Read BEFORE this pass writes anything: "every active profile was already carrying an
    // error" is the evidence that the previous pass failed too, which is what turns a single
    // bad pass into a latched halt below. Derived from the rows rather than a module counter so
    // it survives a restart and cannot leak between tests.
    const allPreviouslyErrored = profiles.length > 0
      && profiles.every((p) => p.last_sweep_error !== null);

    // Group by window, so each window costs exactly one run per batch rather than one per
    // profile. Keys are normalized the same way attribute() normalizes what comes back.
    //
    // Grouping stays coarse in the steady state even though the key is now a timestamp:
    // markSwept stamps every profile in a pass with the SAME nowIso, so profiles swept
    // together share an identical last_swept_at and fall into one group. Only a profile that
    // failed (and so kept its older stamp) splits off, and it rejoins the moment it succeeds.
    const groups = new Map<string, { window: PostedWindow; members: { url: string; id: number }[] }>();
    const seenUrls = new Map<string, number>();
    for (const p of profiles) {
      const key = normalizeProfileUrl(p.profile_url);
      if (key === null) {
        // Stored un-normalizable: nothing can be attributed back to it, so say so rather
        // than paying for a run whose results would be silently dropped.
        repos.trackedProfiles.markSweepError(p.id, 'profile_url could not be normalized');
        result.clean = false;
        continue;
      }
      // Two rows can normalize to ONE key — `/in/Dana` and `/in/dana/` both survive the
      // UNIQUE constraint, which is case- and slash-sensitive, while normalizeProfileUrl
      // lowercases and strips. Sending the URL twice in one run would double `maxItems` for
      // the same profile and, worse, markSwept BOTH rows with no error, leaving the shadow row
      // permanently empty and permanently healthy-looking. Report the duplicate instead;
      // TrackedProfileRepo.add does no normalizing, so only a route can prevent this upstream.
      const twin = seenUrls.get(key);
      if (twin !== undefined) {
        repos.trackedProfiles.markSweepError(p.id, `duplicate of tracked profile ${twin} after URL normalization`);
        result.clean = false;
        continue;
      }
      seenUrls.set(key, p.id);
      const window = windowFor(p.last_swept_at, now);
      const k = windowKey(window);
      const group = groups.get(k) ?? { window, members: [] };
      group.members.push({ url: key, id: p.id });
      groups.set(k, group);
    }

    // Set when an auth failure latches: every remaining run would fail the same way, so stop
    // issuing them — but fall through to the prune and the stamp below rather than returning,
    // because ageing posts out is the only way a post leaves the New chip and an unusable key
    // is no reason to freeze the feed. See the run_failed guard for the trap this avoids.
    let bailed = false;

    for (const { window, members } of groups.values()) {
      if (bailed) break;
      const label = windowLabel(window);
      for (const batch of chunk(members, batchSize)) {
        const byUrl = new Map(batch.map((m) => [m.url, m.id]));
        result.runs++;
        try {
          const items = await opts.client.fetchPosts(batch.map((m) => m.url),
            { maxPosts: opts.maxPosts, ...window });
          // THREE different causes, reported separately on purpose. `unattributed` means the
          // item matched no tracked profile (an attribution or normalization problem worth
          // investigating); `unusable` means it carried no text anywhere (~9% of real
          // payloads); `reshares` means it was a bare reshare, out of scope by decision (~31%).
          // Folding them together sends whoever debugs a lossy sweep hunting through URL
          // normalization that is working fine — and folding the last two together is what
          // hid a real bug, because a single line reading "carried no text (bare reshares)"
          // read as proof reshares were being skipped while 98.5% of them reached the feed.
          const { rows, unattributed, unusable, reshares } = attribute(items, byUrl);
          result.unattributed += unattributed;
          result.unusable += unusable;
          result.reshares += reshares;
          if (unattributed > 0) {
            log.warn('posts', 'items matched no tracked profile', { count: unattributed, window: label });
          }
          if (reshares > 0) {
            // Expected and routine, hence info not warn. Normally the largest of the three.
            log.info('posts', 'bare reshares skipped — no words of the profile\'s own',
              { count: reshares, window: label });
          }
          if (unusable > 0) {
            log.info('posts', 'items carried no text at all — skipped',
              { count: unusable, window: label });
          }
          // A batch where EVERY returned item was unattributable is not a quiet week — it is
          // the signature of a systematic mismatch between the URLs we send and what the actor
          // echoes back, and it is the only signal available for one. Left as a success it
          // would bill in full, store nothing, mark every profile swept and report the pass
          // healthy — so treat it as a failed batch and let the run_failed latch below stop it
          // if it happens twice. A partial miss stays a warning: that IS a quiet week.
          if (items.length > 0 && unattributed === items.length) {
            throw new Error(
              `all ${items.length} returned items matched no tracked profile — attribution is broken`,
            );
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
            log.warn('posts', 'posts rejected by the schema', { count: stored.rejected, window: label });
          }
          // ONLY this batch's profiles — never `members`. Marking a profile swept that was not
          // in the batch that actually ran advances its last_swept_at, so the next pass bounds
          // its window on a sweep it never received and the posts in between are lost for good.
          for (const m of batch) repos.trackedProfiles.markSwept(m.id, nowIso);
          result.profilesSwept += batch.length;
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          result.clean = false;
          if (isApifyAuthFailure(e)) {
            for (const m of batch) repos.trackedProfiles.markSweepError(m.id, error);
            log.error('posts', 'sweep batch failed', { count: batch.length, window: label, error });
            // Pass Apify's own message through rather than asserting a cause: a 403 means
            // either a bad key or a spent monthly budget, and telling an operator their key
            // is wrong when it isn't sends them down the wrong path.
            repos.appState.haltPosts('auth', `Apify refused the request — ${error}`, nowIso);
            bailed = true;
            break;   // every remaining batch would fail the same way
          }
          // A failure that means OUR network was down is not evidence about Apify, and (for a
          // run that never started) there is nothing billed for the halt to contain — so it is
          // reported but exempted from the run_failed latch: no sweep error is written to the
          // profiles (so it cannot count as "the previous failed pass" next time either), and
          // the pass stays un-clean so the next tick simply retries once the machine is back.
          // Checked AFTER auth: a 401/403 arrived over a working network by definition, and
          // the more specific latch must keep winning. Definitive offline codes forgive
          // outright; ambiguous network shapes (a reset, our own client timeout) ask the
          // probe — offline forgives, online counts, because a timeout on a working network
          // is real evidence of an Apify-side problem.
          if (isApifyOfflineFailure(e) || (isApifyAmbiguousNetworkFailure(e) && !(await probe()))) {
            result.offlineFailures++;
            log.warn('posts', 'sweep batch failed while this machine was offline — not counted toward the halt rule',
              { count: batch.length, window: label, error });
            continue;
          }
          // Only THIS batch's profiles are marked, so the next pass retries them without
          // re-billing everyone else.
          for (const m of batch) repos.trackedProfiles.markSweepError(m.id, error);
          log.error('posts', 'sweep batch failed', { count: batch.length, window: label, error });
        }
      }
    }

    // A pass where every run failed, twice in a row, latches. Without this the tick retries
    // every 30 minutes forever — and a run that starts, bills, then ends FAILED has already
    // been charged, so that is up to 48 billable no-op passes a day with only log lines to show
    // it. `posts_halted` is the same containment runEnrichment reaches for with its
    // consecutive-failure limit, and 'run_failed' exists in PostsHaltReason for exactly this.
    //
    // Deliberately requires TWO passes: one failed pass is ordinary (an Apify blip, a timeout)
    // and must self-heal without an operator. `runs > 0` keeps a no-op pass — no profiles, or
    // all of them un-normalizable — from latching something no run was ever attempted for.
    //
    // `!bailed` is load-bearing, not tidiness. An auth failure very easily satisfies all three
    // conditions below (nothing swept, everyone already carrying last pass's error), and
    // haltPosts would then overwrite reason 'auth' with 'run_failed' — throwing away the
    // passed-through Apify message, which is the whole point of the 401/403 work: it is what
    // distinguishes "monthly usage hard limit exceeded" from "your key is wrong". The more
    // specific latch that already fired must win.
    //
    // Offline failures are subtracted before the runs-attempted check: a pass where every
    // failure was this machine's own dead network says nothing about Apify and billed nothing,
    // so it must neither latch by itself nor complete a latch that a genuinely failed previous
    // pass started. (The previous-pass side is covered by never writing sweep errors for
    // offline failures — see the catch above.)
    const countedRuns = result.runs - result.offlineFailures;
    if (!bailed && countedRuns > 0 && result.profilesSwept === 0 && allPreviouslyErrored) {
      repos.appState.haltPosts(
        'run_failed',
        `Every Apify run failed twice in a row (${countedRuns} this pass). Sweeping is stopped so it `
        + 'does not keep billing for failed runs; check the log, then resume.',
        nowIso,
      );
      log.error('posts', 'halted after consecutive fully-failed passes', { runs: countedRuns });
    }

    // Prune regardless of how the runs went — including the auth bail-out above, which is why
    // that path breaks rather than returning. Ageing out is the only way a post leaves the New
    // chip, and a latched halt stops the tick from calling this worker at all, so returning
    // early there would freeze the feed until an operator fixed the key.
    //
    // Wrapped because a throw here would reject the whole call, losing a result the caller
    // needs — profiles already have their last_swept_at advanced by this point, so the work is
    // done and only the reporting would be lost. `clean` is deliberately NOT cleared: a prune
    // failure is a local DB problem, and re-running the entire Apify sweep on the next tick to
    // retry a DELETE would spend money to fix something that costs nothing to defer to the
    // next pass.
    const retention = opts.retentionDays ?? repos.settings.get().posts_retention_days;
    try {
      result.pruned = repos.posts.prune(retention, now);
    } catch (e) {
      log.error('posts', 'prune failed; the pass itself stands', {
        error: e instanceof Error ? e.message : String(e),
      });
    }

    // Stamped only on a clean pass — the acceptance-checker lesson. A bailed-out pass leaves
    // the stamp untouched so the next tick retries within the same slot.
    if (result.clean) repos.appState.markPostsSwept(nowIso);

    log.info('posts', 'sweep finished', {
      runs: result.runs, profiles: result.profilesSwept, added: result.postsAdded,
      rejected: result.postsRejected, unattributed: result.unattributed,
      unusable: result.unusable, reshares: result.reshares, pruned: result.pruned,
      offline: result.offlineFailures, clean: result.clean,
    });
    return result;
  } finally {
    running = false;
  }
}
