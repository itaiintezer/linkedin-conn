// Read-only: report the current top-card CTA state for a profile (Pending? Connect?
// Follow?) and any visible invite dialog. No clicks. Run: npx tsx scripts/check-state.ts [url]
import { launchPersistentContext } from 'cloakbrowser';
import { BROWSER_PROFILE_DIR } from '../src/config.js';

const url = process.argv[2] ?? 'https://www.linkedin.com/in/liron-lalezary';
const ctx = await launchPersistentContext({
  userDataDir: BROWSER_PROFILE_DIR, headless: false, humanize: true,
  viewport: { width: 1280, height: 900 },
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 6000));
  const state = await page.evaluate(() => {
    const title = document.title;
    const nm = title.replace(/^\(\d+\+?\)\s*/, '').replace(/\s*[|·].*$/, '').trim();
    const targets: Record<string, string> = {
      pending: '[aria-label*="Pending" i]',
      withdraw: '[aria-label*="Withdraw" i]',
      connect: `a[aria-label="Invite ${nm} to connect"], button[aria-label="Invite ${nm} to connect"]`,
      follow: `[aria-label="Follow ${nm}"]`,
    };
    const out: Record<string, unknown> = { name: nm };
    for (const k in targets) {
      const el = document.querySelector(targets[k]) as HTMLElement | null;
      out[k] = el ? { visible: el.offsetParent !== null, aria: el.getAttribute('aria-label'), text: (el.textContent || '').trim().slice(0, 30) } : null;
    }
    const dlgs = Array.from(document.querySelectorAll('[role="dialog"]')) as HTMLElement[];
    out.dialogVisible = dlgs.some((d) => d.offsetParent !== null);
    return out;
  });
  console.log(JSON.stringify(state, null, 2));
  await new Promise((r) => setTimeout(r, 3000));
} catch (e) {
  console.error('ERROR:', (e as Error).message);
} finally {
  await ctx.close();
}
