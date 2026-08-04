/**
 * Repositories for the Posts feed.
 *
 * Both live in one file for the same reason event-repos.ts groups four: repositories.ts is
 * already long, and these two always change together.
 */
import type { DB } from './database.js';
import type { FeedPost, Post, PostFilter, TrackedProfile } from '../types.js';

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

/** What upsertMany accepts. Everything the extractor produces, minus the row's own id. */
export interface PostInput {
  post_urn: string;
  post_url: string;
  tracked_profile_id: number;
  author_name: string | null;
  author_headline: string | null;
  content: string | null;
  posted_at: string | null;
  is_repost: number;
  reaction_count: number | null;
  comment_count: number | null;
  raw_json: string | null;
}

/**
 * The feed's three filters, defined ONCE so the API and the UI cannot drift.
 *
 * `new` deliberately re-admits a post whose engagement ended `failed` or `skipped`: the
 * alternative is a post that can never be retried from the feed and is invisible under
 * every chip.
 */
const FILTER_SQL: Record<PostFilter, string> = {
  new: "(p.engagement_id IS NULL OR e.status IN ('failed','skipped'))",
  queued: "e.status IN ('queued','scheduled','sending')",
  engaged: 'e.reacted_at IS NOT NULL',
};

/** Sort and prune key. COALESCE because an unparseable postedAt lands as NULL, and
 *  `NULL < cutoff` is NULL — so without this those rows would never prune. */
const SORT_KEY = 'COALESCE(p.posted_at, p.first_seen_at)';

export class PostRepo {
  constructor(private db: DB) {}

  /**
   * Store a sweep's results. Returns how many rows were genuinely new.
   *
   * INSERT OR IGNORE on the UNIQUE post_urn is the whole dedupe strategy — no cursor, no
   * have-I-seen-this bookkeeping, so a repeated or overlapping sweep is free. Note this
   * dedupes STORAGE and not the Apify bill; that is what the postedLimit window is for.
   */
  upsertMany(items: PostInput[], firstSeenAtIso: string): number {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO posts
        (post_urn, post_url, tracked_profile_id, author_name, author_headline, content,
         posted_at, is_repost, reaction_count, comment_count, raw_json, first_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let added = 0;
    for (const it of items) {
      // `changes` is 0 when OR IGNORE swallowed a duplicate and 1 on a real insert, which is
      // exactly the count we want. Number() because it can arrive as a bigint — same wrapping
      // as EventInviteeRepo and ConnectionRepo already use.
      added += Number(stmt.run(
        it.post_urn, it.post_url, it.tracked_profile_id, it.author_name, it.author_headline,
        it.content, it.posted_at, it.is_repost, it.reaction_count, it.comment_count,
        it.raw_json, firstSeenAtIso,
      ).changes);
    }
    return added;
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
   */
  feed(filter: PostFilter, limit: number, cursor: string | null): FeedPost[] {
    const params: unknown[] = [];
    let keyset = '';
    if (cursor !== null) {
      const sep = cursor.lastIndexOf('|');
      const key = cursor.slice(0, sep);
      const id = Number(cursor.slice(sep + 1));
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
   */
  prune(days: number, now: Date): number {
    const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
    return Number(this.db.prepare(
      `DELETE FROM posts WHERE engagement_id IS NULL
       AND COALESCE(posted_at, first_seen_at) < ?`,
    ).run(cutoff).changes);
  }
}
