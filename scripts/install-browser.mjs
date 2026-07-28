/**
 * Downloads the stealth Chromium that The Machine drives, as part of `npm install`.
 *
 * Runs as npm's `postinstall` hook so a new operator's setup is finished when `npm install`
 * finishes — instead of the first "Connect LinkedIn" click stalling for minutes on a silent
 * ~1 GB download that looks like a hang.
 *
 * Re-run any time:  npm run install-browser
 *
 * Escape hatches (documented in README.md):
 *   SKIP_BROWSER_DOWNLOAD=1     skip it (CI, offline, image builds)
 *   CLOAKBROWSER_BINARY_PATH=…  use a Chromium you already have
 *
 * A failure here is loud but NOT fatal: a flaky network shouldn't fail the whole install,
 * and the app can still fall back to downloading on first use.
 */
import { basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Should the download be skipped for this environment? */
export function shouldSkipDownload(env = process.env) {
  const flag = String(env.SKIP_BROWSER_DOWNLOAD ?? '').trim().toLowerCase();
  if (flag && flag !== '0' && flag !== 'false') return true;
  return Boolean(String(env.CLOAKBROWSER_BINARY_PATH ?? '').trim());
}

async function main() {
  if (shouldSkipDownload()) {
    console.log('[browser] skipped (SKIP_BROWSER_DOWNLOAD / CLOAKBROWSER_BINARY_PATH set).');
    console.log('[browser] run `npm run install-browser` later if you need the bundled browser.');
    return;
  }

  let ensureBinary;
  let binaryInfo;
  try {
    ({ ensureBinary, binaryInfo } = await import('cloakbrowser'));
  } catch (e) {
    // postinstall runs after dependencies are in place, so this should not happen —
    // but never fail an install over it.
    console.warn(`[browser] cloakbrowser not importable yet (${e.message}).`);
    console.warn('[browser] run `npm run install-browser` once dependencies are installed.');
    return;
  }

  try {
    const info = binaryInfo();
    if (info?.installed) {
      console.log(`[browser] already downloaded (Chromium ${info.version}). Nothing to do.`);
      return;
    }
  } catch {
    // binaryInfo throws on an unsupported platform; ensureBinary reports that properly below.
  }

  console.log('[browser] downloading the stealth Chromium The Machine drives (~1 GB, one time).');
  console.log('[browser] this takes a few minutes on a normal connection — leave it running.');
  try {
    const path = await ensureBinary();
    console.log(`[browser] ready: ${path}`);
  } catch (e) {
    console.warn('');
    console.warn('[browser] ---------------------------------------------------------------');
    console.warn(`[browser] DOWNLOAD FAILED: ${e.message}`);
    console.warn('[browser] Dependencies installed fine, but the browser is missing.');
    console.warn('[browser] Fix your connection (VPN/proxy/firewall) and run:');
    console.warn('[browser]     npm run install-browser');
    console.warn('[browser] ---------------------------------------------------------------');
    console.warn('');
  }
}

/**
 * Only run when invoked directly — importing this file (tests) must not start a download.
 * The basename fallback covers npm/Windows handing us a differently-formed path than the
 * URL this module was loaded from.
 */
const invoked = process.argv[1] ?? '';
const isMain =
  invoked !== '' &&
  (pathToFileURL(invoked).href === import.meta.url || basename(invoked) === basename(fileURLToPath(import.meta.url)));

if (isMain) await main();
