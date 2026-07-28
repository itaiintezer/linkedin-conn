// Plain .mjs for the same reason as preflight.test.mjs: the script under test is
// dependency-free JavaScript run by npm's lifecycle hooks, not compiled TypeScript.
import { describe, expect, test } from 'vitest';
import { shouldSkipDownload } from '../../scripts/install-browser.mjs';

describe('shouldSkipDownload', () => {
  test('downloads by default', () => {
    expect(shouldSkipDownload({})).toBe(false);
  });

  test('honours SKIP_BROWSER_DOWNLOAD=1 for CI and offline installs', () => {
    expect(shouldSkipDownload({ SKIP_BROWSER_DOWNLOAD: '1' })).toBe(true);
  });

  test('treats an empty or 0 value as "do not skip"', () => {
    expect(shouldSkipDownload({ SKIP_BROWSER_DOWNLOAD: '' })).toBe(false);
    expect(shouldSkipDownload({ SKIP_BROWSER_DOWNLOAD: '0' })).toBe(false);
  });

  test('skips when the operator points at their own Chromium build', () => {
    expect(shouldSkipDownload({ CLOAKBROWSER_BINARY_PATH: '/opt/chromium/chrome' })).toBe(true);
  });
});
