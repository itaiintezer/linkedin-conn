import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export type DB = DatabaseSync;

export function openDatabase(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  runMigrations(db);
  return db;
}

/** Idempotent schema migrations for databases created before a column existed. */
export function runMigrations(db: DB): void {
  const cols = (db.prepare('PRAGMA table_info(settings)').all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('onboarded')) {
    db.exec('ALTER TABLE settings ADD COLUMN onboarded INTEGER NOT NULL DEFAULT 0');
    // Don't show the wizard to users who already configured an account type.
    db.exec("UPDATE settings SET onboarded = 1 WHERE account_type != 'unknown'");
  }
}
