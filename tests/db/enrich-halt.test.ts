import { test, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, runMigrations } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';

const repos = (): Repos => new Repos(openDatabase(':memory:'));

test('a fresh database starts un-halted', () => {
  const a = repos().appState.get();
  expect(a.enrich_halted).toBe(0);
  expect(a.enrich_halt_reason).toBeNull();
  expect(a.enrich_halted_at).toBeNull();
});

test('haltEnrichment records reason, detail and time', () => {
  const r = repos();
  r.appState.haltEnrichment('auth', 'Apify run failed (HTTP 401)', '2026-07-31T12:00:00.000Z');
  const a = r.appState.get();
  expect(a.enrich_halted).toBe(1);
  expect(a.enrich_halt_reason).toBe('auth');
  expect(a.enrich_halt_detail).toBe('Apify run failed (HTTP 401)');
  expect(a.enrich_halted_at).toBe('2026-07-31T12:00:00.000Z');
});

test('clearEnrichHalt wipes every field, so a stale reason can never render', () => {
  const r = repos();
  r.appState.haltEnrichment('no_api_key', 'no key', '2026-07-31T12:00:00.000Z');
  r.appState.clearEnrichHalt();
  const a = r.appState.get();
  expect(a.enrich_halted).toBe(0);
  expect(a.enrich_halt_reason).toBeNull();
  expect(a.enrich_halt_detail).toBeNull();
  expect(a.enrich_halted_at).toBeNull();
});

test('halting twice overwrites rather than accumulating', () => {
  const r = repos();
  r.appState.haltEnrichment('rate_limit', 'first', '2026-07-31T12:00:00.000Z');
  r.appState.haltEnrichment('auth', 'second', '2026-07-31T13:00:00.000Z');
  const a = r.appState.get();
  expect(a.enrich_halt_reason).toBe('auth');
  expect(a.enrich_halt_detail).toBe('second');
  expect(a.enrich_halted_at).toBe('2026-07-31T13:00:00.000Z');
});

test('the halt latch is independent of the LinkedIn guardrail', () => {
  // They answer different questions: the guardrail is session health, the halt is Apify.
  // Clearing one must never clear the other.
  const r = repos();
  r.appState.trip('login_lost', 'cookie gone', '2026-07-31T12:00:00.000Z');
  r.appState.haltEnrichment('auth', 'bad key', '2026-07-31T12:00:00.000Z');

  r.appState.clearGuardrail();
  expect(r.appState.get().enrich_halted).toBe(1);

  r.appState.haltEnrichment('auth', 'bad key', '2026-07-31T12:00:00.000Z');
  r.appState.trip('login_lost', 'cookie gone', '2026-07-31T12:00:00.000Z');
  r.appState.clearEnrichHalt();
  expect(r.appState.get().guardrail_tripped).toBe(1);
});

test('runMigrations adds the halt columns to a legacy app_state table', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE app_state (id INTEGER PRIMARY KEY CHECK (id = 1), login_logged_in INTEGER NOT NULL DEFAULT 0);');
  db.exec('INSERT INTO app_state (id) VALUES (1);');
  runMigrations(db);
  const cols = (db.prepare('PRAGMA table_info(app_state)').all() as { name: string }[]).map((c) => c.name);
  expect(cols).toContain('enrich_halted');
  expect(cols).toContain('enrich_halt_reason');
  expect(cols).toContain('enrich_halt_detail');
  expect(cols).toContain('enrich_halted_at');
});
