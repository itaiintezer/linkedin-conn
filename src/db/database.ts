import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export type DB = DatabaseSync;

// Columns a pre-messaging profiles table can have, in the order the rebuild migration
// carries them over. Keep in sync with the profiles table in schema.sql: a column added
// there must also be added here, or runMigrations throws (see the orphaned-columns check
// below) instead of silently dropping it during the rebuild.
const LEGACY_CARRY_COLUMNS = [
  'id', 'cohort_id', 'profile_url', 'first_name', 'custom_message', 'status',
  'attempts', 'last_error', 'skip_reason', 'scheduled_for', 'sent_at', 'accepted_at',
  'resolved_at', 'priority', 'created_at',
];

export function openDatabase(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  // Safety net before the connection-roster migration first touches a production database.
  // Detection: the connections table is absent exactly on pre-roster databases — so this
  // MUST run before schema.sql's CREATE TABLE IF NOT EXISTS makes that undetectable. Runs
  // at most once, skipped as soon as the backup exists. :memory: has no file to copy.
  if (path !== ':memory:') {
    const hasTable = (name: string) =>
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;
    const rosterBackup = `${path}.pre-connections-backup`;
    if (hasTable('profiles') && !hasTable('connections') && !existsSync(rosterBackup)) {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); // fold the WAL in — a bare file copy misses it
      copyFileSync(path, rosterBackup);
    }
  }
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  // One-time safety net for the only destructive migration in this project's history: the
  // profiles table rebuild in runMigrations rewrites every row. Snapshot the file first so
  // an operator can recover manually if the rebuild goes wrong in a way the transaction
  // wrapper doesn't catch (e.g. disk corruption). :memory: has no file to copy. Detection
  // mirrors the migration's own guard (profiles lacking `kind`), and is skipped once the
  // backup already exists so this runs at most once per database.
  if (path !== ':memory:') {
    const profileCols = (db.prepare('PRAGMA table_info(profiles)').all() as { name: string }[]).map((c) => c.name);
    const backupPath = `${path}.pre-kind-backup`;
    if (profileCols.length > 0 && !profileCols.includes('kind') && !existsSync(backupPath)) {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); // fold the WAL in — a bare file copy misses it
      copyFileSync(path, backupPath);
    }
  }
  // Safety net before the log-timestamp rebuild rewrites every send_log/profile_events row.
  // Same shape as the two snapshots above, and schema-detectable for the same reason the
  // pre-kind one is: CREATE TABLE IF NOT EXISTS above cannot change an existing table's
  // DEFAULT, so a legacy table still declares datetime('now') at this point. A fresh
  // database was just created with the ISO default and is correctly skipped.
  if (path !== ':memory:' && logTablesNeedIsoRebuild(db)) {
    snapshotOnce(db, path, 'pre-log-iso-backup');
  }
  runMigrations(db);
  return db;
}

/**
 * Copy the database file aside once, before something rewrites data in bulk.
 *
 * Unlike the two snapshots in `openDatabase`, this one cannot be triggered by inspecting the
 * schema: the first-name backfill repairs *values*, and a database that needs repairing looks
 * exactly like one that does not. So the caller decides, and calls this only when it is about
 * to actually write — otherwise every new install would copy its whole database on the second
 * start to guard a migration that will never run for it.
 *
 * Returns whether a file was written (false when one already exists, or on :memory:).
 */
export function snapshotOnce(db: DB, path: string, suffix: string): boolean {
  if (path === ':memory:') return false;
  const dest = `${path}.${suffix}`;
  if (existsSync(dest)) return false;
  db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); // fold the WAL in — a bare file copy misses it
  copyFileSync(path, dest);
  return true;
}

/** The exact shape toISOString() produces, as a SQLite expression and a GLOB. */
const ISO_NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const ISO_GLOB = "'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'";

/** The two tables whose `at` column was written by the datetime('now') default. */
const LOG_TABLES = [
  { table: 'send_log', payload: 'outcome', index: 'CREATE INDEX IF NOT EXISTS idx_send_log_at ON send_log(at)' },
  { table: 'profile_events', payload: 'event_type', index: 'CREATE INDEX IF NOT EXISTS idx_events_type ON profile_events(event_type)' },
] as const;

/**
 * True when `table` exists and still declares the legacy `datetime('now')` default on `at`.
 *
 * Detection is on the STORED CREATE statement, not the data: a table whose rows happen to
 * have been repaired but whose default is still the space form is exactly the trap this
 * rebuild closes, so the default is what decides. `at` is the only defaulted column in
 * either table, which is what makes the substring test precise.
 *
 * Checked per table rather than once for both: a production database has both, but isolated
 * migration tests build partial fixtures, and one missing table must not skip — or crash —
 * the rebuild of the other.
 */
function needsIsoRebuild(db: DB, table: string): boolean {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as
    unknown as { sql: string } | undefined;
  return row !== undefined && row.sql.includes("datetime('now')");
}

/** Whether any log table needs the rebuild — openDatabase's cue to snapshot the file first. */
function logTablesNeedIsoRebuild(db: DB): boolean {
  return LOG_TABLES.some(({ table }) => needsIsoRebuild(db, table));
}

/**
 * Rebuild send_log/profile_events with the ISO default and a shape CHECK, converting stored
 * values in the same pass.
 *
 * A rebuild rather than an UPDATE of the values, because an in-place repair cannot change a
 * column DEFAULT and SQLite cannot ALTER one in: the production table would keep emitting the
 * space form for the next INSERT that omits `at`, which is precisely how the bug survived.
 * Nothing FK-references these two tables, so unlike the profiles rebuild there is nothing to
 * re-point — but foreign_keys is suspended anyway, since both hold an FK *to* profiles and
 * the swap drops the child table out from under it.
 *
 * strftime() returns NULL for anything it cannot parse, which the NOT NULL then rejects and
 * the transaction rolls back on. That is deliberate: a timestamp this code cannot interpret
 * is a row that would silently drop out of the weekly counter, which is the bug, not the fix.
 */
function rebuildLogTablesAsIso(db: DB): void {
  if (!logTablesNeedIsoRebuild(db)) return;
  // PRAGMA foreign_keys is a no-op inside a transaction, so it is toggled outside the
  // BEGIN/COMMIT below; restored in `finally` regardless of how the transaction ends.
  db.exec('PRAGMA foreign_keys = OFF;');
  try {
    db.exec('BEGIN');
    for (const { table, payload, index } of LOG_TABLES) {
      if (!needsIsoRebuild(db, table)) continue;
      db.exec(`DROP TABLE IF EXISTS ${table}_new`); // stale table from an interrupted earlier attempt
      db.exec(`
        -- Keep in sync with ${table} in schema.sql.
        CREATE TABLE ${table}_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_id INTEGER NOT NULL REFERENCES profiles(id),
          ${payload} TEXT NOT NULL,
          at TEXT NOT NULL DEFAULT (${ISO_NOW_SQL}) CHECK (at GLOB ${ISO_GLOB})
        );
      `);
      // Ids are preserved so anything holding one still resolves. strftime() is a no-op on a
      // value that is already this shape, which is what makes a re-run harmless.
      db.exec(`
        INSERT INTO ${table}_new (id, profile_id, ${payload}, at)
        SELECT id, profile_id, ${payload}, strftime('%Y-%m-%dT%H:%M:%fZ', at) FROM ${table};
      `);
      db.exec(`DROP TABLE ${table}; ALTER TABLE ${table}_new RENAME TO ${table}; ${index};`);
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
    throw e;
  } finally {
    db.exec('PRAGMA foreign_keys = ON;');
  }
}

/** Idempotent schema migrations for databases created before a column existed. */
export function runMigrations(db: DB): void {
  const cols = (db.prepare('PRAGMA table_info(settings)').all() as { name: string }[]).map((c) => c.name);
  // Guard on table presence: isolated migration tests may operate on a DB without
  // the settings table. table_info returns [] for a missing table.
  if (cols.length > 0 && !cols.includes('onboarded')) {
    db.exec('ALTER TABLE settings ADD COLUMN onboarded INTEGER NOT NULL DEFAULT 0');
    // Don't show the wizard to users who had already configured the (since-removed)
    // account type. Guarded because the column is dropped further down: a database old
    // enough to lack `onboarded` still has it, a newer one has neither.
    if (cols.includes('account_type')) {
      db.exec("UPDATE settings SET onboarded = 1 WHERE account_type != 'unknown'");
    }
  }
  // Note: new tables (e.g. app_state) need no migration here — schema.sql's
  // `CREATE TABLE IF NOT EXISTS` runs on every openDatabase and back-fills them.
  // Only new columns on pre-existing tables require an explicit ALTER below.
  if (cols.length > 0 && !cols.includes('failure_threshold')) {
    db.exec('ALTER TABLE settings ADD COLUMN failure_threshold INTEGER NOT NULL DEFAULT 3');
  }
  if (cols.length > 0 && !cols.includes('expiry_days')) {
    db.exec('ALTER TABLE settings ADD COLUMN expiry_days INTEGER NOT NULL DEFAULT 0');
  }
  // account_type (free/premium/salesnav) was collected by the setup wizard but never read
  // by anything — limits always came from weekly_cap/batch_size. Removed 2026-07-28; drop
  // the dead column so the schema matches the code. Must run after the onboarded back-fill
  // above, which is the last thing that read it.
  //
  // CAREFUL, read this before adding a THIRD drop anywhere in this function. DROP COLUMN
  // is implemented as a text edit of the stored CREATE TABLE statement, and when the
  // target is the table's LAST column SQLite scans backwards for the preceding comma
  // WITHOUT skipping `--` comments. So a comma anywhere in the comment block directly
  // above the last column makes it cut at the wrong offset and produce unparseable SQL;
  // the ALTER then fails with "error in table <t> after drop column: incomplete input",
  // which names neither the column nor the comment. Verified on SQLite 3.51.2 (Node
  // v24.13.1) — dropping settings.event_shard_threshold fails today for exactly this
  // reason, defeated by the comma in "in a stable order," on the line above it.
  //
  // Both drops in this function target mid-table columns, which is the only reason they
  // are safe. A drop that targets a trailing column is not, and CI will not catch it if
  // the fixture happens to be comma-free: this is a production-database failure mode.
  if (cols.includes('account_type')) {
    db.exec('ALTER TABLE settings DROP COLUMN account_type');
  }
  // Guard on table presence: openDatabase runs schema.sql (which creates app_state) first,
  // but isolated migration tests may operate on a settings-only DB. table_info returns []
  // for a missing table.
  const appCols = (db.prepare('PRAGMA table_info(app_state)').all() as { name: string }[]).map((c) => c.name);
  if (appCols.length > 0 && !appCols.includes('acceptance_checked_at')) {
    db.exec('ALTER TABLE app_state ADD COLUMN acceptance_checked_at TEXT');
  }
  const profileCols = (db.prepare('PRAGMA table_info(profiles)').all() as { name: string }[]).map((c) => c.name);
  if (profileCols.length > 0 && !profileCols.includes('priority')) {
    db.exec('ALTER TABLE profiles ADD COLUMN priority INTEGER NOT NULL DEFAULT 0');
  }
  if (profileCols.length > 0 && !profileCols.includes('skip_reason')) {
    db.exec('ALTER TABLE profiles ADD COLUMN skip_reason TEXT');
  }
  // The already_connected status was folded into skipped + skip_reason (2026-07-03).
  // Idempotent: matches nothing once rewritten.
  if (profileCols.length > 0) {
    db.exec("UPDATE profiles SET status='skipped', skip_reason='already_connected' WHERE status='already_connected'");
  }
  const cohortCols = (db.prepare('PRAGMA table_info(cohorts)').all() as { name: string }[]).map((c) => c.name);
  if (cohortCols.length > 0 && !cohortCols.includes('archived')) {
    db.exec('ALTER TABLE cohorts ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
  }
  // --- Message campaigns (2026-07-28) ---
  if (cohortCols.length > 0 && !cohortCols.includes('kind')) {
    db.exec("ALTER TABLE cohorts ADD COLUMN kind TEXT NOT NULL DEFAULT 'invite'");
  }
  // Each column gets its own guard (rather than one guard around all four): an
  // interruption between ALTERs must not permanently skip whichever ones didn't run yet.
  if (cols.length > 0 && !cols.includes('msg_weekly_cap')) {
    db.exec('ALTER TABLE settings ADD COLUMN msg_weekly_cap INTEGER NOT NULL DEFAULT 250');
  }
  if (cols.length > 0 && !cols.includes('msg_batch_size')) {
    db.exec('ALTER TABLE settings ADD COLUMN msg_batch_size INTEGER NOT NULL DEFAULT 5');
  }
  if (cols.length > 0 && !cols.includes('msg_batches_per_day')) {
    db.exec('ALTER TABLE settings ADD COLUMN msg_batches_per_day INTEGER NOT NULL DEFAULT 6');
  }
  if (cols.length > 0 && !cols.includes('reply_checks_per_day')) {
    db.exec('ALTER TABLE settings ADD COLUMN reply_checks_per_day INTEGER NOT NULL DEFAULT 2');
  }
  if (appCols.length > 0 && !appCols.includes('replies_checked_at')) {
    db.exec('ALTER TABLE app_state ADD COLUMN replies_checked_at TEXT');
  }
  // --- Connection roster (2026-07-31) ---
  // The connections/connection_aliases tables need no migration: schema.sql's
  // CREATE TABLE IF NOT EXISTS back-fills them on every openDatabase. Only new columns on
  // pre-existing tables need an ALTER. One guard each, so an interruption between ALTERs
  // cannot permanently skip whichever ones did not run yet.
  if (cols.length > 0 && !cols.includes('roster_sync_per_day')) {
    db.exec('ALTER TABLE settings ADD COLUMN roster_sync_per_day INTEGER NOT NULL DEFAULT 2');
  }
  if (appCols.length > 0 && !appCols.includes('roster_synced_at')) {
    db.exec('ALTER TABLE app_state ADD COLUMN roster_synced_at TEXT');
  }
  if (appCols.length > 0 && !appCols.includes('connections_seeded_at')) {
    db.exec('ALTER TABLE app_state ADD COLUMN connections_seeded_at TEXT');
  }
  // acceptance_checks_per_day paced the old twice-daily connections scrape. Since the
  // phase-3 cutover the acceptance pass is a pure DB read that runs every tick, and nothing
  // reads this column — a setting the API accepted and then ignored. Dropped for the same
  // reason account_type was above. Mid-table, so the DROP COLUMN hazard documented beside
  // that drop does not apply here either.
  if (cols.includes('acceptance_checks_per_day')) {
    db.exec('ALTER TABLE settings DROP COLUMN acceptance_checks_per_day');
  }

  // --- Enrichment (2026-07-31, phase 2) ---
  // connections_fts needs no migration: schema.sql's CREATE VIRTUAL TABLE IF NOT EXISTS
  // back-fills it on every openDatabase, same as any other new table.
  const connCols = (db.prepare('PRAGMA table_info(connections)').all() as { name: string }[]).map((c) => c.name);
  if (connCols.length > 0 && !connCols.includes('location_country_code')) {
    db.exec('ALTER TABLE connections ADD COLUMN location_country_code TEXT');
  }
  if (cols.length > 0 && !cols.includes('apify_api_key')) {
    db.exec('ALTER TABLE settings ADD COLUMN apify_api_key TEXT');
  }
  if (cols.length > 0 && !cols.includes('enrich_ttl_days')) {
    db.exec('ALTER TABLE settings ADD COLUMN enrich_ttl_days INTEGER NOT NULL DEFAULT 180');
  }
  if (cols.length > 0 && !cols.includes('enrich_concurrency')) {
    db.exec('ALTER TABLE settings ADD COLUMN enrich_concurrency INTEGER NOT NULL DEFAULT 8');
  }
  // --- Enrichment halt latch (2026-07-31, auto-drain) ---
  // Automatic enrichment needs somewhere to say "I stopped, and why" — otherwise a rotated
  // API key is a line in relay.log nobody reads while the roster silently stops growing.
  if (appCols.length > 0 && !appCols.includes('enrich_halted')) {
    db.exec('ALTER TABLE app_state ADD COLUMN enrich_halted INTEGER NOT NULL DEFAULT 0');
    db.exec('ALTER TABLE app_state ADD COLUMN enrich_halt_reason TEXT');
    db.exec('ALTER TABLE app_state ADD COLUMN enrich_halt_detail TEXT');
    db.exec('ALTER TABLE app_state ADD COLUMN enrich_halted_at TEXT');
  }
  // --- Event invites (2026-08-01) ---
  // The events/event_buckets/event_invitees/event_runs/event_run_buckets/reservations
  // tables are back-filled by schema.sql's CREATE TABLE IF NOT EXISTS on every
  // openDatabase.
  //
  // CAREFUL: that covers whole tables, NOT columns added to them afterwards. Once a table
  // exists, CREATE TABLE IF NOT EXISTS is a no-op and a newly-declared column is silently
  // absent — every read of it then returns undefined rather than failing loudly. Any
  // column added to these tables later needs its own guarded ALTER below, exactly like a
  // column on a pre-existing table. `geo_candidates` is the first such case.
  const bucketCols = (db.prepare('PRAGMA table_info(event_buckets)').all() as { name: string }[]).map((c) => c.name);
  if (bucketCols.length > 0 && !bucketCols.includes('geo_candidates')) {
    db.exec('ALTER TABLE event_buckets ADD COLUMN geo_candidates TEXT');
  }
  // Settings columns need an ALTER each, one guard apiece so an interruption between them
  // cannot permanently skip whichever did not run yet.
  if (cols.length > 0 && !cols.includes('events_per_day')) {
    db.exec('ALTER TABLE settings ADD COLUMN events_per_day INTEGER NOT NULL DEFAULT 1');
  }
  if (cols.length > 0 && !cols.includes('event_invite_cap')) {
    db.exec('ALTER TABLE settings ADD COLUMN event_invite_cap INTEGER NOT NULL DEFAULT 500');
  }
  if (cols.length > 0 && !cols.includes('event_bucket_ceiling')) {
    db.exec('ALTER TABLE settings ADD COLUMN event_bucket_ceiling INTEGER NOT NULL DEFAULT 10');
  }
  if (cols.length > 0 && !cols.includes('event_run_budget_minutes')) {
    db.exec('ALTER TABLE settings ADD COLUMN event_run_budget_minutes INTEGER NOT NULL DEFAULT 20');
  }
  // The picker hard-caps at 1000 rows in a STABLE order, so rows past the cap are
  // permanently invisible under that filter. Any bucket whose roster count approaches it
  // gets sub-sharded into child geos. 900 leaves headroom for roster/LinkedIn drift.
  if (cols.length > 0 && !cols.includes('event_shard_threshold')) {
    db.exec('ALTER TABLE settings ADD COLUMN event_shard_threshold INTEGER NOT NULL DEFAULT 900');
  }

  // --- Post engagements (2026-08-02) ---
  // The engagements table is back-filled by schema.sql's CREATE TABLE IF NOT EXISTS.
  // Settings columns are not: one guard each, so an interruption between ALTERs cannot
  // permanently skip whichever did not run yet.
  if (cols.length > 0 && !cols.includes('engage_weekly_cap')) {
    db.exec('ALTER TABLE settings ADD COLUMN engage_weekly_cap INTEGER NOT NULL DEFAULT 500');
  }
  if (cols.length > 0 && !cols.includes('engage_batch_size')) {
    db.exec('ALTER TABLE settings ADD COLUMN engage_batch_size INTEGER NOT NULL DEFAULT 15');
  }
  if (cols.length > 0 && !cols.includes('engage_batches_per_day')) {
    db.exec('ALTER TABLE settings ADD COLUMN engage_batches_per_day INTEGER NOT NULL DEFAULT 6');
  }
  if (cols.length > 0 && !cols.includes('engage_comment_daily_cap')) {
    db.exec('ALTER TABLE settings ADD COLUMN engage_comment_daily_cap INTEGER NOT NULL DEFAULT 10');
  }

  // profiles: kind/full_name/thread_url/replied_at + UNIQUE(profile_url) -> UNIQUE(profile_url, kind).
  // SQLite cannot alter a column-level UNIQUE, so rebuild the table once. Detection: the
  // kind column is absent exactly on pre-messaging databases. IDs are preserved, so
  // send_log/profile_events FKs stay valid; FKs are suspended for the swap.
  if (profileCols.length > 0 && !profileCols.includes('kind')) {
    // Re-read live columns here (not the stale profileCols snapshot above): the
    // priority/skip_reason ALTERs and the already_connected backfill just ran against
    // this same table, so the live shape can have columns/data profileCols doesn't know
    // about. Only carry over columns that actually exist right now.
    const liveCols = (db.prepare('PRAGMA table_info(profiles)').all() as { name: string }[]).map((c) => c.name);
    const carryCols = LEGACY_CARRY_COLUMNS.filter((c) => liveCols.includes(c));
    const orphaned = liveCols.filter((c) => !carryCols.includes(c));
    // Fail loudly rather than silently drop data: a profiles column added above this
    // block must also be listed in LEGACY_CARRY_COLUMNS, or legacy databases would lose
    // it on rebuild.
    if (orphaned.length > 0) {
      throw new Error(`profiles rebuild would drop columns: ${orphaned.join(', ')}`);
    }
    // PRAGMA foreign_keys is a no-op inside a transaction, so it's toggled outside the
    // BEGIN/COMMIT below; restored in `finally` regardless of how the transaction ends.
    db.exec('PRAGMA foreign_keys = OFF;');
    try {
      db.exec('BEGIN');
      db.exec('DROP TABLE IF EXISTS profiles_new'); // stale table from an interrupted earlier attempt
      db.exec(`
        -- Keep in sync with the profiles table in schema.sql.
        CREATE TABLE profiles_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          cohort_id INTEGER NOT NULL REFERENCES cohorts(id),
          kind TEXT NOT NULL DEFAULT 'invite',
          profile_url TEXT NOT NULL,
          first_name TEXT,
          full_name TEXT,
          custom_message TEXT,
          status TEXT NOT NULL DEFAULT 'queued',
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          skip_reason TEXT,
          scheduled_for TEXT,
          sent_at TEXT,
          accepted_at TEXT,
          replied_at TEXT,
          resolved_at TEXT,
          thread_url TEXT,
          priority INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE (profile_url, kind)
        );
      `);
      db.exec(
        `INSERT INTO profiles_new (${carryCols.join(', ')}) SELECT ${carryCols.join(', ')} FROM profiles;`,
      );
      db.exec(`
        DROP TABLE profiles;
        ALTER TABLE profiles_new RENAME TO profiles;
        CREATE INDEX IF NOT EXISTS idx_profiles_status ON profiles(status);
        CREATE INDEX IF NOT EXISTS idx_profiles_cohort ON profiles(cohort_id);
      `);
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
      throw e;
    } finally {
      db.exec('PRAGMA foreign_keys = ON;');
    }
  }

  // --- send_log/profile_events timestamp normalisation (2026-08-02) ---
  // Runs last, after the profiles rebuild above has settled the table these two reference.
  // No-op on a fresh database and on a second run: see rebuildLogTablesAsIso.
  rebuildLogTablesAsIso(db);
}
