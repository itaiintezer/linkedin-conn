// Validation-only: launch CloakBrowser (downloads the Chromium binary on first run),
// open LinkedIn, report login status, keep the window visible briefly, then close.
// Sends NOTHING. Run: npx tsx scripts/check-browser.ts
import { CloakSession } from '../src/browser/cloak-session.js';

const session = new CloakSession();
try {
  console.log('[check] launching CloakBrowser (first run downloads Chromium — may take a few minutes)...');
  const page = await session.page();
  console.log('[check] browser launched. Navigating to LinkedIn...');
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' });
  const title = await page.title();
  console.log(`[check] page title: ${title}`);
  // logged-in heuristic: the feed loads the main scaffold; logged-out redirects to a login/auth wall
  const url = page.url();
  const loggedIn = !/login|authwall|signup/i.test(url);
  console.log(`[check] current url: ${url}`);
  console.log(`[check] appears logged in: ${loggedIn}`);
  console.log('[check] leaving the window open for 20s so you can see it...');
  await new Promise((r) => setTimeout(r, 20_000));
} catch (e) {
  console.error('[check] ERROR:', (e as Error).message);
  process.exitCode = 1;
} finally {
  await session.close();
  console.log('[check] closed.');
}
