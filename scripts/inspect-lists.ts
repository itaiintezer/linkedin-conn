// Diagnostic: dump how the "Sent invitations" and "Connections" pages expose profile
// links in the new LinkedIn UI, so we can fix the acceptance-tracking selectors.
// Read-only. Run: npx tsx scripts/inspect-lists.ts
import { launchPersistentContext } from 'cloakbrowser';
import { BROWSER_PROFILE_DIR } from '../src/config.js';

const PAGES = [
  { label: 'SENT INVITATIONS', url: 'https://www.linkedin.com/mynetwork/invitation-manager/sent/' },
  { label: 'CONNECTIONS', url: 'https://www.linkedin.com/mynetwork/invite-connect/connections/' },
];

const ctx = await launchPersistentContext({
  userDataDir: BROWSER_PROFILE_DIR, headless: false, humanize: true,
  locale: 'en-US', viewport: { width: 1280, height: 1000 },
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
try {
  for (const p of PAGES) {
    await page.goto(p.url, { waitUntil: 'domcontentloaded' });
    await new Promise((r) => setTimeout(r, 7000));
    console.log(`\n===== ${p.label} =====`);
    console.log('url:', page.url());
    const data = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a[href*="/in/"]'))
        .filter((a) => (a as HTMLElement).offsetParent !== null)
        .map((a) => ({
          href: (a as HTMLAnchorElement).getAttribute('href'),
          text: (a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40),
          aria: a.getAttribute('aria-label'),
        }));
      // de-dupe by href
      const seen = new Set<string>();
      const uniq = anchors.filter((a) => { const k = a.href || ''; if (seen.has(k)) return false; seen.add(k); return true; });
      return { count: anchors.length, uniqueProfileLinks: uniq.slice(0, 15) };
    });
    console.log(JSON.stringify(data, null, 2));
  }
  await new Promise((r) => setTimeout(r, 2000));
} catch (e) {
  console.error('[inspect] ERROR:', (e as Error).message);
} finally {
  await ctx.close();
  console.log('\n[inspect] closed.');
}
