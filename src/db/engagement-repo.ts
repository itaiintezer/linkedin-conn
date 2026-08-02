/**
 * Repository for the post-engagement pipeline.
 *
 * Its own file for the same reason event-repos.ts is: repositories.ts is already long, and
 * a pipeline's queries belong together. It hangs off the same `Repos` aggregator.
 */
import type { DB } from './database.js';
import type { Engagement, EngagementStatus, Reaction } from '../types.js';

/**
 * Columns `setStatus` may write. Mirrors PROFILE_COLUMNS in repositories.ts and exists for
 * the same reason: setStatus takes a caller-supplied object, so without an allow-list a
 * typo'd or hostile key becomes SQL.
 *
 * Note what is ABSENT: post_url, post_urn and reaction are immutable through this path. The
 * URN is the identity, and rewriting a row's reaction after the fact would silently change
 * what a queued task does. (reconcileUrn is the one sanctioned way to change a URN, and it
 * checks for a collision first.)
 */
const ENGAGEMENT_COLUMNS = new Set([
  'attempts', 'last_error', 'skip_reason', 'scheduled_for', 'reacted_at', 'commented_at',
]);

export class EngagementRepo {
  constructor(private db: DB) {}

  /**
   * Insert, or return the row that already exists for this post.
   *
   * Idempotent rather than throwing, mirroring ProfileRepo.add. The API checks for a
   * duplicate first and returns a 409 naming the existing row — this is the backstop for
   * any path that does not, and a silent no-op is better than a 500 from a raw SQLite
   * constraint violation.
   */
  add(postUrl: string, postUrn: string, reaction: Reaction, commentText: string | null): Engagement {
    const existing = this.findByUrn(postUrn);
    if (existing) return existing;
    this.db.prepare(
      'INSERT INTO engagements (post_url, post_urn, reaction, comment_text) VALUES (?, ?, ?, ?)',
    ).run(postUrl, postUrn, reaction, commentText);
    return this.findByUrn(postUrn)!;
  }

  findById(id: number): Engagement | undefined {
    return this.db.prepare('SELECT * FROM engagements WHERE id = ?')
      .get(id) as unknown as Engagement | undefined;
  }

  findByUrn(urn: string): Engagement | undefined {
    return this.db.prepare('SELECT * FROM engagements WHERE post_urn = ?')
      .get(urn) as unknown as Engagement | undefined;
  }

  all(): Engagement[] {
    return this.db.prepare('SELECT * FROM engagements ORDER BY id').all() as unknown as Engagement[];
  }

  byStatus(status: EngagementStatus): Engagement[] {
    return this.db.prepare('SELECT * FROM engagements WHERE status = ? ORDER BY id')
      .all(status) as unknown as Engagement[];
  }

  queuedByPriority(): Engagement[] {
    return this.db.prepare("SELECT * FROM engagements WHERE status='queued' ORDER BY priority, id")
      .all() as unknown as Engagement[];
  }

  setStatus(id: number, status: EngagementStatus, fields: Partial<Engagement> = {}): void {
    const sets: string[] = ['status = ?'];
    const vals: unknown[] = [status];
    for (const [k, v] of Object.entries(fields)) {
      if (!ENGAGEMENT_COLUMNS.has(k)) throw new Error(`Illegal engagement column: ${k}`);
      sets.push(`${k} = ?`); vals.push(v);
    }
    vals.push(id);
    this.db.prepare(`UPDATE engagements SET ${sets.join(', ')} WHERE id = ?`).run(...(vals as never[]));
  }

  setScheduled(id: number, iso: string): void {
    this.db.prepare("UPDATE engagements SET status='scheduled', scheduled_for=? WHERE id=?")
      .run(iso, id);
  }

  /**
   * The weekly-cap unit. The reaction always happens, so it is what a spent slot means.
   *
   * `reacted_at >= ?` is a TEXT comparison, which is a chronological one only because every
   * timestamp written here is the same fixed-width UTC ISO-8601 string. Rows that never
   * reacted hold NULL, and `NULL >= x` is NULL rather than true, so they are excluded.
   */
  countReactedSince(iso: string): number {
    return (this.db.prepare('SELECT COUNT(*) c FROM engagements WHERE reacted_at >= ?')
      .get(iso) as unknown as { c: number }).c;
  }

  /** Drives engage_comment_daily_cap. Same TEXT-comparison and NULL rules as above. */
  countCommentedSince(iso: string): number {
    return (this.db.prepare('SELECT COUNT(*) c FROM engagements WHERE commented_at >= ?')
      .get(iso) as unknown as { c: number }).c;
  }

  /**
   * Rewrite a row's URN to the canonical one the driver read off the live post.
   *
   * The URN parsed from a URL is only a best-effort identity: LinkedIn's share-link slug
   * carries a DIFFERENT number from the post's own `data-urn` (observed 2026-08-02 —
   * slug 7489401095899770880 vs data-urn urn:li:activity:7489401096851906561 for one post).
   * So two URL forms of one post enqueue as two rows, and this is how that self-heals on
   * first execution.
   *
   * Returns 'reconciled' when the row was updated, 'duplicate' when the canonical URN is
   * already held by ANOTHER row — in which case this row is the redundant one and the
   * caller must retire it rather than engaging twice with the same post.
   *
   * Throws on an id with no row. That case is deliberately NOT folded into 'unchanged':
   * only a caller holding a row it just loaded can reach here, so a missing id is a bug,
   * and answering 'unchanged' would tell it "your URN is already canonical" — after which
   * it would engage under an identity nothing verified.
   */
  reconcileUrn(id: number, canonicalUrn: string): 'unchanged' | 'reconciled' | 'duplicate' {
    const row = this.findById(id);
    if (!row) throw new Error(`No engagement ${id}`);
    if (row.post_urn === canonicalUrn) return 'unchanged';
    const holder = this.findByUrn(canonicalUrn);
    if (holder && holder.id !== id) return 'duplicate';
    this.db.prepare('UPDATE engagements SET post_urn = ? WHERE id = ?').run(canonicalUrn, id);
    return 'reconciled';
  }

  countsByStatus(): Record<string, number> {
    const rows = this.db.prepare('SELECT status, COUNT(*) c FROM engagements GROUP BY status')
      .all() as unknown as { status: string; c: number }[];
    const out: Record<string, number> = {};
    for (const r of rows) out[r.status] = r.c;
    return out;
  }
}
