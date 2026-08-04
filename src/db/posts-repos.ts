/**
 * Repositories for the Posts feed.
 *
 * Both live in one file for the same reason event-repos.ts groups four: repositories.ts is
 * already long, and these two always change together.
 */
import type { DB } from './database.js';
import type { TrackedProfile } from '../types.js';

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

  /** Display rows for the tracking manager: the profile plus how many posts it has yielded. */
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
