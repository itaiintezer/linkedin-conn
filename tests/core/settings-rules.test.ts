/**
 * The settings rule table.
 *
 * The load-bearing test here is the defaults one: a ceiling accidentally set below a value
 * schema.sql ships would make every fresh install start in a state the API rejects, and
 * nothing else in the suite would notice.
 */
import { test, expect } from 'vitest';
import { SETTING_RULES } from '../../src/core/settings-rules.js';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';

/** Every key the Settings form posts. Kept literal so a dropped rule fails loudly here. */
const FORM_KEYS = [
  'weekly_cap', 'batch_size', 'batches_per_day',
  'msg_weekly_cap', 'msg_batch_size', 'msg_batches_per_day', 'reply_checks_per_day',
  'events_per_day', 'event_invite_cap', 'event_bucket_ceiling', 'event_run_budget_minutes',
  'engage_weekly_cap', 'engage_batch_size', 'engage_batches_per_day', 'engage_comment_daily_cap',
  'workday_start_hour', 'workday_end_hour', 'roster_sync_per_day',
];

test('every field the Settings form posts has a rule', () => {
  for (const key of FORM_KEYS) {
    expect(SETTING_RULES[key], `no rule for ${key}`).toBeDefined();
  }
});

test('the API-only numeric keys are ruled too', () => {
  for (const key of ['min_delay_ms', 'max_delay_ms', 'enrich_ttl_days', 'enrich_concurrency', 'event_shard_threshold']) {
    expect(SETTING_RULES[key], `no rule for ${key}`).toBeDefined();
  }
});

test('every rule is a sane integer range with a label', () => {
  for (const [key, rule] of Object.entries(SETTING_RULES)) {
    expect(Number.isInteger(rule.min), `${key} min`).toBe(true);
    expect(Number.isInteger(rule.max), `${key} max`).toBe(true);
    expect(rule.min, `${key} min <= max`).toBeLessThanOrEqual(rule.max);
    expect(rule.label.length, `${key} label`).toBeGreaterThan(0);
  }
});

test('every schema.sql default falls inside its own rule', () => {
  const repos = new Repos(openDatabase(':memory:'));
  const defaults = repos.settings.get() as unknown as Record<string, number>;
  for (const [key, rule] of Object.entries(SETTING_RULES)) {
    const value = defaults[key];
    expect(typeof value, `${key} missing from the settings row`).toBe('number');
    expect(value, `${key} default ${value} is outside ${rule.min}..${rule.max}`)
      .toBeGreaterThanOrEqual(rule.min);
    expect(value).toBeLessThanOrEqual(rule.max);
  }
});

/**
 * Columns SETTING_RULES is not required to cover, and why. Each entry is a deliberate
 * decision, not an oversight — see docs/superpowers/specs/2026-08-04-settings-validation-
 * design.md for the fuller rationale on expiry_days.
 */
const UNRULED_COLUMNS: Record<string, string> = {
  id: 'the single-row primary key, always 1 — not a setting',
  weekdays_only: '0/1 flag, not a range',
  note_quota_exhausted: '0/1 flag, not a range',
  paused: '0/1 flag, not a range',
  onboarded: '0/1 flag, not a range',
  failure_threshold: 'not in ALLOWED_SETTINGS_KEYS (src/api/server.ts) — cannot be written via the API',
  expiry_days: 'deliberate omission (0 = disabled, no form input, not in the approved set) — ' +
    'see docs/superpowers/specs/2026-08-04-settings-validation-design.md',
};

test('every INTEGER column on settings is ruled or explicitly excluded', () => {
  const db = openDatabase(':memory:');
  const columns = db.prepare('PRAGMA table_info(settings)').all() as { name: string; type: string }[];
  for (const { name, type } of columns) {
    if (type !== 'INTEGER') continue; // TEXT columns (apify_api_key, pause_reason) are not numeric settings
    const known = SETTING_RULES[name] !== undefined || UNRULED_COLUMNS[name] !== undefined;
    expect(
      known,
      `settings.${name} is a new INTEGER column with no rule in SETTING_RULES and no entry in ` +
        `UNRULED_COLUMNS (tests/core/settings-rules.test.ts). Add a { label, min, max } rule to ` +
        `src/core/settings-rules.ts, or if it deliberately has no range, add it to UNRULED_COLUMNS ` +
        `here with a one-line reason.`,
    ).toBe(true);
  }
});
