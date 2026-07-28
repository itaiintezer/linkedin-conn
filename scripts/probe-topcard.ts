// Read-only DOM probe: what element holds the profile name, and where does the
// top-card Message button live in the ancestor tree? No clicks, no sends.
// Run (app stopped): npx tsx scripts/probe-topcard.ts <slug> "<Full Name>"
import { launchPersistentContext } from 'cloakbrowser';
import { BROWSER_PROFILE_DIR } from '../src/config.js';

const [slug, fullName] = process.argv.slice(2);
if (!slug || !fullName) { console.error('usage: probe-topcard.ts <slug> "<Full Name>"'); process.exit(1); }

const ctx = await launchPersistentContext({
  userDataDir: BROWSER_PROFILE_DIR, headless: false, humanize: true,
  locale: 'en-US', viewport: { width: 1280, height: 900 },
});
await ctx.addCookies([
  { name: 'lang', value: 'v=2&lang=en-US', domain: '.linkedin.com', path: '/' },
  { name: 'lang', value: 'v=2&lang=en-US', domain: '.www.linkedin.com', path: '/' },
]);
const page = ctx.pages()[0] ?? (await ctx.newPage());
try {
  await page.goto(`https://www.linkedin.com/in/${slug}`, { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 8000));

  const probe = await page.evaluate((name) => {
    (globalThis as { __name?: unknown }).__name = (t: unknown) => t;
    const brief = (el: Element) =>
      `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}.${(el.className || '').toString().split(/\s+/).slice(0, 3).join('.')}`;
    const chain = (el: Element, depth = 10) => {
      const out: string[] = [];
      let cur: Element | null = el;
      while (cur && out.length < depth) { out.push(brief(cur)); cur = cur.parentElement; }
      return out;
    };
    // Smallest element whose text is exactly the profile name.
    const nameEls = Array.from(document.querySelectorAll('h1,h2,span,div,a'))
      .filter((el) => (el.textContent || '').replace(/\s+/g, ' ').trim() === name)
      .sort((a, b) => (a.textContent || '').length - (b.textContent || '').length
        || (a.querySelectorAll('*').length - b.querySelectorAll('*').length));
    const nameEl = nameEls[0] ?? null;
    // All exact "Message" controls with their ancestor chains.
    const msgs = Array.from(document.querySelectorAll('button, a'))
      .filter((el) => /^message$/i.test((el.textContent || '').replace(/\s+/g, ' ').trim())
        || /^message\b/i.test(el.getAttribute('aria-label') || ''))
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        ariaLabel: el.getAttribute('aria-label'),
        href: el.getAttribute('href')?.slice(0, 140) ?? null,
        chain: chain(el, 8),
        outerHTML: el.outerHTML.slice(0, 400),
      }));
    // Degree badge candidates.
    const degrees = Array.from(document.querySelectorAll('span,div'))
      .filter((el) => /^(·\s*)?(1st|2nd|3rd)\+?$/.test((el.textContent || '').trim()))
      .map((el) => ({ text: (el.textContent || '').trim(), chain: chain(el, 6) }));
    // Does the name element share an ancestor with a Message control? Find the lowest
    // common ancestor tag for nameEl and the first message control.
    let lca: string[] = [];
    if (nameEl && msgs.length) {
      const first = document.querySelectorAll('button, a');
      void first;
    }
    return {
      h1Count: document.querySelectorAll('h1').length,
      mainExists: !!document.querySelector('main'),
      nameElement: nameEl ? { tag: nameEl.tagName.toLowerCase(), chain: chain(nameEl, 10) } : null,
      messageControls: msgs,
      degreeBadges: degrees.slice(0, 6),
      lca,
    };
  }, fullName);
  console.log(JSON.stringify(probe, null, 2));
} catch (e) {
  console.error('[probe-topcard] ERROR:', (e as Error).message);
} finally {
  await ctx.close();
  console.log('[probe-topcard] closed (read-only).');
}
