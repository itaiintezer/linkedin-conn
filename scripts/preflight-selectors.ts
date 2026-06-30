// Preflight: verify the live invite-composer selectors resolve, WITHOUT sending.
// Requires a logged-in persistent profile. Run: npx tsx scripts/preflight-selectors.ts [slug]
import { launchPersistentContext } from 'cloakbrowser';
import type { Locator } from 'playwright-core';
import { BROWSER_PROFILE_DIR } from '../src/config.js';
import { find, customInviteUrl } from '../src/browser/linkedin-selectors.js';

const slug = process.argv[2] ?? 'liron-lalezary';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ctx = await launchPersistentContext({
  userDataDir: BROWSER_PROFILE_DIR, headless: false, humanize: true,
  locale: 'en-US', viewport: { width: 1280, height: 900 },
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
const results: Array<{ selector: string; found: boolean; critical: boolean }> = [];
const check = async (name: string, locator: Locator, critical = true) => {
  const found = await locator.first().isVisible().catch(() => false);
  results.push({ selector: name, found, critical });
};

try {
  await page.goto(customInviteUrl(slug), { waitUntil: 'domcontentloaded' });
  await sleep(6000);

  await check('sendWithoutNote', find.sendWithoutNote(page));
  await check('addNote', find.addNote(page));

  // Open the note path to reveal the textarea + Send invitation button.
  if (await find.addNote(page).first().isVisible().catch(() => false)) {
    await find.addNote(page).first().click().catch(() => {});
    await sleep(2000);
  }
  await check('sendInvitation', find.sendInvitation(page));
  await check('dismissDialog', find.dismissDialog(page), false);

  // Pending lives on the PROFILE page (the driver's send-confirmation reads it
  // there), not the composer route. Informational: only present if already invited.
  await page.goto(`https://www.linkedin.com/in/${slug}`, { waitUntil: 'domcontentloaded' });
  await sleep(4000);
  await check('pendingBadge (informational; only if already invited)', find.pendingBadge(page), false);

  console.log('\nSELECTOR HEALTH:');
  for (const r of results) {
    const mark = r.found ? 'OK  ' : (r.critical ? 'FAIL' : 'miss');
    console.log(`  [${mark}] ${r.selector}`);
  }
  const brokenCritical = results.filter((r) => r.critical && !r.found);
  if (brokenCritical.length) {
    console.error(`\n${brokenCritical.length} critical selector(s) broken — composer flow will fail.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll critical selectors resolved.');
  }
} catch (e) {
  console.error('[preflight] ERROR:', (e as Error).message);
  process.exitCode = 1;
} finally {
  await ctx.close();
  console.log('[preflight] closed (no invitation sent).');
}
