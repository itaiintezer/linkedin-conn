import { test, expect } from 'vitest';
import { classifyEnrichError, isAccountLevel } from '../../src/core/enrich-failure.js';

/**
 * The distinction this module exists to draw: is the PROFILE broken, or is the ACCOUNT
 * broken? Charging a row an attempt for a rotated API key would park the whole roster as
 * `failed` — a state that is manual-re-arm-only by design.
 */

test('HTTP 401/403 from the Apify client is an auth problem', () => {
  expect(classifyEnrichError('Apify run failed (HTTP 401)')).toBe('auth');
  expect(classifyEnrichError('Apify run failed (HTTP 403)')).toBe('auth');
});

test('HTTP 402 is a billing problem', () => {
  expect(classifyEnrichError('Apify run failed (HTTP 402)')).toBe('billing');
});

test('HTTP 429 is a rate limit', () => {
  expect(classifyEnrichError('Apify run failed (HTTP 429)')).toBe('rate_limit');
});

test('5xx is an upstream problem, not the profile’s fault', () => {
  expect(classifyEnrichError('Apify run failed (HTTP 500)')).toBe('upstream');
  expect(classifyEnrichError('Apify run failed (HTTP 503)')).toBe('upstream');
});

test('a restricted or missing profile is profile-level', () => {
  expect(classifyEnrichError('Apify returned an empty dataset')).toBe('profile');
  expect(classifyEnrichError('Apify returned an unexpected payload shape (not a dataset array)')).toBe('profile');
});

test('HTTP 404 is profile-level — that URL, not the account', () => {
  expect(classifyEnrichError('Apify run failed (HTTP 404)')).toBe('profile');
});

test('an unrecognised message degrades to profile-level', () => {
  // Bounded attempts already cover the per-row case, so the safe default is the one that
  // does NOT halt the whole run on a message we have never seen.
  expect(classifyEnrichError('socket hang up')).toBe('profile');
  expect(classifyEnrichError('')).toBe('profile');
});

test('a timeout is profile-level, and the consecutive-failure breaker catches a storm of them', () => {
  expect(classifyEnrichError('This operation was aborted')).toBe('profile');
});

test('isAccountLevel splits the halt-now kinds from the charge-an-attempt kinds', () => {
  expect(isAccountLevel('auth')).toBe(true);
  expect(isAccountLevel('billing')).toBe(true);
  expect(isAccountLevel('rate_limit')).toBe(true);
  expect(isAccountLevel('upstream')).toBe(true);
  expect(isAccountLevel('profile')).toBe(false);
});
