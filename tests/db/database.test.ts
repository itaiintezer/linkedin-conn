import { test, expect } from 'vitest';
import { openDatabase } from '../../src/db/database.js';

test('opens in-memory db and creates all tables', () => {
  const db = openDatabase(':memory:');
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as { name: string }[];
  const names = rows.map((r) => r.name);
  expect(names).toEqual(
    expect.arrayContaining(['cohorts', 'profiles', 'send_log', 'profile_events', 'settings']),
  );
});

test('seeds a single settings row with defaults', () => {
  const db = openDatabase(':memory:');
  const s = db.prepare('SELECT * FROM settings WHERE id = 1').get() as any;
  expect(s.weekly_cap).toBe(100);
  expect(s.batch_size).toBe(5);
  expect(s.workday_start_hour).toBe(8);
  expect(s.workday_end_hour).toBe(20);
});
