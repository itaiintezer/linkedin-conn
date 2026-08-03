// Read-only DOM probe for the Pending / Connect / Connected affordances on the profile
// top card. Exists because a Sales Navigator licence restructures the top card: the
// primary slots go to Message + "Save in Sales Navigator" and the Pending state is
// demoted into the "More" overflow menu, where the driver's `pendingBadge` selector
// (a VISIBLE [aria-label*="Pending"]) cannot see it. The post-submit confirmation then
// reads its own blindness as "already connected" (linkedin-driver.ts:154).
//
// No clicks except the "More" overflow toggle. No sends, no invites, no withdrawals.
//
// Run (app stopped — the browser profile is single-instance):
//   npx tsx scripts/probe-pending.ts <slug> [label]
// e.g.
//   npx tsx scripts/probe-pending.ts brian-palazini-b5a52b7 pending
//
// Writes data/probe/pending-<label>-<slug>.json plus two screenshots. Send all three.
import { launchPersistentContext } from 'cloakbrowser';
import { mkdirSync, writeFileSync } from 'node:fs';
import { BROWSER_PROFILE_DIR } from '../src/config.js';

const [slug, label = 'case'] = process.argv.slice(2);
if (!slug) {
  console.error('usage: probe-pending.ts <slug> [label]');
  console.error('  <slug> is the bit after /in/ — e.g. brian-palazini-b5a52b7');
  process.exit(1);
}

const OUT_DIR = 'data/probe';
const stem = `pending-${label}-${slug}`;
mkdirSync(OUT_DIR, { recursive: true });

/**
 * Everything we need to write a verified selector, gathered in one page context:
 * which controls exist, what the driver's own selectors match, and whether each
 * match is actually VISIBLE (the distinction that breaks on the Sales Nav layout).
 */
function collect() {
  const vis = (el: Element): boolean => {
    if (el.getClientRects().length === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  };
  const brief = (el: Element) =>
    `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}.${(el.className || '').toString().split(/\s+/).slice(0, 3).join('.')}`;
  const chain = (el: Element, depth = 6) => {
    const out: string[] = [];
    let cur: Element | null = el;
    while (cur && out.length < depth) { out.push(brief(cur)); cur = cur.parentElement; }
    return out;
  };
  const describe = (el: Element) => ({
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute('role'),
    ariaLabel: el.getAttribute('aria-label'),
    text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
    href: el.getAttribute('href')?.slice(0, 160) ?? null,
    visible: vis(el),
    chain: chain(el),
    outerHTML: el.outerHTML.slice(0, 500),
  });
  const all = (sel: string) => Array.from(document.querySelectorAll(sel));

  // Any element whose own text is exactly "Pending" — the Sales Nav menu item included.
  const pendingByText = all('button, a, div, span, li, p, h2')
    .filter((el) => /^pending$/i.test((el.textContent || '').replace(/\s+/g, ' ').trim()))
    .filter((el) => el.querySelectorAll('button, a').length === 0)
    .map(describe);

  // Anything hinting at an existing connection — the positive 1st-degree signal the
  // driver currently lacks (it infers "connected" from the ABSENCE of Connect).
  const connectedHints = all('button, a, div, span, li')
    .filter((el) => /^(remove connection|connected|unfollow|remove your connection)$/i
      .test((el.textContent || '').replace(/\s+/g, ' ').trim()))
    .map(describe);

  const main = document.querySelector('main');
  return {
    lang: document.documentElement.getAttribute('lang'),
    url: location.href,
    title: document.title,
    hasSalesNavButton: all('button, a')
      .some((el) => /sales navigator/i.test((el.textContent || '') + (el.getAttribute('aria-label') || ''))),

    // --- exactly what the driver's selectors see -------------------------------------
    driverSelectors: {
      // find.pendingBadge — needs a VISIBLE match to yield 'sent'.
      pendingBadge: all('[aria-label*="Pending" i]').map(describe),
      // find.connectByHref — the Connect-under-More anchor, language-independent.
      connectByHref: all('a[href*="custom-invite"]').map(describe),
      // find.connectByName — English-only aria-label on the top card.
      connectByName: all('[aria-label*="to connect"]').map(describe),
      // find.moreButton — the overflow toggle, collapsed.
      moreButton: all('main button')
        .filter((el) => /^more$/i.test((el.textContent || '').replace(/\s+/g, ' ').trim())
          || /^more$/i.test(el.getAttribute('aria-label') || ''))
        .map((el) => ({ ...describe(el), ariaExpanded: el.getAttribute('aria-expanded') })),
      // SEL.msgComposeLink — sendMessage() navigates here once its 1st-degree gate passes.
      msgComposeLink: all('a[href*="/messaging/compose/"]').map(describe),
    },

    pendingByText,
    connectedHints,
    degreeBadges: all('span, div')
      .filter((el) => /^(·\s*)?(1st|2nd|3rd)\+?$/.test((el.textContent || '').trim()))
      .map((el) => ({ text: (el.textContent || '').trim(), visible: vis(el), chain: chain(el) }))
      .slice(0, 6),

    // Every visible control in <main> — the action bar, plus some noise. Shows which
    // affordances hold the primary slots on this account's layout.
    visibleControls: (main ? Array.from(main.querySelectorAll('button, a')) : [])
      .filter(vis)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
        ariaLabel: el.getAttribute('aria-label')?.slice(0, 100) ?? null,
        href: el.getAttribute('href')?.slice(0, 120) ?? null,
      }))
      .filter((c) => c.text || c.ariaLabel)
      .slice(0, 45),

    // Any open dropdown surface, verbatim — this is where Pending hides.
    dropdowns: all('[class*="artdeco-dropdown__content"], [role="menu"]')
      .map((el) => ({ visible: vis(el), chain: chain(el), outerHTML: el.outerHTML.slice(0, 6000) })),
  };
}

const ctx = await launchPersistentContext({
  userDataDir: BROWSER_PROFILE_DIR, headless: false, humanize: true,
  locale: 'en-US', viewport: { width: 1280, height: 900 },
});
// Same language pin as the real session (cloak-session.ts) — without it the cold first
// navigation can render non-English and every English selector misses for that reason
// instead of the one we are probing.
await ctx.addCookies([
  { name: 'lang', value: 'v=2&lang=en-US', domain: '.linkedin.com', path: '/' },
  { name: 'lang', value: 'v=2&lang=en-US', domain: '.www.linkedin.com', path: '/' },
]);
const page = ctx.pages()[0] ?? (await ctx.newPage());
try {
  await page.goto(`https://www.linkedin.com/in/${slug}`, { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 8000));

  const collapsed = await page.evaluate(collect);
  await page.screenshot({ path: `${OUT_DIR}/${stem}-1-collapsed.png`, fullPage: false });

  // Expand the overflow with the driver's own locator, so a failure to find it here is
  // a failure the driver would have too.
  let moreClicked = false;
  const more = page.locator('main').getByRole('button', { name: /^more$/i, expanded: false }).first();
  if (await more.isVisible().catch(() => false)) {
    await more.click().catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
    moreClicked = true;
  }
  const expanded = await page.evaluate(collect);
  await page.screenshot({ path: `${OUT_DIR}/${stem}-2-expanded.png`, fullPage: false });

  const report = { slug, label, probedAt: new Date().toISOString(), moreClicked, collapsed, expanded };
  writeFileSync(`${OUT_DIR}/${stem}.json`, JSON.stringify(report, null, 2));

  // Console summary: the four facts that decide the fix.
  const v = (list: Array<{ visible: boolean }>) => `${list.length} in DOM, ${list.filter((x) => x.visible).length} visible`;
  console.log(`\n=== ${slug} (${label}) ===`);
  console.log(`sales navigator UI present : ${collapsed.hasSalesNavButton}`);
  console.log(`html lang                  : ${collapsed.lang}`);
  console.log(`degree badge               : ${collapsed.degreeBadges.map((d) => d.text).join(', ') || '(none)'}`);
  console.log(`--- collapsed (what the driver judges on) ---`);
  console.log(`[aria-label*=Pending]      : ${v(collapsed.driverSelectors.pendingBadge)}`);
  console.log(`text "Pending"             : ${v(collapsed.pendingByText)}`);
  console.log(`custom-invite anchor       : ${v(collapsed.driverSelectors.connectByHref)}`);
  console.log(`"to connect" aria-label    : ${v(collapsed.driverSelectors.connectByName)}`);
  console.log(`connected hints            : ${v(collapsed.connectedHints)}`);
  console.log(`messaging compose anchor   : ${v(collapsed.driverSelectors.msgComposeLink)}`);
  console.log(`--- after clicking More (clicked: ${moreClicked}) ---`);
  console.log(`[aria-label*=Pending]      : ${v(expanded.driverSelectors.pendingBadge)}`);
  console.log(`text "Pending"             : ${v(expanded.pendingByText)}`);
  console.log(`custom-invite anchor       : ${v(expanded.driverSelectors.connectByHref)}`);
  console.log(`connected hints            : ${v(expanded.connectedHints)}`);
  console.log(`\nwrote ${OUT_DIR}/${stem}.json + 2 screenshots`);
} catch (e) {
  console.error('[probe-pending] ERROR:', (e as Error).message);
} finally {
  await ctx.close();
  console.log('[probe-pending] closed (read-only — nothing was sent or withdrawn).');
}
