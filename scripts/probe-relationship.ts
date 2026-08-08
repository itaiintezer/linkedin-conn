// Read-only probe of the four relationship signals on one profile page, printing every
// fact the driver's verdict rests on — built for the 2026-08-07/08 false "already
// connected" investigation, where a Pending badge belonging to a NEIGHBOUR card
// ("More profiles for you") satisfied the page-wide fallback in pendingForTarget, and
// a page that showed no signal at all ('unknown') was skipped as connected.
//
// For the URL/slug on argv it prints:
//   - the title-derived name and its canonicalName;
//   - EVERY [aria-label*="Pending" i]: the full label, whether it is inside <main>, and
//     the /in/<slug> of the nearest ancestor card that links to one — the two facts that
//     decide whether a badge belongs to the target or to a neighbour;
//   - every connectByName / connectByHref hit;
//   - the overflow menu's item texts after expanding (where "Remove connection" lives);
//   - the classifyRelationship verdict, via the same pure function the driver uses.
//
// No clicks except the "More" overflow toggle. No sends, no invites, no withdrawals.
//
// Run (app stopped — the browser profile is single-instance):
//   npx tsx scripts/probe-relationship.ts <slug-or-url> [label]
// e.g.
//   npx tsx scripts/probe-relationship.ts vince-aimutis false-skip
//
// Writes data/probe/relationship-<label>-<slug>.json plus two screenshots.
import { launchPersistentContext } from 'cloakbrowser';
import { mkdirSync, writeFileSync } from 'node:fs';
import { BROWSER_PROFILE_DIR } from '../src/config.js';
import { canonicalName } from '../src/core/name-match.js';
import { classifyRelationship } from '../src/core/relationship.js';

const [arg, label = 'case'] = process.argv.slice(2);
if (!arg) {
  console.error('usage: probe-relationship.ts <slug-or-url> [label]');
  process.exit(1);
}
const slug = arg.match(/\/in\/([^/?#]+)/)?.[1] ?? arg;

const OUT_DIR = 'data/probe';
const stem = `relationship-${label}-${slug}`;
mkdirSync(OUT_DIR, { recursive: true });

interface PendingBadgeSeen {
  label: string | null;
  visible: boolean;
  insideMain: boolean;
  nearestCardSlug: string | null;
}

/** Runs in the page. Same shape as probe-pending.ts' collector, narrowed to the four
 *  signals plus the badge-ancestry facts this investigation needs. */
function collect() {
  // esbuild keepNames shim — must stay the FIRST statement (see probe-pending.ts).
  (globalThis as { __name?: unknown }).__name = (t: unknown) => t;

  const vis = (el: Element): boolean => {
    if (el.getClientRects().length === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  };
  // The /in/<slug> of the nearest ancestor that contains one — how a neighbour card's
  // badge is attributed to the neighbour. Stops at <main>/body: a hit that generic is
  // the whole page, not a card.
  const cardSlug = (el: Element): string | null => {
    let cur: Element | null = el;
    while (cur && cur.tagName !== 'MAIN' && cur !== document.body) {
      const a = cur.querySelector('a[href*="/in/"]');
      const m = a?.getAttribute('href')?.match(/\/in\/([^/?#]+)/);
      if (m) return decodeURIComponent(m[1]!);
      cur = cur.parentElement;
    }
    return null;
  };
  const all = (sel: string) => Array.from(document.querySelectorAll(sel));

  return {
    lang: document.documentElement.getAttribute('lang'),
    url: location.href,
    title: document.title,
    pendingBadges: all('[aria-label*="Pending" i]').map((el) => ({
      label: el.getAttribute('aria-label'),
      visible: vis(el),
      insideMain: !!el.closest('main'),
      nearestCardSlug: cardSlug(el),
    })),
    connectByName: all('[aria-label*="to connect" i]').map((el) => ({
      label: el.getAttribute('aria-label'),
      visible: vis(el),
      insideMain: !!el.closest('main'),
    })),
    connectByHref: all('a[href*="custom-invite"]').map((el) => ({
      href: el.getAttribute('href')?.slice(0, 160) ?? null,
      visible: vis(el),
    })),
    overflowItems: all('.artdeco-dropdown__content [role="menuitem"], [role="menu"] [role="menuitem"]')
      .map((el) => ({ text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80), visible: vis(el) })),
  };
}

const ctx = await launchPersistentContext({
  userDataDir: BROWSER_PROFILE_DIR, headless: false, humanize: true,
  locale: 'en-US', viewport: { width: 1280, height: 900 },
});
// Same language pin as the real session (cloak-session.ts).
await ctx.addCookies([
  { name: 'lang', value: 'v=2&lang=en-US', domain: '.linkedin.com', path: '/' },
  { name: 'lang', value: 'v=2&lang=en-US', domain: '.www.linkedin.com', path: '/' },
]);
const page = ctx.pages()[0] ?? (await ctx.newPage());
try {
  const url = `https://www.linkedin.com/in/${slug}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 8000));

  // The driver's own name derivation (linkedin-driver.ts readFullName), inlined so the
  // probe cannot drift from it silently: title, minus counters and the headline tail.
  const title = await page.title().catch(() => '');
  const fullName = title.replace(/^\(\d+\+?\)\s*/, '').replace(/\s*[|·].*$/, '').trim();
  const nameRead = !!fullName && !/linkedin/i.test(fullName);

  const collapsed = await page.evaluate(collect);
  await page.screenshot({ path: `${OUT_DIR}/${stem}-1-collapsed.png`, fullPage: false });

  let moreClicked = false;
  const more = page.locator('main').getByRole('button', { name: /^more$/i, expanded: false }).first();
  if (await more.isVisible().catch(() => false)) {
    await more.click().catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
    moreClicked = true;
  }
  const expanded = await page.evaluate(collect);
  await page.screenshot({ path: `${OUT_DIR}/${stem}-2-expanded.png`, fullPage: false });

  // Reproduce the verdict with the same pure classifier the driver calls. "For the
  // target" here means the CURRENT driver semantics (any visible badge / any connect hit
  // for this name or slug), so the probe shows what the driver would decide today.
  const canonical = canonicalName(fullName);
  const badgeForTarget = (b: PendingBadgeSeen): boolean =>
    b.visible && (
      (!!b.label && canonicalName(b.label).includes(canonical) && canonical.length > 0)
      || b.nearestCardSlug === slug
    );
  const anyVisible = (xs: Array<{ visible: boolean }>) => xs.some((x) => x.visible);
  const signals = {
    nameRead,
    pendingForTarget: expanded.pendingBadges.some(badgeForTarget),
    /** what the driver's page-wide FALLBACK would add on top — the suspect read */
    pendingAnywhere: anyVisible(expanded.pendingBadges),
    connectForTarget: anyVisible(expanded.connectByName.filter((c) =>
      !!c.label && canonical.length > 0 && canonicalName(c.label).includes(canonical)))
      || anyVisible(expanded.connectByHref.filter((c) => c.href?.includes(slug))),
    removeConnection: expanded.overflowItems.some((i) => /remove connection/i.test(i.text) && i.visible),
  };
  const verdictScoped = classifyRelationship(signals);
  const verdictAsDriverToday = classifyRelationship({ ...signals, pendingForTarget: signals.pendingAnywhere });

  const report = {
    slug, label, probedAt: new Date().toISOString(), moreClicked,
    fullName, canonicalName: canonical, signals, verdictScoped, verdictAsDriverToday,
    collapsed, expanded,
  };
  writeFileSync(`${OUT_DIR}/${stem}.json`, JSON.stringify(report, null, 2));

  console.log(`\n=== ${slug} (${label}) ===`);
  console.log(`name (title-derived)      : ${fullName || '(none)'} → canonical "${canonical}"`);
  console.log(`pending badges in DOM     : ${expanded.pendingBadges.length}`);
  for (const b of expanded.pendingBadges) {
    console.log(`  - visible=${b.visible} inMain=${b.insideMain} cardSlug=${b.nearestCardSlug} label="${b.label}"`);
  }
  console.log(`connect (name)            : ${expanded.connectByName.filter((c) => c.visible).map((c) => c.label).join(' | ') || '(none visible)'}`);
  console.log(`connect (custom-invite)   : ${expanded.connectByHref.filter((c) => c.visible).map((c) => c.href).join(' | ') || '(none visible)'}`);
  console.log(`overflow items            : ${expanded.overflowItems.filter((i) => i.visible).map((i) => i.text).join(' | ') || '(none)'}`);
  console.log(`signals                   : ${JSON.stringify(signals)}`);
  console.log(`verdict (target-scoped)   : ${verdictScoped}`);
  console.log(`verdict (driver today)    : ${verdictAsDriverToday}${verdictScoped !== verdictAsDriverToday ? '   <-- the page-wide fallback changes the verdict' : ''}`);
  console.log(`\nwrote ${OUT_DIR}/${stem}.json + 2 screenshots`);
} catch (e) {
  console.error('[probe-relationship] ERROR:', (e as Error).message);
} finally {
  await ctx.close();
  console.log('[probe-relationship] closed (read-only — nothing was sent or withdrawn).');
}
