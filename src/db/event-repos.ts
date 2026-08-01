/**
 * Repositories for the event-invite pipeline.
 *
 * Split out of repositories.ts purely for size; they hang off the same `Repos`
 * aggregator. Note that `EventRepo` in repositories.ts is the send_log/profile_events
 * repo and predates this pipeline — it is unrelated, hence the different names here.
 */
import type { DB } from './database.js';
import type {
  LinkedInEvent, EventBucket, EventInvitee, EventStatus, EventInviteeStatus,
} from '../types.js';
import type { PlannedBucket } from '../core/event-buckets.js';

export interface EventRun {
  id: number;
  event_id: number;
  mode: 'dry' | 'live';
  started_at: string;
  ended_at: string | null;
  reserved_from: string | null;
  reserved_to: string | null;
  invited_count: number;
  outcome: string | null;
  error: string | null;
}

export interface EventRunBucket {
  id: number;
  run_id: number;
  bucket_id: number;
  rows_loaded: number;
  matched: number;
  ticked: number;
  submitted: number;
  outcome: string | null;
  error: string | null;
  updated_at: string;
}

/** Columns callers may patch on an event. Anything else is a bug, not a feature. */
const EVENT_COLUMNS = new Set([
  'event_urn', 'title', 'starts_at', 'status', 'invite_cap', 'bucket_ceiling',
  'bucket_cursor', 'attended', 'armed_at', 'closed_at', 'close_reason',
]);

export class EventCampaignRepo {
  constructor(private db: DB) {}

  create(eventUrl: string, opts: {
    eventUrn?: string | null; inviteCap: number; bucketCeiling: number;
  }): LinkedInEvent {
    const r = this.db.prepare(`
      INSERT INTO events (event_url, event_urn, invite_cap, bucket_ceiling)
      VALUES (?, ?, ?, ?)
    `).run(eventUrl, opts.eventUrn ?? null, opts.inviteCap, opts.bucketCeiling);
    return this.findById(Number(r.lastInsertRowid))!;
  }

  findById(id: number): LinkedInEvent | undefined {
    return this.db.prepare('SELECT * FROM events WHERE id = ?')
      .get(id) as unknown as LinkedInEvent | undefined;
  }

  findByUrl(eventUrl: string): LinkedInEvent | undefined {
    return this.db.prepare('SELECT * FROM events WHERE event_url = ?')
      .get(eventUrl) as unknown as LinkedInEvent | undefined;
  }

  list(): LinkedInEvent[] {
    return this.db.prepare('SELECT * FROM events ORDER BY id DESC')
      .all() as unknown as LinkedInEvent[];
  }

  byStatus(status: EventStatus): LinkedInEvent[] {
    return this.db.prepare('SELECT * FROM events WHERE status = ? ORDER BY id')
      .all(status) as unknown as LinkedInEvent[];
  }

  update(id: number, patch: Partial<LinkedInEvent>): void {
    const keys = Object.keys(patch).filter((k) => k !== 'id');
    if (keys.length === 0) return;
    for (const k of keys) if (!EVENT_COLUMNS.has(k)) throw new Error(`Illegal events column: ${k}`);
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    const vals = keys.map((k) => (patch as Record<string, unknown>)[k]);
    this.db.prepare(`UPDATE events SET ${sets} WHERE id = ?`).run(...(vals as never[]), id);
  }

  /** Terminal. Used for "the event already started" and for an operator stop. */
  close(id: number, status: EventStatus, reason: string, nowIso: string): void {
    this.db.prepare('UPDATE events SET status = ?, closed_at = ?, close_reason = ? WHERE id = ?')
      .run(status, nowIso, reason, id);
  }

  /** How many runs started on a given local date — enforces `events_per_day`. */
  countRunsOnDate(dateIso: string): number {
    return (this.db.prepare(
      "SELECT COUNT(*) c FROM event_runs WHERE mode = 'live' AND date(started_at) = date(?)",
    ).get(dateIso) as unknown as { c: number }).c;
  }
}

export class EventBucketRepo {
  constructor(private db: DB) {}

  /**
   * Replace an event's bucket plan wholesale. Only legal while the campaign is a draft —
   * once armed, `bucket_cursor` indexes into this list and rewriting it would silently
   * re-point the cursor at different work.
   */
  replaceAll(eventId: number, planned: PlannedBucket[]): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM event_buckets WHERE event_id = ?').run(eventId);
      const ins = this.db.prepare(`
        INSERT INTO event_buckets
          (event_id, rank, label, geo_label, geo_candidates, kind, target_count, roster_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const b of planned) {
        ins.run(eventId, b.rank, b.label, b.geoLabel,
          JSON.stringify(b.geoCandidates), b.kind, b.targetCount, b.rosterCount);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
      throw e;
    }
  }

  list(eventId: number): EventBucket[] {
    return this.db.prepare('SELECT * FROM event_buckets WHERE event_id = ? ORDER BY rank')
      .all(eventId) as unknown as EventBucket[];
  }

  /** The slice of buckets one run should work: `ceiling` of them, from the cursor. */
  forRun(eventId: number, cursor: number, ceiling: number): EventBucket[] {
    return this.db.prepare(
      'SELECT * FROM event_buckets WHERE event_id = ? AND rank >= ? ORDER BY rank LIMIT ?',
    ).all(eventId, cursor, Math.max(0, ceiling)) as unknown as EventBucket[];
  }

  /** Drop buckets by rank and renumber, for the operator's pre-arm edit. */
  removeRanks(eventId: number, ranks: number[]): void {
    if (ranks.length === 0) return;
    this.db.exec('BEGIN');
    try {
      const holes = ranks.map(() => '?').join(',');
      this.db.prepare(`DELETE FROM event_buckets WHERE event_id = ? AND rank IN (${holes})`)
        .run(eventId, ...ranks);
      const remaining = this.db.prepare(
        'SELECT id FROM event_buckets WHERE event_id = ? ORDER BY rank',
      ).all(eventId) as unknown as { id: number }[];
      const upd = this.db.prepare('UPDATE event_buckets SET rank = ? WHERE id = ?');
      remaining.forEach((r, i) => upd.run(i, r.id));
      this.db.exec('COMMIT');
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
      throw e;
    }
  }

  /** Cache a resolved geo so a later run skips the typeahead round-trip. */
  setGeo(bucketId: number, geoLabel: string, geoUrn: string): void {
    this.db.prepare('UPDATE event_buckets SET geo_label = ?, geo_urn = ? WHERE id = ?')
      .run(geoLabel, geoUrn, bucketId);
  }

  setStatus(bucketId: number, status: EventBucket['status']): void {
    this.db.prepare('UPDATE event_buckets SET status = ? WHERE id = ?').run(status, bucketId);
  }

  /** The ordered labels to try for a bucket. Falls back to the stored primary. */
  candidates(bucket: EventBucket & { geo_candidates?: string | null }): string[] {
    const raw = bucket.geo_candidates;
    if (typeof raw === 'string' && raw.length > 0) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string') && parsed.length > 0) {
          return parsed as string[];
        }
      } catch { /* fall through to the stored primary */ }
    }
    return [bucket.geo_label];
  }
}

export class EventInviteeRepo {
  constructor(private db: DB) {}

  /** Insert the invitee list. Ignores duplicates so re-adding a URL is harmless. */
  addMany(eventId: number, rows: {
    profile_url: string; connection_id: number | null; member_urn: string | null;
    full_name: string | null; status?: EventInviteeStatus; note?: string | null;
  }[]): number {
    const ins = this.db.prepare(`
      INSERT OR IGNORE INTO event_invitees
        (event_id, connection_id, member_urn, profile_url, full_name, status, note)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    let n = 0;
    this.db.exec('BEGIN');
    try {
      for (const r of rows) {
        n += Number(ins.run(eventId, r.connection_id, r.member_urn, r.profile_url,
          r.full_name, r.status ?? 'pending', r.note ?? null).changes);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
      throw e;
    }
    return n;
  }

  list(eventId: number): EventInvitee[] {
    return this.db.prepare('SELECT * FROM event_invitees WHERE event_id = ? ORDER BY id')
      .all(eventId) as unknown as EventInvitee[];
  }

  /**
   * Everyone still awaiting an invite, as a URN -> invitee map.
   *
   * The run ticks against THIS set rather than against a bucket's own membership: a Tel
   * Aviv invitee surfacing under the parent "Israel" pass should still be invited. Bucket
   * assignment ranks the work; it does not restrict who may be ticked.
   */
  pendingByUrn(eventId: number): Map<string, EventInvitee> {
    const rows = this.db.prepare(
      "SELECT * FROM event_invitees WHERE event_id = ? AND status = 'pending' AND member_urn IS NOT NULL",
    ).all(eventId) as unknown as EventInvitee[];
    return new Map(rows.map((r) => [r.member_urn!, r]));
  }

  countsByStatus(eventId: number): Record<string, number> {
    const rows = this.db.prepare(
      'SELECT status, COUNT(*) c FROM event_invitees WHERE event_id = ? GROUP BY status',
    ).all(eventId) as unknown as { status: string; c: number }[];
    return Object.fromEntries(rows.map((r) => [r.status, r.c]));
  }

  /** How many invites this event has already dispatched — enforces the lifetime cap. */
  invitedCount(eventId: number): number {
    return (this.db.prepare(
      "SELECT COUNT(*) c FROM event_invitees WHERE event_id = ? AND status = 'invited'",
    ).get(eventId) as unknown as { c: number }).c;
  }

  markInvited(ids: number[], bucketId: number, nowIso: string): void {
    if (ids.length === 0) return;
    const upd = this.db.prepare(
      "UPDATE event_invitees SET status = 'invited', invited_at = ?, bucket_id = ? WHERE id = ?",
    );
    this.db.exec('BEGIN');
    try {
      for (const id of ids) upd.run(nowIso, bucketId, id);
      this.db.exec('COMMIT');
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
      throw e;
    }
  }

  setStatus(id: number, status: EventInviteeStatus, note: string | null): void {
    this.db.prepare('UPDATE event_invitees SET status = ?, note = ? WHERE id = ?')
      .run(status, note, id);
  }

  /** Park everyone still pending once the campaign can make no further progress. */
  markRemainingUnreachable(eventId: number, note: string): number {
    return Number(this.db.prepare(
      "UPDATE event_invitees SET status = 'unreachable', note = ? WHERE event_id = ? AND status = 'pending'",
    ).run(note, eventId).changes);
  }
}

export class EventRunRepo {
  constructor(private db: DB) {}

  start(eventId: number, mode: 'dry' | 'live', reserved: { from: string; to: string } | null): EventRun {
    const r = this.db.prepare(`
      INSERT INTO event_runs (event_id, mode, reserved_from, reserved_to) VALUES (?, ?, ?, ?)
    `).run(eventId, mode, reserved?.from ?? null, reserved?.to ?? null);
    return this.findById(Number(r.lastInsertRowid))!;
  }

  findById(id: number): EventRun | undefined {
    return this.db.prepare('SELECT * FROM event_runs WHERE id = ?')
      .get(id) as unknown as EventRun | undefined;
  }

  finish(id: number, outcome: string, invitedCount: number, nowIso: string, error?: string): void {
    this.db.prepare(
      'UPDATE event_runs SET ended_at = ?, outcome = ?, invited_count = ?, error = ? WHERE id = ?',
    ).run(nowIso, outcome, invitedCount, error ?? null, id);
  }

  listForEvent(eventId: number): EventRun[] {
    return this.db.prepare('SELECT * FROM event_runs WHERE event_id = ? ORDER BY id DESC')
      .all(eventId) as unknown as EventRun[];
  }

  /** A run that started but never ended — orphaned by a crash. */
  unfinished(): EventRun[] {
    return this.db.prepare('SELECT * FROM event_runs WHERE ended_at IS NULL ORDER BY id')
      .all() as unknown as EventRun[];
  }

  /**
   * Live per-bucket progress. Upserted on every tick of the scroll loop so the UI can
   * show "Israel — 840 rows scanned, 3 of 4 matched" instead of 20 opaque minutes.
   */
  progress(runId: number, bucketId: number, patch: Partial<Omit<EventRunBucket, 'id' | 'run_id' | 'bucket_id'>>): void {
    this.db.prepare(`
      INSERT INTO event_run_buckets (run_id, bucket_id, rows_loaded, matched, ticked, submitted, outcome, error, updated_at)
      VALUES (?, ?, 0, 0, 0, 0, NULL, NULL, datetime('now'))
      ON CONFLICT (run_id, bucket_id) DO NOTHING
    `).run(runId, bucketId);
    const keys = Object.keys(patch);
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    const vals = keys.map((k) => (patch as Record<string, unknown>)[k]);
    this.db.prepare(
      `UPDATE event_run_buckets SET ${sets}, updated_at = datetime('now') WHERE run_id = ? AND bucket_id = ?`,
    ).run(...(vals as never[]), runId, bucketId);
  }

  bucketProgress(runId: number): EventRunBucket[] {
    return this.db.prepare(
      'SELECT * FROM event_run_buckets WHERE run_id = ? ORDER BY id',
    ).all(runId) as unknown as EventRunBucket[];
  }
}
