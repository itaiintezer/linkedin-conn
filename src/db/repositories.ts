import type { DB } from './database.js';
import type { Cohort, Profile, Settings, ProfileStatus, EventType } from '../types.js';

export class CohortRepo {
  constructor(private db: DB) {}
  create(name: string, template: string | null, allowNoNote: boolean): Cohort {
    this.db.prepare(
      'INSERT INTO cohorts (name, message_template, allow_no_note) VALUES (?, ?, ?)',
    ).run(name, template, allowNoNote ? 1 : 0);
    return this.findByName(name)!;
  }
  findByName(name: string): Cohort | undefined {
    return this.db.prepare('SELECT * FROM cohorts WHERE name = ?').get(name) as Cohort | undefined;
  }
  findById(id: number): Cohort | undefined {
    return this.db.prepare('SELECT * FROM cohorts WHERE id = ?').get(id) as Cohort | undefined;
  }
  list(): Cohort[] {
    return this.db.prepare('SELECT * FROM cohorts ORDER BY created_at DESC').all() as Cohort[];
  }
  getOrCreate(name: string, template: string | null, allowNoNote: boolean): Cohort {
    return this.findByName(name) ?? this.create(name, template, allowNoNote);
  }
}

export class ProfileRepo {
  constructor(private db: DB) {}
  add(cohortId: number, normalizedUrl: string, customMessage: string | null): Profile {
    const existing = this.db
      .prepare('SELECT * FROM profiles WHERE profile_url = ?')
      .get(normalizedUrl) as Profile | undefined;
    if (existing) return existing;
    this.db.prepare(
      'INSERT INTO profiles (cohort_id, profile_url, custom_message) VALUES (?, ?, ?)',
    ).run(cohortId, normalizedUrl, customMessage);
    return this.db.prepare('SELECT * FROM profiles WHERE profile_url = ?').get(normalizedUrl) as Profile;
  }
  countAll(): number {
    return (this.db.prepare('SELECT COUNT(*) c FROM profiles').get() as { c: number }).c;
  }
  byStatus(status: ProfileStatus): Profile[] {
    return this.db.prepare('SELECT * FROM profiles WHERE status = ? ORDER BY id').all(status) as Profile[];
  }
  setStatus(id: number, status: ProfileStatus, fields: Partial<Profile> = {}): void {
    const sets: string[] = ['status = ?'];
    const vals: unknown[] = [status];
    for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = ?`); vals.push(v); }
    vals.push(id);
    this.db.prepare(`UPDATE profiles SET ${sets.join(', ')} WHERE id = ?`).run(...(vals as any[]));
  }
  setScheduled(id: number, iso: string): void {
    this.db.prepare("UPDATE profiles SET status='scheduled', scheduled_for=? WHERE id=?").run(iso, id);
  }
  all(): Profile[] {
    return this.db.prepare('SELECT * FROM profiles ORDER BY id').all() as Profile[];
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
      .get(iso) as { c: number }).c;
  }
}

export class SettingsRepo {
  constructor(private db: DB) {}
  get(): Settings {
    return this.db.prepare('SELECT * FROM settings WHERE id = 1').get() as Settings;
  }
  update(patch: Partial<Settings>): void {
    const keys = Object.keys(patch).filter((k) => k !== 'id');
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    const vals = keys.map((k) => (patch as any)[k]);
    this.db.prepare(`UPDATE settings SET ${sets} WHERE id = 1`).run(...(vals as any[]));
  }
}

export class Repos {
  cohorts: CohortRepo;
  profiles: ProfileRepo;
  events: EventRepo;
  settings: SettingsRepo;
  constructor(public db: DB) {
    this.cohorts = new CohortRepo(db);
    this.profiles = new ProfileRepo(db);
    this.events = new EventRepo(db);
    this.settings = new SettingsRepo(db);
  }
}
