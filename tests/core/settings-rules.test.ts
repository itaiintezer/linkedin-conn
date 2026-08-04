/**
 * The settings rule table.
 *
 * The load-bearing test here is the defaults one: a ceiling accidentally set below a value
 * schema.sql ships would make every fresh install start in a state the API rejects, and
 * nothing else in the suite would notice.
 */
import { test, expect } from 'vitest';
import { SETTING_RULES, validateSettingsPatch } from '../../src/core/settings-rules.js';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import type { Settings } from '../../src/types.js';

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

/** The stored row a patch is validated against. Defaults, so cross-field rules start valid. */
function stored(over: Partial<Settings> = {}): Settings {
  const repos = new Repos(openDatabase(':memory:'));
  return { ...repos.settings.get(), ...over };
}

test('a valid patch produces no failures', () => {
  expect(validateSettingsPatch({ weekly_cap: 120, batch_size: 5 }, stored())).toEqual([]);
});

test('an out-of-range value fails with the operator-facing label', () => {
  const [f] = validateSettingsPatch({ weekly_cap: 5000 }, stored());
  expect(f.key).toBe('weekly_cap');
  expect(f.message).toBe('Weekly cap (invites) must be between 0 and 150.');
});

test('a non-integer fails even when it is inside the range', () => {
  const [f] = validateSettingsPatch({ batches_per_day: 3.5 }, stored());
  expect(f.message).toBe('Batches / day (invites) must be a whole number.');
});

test('a non-number fails rather than coercing', () => {
  expect(validateSettingsPatch({ weekly_cap: '10' }, stored())).toHaveLength(1);
});

test('unruled keys are ignored, not rejected', () => {
  expect(validateSettingsPatch({ paused: 1, pause_reason: 'x', apify_api_key: 'k' }, stored())).toEqual([]);
});

test('every failing key is reported, not just the first', () => {
  const out = validateSettingsPatch({ weekly_cap: 5000, batch_size: 0 }, stored());
  expect(out.map((f) => f.key)).toEqual(['weekly_cap', 'batch_size']);
});

test('failures come back in table order regardless of patch key order', () => {
  const out = validateSettingsPatch({ batch_size: 0, weekly_cap: 5000 }, stored());
  expect(out.map((f) => f.key)).toEqual(['weekly_cap', 'batch_size']);
});

test('an inverted workday window is rejected', () => {
  const [f] = validateSettingsPatch({ workday_start_hour: 18, workday_end_hour: 9 }, stored());
  expect(f.key).toBe('workday_end_hour');
  expect(f.message).toBe('Workday end hour must be after the start hour (currently 18).');
});

test('an equal workday window is rejected — it sends nothing', () => {
  expect(validateSettingsPatch({ workday_start_hour: 9, workday_end_hour: 9 }, stored())).toHaveLength(1);
});

// The half-patch case: the form posts both hours, but an agent following API.md may send one.
test('a one-sided workday patch is checked against the stored other side', () => {
  expect(validateSettingsPatch({ workday_end_hour: 6 }, stored({ workday_start_hour: 8 }))).toHaveLength(1);
  expect(validateSettingsPatch({ workday_start_hour: 22 }, stored({ workday_end_hour: 20 }))).toHaveLength(1);
});

/* An install can already hold an inverted window — nothing stopped it before this feature.
   Rejecting an unrelated patch because of it would strand that operator: they could not
   even pause the engine through settings. */
test('an already-inverted stored window does not fail an unrelated patch', () => {
  const bad = stored({ workday_start_hour: 18, workday_end_hour: 9 });
  expect(validateSettingsPatch({ weekly_cap: 50 }, bad)).toEqual([]);
});

// -5 is chosen, not 99: it fails its own range (min 0) AND -5 <= 8 is true, so without the
// suppression guard the cross-field comparison would also fire, producing two failures.
test('a range failure on an hour suppresses the cross-field message', () => {
  const out = validateSettingsPatch({ workday_end_hour: -5 }, stored());
  expect(out).toHaveLength(1);                       // not also "must be after the start hour"
  expect(out[0].message).toBe('Workday end hour must be between 0 and 23.');
});

// Symmetric case: the failing key is the *start* hour this time, exercising the other half
// of the failed.has(a) && failed.has(b) guard. Stored end is 20, and 20 <= 99 is true, so
// without suppression this would also produce a second, cross-field failure.
test('a range failure on the start hour also suppresses the cross-field message', () => {
  const out = validateSettingsPatch({ workday_start_hour: 99 }, stored({ workday_end_hour: 20 }));
  expect(out).toHaveLength(1);
  expect(out[0].message).toBe('Workday start hour must be between 0 and 23.');
});

test('max_delay_ms below min_delay_ms is rejected, equal is allowed', () => {
  expect(validateSettingsPatch({ min_delay_ms: 90000, max_delay_ms: 20000 }, stored())).toHaveLength(1);
  expect(validateSettingsPatch({ min_delay_ms: 30000, max_delay_ms: 30000 }, stored())).toEqual([]);
});

// Mirrors the workday one-sided tests: both values are individually in range (5000..600000),
// so this is the cross-field rule catching the stored fallback, not a range check — hence
// asserting on the message, not just the count.
test('a one-sided delay patch is checked against the stored other side', () => {
  const [f] = validateSettingsPatch({ max_delay_ms: 10000 }, stored({ min_delay_ms: 90000 }));
  expect(f.message).toBe('Maximum send delay must be at least the minimum (90000 ms).');
});
