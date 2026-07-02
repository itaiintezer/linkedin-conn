import type { DB } from './database.js';
import type { Cohort, Profile, Settings, ProfileStatus, EventType, AppState, GuardrailReason } from '../types.js';

const PROFILE_COLUMNS = new Set([
  'first_name', 'custom_message', 'attempts', 'last_error',
  'scheduled_for', 'sent_at', 'accepted_at', 'resolved_at',
]);
const SETTINGS_COLUMNS = new Set([
  'workday_start_hour', 'workday_end_hour', 'weekdays_only', 'weekly_cap',
  'batch_size', 'batches_per_day', 'acceptance_checks_per_day', 'account_type',
  'note_quota_exhausted', 'min_delay_ms', 'max_delay_ms', 'paused', 'pause_reason',
  'onboarded',
  'failure_threshold',
  'expiry_days',
]);

export class CohortRepo {
  constructor(private db: DB) {}
  create(name: string, template: string | null, allowNoNote: boolean): Cohort {
    this.db.prepare(
      'INSERT INTO cohorts (name, message_template, allow_no_note) VALUES (?, ?, ?)',
    ).run(name, template, allowNoNote ? 1 : 0);
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
  getOrCreate(name: string, template: string | null, allowNoNote: boolean): Cohort {
    const existing = this.findByName(name);
    if (!existing) return this.create(name, template, allowNoNote);
    // Adding under an archived name resurrects the cohort — otherwise the new
    // profiles would queue into a cohort the UI can't show.
    if (existing.archived) { this.setArchived(existing.id, false); return this.findById(existing.id)!; }
    return existing;
  }
}

export class ProfileRepo {
  constructor(private db: DB) {}
  add(cohortId: number, normalizedUrl: string, customMessage: string | null): Profile {
    const existing = this.db
      .prepare('SELECT * FROM profiles WHERE profile_url = ?')
      .get(normalizedUrl) as unknown as Profile | undefined;
    if (existing) return existing;
    this.db.prepare(
      'INSERT INTO profiles (cohort_id, profile_url, custom_message) VALUES (?, ?, ?)',
    ).run(cohortId, normalizedUrl, customMessage);
    return this.db.prepare('SELECT * FROM profiles WHERE profile_url = ?').get(normalizedUrl) as unknown as Profile;
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
    this.db.prepare("UPDATE profiles SET status='skipped' WHERE cohort_id = ? AND status IN ('queued','scheduled')").run(cohortId);
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
  countSentSince(iso: string): number {
    return (this.db
      .prepare("SELECT COUNT(*) c FROM send_log WHERE outcome='sent' AND at >= ?")
      .get(iso) as unknown as { c: number }).c;
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
}

export class Repos {
  cohorts: CohortRepo;
  profiles: ProfileRepo;
  events: EventRepo;
  settings: SettingsRepo;
  appState: AppStateRepo;
  constructor(public db: DB) {
    this.cohorts = new CohortRepo(db);
    this.profiles = new ProfileRepo(db);
    this.events = new EventRepo(db);
    this.settings = new SettingsRepo(db);
    this.appState = new AppStateRepo(db);
  }
}
