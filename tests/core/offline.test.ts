import { test, expect } from 'vitest';
import { isOfflineError, isAmbiguousNetworkError } from '../../src/core/offline.js';

// Real messages lifted from data/relay.log — the six false halts of 2026-08-07..16.
const REAL_HALTS = [
  'page.goto: net::ERR_NETWORK_IO_SUSPENDED at https://www.linkedin.com/messaging/ Call log:   - navigating to "https://www.linkedin.com/messaging/", waiting until "domcontentloaded"',
  'page.goto: net::ERR_INTERNET_DISCONNECTED at https://www.linkedin.com/messaging/ Call log:   - navigating to "https://www.linkedin.com/messaging/", waiting until "domcontentloaded"',
  'page.goto: net::ERR_NAME_NOT_RESOLVED at https://www.linkedin.com/messaging/ Call log:   - navigating to "https://www.linkedin.com/messaging/", waiting until "domcontentloaded"',
];

test('every definitely-offline halt from the log classifies as offline', () => {
  for (const msg of REAL_HALTS) expect(isOfflineError(msg)).toBe(true);
});

test('the 2026-08-14 bare goto timeouts classify as ambiguous, not offline', () => {
  const msg = 'page.goto: Timeout 30000ms exceeded. Call log:   - navigating to "https://www.linkedin.com/messaging/", waiting until "domcontentloaded"';
  expect(isOfflineError(msg)).toBe(false);
  expect(isAmbiguousNetworkError(msg)).toBe(true);
});

test('TCP-level trouble is ambiguous — a live LinkedIn could produce it too', () => {
  for (const code of ['ERR_TIMED_OUT', 'ERR_CONNECTION_TIMED_OUT', 'ERR_CONNECTION_RESET',
    'ERR_CONNECTION_REFUSED', 'ERR_CONNECTION_CLOSED', 'ERR_EMPTY_RESPONSE']) {
    const msg = `page.goto: net::${code} at https://www.linkedin.com/feed/`;
    expect(isOfflineError(msg), code).toBe(false);
    expect(isAmbiguousNetworkError(msg), code).toBe(true);
  }
});

test('non-network failures are neither offline nor ambiguous', () => {
  for (const msg of [
    'send composer unavailable — screenshot: /incidents/x.png',
    'locator.click: Target closed',
    'Checkpoint page at https://www.linkedin.com/checkpoint/challenge/x',
    'unknown',
  ]) {
    expect(isOfflineError(msg), msg).toBe(false);
    expect(isAmbiguousNetworkError(msg), msg).toBe(false);
  }
});

test('code names must match whole — ERR_TIMED_OUT does not swallow ERR_TIMED_OUTLIER', () => {
  // A word boundary guards against a future Chromium code that merely shares a prefix.
  expect(isAmbiguousNetworkError('net::ERR_TIMED_OUTLIER')).toBe(false);
});

test('Playwright timeout matches any duration, not just 30000', () => {
  expect(isAmbiguousNetworkError('page.goto: Timeout 45000ms exceeded.')).toBe(true);
});
