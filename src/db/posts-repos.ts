/**
 * Repositories for the Posts feed.
 *
 * Both live in one file for the same reason event-repos.ts groups four: repositories.ts is
 * already long, and these two always change together.
 */
import type { DB } from './database.js';
import type { FeedPost, Post, PostFilter, PostInput, TrackedProfile } from '../types.js';
import { log } from '../core/log.js';

export class TrackedProfileRepo {
  constructor(private db: DB) {}

  /**
   * Insert, or return (and REACTIVATE) the row that already holds this URL.
   *
   * Reactivating rather than refusing is what makes untracking safe: `active = 0` is a soft
   * delete, so re-adding someone you removed must resurrect their row instead of colliding
   * with the UNIQUE constraint. Idempotent, mirroring ProfileRepo.add.
   */
  add(profileUrl: string, connectionId: number | null, source: 'search' | 'urls'): TrackedProfile {
    const existing = this.findByUrl(profileUrl);
    if (existing) {
      if (existing.active !== 1) {
        this.db.prepare('UPDATE tracked_profiles SET active = 1 WHERE id = ?').run(existing.id);
      }
      // A later add may know the connection the first one did not. Never unset it.
      if (connectionId !== null && existing.connection_id === null) {
        this.db.prepare('UPDATE tracked_profiles SET connection_id = ? WHERE id = ?')
          .run(connectionId, existing.id);
      }
      return this.findById(existing.id)!;
    }
    this.db.prepare(
      'INSERT INTO tracked_profiles (profile_url, connection_id, source) VALUES (?, ?, ?)',
    ).run(profileUrl, connectionId, source);
    return this.findByUrl(profileUrl)!;
  }

  findById(id: number): TrackedProfile | undefined {
    return this.db.prepare('SELECT * FROM tracked_profiles WHERE id = ?')
      .get(id) as unknown as TrackedProfile | undefined;
  }

  findByUrl(profileUrl: string): TrackedProfile | undefined {
    return this.db.prepare('SELECT * FROM tracked_profiles WHERE profile_url = ?')
      .get(profileUrl) as unknown as TrackedProfile | undefined;
  }

  /** Untrack. Soft, so posts keep a valid parent and history survives. */
  deactivate(id: number): void {
    this.db.prepare('UPDATE tracked_profiles SET active = 0 WHERE id = ?').run(id);
  }

  activeProfiles(): TrackedProfile[] {
    return this.db.prepare('SELECT * FROM tracked_profiles WHERE active = 1 ORDER BY id')
      .all() as unknown as TrackedProfile[];
  }

  countActive(): number {
    return (this.db.prepare('SELECT COUNT(*) c FROM tracked_profiles WHERE active = 1')
      .get() as unknown as { c: number }).c;
  }

  /** A clean sweep of this profile. Clears any previous error — it no longer applies. */
  markSwept(id: number, atIso: string): void {
    this.db.prepare(
      'UPDATE tracked_profiles SET last_swept_at = ?, last_sweep_error = NULL WHERE id = ?',
    ).run(atIso, id);
  }

  /**
   * A failed sweep of this profile. Deliberately does NOT touch last_swept_at: advancing it
   * would tell the next pass this profile is fresh and hand it the narrow 24h window it
   * never actually received, silently losing whatever it posted.
   */
  markSweepError(id: number, error: string): void {
    this.db.prepare('UPDATE tracked_profiles SET last_sweep_error = ? WHERE id = ?')
      .run(error, id);
  }

  /**
   * Display rows for the tracking manager: the profile plus how many posts it has
   * yielded. `post_count` is unconditional — it deliberately includes posts already
   * engaged with, not just fresh/unactioned ones, because this is a yield figure for
   * the operator, not a work-queue depth.
   */
  withCounts(): (TrackedProfile & { post_count: number })[] {
    return this.db.prepare(`
      SELECT tp.*, COUNT(p.id) AS post_count
      FROM tracked_profiles tp
      LEFT JOIN posts p ON p.tracked_profile_id = tp.id
      WHERE tp.active = 1
      GROUP BY tp.id
      ORDER BY tp.id
    `).all() as unknown as (TrackedProfile & { post_count: number })[];
  }
}

/**
 * The feed's three filters, defined ONCE so the API and the UI cannot drift.
 *
 * A deliberate, TOTAL partition: every post on an active profile lands in exactly one
 * chip, for every combination of `status` and whether `reacted_at` is set. `reacted_at`
 * takes precedence over `status` — a reaction is a fact already live on LinkedIn, while
 * `status` is bookkeeping about the task that produced it, and the two can disagree (a
 * live reaction whose comment attempt then failed). Concretely:
 *   - no engagement at all                                        -> new
 *   - reacted_at IS NOT NULL, any status whatsoever                -> engaged
 *   - not reacted, status IN (failed, skipped)                     -> new (retryable —
 *     the alternative is a post that can never be retried from the feed)
 *   - not reacted, anything else (queued/scheduled/sending, and
 *     needs_attention/sent) -> queued. `needs_attention` counts as in-flight because a
 *     human still has to act on it, not because work is progressing unattended.
 * `queued`'s predicate relies on `e.status` being NULL (via the LEFT JOIN) when there is
 * no engagement row, and `NULL NOT IN (...)` evaluating to NULL rather than true — that
 * is what keeps an engagement-less post out of `queued` rather than defaulting into it.
 */
const RETRYABLE_STATUSES = ['failed', 'skipped'] as const;

/** `('failed','skipped')`, built from the list above so the SQL cannot drift from the JS. */
const RETRYABLE_SQL = `(${RETRYABLE_STATUSES.map((s) => `'${s}'`).join(',')})`;

/**
 * May a feed click re-drive this engagement? The JS half of `new`'s second clause below, and
 * it must stay exactly that — the API used to keep its own `status`-only copy, which is how a
 * post sitting in the `engaged` chip was still re-queueable from `/api/posts/:id/engage`.
 *
 * `reacted_at` is the load-bearing half, not decoration: an engagement can be `failed` because
 * the COMMENT step fell over after the reaction already landed, and that reaction is live on
 * LinkedIn. Re-queueing such a row hands the sender a second reaction to drive.
 */
export function isRetryableEngagement(e: { status: string; reacted_at: string | null }): boolean {
  return e.reacted_at === null && (RETRYABLE_STATUSES as readonly string[]).includes(e.status);
}

const FILTER_SQL: Record<PostFilter, string> = {
  new: `(p.engagement_id IS NULL OR (e.reacted_at IS NULL AND e.status IN ${RETRYABLE_SQL}))`,
  queued: `(e.reacted_at IS NULL AND e.status NOT IN ${RETRYABLE_SQL})`,
  engaged: 'e.reacted_at IS NOT NULL',
};

/** Sort and prune key. COALESCE because an unparseable postedAt lands as NULL, and
 *  `NULL < cutoff` is NULL — so without this those rows would never prune. */
const SORT_KEY = 'COALESCE(p.posted_at, p.first_seen_at)';

export class PostRepo {
  constructor(private db: DB) {}

  /**
   * Store a sweep's results. Returns how many rows were genuinely new, and how many were
   * REJECTED — dropped by a CHECK/NOT NULL violation rather than the duplicate-URN dedupe
   * this exists for.
   *
   * `INSERT OR IGNORE` swallows every constraint failure a row can hit, not just the
   * UNIQUE post_urn collision it is here for: `changes === 0` is identical whether the row
   * was a genuine duplicate or a malformed one (an unparseable `posted_at`, a NULL
   * `post_url`, etc.) that never got a chance to insert. Left undistinguished, that meant a
   * bad batch from the scrape vanished with zero signal: the operator saw "0 new posts",
   * the sweep stamped itself clean, and the NEXT sweep re-fetched — and re-billed — the
   * same posts from Apify and dropped them again, forever. So on `changes === 0` we look
   * the row up by its URN: present means the duplicate this statement exists to catch and
   * is silently expected; absent means the insert was rejected, which we count separately
   * and log loudly enough to actually notice.
   *
   * Wrapped in one transaction for the same reason as ConnectionRepo.upsertMany:
   * unbatched, a realistic ~600-row sweep measured ~430ms of synchronous, event-loop-
   * blocking writes on a WAL-backed file DB versus ~4ms wrapped — and separately, a FOREIGN
   * KEY violation (unlike CHECK/NOT NULL) is NOT swallowed by OR IGNORE and throws, so an
   * un-batched loop could commit the rows before a bad one and then blow up, half-written.
   */
  upsertMany(items: PostInput[], firstSeenAtIso: string): { added: number; rejected: number } {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO posts
        (post_urn, post_url, tracked_profile_id, author_name, author_headline, content,
         posted_at, is_repost, reaction_count, comment_count, raw_json, first_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let added = 0;
    let rejected = 0;
    this.db.exec('BEGIN');
    try {
      for (const it of items) {
        // Number() because `changes` can arrive as a bigint — same wrapping as
        // EventInviteeRepo and ConnectionRepo already use.
        const changes = Number(stmt.run(
          it.post_urn, it.post_url, it.tracked_profile_id, it.author_name, it.author_headline,
          it.content, it.posted_at, it.is_repost, it.reaction_count, it.comment_count,
          it.raw_json, firstSeenAtIso,
        ).changes);
        if (changes === 1) { added++; continue; }
        if (this.findByUrn(it.post_urn)) continue; // genuine duplicate — expected, silent
        rejected++;
        log.warn('posts', 'upsertMany rejected a row (constraint violation, not a duplicate)', {
          post_urn: it.post_urn, posted_at: it.posted_at,
        });
      }
      this.db.exec('COMMIT');
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
      throw e;
    }
    return { added, rejected };
  }

  findById(id: number): Post | undefined {
    return this.db.prepare('SELECT * FROM posts WHERE id = ?')
      .get(id) as unknown as Post | undefined;
  }

  findByUrn(urn: string): Post | undefined {
    return this.db.prepare('SELECT * FROM posts WHERE post_urn = ?')
      .get(urn) as unknown as Post | undefined;
  }

  countAll(): number {
    return (this.db.prepare('SELECT COUNT(*) c FROM posts').get() as unknown as { c: number }).c;
  }

  /** Link a post to the engagement queued for it. */
  setEngagement(id: number, engagementId: number): void {
    this.db.prepare('UPDATE posts SET engagement_id = ? WHERE id = ?').run(engagementId, id);
  }

  /**
   * One page of the feed, newest first.
   *
   * `cursor` is the keyset position — `"<sortKey>|<id>"` from the previous page's last row.
   * Keyset rather than OFFSET because the sweep inserts rows between requests, and OFFSET
   * would skip or repeat posts as the set shifts underneath the reader.
   *
   * Validated here because this file owns the format: in a later task this string arrives
   * verbatim from an HTTP query parameter. `indexOf` rather than `lastIndexOf` is
   * deliberate — the key is either `posted_at` or `first_seen_at`, both GLOB-checked ISO
   * shapes in schema.sql that can never contain a `|`, so the first pipe is always the
   * separator; splitting on the LAST one is what let a cursor with an extra `|` silently
   * re-serve an already-seen row.
   *
   * Both halves are validated against a strict shape rather than merely coerced:
   *  - the id half must be all digits. `Number.isInteger` alone let `""` through as `0`
   *    (`Number('') === 0`), which then excluded every row AT the cursor's key via
   *    `p.id < 0` — silently dropping the rest of a tie group rather than re-serving it,
   *    the one case among these that loses rows instead of repeating them. Digits-only
   *    also rejects `-1`, `1e3`, hex, and anything past safe-integer precision, none of
   *    which a real cursor should ever contain.
   *  - the key half must match the same ISO shape the schema's GLOB CHECK enforces on
   *    `posted_at`/`first_seen_at`. Unvalidated, any string sorting above all real data
   *    (e.g. injected SQL text) satisfies `SORT_KEY < ?` for every row and silently
   *    re-serves page one — parameterization means this was never an injection risk, just
   *    a wrong page with no signal that the cursor was garbage.
   */
  feed(filter: PostFilter, limit: number, cursor: string | null): FeedPost[] {
    const params: unknown[] = [];
    let keyset = '';
    if (cursor !== null) {
      const sep = cursor.indexOf('|');
      const key = cursor.slice(0, sep);
      const idPart = cursor.slice(sep + 1);
      if (sep <= 0 || !/^\d+$/.test(idPart) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(key)) {
        throw new Error(`malformed feed cursor: ${cursor}`);
      }
      const id = Number(idPart);
      keyset = `AND (${SORT_KEY} < ? OR (${SORT_KEY} = ? AND p.id < ?))`;
      params.push(key, key, id);
    }
    params.push(limit);
    return this.db.prepare(`
      SELECT p.*,
             e.status   AS engagement_status,
             e.reaction AS engagement_reaction,
             e.reacted_at AS engagement_reacted_at,
             COALESCE(c.full_name, p.author_name, tp.full_name) AS author_display,
             COALESCE(c.headline, p.author_headline, tp.headline) AS headline_display
      FROM posts p
      JOIN tracked_profiles tp ON tp.id = p.tracked_profile_id
      LEFT JOIN engagements e ON e.id = p.engagement_id
      LEFT JOIN connections c ON c.id = tp.connection_id
      WHERE tp.active = 1 AND ${FILTER_SQL[filter]} ${keyset}
      ORDER BY ${SORT_KEY} DESC, p.id DESC
      LIMIT ?
    `).all(...(params as never[])) as unknown as FeedPost[];
  }

  /** The chip counts, in one pass rather than three round-trips. */
  counts(): Record<PostFilter, number> {
    const row = this.db.prepare(`
      SELECT
        SUM(CASE WHEN ${FILTER_SQL.new}    THEN 1 ELSE 0 END) AS new_c,
        SUM(CASE WHEN ${FILTER_SQL.queued} THEN 1 ELSE 0 END) AS queued_c,
        SUM(CASE WHEN ${FILTER_SQL.engaged} THEN 1 ELSE 0 END) AS engaged_c
      FROM posts p
      JOIN tracked_profiles tp ON tp.id = p.tracked_profile_id
      LEFT JOIN engagements e ON e.id = p.engagement_id
      WHERE tp.active = 1
    `).get() as unknown as { new_c: number | null; queued_c: number | null; engaged_c: number | null };
    return { new: row.new_c ?? 0, queued: row.queued_c ?? 0, engaged: row.engaged_c ?? 0 };
  }

  /** Posts stored in the trailing window — drives the informational cost readout. */
  countSince(iso: string): number {
    return (this.db.prepare('SELECT COUNT(*) c FROM posts WHERE first_seen_at >= ?')
      .get(iso) as unknown as { c: number }).c;
  }

  /**
   * Delete un-engaged posts older than `days`. Returns how many went.
   *
   * Load-bearing, not hygiene: with no dismiss action, ageing out is the only way a post
   * leaves the New chip. Anything with an engagement is kept regardless of age — that is
   * the record of what was actually done.
   *
   * `days <= 0` is refused rather than honoured: `posts_retention_days` is operator-
   * editable, 0 is the value an operator would guess means "keep everything forever", and
   * the naive cutoff math does the opposite — it makes every un-engaged post instantly
   * overdue and wipes the New feed in one tick, recoverable only by re-paying Apify to
   * re-sweep. A non-finite `days` (NaN, or a settings value that arrives as a string —
   * `Number.isFinite('30')` is `false`, with no coercion) must not throw out of
   * `new Date(...).toISOString()` either, because this runs inside a scheduler tick and
   * tick handlers must never throw (see orchestrator.ts).
   *
   * The refusal is logged, not silent: the whole point of the upsertMany reject/duplicate
   * fix above is that a silent drop is worse than a loud one, and an invalid `days` means
   * retention never runs again — New grows without bound with nothing in the log to say
   * why, which is exactly the "load-bearing" failure mode this method's own comment warns
   * about.
   */
  prune(days: number, now: Date): number {
    if (!Number.isFinite(days) || days < 1) {
      log.warn('posts', 'prune refused an out-of-range retention window', { days });
      return 0;
    }
    const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
    return Number(this.db.prepare(
      `DELETE FROM posts WHERE engagement_id IS NULL
       AND COALESCE(posted_at, first_seen_at) < ?`,
    ).run(cutoff).changes);
  }
}
