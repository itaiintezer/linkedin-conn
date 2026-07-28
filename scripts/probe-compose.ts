// Read-only probe #2: (a) the true markup of the name/degree-badge region, and
// (b) what the /messaging/compose/ deep link renders (composer anatomy). No typing.
// Run (app stopped): npx tsx scripts/probe-compose.ts <slug> "<Full Name>"
import { launchPersistentContext } from 'cloakbrowser';
import { BROWSER_PROFILE_DIR } from '../src/config.js';

const [slug, fullName] = process.argv.slice(2);
if (!slug || !fullName) { console.error('usage: probe-compose.ts <slug> "<Full Name>"'); process.exit(1); }

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

  const region = await page.evaluate((name) => {
    (globalThis as { __name?: unknown }).__name = (t: unknown) => t;
    const nameEl = Array.from(document.querySelectorAll('h1,h2'))
      .find((el) => (el.textContent || '').replace(/\s+/g, ' ').trim() === name);
    if (!nameEl) return { error: 'name element not found' };
    // Walk up until the container also holds a degree token or gets big; dump that region.
    let region: Element = nameEl;
    for (let i = 0; i < 6; i++) {
      if (/\b(1st|2nd|3rd)\b/.test(region.textContent || '') && region !== nameEl) break;
      if (!region.parentElement) break;
      region = region.parentElement;
    }
    const composeHref = document.querySelector('a[href*="/messaging/compose/"]')?.getAttribute('href') ?? null;
    return {
      nameTag: nameEl.tagName.toLowerCase(),
      regionHTML: region.outerHTML.slice(0, 3500),
      composeHref,
    };
  }, fullName);
  console.log('--- NAME REGION ---');
  console.log(JSON.stringify(region, null, 2));

  const href = (region as { composeHref?: string | null }).composeHref;
  if (href) {
    await page.goto(`https://www.linkedin.com${href}`, { waitUntil: 'domcontentloaded' });
    await new Promise((r) => setTimeout(r, 7000));
    const composer = await page.evaluate(() => {
      (globalThis as { __name?: unknown }).__name = (t: unknown) => t;
      const editable = Array.from(document.querySelectorAll('div[contenteditable="true"], textarea')).map((el) => ({
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role'),
        ariaLabel: el.getAttribute('aria-label'),
        placeholder: el.getAttribute('aria-placeholder') ?? el.getAttribute('placeholder'),
        class: (el.className || '').toString().slice(0, 150),
        visible: (el as HTMLElement).offsetParent !== null,
      }));
      const sendish = Array.from(document.querySelectorAll('button'))
        .filter((b) => /send/i.test((b.textContent || '').trim()) || /send/i.test(b.getAttribute('aria-label') || ''))
        .map((b) => ({ text: (b.textContent || '').trim().slice(0, 30), ariaLabel: b.getAttribute('aria-label'), type: b.getAttribute('type'), class: (b.className || '').toString().slice(0, 150), disabled: b.disabled }));
      const overlay = document.querySelector('[class*="msg-overlay"]');
      const form = document.querySelector('form[class*="msg-form"], .msg-form');
      const recipientHeader = (document.querySelector('[class*="msg-overlay"] header, [class*="msg-entity"], [class*="compose"] h2')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      const history = document.querySelectorAll('[class*="msg-s-event"]').length;
      return {
        url: location.href,
        overlayClass: overlay ? (overlay.className || '').toString().slice(0, 120) : null,
        formClass: form ? (form.className || '').toString().slice(0, 120) : null,
        recipientHeader, editable, sendButtons: sendish, historyEvents: history,
        inMailMarker: /inmail/i.test((overlay ?? form ?? document.body).textContent || ''),
      };
    });
    console.log('--- COMPOSE ROUTE ---');
    console.log(JSON.stringify(composer, null, 2));
    await page.screenshot({ path: 'C:/Users/itai/AppData/Local/Temp/claude/C--Projects-linkedin-conn/d69c95fc-dc51-4e34-ace1-ef35cddd73f1/scratchpad/msg-discovery/compose-route.png' });
  }
} catch (e) {
  console.error('[probe-compose] ERROR:', (e as Error).message);
} finally {
  await ctx.close();
  console.log('[probe-compose] closed (read-only).');
}
