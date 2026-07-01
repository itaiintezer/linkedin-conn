// Read-only diagnostic: is LinkedIn rendering in Hebrew (breaking English selectors),
// and what reliably marks the profile OWNER as a 1st-degree connection?
// Sends nothing. Run (app stopped): npx tsx scripts/inspect-connected.ts [slug ...]
import { launchPersistentContext } from 'cloakbrowser';
import { BROWSER_PROFILE_DIR } from '../src/config.js';

const slugs = process.argv.slice(2);
const targets = slugs.length ? slugs : ['erik-decker'];

const ctx = await launchPersistentContext({
  userDataDir: BROWSER_PROFILE_DIR, headless: false, humanize: true,
  locale: 'en-US', viewport: { width: 1280, height: 900 },
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
try {
  const cookies = await ctx.cookies('https://www.linkedin.com');
  const langCookie = cookies.find((c) => c.name === 'lang');
  console.log('LANG COOKIE:', langCookie ? langCookie.value : '(none)');

  for (const slug of targets) {
    await page.goto(`https://www.linkedin.com/in/${slug}`, { waitUntil: 'domcontentloaded' });
    await new Promise((r) => setTimeout(r, 8000));

    const info = await page.evaluate(() => {
      const htmlLang = document.documentElement.lang;
      const dir = document.documentElement.dir;
      const main = document.querySelector('main');
      const mainText = (main?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 220);
      // Owner-degree tokens (EN + HE), excluding sidebar cards that link to other profiles.
      const degreeRe = /^(·\s*)?(1st|2nd|3rd|1|2|3)\+?$/i;
      const nodes = Array.from(document.querySelectorAll('span,div,li'));
      const owner: string[] = [];
      for (const el of nodes) {
        const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3)
          .map((n) => n.textContent || '').join('').trim();
        if (degreeRe.test(own) && !el.closest('a[href*="/in/"]')) owner.push(own);
      }
      const btns = Array.from(main?.querySelectorAll('button') || [])
        .map((b) => (b.getAttribute('aria-label') || b.textContent || '').trim().replace(/\s+/g, ' '))
        .filter(Boolean).slice(0, 10);
      return { htmlLang, dir, ownerDegreeTokens: [...new Set(owner)], mainButtons: btns, mainText };
    });
    console.log(JSON.stringify({ slug, ...info }, null, 2));
  }
} catch (e) {
  console.error('[inspect-connected] ERROR:', (e as Error).message);
} finally {
  await ctx.close();
  console.log('[inspect-connected] closed (nothing sent).');
}
