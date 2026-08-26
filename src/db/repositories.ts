import type { DB } from './database.js';
import type {
  Cohort, Profile, Settings, ProfileStatus, EventType, AppState, GuardrailReason, CampaignKind,
  Connection, ConnectionInput, ConnectionSource, EnrichStatus, EnrichedProfile, EnrichHaltReason,
  PostsHaltReason,
} from '../types.js';
import { firstNameFrom } from '../core/first-name.js';
import type { ReservationWindow } from '../core/reservations.js';
import {
  EventCampaignRepo, EventBucketRepo, EventInviteeRepo, EventRunRepo,
} from './event-repos.js';
import { EngagementRepo } from './engagement-repo.js';
import { PostRepo, TrackedProfileRepo } from './posts-repos.js';

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
  'events_per_day', 'event_invite_cap', 'event_bucket_ceiling',
  'event_run_budget_minutes', 'event_shard_threshold',
  'engage_weekly_cap', 'engage_batch_size', 'engage_batches_per_day',
  'engage_comment_daily_cap',
  'posts_sweep_per_day', 'posts_max_per_sweep', 'posts_sweep_batch_size',
  'posts_retention_days', 'tracked_profile_cap',
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
  /**
   * Insert, or return the row that already holds this (url, kind) — with one exception:
   * a row skipped as 'dismissed' was never processed, only set aside by the operator
   * (cohort archived, or removed from the queue), so re-adding it adopts it into the new
   * cohort and re-queues it as if fresh. Every other skip reason is a LinkedIn-observed
   * verdict, and rows with real send history must never be re-sent — those stay untouched.
   */
  add(cohortId: number, normalizedUrl: string, customMessage: string | null, kind: CampaignKind = 'invite'): Profile {
    const existing = this.db
      .prepare('SELECT * FROM profiles WHERE profile_url = ? AND kind = ?')
      .get(normalizedUrl, kind) as unknown as Profile | undefined;
    if (existing) {
      if (existing.status === 'skipped' && existing.skip_reason === 'dismissed') {
        this.db.prepare(`
          UPDATE profiles SET cohort_id = ?, custom_message = ?, status = 'queued',
            skip_reason = NULL, scheduled_for = NULL, attempts = 0, last_error = NULL, priority = 0
          WHERE id = ?
        `).run(cohortId, customMessage, existing.id);
        return this.findById(existing.id)!;
      }
      return existing;
    }
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
  /**
   * Move rows to the front of the queue by JOINING the existing front block, not going one
   * below it: every id gets MIN(queued priority) when that is already negative, else -1.
   * Deliberately NOT moveProfile's MIN-1: a prioritized *add* must converge on the same
   * order whether N profiles arrive as one list or as N calls — with MIN-1 each new arrival
   * would jump ahead of the last, reversing a one-by-one sequence. Sharing one value defers
   * ordering to the (priority, id) tie-break, which IS arrival order. moveProfile keeps
   * MIN-1 on purpose: "put THIS one first" is the opposite intent.
   */
  frontBlock(ids: number[]): void {
    if (ids.length === 0) return;
    const min = this.queuedBound('MIN');
    const priority = min < 0 ? min : -1;
    const upd = this.db.prepare('UPDATE profiles SET priority = ? WHERE id = ?');
    for (const id of ids) upd.run(priority, id);
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
  /**
   * `atIso` is written explicitly rather than left to the column DEFAULT. Both are the same
   * shape today (see schema.sql), but leaving it to the default would mean the weekly counter
   * compares SQLite's clock against JS's `windowStartIso`, and the timestamp would be
   * untestable — `datetime('now')` does not move under vitest's fake timers.
   */
  recordSend(profileId: number, outcome: EventType, atIso: string = new Date().toISOString()): void {
    this.db.prepare('INSERT INTO send_log (profile_id, outcome, at) VALUES (?, ?, ?)').run(profileId, outcome, atIso);
    this.db.prepare('INSERT INTO profile_events (profile_id, event_type, at) VALUES (?, ?, ?)').run(profileId, outcome, atIso);
  }
  recordEvent(profileId: number, type: EventType, atIso: string = new Date().toISOString()): void {
    this.db.prepare('INSERT INTO profile_events (profile_id, event_type, at) VALUES (?, ?, ?)').run(profileId, type, atIso);
  }
  /**
   * `iso` MUST be a toISOString() value — it is compared to `at` as TEXT, which is only a
   * chronological comparison because schema.sql pins both columns to that exact shape.
   */
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

  /**
   * Latch "automatic enrichment stopped, and here is why".
   *
   * Separate from the guardrail on purpose: that one means the LinkedIn session is in
   * trouble, this one only ever means Apify work cannot proceed. Clearing either must
   * never clear the other. `detail` is operator-facing text and must never carry the token.
   */
  haltEnrichment(reason: EnrichHaltReason, detail: string, atIso: string): void {
    this.db.prepare(
      'UPDATE app_state SET enrich_halted = 1, enrich_halt_reason = ?, enrich_halt_detail = ?, enrich_halted_at = ? WHERE id = 1',
    ).run(reason, detail, atIso);
  }

  /** Clear the latch entirely — a half-cleared halt would render a stale reason. */
  clearEnrichHalt(): void {
    this.db.prepare(
      'UPDATE app_state SET enrich_halted = 0, enrich_halt_reason = NULL, enrich_halt_detail = NULL, enrich_halted_at = NULL WHERE id = 1',
    ).run();
  }

  /** Latch the posts sweep off. An ERROR latch, not a spend cap. */
  haltPosts(reason: PostsHaltReason, detail: string, atIso: string): void {
    this.db.prepare(
      'UPDATE app_state SET posts_halted = 1, posts_halt_reason = ?, posts_halt_detail = ?, posts_halted_at = ? WHERE id = 1',
    ).run(reason, detail, atIso);
  }

  /** Clear the latch entirely — a half-cleared halt would render a stale reason. */
  clearPostsHalt(): void {
    this.db.prepare(
      'UPDATE app_state SET posts_halted = 0, posts_halt_reason = NULL, posts_halt_detail = NULL, posts_halted_at = NULL WHERE id = 1',
    ).run();
  }

  /** Stamped ONLY on a clean sweep, so a failed pass is retried by the next tick. */
  markPostsSwept(atIso: string): void {
    this.db.prepare('UPDATE app_state SET posts_swept_at = ? WHERE id = 1').run(atIso);
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

  /** Roster rows for a batch of normalized URLs. Missing URLs simply do not come back —
   *  the caller reports them as "not a connection". Chunked to stay under SQLite's
   *  999-parameter limit, which a 500-person invitee list would otherwise blow. */
  findManyByUrls(profileUrls: string[]): Connection[] {
    const out: Connection[] = [];
    for (let i = 0; i < profileUrls.length; i += 500) {
      const chunk = profileUrls.slice(i, i + 500);
      if (chunk.length === 0) continue;
      const holes = chunk.map(() => '?').join(',');
      out.push(...this.db.prepare(`SELECT * FROM connections WHERE profile_url IN (${holes})`)
        .all(...chunk) as unknown as Connection[]);
    }
    return out;
  }

  /**
   * How many connections sit in each location bucket, keyed exactly like
   * `event-buckets.keyId()` so the two can be joined without a translation layer.
   *
   * This is the number the 1000-row picker cap acts on, so it decides SHARDING — never
   * ranking. Rows that bucketing would call unreachable (no country; US with no state)
   * are excluded here too, so the two agree.
   */
  locationHistogram(): Map<string, number> {
    const rows = this.db.prepare(`
      SELECT CASE WHEN location_country_code = 'US'
                  THEN 'us_state:' || location_region
                  ELSE 'country:' || location_country END AS k,
             COUNT(*) AS c
      FROM connections
      WHERE location_country IS NOT NULL AND TRIM(location_country) <> ''
        AND NOT (location_country_code = 'US'
                 AND (location_region IS NULL OR TRIM(location_region) = ''))
      GROUP BY k
    `).all() as unknown as { k: string; c: number }[];
    return new Map(rows.map((r) => [r.k, r.c]));
  }

  /** Child regions of a country, biggest first — the shards for an oversized bucket. */
  childRegions(country: string): { region: string; count: number }[] {
    return this.db.prepare(`
      SELECT location_region AS region, COUNT(*) AS count
      FROM connections
      WHERE location_country = ? AND location_region IS NOT NULL AND TRIM(location_region) <> ''
      GROUP BY location_region ORDER BY count DESC
    `).all(country) as unknown as { region: string; count: number }[];
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
    // Same rule as enrichment: whatever the source, the stored greeting name is sanitised.
    const cleanFirst = firstNameFrom(input.first_name) ?? firstNameFrom(input.full_name);
    if (!existing) {
      this.db.prepare(`
        INSERT INTO connections
          (profile_url, full_name, first_name, last_name, current_title, current_company,
           connected_on, source, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.profile_url,
        input.full_name ?? null, cleanFirst, input.last_name ?? null,
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
      // first_name is the derived, sanitised value — never the caller's raw fragment. The
      // fill-NULLs / overwrite-while-un-enriched rule below is unchanged; only the value is.
      const incoming = col === 'first_name' ? cleanFirst : input[col];
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

  /**
   * Rewrite every stored greeting name through firstNameFrom. One-time repair for rows
   * written before sanitisation existed; safe to re-run (it only writes rows whose value
   * would actually change, and re-sanitising a clean name is a no-op).
   *
   * Only `first_name` is touched — `full_name` stays verbatim as the display name, and is
   * the input the repair derives from when the stored first name is unusable.
   *
   * The repair is decided in full BEFORE anything is written, so a run with nothing to do
   * opens no transaction and — via `beforeWrite` — takes no backup. That is what keeps a
   * fresh install from snapshotting its whole database to guard a migration it never needs:
   * rows written after sanitisation existed are already correct. `beforeWrite` runs at most
   * once, immediately before the first UPDATE.
   *
   * Returns how many rows changed.
   */
  backfillFirstNames(beforeWrite?: () => void): number {
    const rows = this.db.prepare('SELECT id, first_name, full_name FROM connections')
      .all() as unknown as { id: number; first_name: string | null; full_name: string | null }[];

    const pending: { id: number; next: string | null }[] = [];
    for (const r of rows) {
      const next = firstNameFrom(r.first_name) ?? firstNameFrom(r.full_name);
      if (next !== r.first_name) pending.push({ id: r.id, next });
    }
    if (pending.length === 0) return 0;

    beforeWrite?.();
    const upd = this.db.prepare('UPDATE connections SET first_name = ? WHERE id = ?');
    this.db.exec('BEGIN');
    try {
      for (const p of pending) upd.run(p.next, p.id);
      this.db.exec('COMMIT');
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
      throw e;
    }
    return pending.length;
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

/**
 * Windows the send planner must route around. Generic on purpose — the event-invite run
 * is the first user, but anything needing the single browser to itself for a stretch can
 * claim one.
 *
 * Note the name: `EventRepo` above is the send_log/profile_events repo and predates the
 * event-invite pipeline entirely. These are unrelated.
 */
export class ReservationRepo {
  constructor(private db: DB) {}

  /** Reservations overlapping [from, to). */
  between(fromIso: string, toIso: string): ReservationWindow[] {
    return this.db.prepare(
      'SELECT from_ts, to_ts FROM reservations WHERE to_ts > ? AND from_ts < ? ORDER BY from_ts',
    ).all(fromIso, toIso) as unknown as ReservationWindow[];
  }

  create(fromIso: string, toIso: string, purpose: string, refId: number | null): number {
    const r = this.db.prepare(
      'INSERT INTO reservations (from_ts, to_ts, purpose, ref_id) VALUES (?, ?, ?, ?)',
    ).run(fromIso, toIso, purpose, refId);
    return Number(r.lastInsertRowid);
  }

  /** Drop every reservation held for one ref — used when a campaign is disarmed or done. */
  clearFor(purpose: string, refId: number): void {
    this.db.prepare('DELETE FROM reservations WHERE purpose = ? AND ref_id = ?').run(purpose, refId);
  }

  /** Housekeeping: reservations whose window has fully passed are dead weight. */
  purgeBefore(iso: string): number {
    return this.db.prepare('DELETE FROM reservations WHERE to_ts < ?').run(iso).changes as number;
  }
}

export class Repos {
  cohorts: CohortRepo;
  profiles: ProfileRepo;
  events: EventRepo;
  settings: SettingsRepo;
  appState: AppStateRepo;
  connections: ConnectionRepo;
  reservations: ReservationRepo;
  /** Event-invite pipeline. Note `events` above is the send_log repo — unrelated. */
  eventCampaigns: EventCampaignRepo;
  eventBuckets: EventBucketRepo;
  eventInvitees: EventInviteeRepo;
  eventRuns: EventRunRepo;
  /** Post engagements — the fourth pipeline. */
  engagements: EngagementRepo;
  /** Posts feed — the tracked set. */
  trackedProfiles: TrackedProfileRepo;
  /** Posts feed — the swept posts. */
  posts: PostRepo;
  constructor(public db: DB) {
    this.cohorts = new CohortRepo(db);
    this.profiles = new ProfileRepo(db);
    this.events = new EventRepo(db);
    this.settings = new SettingsRepo(db);
    this.appState = new AppStateRepo(db);
    this.connections = new ConnectionRepo(db);
    this.reservations = new ReservationRepo(db);
    this.eventCampaigns = new EventCampaignRepo(db);
    this.eventBuckets = new EventBucketRepo(db);
    this.eventInvitees = new EventInviteeRepo(db);
    this.eventRuns = new EventRunRepo(db);
    this.engagements = new EngagementRepo(db);
    this.trackedProfiles = new TrackedProfileRepo(db);
    this.posts = new PostRepo(db);
  }
}
