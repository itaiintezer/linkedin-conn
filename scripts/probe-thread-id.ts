// Read-only probe: where does a conversation's identity live?
// (a) On the inbox list row — anchors, ids, data-* attributes.
// (b) What is page.url() right after opening a compose deep link, and does clicking a
//     row navigate to /messaging/thread/<id>/ ?
// Sends nothing, types nothing.
// Run (app stopped): npx tsx scripts/probe-thread-id.ts
import { launchPersistentContext } from 'cloakbrowser';
import { BROWSER_PROFILE_DIR } from '../src/config.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
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
  await page.goto('https://www.linkedin.com/messaging/', { waitUntil: 'domcontentloaded' });
  await sleep(8000);
  console.log('INBOX URL:', page.url());

  const rows = await page.evaluate(() => {
    (globalThis as { __name?: unknown }).__name = (t: unknown) => t;
    const list = document.querySelectorAll('li.msg-conversation-listitem');
    const first = list[0];
    const dump = (el: Element) => ({
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      attrs: Array.from(el.attributes).map((a) => `${a.name}=${a.value.slice(0, 90)}`),
      anchors: Array.from(el.querySelectorAll('a')).map((a) => ({
        href: a.getAttribute('href'),
        cls: (a.className || '').toString().slice(0, 80),
      })),
      dataAttrsDeep: Array.from(el.querySelectorAll('*'))
        .flatMap((n) => Array.from(n.attributes)
          .filter((a) => a.name.startsWith('data-') || a.name === 'id')
          .map((a) => `${n.tagName.toLowerCase()}[${a.name}=${a.value.slice(0, 80)}]`))
        .slice(0, 25),
    });
    return {
      count: list.length,
      firstRow: first ? dump(first) : null,
      firstRowHtmlHead: first ? first.outerHTML.slice(0, 1200) : null,
    };
  });
  console.log('--- FIRST INBOX ROW ---');
  console.log(JSON.stringify(rows, null, 2));

  // Click the first row and see what the URL becomes (read-only navigation).
  await page.locator('li.msg-conversation-listitem').first().click().catch(() => {});
  await sleep(5000);
  console.log('URL AFTER CLICKING FIRST ROW:', page.url());

  // What does the compose deep link leave in the address bar?
  const composeHref = await page.evaluate(() => {
    (globalThis as { __name?: unknown }).__name = (t: unknown) => t;
    return document.querySelector('a[href*="/messaging/compose/"]')?.getAttribute('href') ?? null;
  });
  console.log('COMPOSE HREF FOUND ON MESSAGING PAGE:', composeHref);
} catch (e) {
  console.error('[probe-thread-id] ERROR:', (e as Error).message);
} finally {
  await ctx.close();
  console.log('[probe-thread-id] closed (read-only).');
}
