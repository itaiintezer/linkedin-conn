import type { DB } from './database.js';
import type {
  Cohort, Profile, Settings, ProfileStatus, EventType, AppState, GuardrailReason, CampaignKind,
  Connection, ConnectionInput, ConnectionSource, EnrichStatus, EnrichedProfile,
} from '../types.js';

const PROFILE_COLUMNS = new Set([
  'first_name', 'full_name', 'custom_message', 'attempts', 'last_error', 'skip_reason',
  'scheduled_for', 'sent_at', 'accepted_at', 'replied_at', 'resolved_at', 'thread_url',
]);
const SETTINGS_COLUMNS = new Set([
  'workday_start_hour', 'workday_end_hour', 'weekdays_only', 'weekly_cap',
  'batch_size', 'batches_per_day',
  'msg_weekly_cap', 'msg_batch_size', 'msg_batches_per_day', 'reply_checks_per_day',
  'roster_sync_per_day',
  'apify_api_key', 'enrich_ttl_days', 'enrich_concurrency',
  'note_quota_exhausted', 'min_delay_ms', 'max_delay_ms', 'paused', 'pause_reason',
  'onboarded',
  'failure_threshold',
  'expiry_days',
]);

export class CohortRepo {
  constructor(private db: DB) {}
  create(name: string, template: string | null, allowNoNote: boolean, kind: CampaignKind = 'invite'): Cohort {
    this.db.prepare(
      'INSERT INTO cohorts (name, message_template, allow_no_note, kind) VALUES (?, ?, ?, ?)',
    ).run(name, template, allowNoNote ? 1 : 0, kind);
    return this.findByName(name)!;
  }
  findByName(name: string): Cohort | undefined {
    return this.db.prepare('SELECT * FROM cohorts WHERE name = ?').get(name) as unknown as Cohort | undefined;
  }
  findById(id: number): Cohort | undefined {
    return this.db.prepare('SELECT * FROM cohorts WHERE id = ?').get(id) as unknown as Cohort | undefined;
  }
  list(): Cohort[] {
    return this.db.prepare('SELECT * FROM cohorts WHERE archived = 0 ORDER BY created_at DESC').all() as unknown as Cohort[];
  }
  listArchived(): Cohort[] {
    return this.db.prepare('SELECT * FROM cohorts WHERE archived = 1 ORDER BY created_at DESC').all() as unknown as Cohort[];
  }
  setArchived(id: number, archived: boolean): void {
    this.db.prepare('UPDATE cohorts SET archived = ? WHERE id = ?').run(archived ? 1 : 0, id);
  }
  getOrCreate(name: string, template: string | null, allowNoNote: boolean, kind: CampaignKind = 'invite'): Cohort {
    const existing = this.findByName(name);
    if (!existing) return this.create(name, template, allowNoNote, kind);
    // Adding under an archived name resurrects the cohort — otherwise the new
    // profiles would queue into a cohort the UI can't show.
    if (existing.archived) { this.setArchived(existing.id, false); return this.findById(existing.id)!; }
    return existing;
  }
}

export class ProfileRepo {
  constructor(private db: DB) {}
  add(cohortId: number, normalizedUrl: string, customMessage: string | null, kind: CampaignKind = 'invite'): Profile {
    const existing = this.db
      .prepare('SELECT * FROM profiles WHERE profile_url = ? AND kind = ?')
      .get(normalizedUrl, kind) as unknown as Profile | undefined;
    if (existing) return existing;
    this.db.prepare(
      'INSERT INTO profiles (cohort_id, profile_url, custom_message, kind) VALUES (?, ?, ?, ?)',
    ).run(cohortId, normalizedUrl, customMessage, kind);
    return this.db.prepare('SELECT * FROM profiles WHERE profile_url = ? AND kind = ?')
      .get(normalizedUrl, kind) as unknown as Profile;
  }
  findById(id: number): Profile | undefined {
    return this.db.prepare('SELECT * FROM profiles WHERE id = ?').get(id) as unknown as Profile | undefined;
  }
  countAll(): number {
    return (this.db.prepare('SELECT COUNT(*) c FROM profiles').get() as unknown as { c: number }).c;
  }
  byStatus(status: ProfileStatus): Profile[] {
    return this.db.prepare('SELECT * FROM profiles WHERE status = ? ORDER BY id').all(status) as unknown as Profile[];
  }
  byStatusKind(status: ProfileStatus, kind: CampaignKind): Profile[] {
    return this.db.prepare('SELECT * FROM profiles WHERE status = ? AND kind = ? ORDER BY id')
      .all(status, kind) as unknown as Profile[];
  }
  setStatus(id: number, status: ProfileStatus, fields: Partial<Profile> = {}): void {
    const sets: string[] = ['status = ?'];
    const vals: unknown[] = [status];
    for (const [k, v] of Object.entries(fields)) {
      if (!PROFILE_COLUMNS.has(k)) throw new Error(`Illegal profile column: ${k}`);
      sets.push(`${k} = ?`); vals.push(v);
    }
    vals.push(id);
    this.db.prepare(`UPDATE profiles SET ${sets.join(', ')} WHERE id = ?`).run(...(vals as any[]));
  }
  setScheduled(id: number, iso: string): void {
    this.db.prepare("UPDATE profiles SET status='scheduled', scheduled_for=? WHERE id=?").run(iso, id);
  }
  all(): Profile[] {
    return this.db.prepare('SELECT * FROM profiles ORDER BY id').all() as unknown as Profile[];
  }
  queuedByPriority(): Profile[] {
    return this.db.prepare("SELECT * FROM profiles WHERE status='queued' ORDER BY priority, id").all() as unknown as Profile[];
  }
  queuedByPriorityKind(kind: CampaignKind): Profile[] {
    return this.db.prepare("SELECT * FROM profiles WHERE status='queued' AND kind = ? ORDER BY priority, id")
      .all(kind) as unknown as Profile[];
  }
  setPriority(id: number, priority: number): void {
    this.db.prepare('UPDATE profiles SET priority = ? WHERE id = ?').run(priority, id);
  }
  private queuedBound(kind: 'MIN' | 'MAX'): number {
    const row = this.db.prepare(`SELECT ${kind}(priority) v FROM profiles WHERE status='queued'`).get() as unknown as { v: number | null };
    return row.v ?? 0;
  }
  moveProfile(id: number, to: 'top' | 'bottom'): void {
    const priority = to === 'top' ? this.queuedBound('MIN') - 1 : this.queuedBound('MAX') + 1;
    this.setPriority(id, priority);
  }
  prioritizeCohort(cohortId: number, to: 'top' | 'bottom'): void {
    const priority = to === 'top' ? this.queuedBound('MIN') - 1 : this.queuedBound('MAX') + 1;
    this.db.prepare("UPDATE profiles SET priority = ? WHERE cohort_id = ? AND status = 'queued'").run(priority, cohortId);
  }
  reorderCohorts(orderedCohortIds: number[]): void {
    let p = 0;
    const upd = this.db.prepare('UPDATE profiles SET priority = ? WHERE id = ?');
    for (const cid of orderedCohortIds) {
      const rows = this.db.prepare("SELECT id FROM profiles WHERE status='queued' AND cohort_id = ? ORDER BY id").all(cid) as unknown as { id: number }[];
      for (const r of rows) upd.run(p++, r.id);
    }
  }
  skipCohortQueue(cohortId: number): void {
    this.db.prepare("UPDATE profiles SET status='skipped', skip_reason='dismissed' WHERE cohort_id = ? AND status IN ('queued','scheduled')").run(cohortId);
  }
}

export class EventRepo {
  constructor(private db: DB) {}
  recordSend(profileId: number, outcome: EventType): void {
    this.db.prepare('INSERT INTO send_log (profile_id, outcome) VALUES (?, ?)').run(profileId, outcome);
    this.db.prepare('INSERT INTO profile_events (profile_id, event_type) VALUES (?, ?)').run(profileId, outcome);
  }
  recordEvent(profileId: number, type: EventType): void {
    this.db.prepare('INSERT INTO profile_events (profile_id, event_type) VALUES (?, ?)').run(profileId, type);
  }
  countSentSince(iso: string, kind: CampaignKind): number {
    return (this.db.prepare(`
      SELECT COUNT(*) c FROM send_log s JOIN profiles p ON p.id = s.profile_id
      WHERE s.outcome='sent' AND s.at >= ? AND p.kind = ?`).get(iso, kind) as unknown as { c: number }).c;
  }
}

export class SettingsRepo {
  constructor(private db: DB) {}
  get(): Settings {
    return this.db.prepare('SELECT * FROM settings WHERE id = 1').get() as unknown as Settings;
  }
  update(patch: Partial<Settings>): void {
    const keys = Object.keys(patch).filter((k) => k !== 'id');
    if (keys.length === 0) return;
    for (const k of keys) if (!SETTINGS_COLUMNS.has(k)) throw new Error(`Illegal settings column: ${k}`);
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    const vals = keys.map((k) => (patch as any)[k]);
    this.db.prepare(`UPDATE settings SET ${sets} WHERE id = 1`).run(...(vals as any[]));
  }
}

export class AppStateRepo {
  constructor(private db: DB) {}

  get(): AppState {
    return this.db.prepare('SELECT * FROM app_state WHERE id = 1').get() as unknown as AppState;
  }

  setLogin(snap: { loggedIn: boolean; cookieExpiry: string | null }, confirmedAtIso: string): void {
    this.db.prepare(
      'UPDATE app_state SET login_logged_in = ?, login_cookie_expiry = ?, login_confirmed_at = ? WHERE id = 1',
    ).run(snap.loggedIn ? 1 : 0, snap.cookieExpiry, confirmedAtIso);
  }

  trip(reason: GuardrailReason, detail: string, atIso: string): void {
    this.db.prepare(
      'UPDATE app_state SET guardrail_tripped = 1, guardrail_reason = ?, guardrail_detail = ?, guardrail_tripped_at = ? WHERE id = 1',
    ).run(reason, detail, atIso);
  }

  clearGuardrail(): void {
    this.db.prepare(
      'UPDATE app_state SET guardrail_tripped = 0, guardrail_reason = NULL, guardrail_detail = NULL, guardrail_tripped_at = NULL WHERE id = 1',
    ).run();
  }

  /** Increment the consecutive-failure counter and return the new value. */
  incFailureStreak(): number {
    this.db.prepare('UPDATE app_state SET failure_streak = failure_streak + 1 WHERE id = 1').run();
    return this.get().failure_streak;
  }

  resetFailureStreak(): void {
    this.db.prepare('UPDATE app_state SET failure_streak = 0 WHERE id = 1').run();
  }

  setAcceptanceChecked(iso: string): void {
    this.db.prepare('UPDATE app_state SET acceptance_checked_at = ? WHERE id = 1').run(iso);
  }

  setRepliesChecked(iso: string): void {
    this.db.prepare('UPDATE app_state SET replies_checked_at = ? WHERE id = 1').run(iso);
  }

  setRosterSynced(iso: string): void {
    this.db.prepare('UPDATE app_state SET roster_synced_at = ? WHERE id = 1').run(iso);
  }

  setConnectionsSeeded(iso: string): void {
    this.db.prepare('UPDATE app_state SET connections_seeded_at = ? WHERE id = 1').run(iso);
  }
}

/** Fields an import or scrape may fill. Enrichment columns are deliberately NOT here —
 *  only the phase-2 enrichment worker writes those. */
const CONNECTION_INPUT_COLUMNS = [
  'full_name', 'first_name', 'last_name', 'current_title', 'current_company',
] as const;

const ENRICH_STATUSES: EnrichStatus[] = ['pending', 'enriching', 'enriched', 'empty', 'failed'];

export class ConnectionRepo {
  constructor(private db: DB) {}

  findByUrl(profileUrl: string): Connection | undefined {
    return this.db.prepare('SELECT * FROM connections WHERE profile_url = ?')
      .get(profileUrl) as unknown as Connection | undefined;
  }

  /**
   * Insert or merge one roster row. Merge rules (see the 2026-07-31 design doc):
   *  - `first_seen_at` and `source` record the FIRST sighting and never change.
   *  - `last_seen_at` always advances.
   *  - `connected_on` fills a NULL and is then immutable — the CSV export is its only
   *    real source, and a later sighting has nothing better to offer.
   *  - Everything else fills a NULL, and additionally overwrites on a row that has not
   *    been enriched yet. Once `enrich_status = 'enriched'`, Apify's values win: a stale
   *    CSV must never clobber freshly scraped data.
   */
  upsert(input: ConnectionInput, source: ConnectionSource, nowIso: string): 'inserted' | 'updated' {
    const existing = this.findByUrl(input.profile_url);
    if (!existing) {
      this.db.prepare(`
        INSERT INTO connections
          (profile_url, full_name, first_name, last_name, current_title, current_company,
           connected_on, source, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.profile_url,
        input.full_name ?? null, input.first_name ?? null, input.last_name ?? null,
        input.current_title ?? null, input.current_company ?? null,
        input.connected_on ?? null,
        source, nowIso, nowIso,
      );
      return 'inserted';
    }

    const sets: string[] = ['last_seen_at = ?'];
    const vals: unknown[] = [nowIso];
    const enriched = existing.enrich_status === 'enriched';
    for (const col of CONNECTION_INPUT_COLUMNS) {
      const incoming = input[col];
      if (incoming === undefined || incoming === null || incoming === '') continue;
      if (existing[col] !== null && enriched) continue; // Apify's value stands
      sets.push(`${col} = ?`); vals.push(incoming);
    }
    if (input.connected_on && existing.connected_on === null) {
      sets.push('connected_on = ?'); vals.push(input.connected_on);
    }
    vals.push(input.profile_url);
    this.db.prepare(`UPDATE connections SET ${sets.join(', ')} WHERE profile_url = ?`).run(...(vals as any[]));
    return 'updated';
  }

  /**
   * Upsert a whole roster in ONE transaction.
   *
   * Not a convenience wrapper — a correctness and liveness fix. `node:sqlite` is
   * synchronous, so an import runs on the event loop and blocks the entire server for its
   * duration. Un-batched, each row is its own implicit commit with an fsync: a real 8k
   * Connections.csv measured 6.5s on-disk versus 0.36s in memory, and a 30k export (the
   * LinkedIn maximum) would stall the server for ~25s. One transaction collapses that to a
   * single commit. It also makes the import atomic — a malformed row late in the file can
   * no longer leave the roster half-written.
   */
  upsertMany(
    rows: ConnectionInput[], source: ConnectionSource, nowIso: string,
  ): { inserted: number; updated: number } {
    let inserted = 0; let updated = 0;
    this.db.exec('BEGIN');
    try {
      for (const row of rows) {
        if (this.upsert(row, source, nowIso) === 'inserted') inserted++;
        else updated++;
      }
      this.db.exec('COMMIT');
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
      throw e;
    }
    return { inserted, updated };
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) c FROM connections').get() as unknown as { c: number }).c;
  }

  /**
   * Every roster URL, including aliased old slugs. Used by the acceptance check, which asks
   * "is this sent invite's URL a connection yet?" — an invite sent to a slug the person has
   * since changed must still resolve, or it would sit pending forever.
   */
  allUrls(): Set<string> {
    const rows = this.db.prepare(
      'SELECT profile_url FROM connections UNION SELECT profile_url FROM connection_aliases',
    ).all() as unknown as { profile_url: string }[];
    return new Set(rows.map((r) => r.profile_url));
  }

  countsByEnrichStatus(): Record<EnrichStatus, number> {
    const out = Object.fromEntries(ENRICH_STATUSES.map((s) => [s, 0])) as Record<EnrichStatus, number>;
    const rows = this.db.prepare('SELECT enrich_status s, COUNT(*) c FROM connections GROUP BY enrich_status')
      .all() as unknown as { s: EnrichStatus; c: number }[];
    for (const r of rows) if (r.s in out) out[r.s] = r.c;
    return out;
  }

  list(limit: number, offset: number): Connection[] {
    return this.db.prepare('SELECT * FROM connections ORDER BY id DESC LIMIT ? OFFSET ?')
      .all(limit, offset) as unknown as Connection[];
  }

  /* ---------- enrichment lifecycle ---------- */

  /**
   * Atomically take up to `limit` pending rows and mark them `enriching`.
   *
   * The claim is what keeps a concurrent worker pool from scraping (and paying for) the
   * same person twice: selection and the status flip happen in one transaction, so two
   * in-flight callers can never see the same row as pending.
   */
  claimForEnrichment(limit: number): Connection[] {
    if (limit <= 0) return [];
    this.db.exec('BEGIN');
    try {
      const rows = this.db.prepare(
        "SELECT * FROM connections WHERE enrich_status = 'pending' ORDER BY id LIMIT ?",
      ).all(limit) as unknown as Connection[];
      const upd = this.db.prepare("UPDATE connections SET enrich_status = 'enriching' WHERE id = ?");
      for (const r of rows) upd.run(r.id);
      this.db.exec('COMMIT');
      return rows.map((r) => ({ ...r, enrich_status: 'enriching' as EnrichStatus }));
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
      throw e;
    }
  }

  /**
   * Store a successful scrape: scalars, `raw_json`, the FTS document, and `enriched`.
   *
   * If the payload's `linkedin_id` already belongs to a DIFFERENT row, this is the same
   * person under a changed public slug — merge into the older row, alias the newer URL, and
   * delete the duplicate. A null id never merges: two un-identified people sharing a NULL
   * are not the same person, and merging them would destroy one.
   */
  applyEnrichment(id: number, p: EnrichedProfile, nowIso: string): void {
    this.db.exec('BEGIN');
    try {
      let targetId = id;
      if (p.linkedin_id) {
        const other = this.db.prepare(
          'SELECT id FROM connections WHERE linkedin_id = ? AND id != ? ORDER BY id LIMIT 1',
        ).get(p.linkedin_id, id) as unknown as { id: number } | undefined;
        if (other) {
          // Keep the older row (lower id) — it holds the earlier first_seen_at and any
          // connected_on the CSV gave us.
          const keep = Math.min(other.id, id);
          const drop = Math.max(other.id, id);
          const dropUrl = (this.db.prepare('SELECT profile_url FROM connections WHERE id = ?')
            .get(drop) as unknown as { profile_url: string }).profile_url;
          this.db.prepare('INSERT OR REPLACE INTO connection_aliases (profile_url, connection_id) VALUES (?, ?)')
            .run(dropUrl, keep);
          this.db.prepare('DELETE FROM connections_fts WHERE rowid = ?').run(drop);
          this.db.prepare('DELETE FROM connections WHERE id = ?').run(drop);
          targetId = keep;
        }
      }

      this.db.prepare(`
        UPDATE connections SET
          linkedin_id = ?, public_identifier = ?, full_name = ?, first_name = ?, last_name = ?,
          headline = ?, location_raw = ?, location_city = ?, location_region = ?,
          location_country = ?, location_country_code = ?, current_title = ?, current_company = ?,
          raw_json = ?, enrich_status = 'enriched', enrich_error = NULL, enriched_at = ?
        WHERE id = ?
      `).run(
        p.linkedin_id, p.public_identifier, p.full_name, p.first_name, p.last_name,
        p.headline, p.location_raw, p.location_city, p.location_region,
        p.location_country, p.location_country_code, p.current_title, p.current_company,
        JSON.stringify(p.compact), nowIso, targetId,
      );

      // Delete-then-insert: FTS5 has no UPSERT, and leaving the old document behind would
      // keep a superseded job title matching forever.
      this.db.prepare('DELETE FROM connections_fts WHERE rowid = ?').run(targetId);
      this.db.prepare('INSERT INTO connections_fts (rowid, doc) VALUES (?, ?)').run(targetId, p.doc);

      this.db.exec('COMMIT');
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
      throw e;
    }
  }

  /**
   * Record a failed attempt. Returns to `pending` for another try until `maxAttempts`, then
   * parks as `failed` — never auto-retried again, because every attempt bills.
   */
  markEnrichFailure(id: number, error: string, maxAttempts: number): void {
    this.db.prepare(`
      UPDATE connections
      SET enrich_attempts = enrich_attempts + 1,
          enrich_error = ?,
          enrich_status = CASE WHEN enrich_attempts + 1 >= ? THEN 'failed' ELSE 'pending' END
      WHERE id = ?
    `).run(error, maxAttempts, id);
  }

  /**
   * Park a silent-empty shell. Terminal on the first sighting: a restricted or deleted
   * profile does not become scrapeable on retry, so paying to find out again is waste.
   */
  markEnrichEmpty(id: number): void {
    this.db.prepare(
      "UPDATE connections SET enrich_attempts = enrich_attempts + 1, enrich_status = 'empty' WHERE id = ?",
    ).run(id);
  }

  /** Return rows stranded mid-flight (pause, crash) to pending. Returns how many. */
  requeueEnriching(): number {
    const info = this.db.prepare("UPDATE connections SET enrich_status = 'pending' WHERE enrich_status = 'enriching'").run();
    return Number(info.changes);
  }

  /** Enriched rows whose data is older than the TTL. Parked rows are deliberately excluded. */
  dueForRefresh(ttlDays: number, now: Date): Connection[] {
    const cutoff = new Date(now.getTime() - ttlDays * 86_400_000).toISOString();
    return this.db.prepare(
      "SELECT * FROM connections WHERE enrich_status = 'enriched' AND enriched_at IS NOT NULL AND enriched_at < ? ORDER BY enriched_at",
    ).all(cutoff) as unknown as Connection[];
  }

  /** Move TTL-stale rows back into the queue. Returns how many. */
  requeueForRefresh(ttlDays: number, now: Date): number {
    const cutoff = new Date(now.getTime() - ttlDays * 86_400_000).toISOString();
    const info = this.db.prepare(
      "UPDATE connections SET enrich_status = 'pending', enrich_attempts = 0 WHERE enrich_status = 'enriched' AND enriched_at IS NOT NULL AND enriched_at < ?",
    ).run(cutoff);
    return Number(info.changes);
  }

  /** Operator-driven re-arm of parked rows. Never automatic. Returns how many. */
  resetFailed(): number {
    const info = this.db.prepare(
      "UPDATE connections SET enrich_status = 'pending', enrich_attempts = 0, enrich_error = NULL WHERE enrich_status IN ('failed', 'empty')",
    ).run();
    return Number(info.changes);
  }
}

export class Repos {
  cohorts: CohortRepo;
  profiles: ProfileRepo;
  events: EventRepo;
  settings: SettingsRepo;
  appState: AppStateRepo;
  connections: ConnectionRepo;
  constructor(public db: DB) {
    this.cohorts = new CohortRepo(db);
    this.profiles = new ProfileRepo(db);
    this.events = new EventRepo(db);
    this.settings = new SettingsRepo(db);
    this.appState = new AppStateRepo(db);
    this.connections = new ConnectionRepo(db);
  }
}
