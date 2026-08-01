// Read-only DOM probe for the event-invite flow, phase 1: the event page itself.
// Answers: does the same-origin iframe quirk reproduce, where does the start time live,
// what is the Attend control's state, and is Share present before attending?
// NOTHING is clicked. Run (app stopped): npx tsx scripts/probe-event.ts <eventUrl>
import { launchPersistentContext } from 'cloakbrowser';
import { BROWSER_PROFILE_DIR } from '../src/config.js';

const url = process.argv[2];
if (!url) { console.error('usage: probe-event.ts <eventUrl>'); process.exit(1); }

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
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 9000));

  const probe = await page.evaluate(() => {
    (globalThis as { __name?: unknown }).__name = (t: unknown) => t;

    // The spec's defensive root resolution. Report whether it actually mattered.
    const frames = Array.from(document.querySelectorAll('iframe'));
    let usedIframe = false;
    let rootDoc: Document = document;
    for (const f of frames) {
      try {
        const d = (f as HTMLIFrameElement).contentDocument;
        if (d && d.querySelector('.global-nav, .scaffold-layout, .events-components-shared-support-share__share-button')) {
          rootDoc = d; usedIframe = true; break;
        }
      } catch { /* cross-origin */ }
    }
    const r = rootDoc;
    const txt = (el: Element | null) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
    const brief = (el: Element) =>
      `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}.${(el.className || '').toString().split(/\s+/).slice(0, 4).join('.')}`;

    // Structured time sources, in order of how much we'd trust them.
    const ldJson = Array.from(r.querySelectorAll('script[type="application/ld+json"]'))
      .map((s) => (s.textContent || '').slice(0, 1500));
    const metas = Array.from(r.querySelectorAll('meta'))
      .filter((m) => /time|date|start|end/i.test(m.getAttribute('property') || m.getAttribute('name') || ''))
      .map((m) => ({ key: m.getAttribute('property') || m.getAttribute('name'), content: m.getAttribute('content') }));
    const timeEls = Array.from(r.querySelectorAll('time')).map((t) => ({
      datetime: t.getAttribute('datetime'), text: txt(t), chain: brief(t),
    }));

    // Anything that reads like a date/time in the top card.
    const dateish = Array.from(r.querySelectorAll('p, span, div, h2'))
      .map((el) => ({ el, t: txt(el) }))
      .filter(({ t }) => t.length < 120 && /\b(20\d\d)\b/.test(t)
        && /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|AM|PM)/i.test(t))
      .slice(0, 8)
      .map(({ el, t }) => ({ text: t, sel: brief(el) }));

    // Attend / Share / RSVP controls.
    const controls = Array.from(r.querySelectorAll('button, a[role="button"]'))
      .map((el) => ({
        text: txt(el),
        aria: el.getAttribute('aria-label'),
        pressed: el.getAttribute('aria-pressed'),
        expanded: el.getAttribute('aria-expanded'),
        disabled: (el as HTMLButtonElement).disabled ?? null,
        sel: brief(el),
      }))
      .filter((c) => /attend|share|invite|rsvp|going|register|join/i.test(`${c.text} ${c.aria ?? ''}`))
      .slice(0, 25);

    return {
      topDocTextLen: document.body.innerText.length,
      iframeCount: frames.length,
      usedIframe,
      rootTextLen: (r.body?.innerText || '').length,
      title: txt(r.querySelector('h1')),
      htmlLang: r.documentElement.getAttribute('lang'),
      shareButtonPresent: !!r.querySelector('button.events-components-shared-support-share__share-button'),
      ldJson,
      metas,
      timeEls,
      dateish,
      controls,
    };
  });
  console.log(JSON.stringify(probe, null, 2));
} catch (e) {
  console.error('[probe-event] ERROR:', (e as Error).message);
} finally {
  await ctx.close();
  console.log('[probe-event] closed (read-only).');
}
