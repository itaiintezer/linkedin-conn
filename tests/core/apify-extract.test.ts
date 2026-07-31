/**
 * Extraction tests run against `tests/fixtures/apify-profile-raw.json` — a REAL Apify
 * payload captured live on 2026-07-31, not a hand-written stub. Field shapes here
 * (`position` rather than `title`, skills as objects, the pre-parsed location) are exactly
 * what the actor emits; a hand-rolled fixture would have encoded my assumptions instead.
 */
import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isEmptyProfile, extractProfile } from '../../src/core/apify-extract.js';
import type { ApifyProfile } from '../../src/types.js';

const RAW = JSON.parse(
  readFileSync(join(process.cwd(), 'tests/fixtures/apify-profile-raw.json'), 'utf8'),
) as ApifyProfile;

test('extracts identity and current role from a real payload', () => {
  const p = extractProfile(RAW);
  expect(p.linkedin_id).toBe('ACoAABCb3-UBTG79PeQUR4P-txeGhSMVy1_AU5k');
  expect(p.public_identifier).toBe('keren-tevet-3453a079');
  expect(p.full_name).toBe('Keren Tevet');
  expect(p.current_title).toBe('Senior Software Engineer'); // from `position`, not `title`
  expect(p.current_company).toBe('Aiven');
});

test("uses Apify's parsed location rather than splitting the display string", () => {
  const p = extractProfile(RAW);
  expect(p.location_raw).toBe('Israel');
  expect(p.location_country).toBe('Israel');
  expect(p.location_country_code).toBe('IL');
  expect(p.location_city).toBeNull();   // a country-only location yields no city
  expect(p.location_region).toBeNull();
});

test('resolves a metro-area location into city/state/country', () => {
  // Verified live: Apify turns "Greater Leeds Area" into Leeds / England / GB. This is the
  // 29.6% of profiles a positional comma-split could not have handled at all.
  const p = extractProfile({
    location: {
      linkedinText: 'Greater Leeds Area',
      countryCode: 'GB',
      parsed: {
        text: 'Leeds, United Kingdom', city: 'Leeds', state: 'England',
        country: 'UK', countryFull: 'United Kingdom', countryCode: 'GB',
      },
    },
  });
  expect(p.location_raw).toBe('Greater Leeds Area');
  expect(p.location_city).toBe('Leeds');
  expect(p.location_region).toBe('England');
  expect(p.location_country).toBe('United Kingdom'); // countryFull beats the "UK" abbreviation
  expect(p.location_country_code).toBe('GB');
});

test('tolerates location arriving as a bare string and refuses to guess its parts', () => {
  const p = extractProfile({ location: 'Seattle, Washington, United States' });
  expect(p.location_raw).toBe('Seattle, Washington, United States');
  // Deliberately NOT split: measured over 6,333 profiles, 3.2% put a country in the second
  // segment ("Delhi, India"), which positional splitting would store as a region.
  expect(p.location_city).toBeNull();
  expect(p.location_region).toBeNull();
  expect(p.location_country_code).toBeNull();
});

test('the FTS document carries every field search must reach', () => {
  const { doc } = extractProfile(RAW);
  const lower = doc.toLowerCase();
  for (const term of ['keren', 'senior software engineer', 'aiven', 'israel', 'python']) {
    expect(lower).toContain(term);
  }
});

test('the FTS document reaches PAST roles, not just the current one', () => {
  const { doc } = extractProfile({
    currentPosition: [{ position: 'VP Engineering', companyName: 'Nowhere Inc' }],
    experience: [
      { position: 'VP Engineering', companyName: 'Nowhere Inc' },
      { position: 'Head of Security', companyName: 'Amazon' },
    ],
  });
  expect(doc).toContain('Head of Security');
  expect(doc).toContain('Amazon');
});

test('skills are flattened from objects to names', () => {
  const p = extractProfile(RAW);
  expect(p.compact.skills).toEqual(expect.arrayContaining(['C++']));
  expect((p.compact.skills as string[]).every((s) => typeof s === 'string')).toBe(true);
});

test('full_name falls back to firstName + lastName when `name` is absent', () => {
  expect(extractProfile({ firstName: 'Ada', lastName: 'Lovelace' }).full_name).toBe('Ada Lovelace');
  expect(extractProfile({ name: 'Grace Hopper', firstName: 'Grace' }).full_name).toBe('Grace Hopper');
  expect(extractProfile({}).full_name).toBeNull();
});

test('current role falls back to the first experience entry', () => {
  const p = extractProfile({ experience: [{ position: 'CISO', companyName: 'Acme' }] });
  expect(p.current_title).toBe('CISO');
  expect(p.current_company).toBe('Acme');
});

test('isEmptyProfile only fires when EVERY identifying signal is missing', () => {
  expect(isEmptyProfile({})).toBe(true);
  expect(isEmptyProfile(null)).toBe(true);
  expect(isEmptyProfile({ firstName: '', headline: '', about: '', experience: [], education: [], skills: [] })).toBe(true);
  // Sparse but real — a headline-only profile must NOT be discarded as a shell.
  expect(isEmptyProfile({ headline: 'Security Engineer' })).toBe(false);
  expect(isEmptyProfile({ skills: [{ name: 'Python' }] })).toBe(false);
  expect(isEmptyProfile(RAW)).toBe(false);
});

test('extraction never throws on a malformed payload', () => {
  expect(() => extractProfile({ skills: ['bare string', { name: null }, null] as never })).not.toThrow();
  expect(() => extractProfile({ experience: null, currentPosition: null })).not.toThrow();
  expect(() => extractProfile({ location: { parsed: null } })).not.toThrow();
});

test('the stored payload keeps Apify\'s raw first/last name', () => {
  // The backfill overwrites the first_name COLUMN. Without the raw here, Apify's original
  // value is unrecoverable and the migration is one-way.
  const p = extractProfile({ firstName: 'Dr. Chidhanandham', lastName: 'Arunachalam' });
  expect(p.compact.firstNameRaw).toBe('Dr. Chidhanandham');
  expect(p.compact.lastNameRaw).toBe('Arunachalam');
});

test('extraction stores a sanitised first name, not Apify\'s raw fragment', () => {
  const p = extractProfile({ firstName: '🪐 Leonardo', lastName: 'Pizarro', name: '🪐 Leonardo Pizarro' });
  expect(p.first_name).toBe('Leonardo');
  expect(p.full_name).toBe('🪐 Leonardo Pizarro');   // display name is NOT sanitised
});

test('falls back to the full name when the first-name field is unusable', () => {
  expect(extractProfile({ firstName: 'M.', name: 'M. Grace Hopper' }).first_name).toBe('Grace');
});
