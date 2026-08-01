// Read-only-ish probe, phase 3: the selection mechanism and the early exit.
// Filters one geo, loads pages ONLY until every target URN is present (the design's
// "stop when the list is exhausted" exit), ticks those rows, and verifies the selected
// counter and the submit label.
//
// SAFETY: the submit button is READ, never clicked. This is exactly the dry-run path.
// Run (app stopped): npx tsx scripts/probe-event-tick.ts <eventUrl> <geoExact> <urn,urn>
import { launchPersistentContext } from 'cloakbrowser';
import { BROWSER_PROFILE_DIR } from '../src/config.js';

const [url, geoExact, urnCsv] = process.argv.slice(2);
if (!url || !geoExact || !urnCsv) {
  console.error('usage: probe-event-tick.ts <eventUrl> <geoExact> <urn,urn>');
  process.exit(1);
}
const targets = urnCsv.split(',').map((s) => s.trim()).filter(Boolean);

const ctx = await launchPersistentContext({
  userDataDir: BROWSER_PROFILE_DIR, headless: false, humanize: true,
  locale: 'en-US', viewport: { width: 1280, height: 900 },
});
await ctx.addCookies([
  { name: 'lang', value: 'v=2&lang=en-US', domain: '.linkedin.com', path: '/' },
  { name: 'lang', value: 'v=2&lang=en-US', domain: '.www.linkedin.com', path: '/' },
]);
const page = ctx.pages()[0] ?? (await ctx.newPage());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PRELUDE = `(globalThis).__name = (t) => t;`;

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await sleep(9000);

  // Attend only if not already attending.
  const needsAttend = await page.evaluate(`${PRELUDE}
    !!Array.from(document.querySelectorAll('button'))
      .find(b => /^attend$/i.test((b.textContent||'').replace(/\\s+/g,' ').trim()))
  `);
  console.log('needsAttend:', needsAttend);
  if (needsAttend) {
    await page.evaluate(`${PRELUDE}
      Array.from(document.querySelectorAll('button'))
        .find(b => /^attend$/i.test((b.textContent||'').replace(/\\s+/g,' ').trim())).click()
    `);
    await sleep(6000);
  }
  await page.evaluate(`${PRELUDE}
    (() => {
      document.querySelectorAll('div[role="dialog"] button.artdeco-modal__dismiss, div[role="dialog"] button[aria-label="Dismiss"]').forEach(b => b.click());
      document.querySelectorAll('.artdeco-toast-item button[aria-label="Dismiss"]').forEach(b => b.click());
    })()
  `);
  await sleep(2000);

  // Share -> Invite
  await page.evaluate(`${PRELUDE}
    document.querySelector('button.events-components-shared-support-share__share-button').click()
  `);
  await sleep(2500);
  await page.evaluate(`${PRELUDE}
    Array.from(document.querySelectorAll('[role="menuitem"]'))
      .find(e => /^invite$/i.test((e.textContent||'').replace(/\\s+/g,' ').trim())).click()
  `);
  for (let i = 0; i < 30; i++) {
    if (await page.evaluate(`${PRELUDE} !!document.querySelector('.invitee-picker__results-container li[role="option"]')`)) break;
    await sleep(1000);
  }
  console.log('picker open');

  // Locations filter -> exact geo -> apply
  await page.evaluate(`${PRELUDE}
    document.querySelector('button.search-reusables__filter-pill-button[aria-label^="Locations filter"]').click()
  `);
  await sleep(2500);
  const input = page.locator('input.basic-input[role="combobox"][aria-label="Add a location"]');
  await input.click();
  await input.fill('');
  await input.type(geoExact.split(',')[0]!, { delay: 90 });
  await sleep(2800);
  const picked = await page.evaluate(`${PRELUDE}
    ((want) => {
      const opts = Array.from(document.querySelectorAll('.basic-typeahead__triggered-content [role="option"]'));
      const exact = opts.find(o => {
        const h = o.querySelector('.search-typeahead-v2__hit-text');
        return h && h.textContent.replace(/\\s+/g,' ').trim() === want;
      });
      if (!exact) return { ok: false, saw: opts.slice(0,5).map(o => (o.textContent||'').trim()) };
      exact.click();
      return { ok: true };
    })(${JSON.stringify(geoExact)})
  `);
  console.log('geo picked:', JSON.stringify(picked));
  if (!(picked as { ok: boolean }).ok) throw new Error('exact geo not found');
  await sleep(1800);
  await page.evaluate(`${PRELUDE}
    document.querySelector('button[aria-label="Apply current filter to show results"]').click()
  `);
  await sleep(5000);

  // Load pages ONLY until every target is present — the early exit.
  const t0 = Date.now();
  let pages = 0; let stable = 0; let prev = -1;
  let found: string[] = [];
  while (stable < 4) {
    found = await page.evaluate(`${PRELUDE}
      ((want) => {
        const rows = Array.from(document.querySelectorAll('.invitee-picker__results-container li[role="option"]'));
        const seen = new Set();
        for (const r of rows) {
          const cb = r.querySelector('input[type="checkbox"]');
          const m = cb && cb.id && cb.id.match(/(ACoAA[A-Za-z0-9_-]+)/);
          if (m) seen.add(m[1]);
        }
        return want.filter(u => seen.has(u));
      })(${JSON.stringify(targets)})
    `) as string[];
    if (found.length === targets.length) break;
    const snap = await page.evaluate(`${PRELUDE}
      (() => {
        const c = document.querySelector('.invitee-picker__results-container');
        const btn = document.querySelector('.scaffold-finite-scroll__load-button');
        if (btn && btn.offsetParent) btn.click();
        c.scrollTop = c.scrollHeight;
        return c.querySelectorAll('li[role="option"]').length;
      })()
    `) as number;
    await sleep(1300);
    stable = snap === prev ? stable + 1 : 0;
    prev = snap; pages++;
    if (pages % 5 === 0) console.log(`   ...${snap} rows, found ${found.length}/${targets.length} @ ${Math.round((Date.now()-t0)/1000)}s`);
  }
  const rowsLoaded = await page.evaluate(`${PRELUDE}
    document.querySelectorAll('.invitee-picker__results-container li[role="option"]').length
  `);
  console.log(`EARLY EXIT: found ${found.length}/${targets.length} after loading ${rowsLoaded} rows in ${Math.round((Date.now()-t0)/1000)}s`);

  // Tick each target by URN, clicking the LABEL (spec: a bare input.click() can bypass
  // Ember's change binding).
  const tickResults = [];
  for (const urn of targets) {
    const res = await page.evaluate(`${PRELUDE}
      ((urn) => {
        const rows = Array.from(document.querySelectorAll('.invitee-picker__results-container li[role="option"]'));
        const row = rows.find(r => {
          const cb = r.querySelector('input[type="checkbox"]');
          return cb && cb.id && cb.id.includes(urn);
        });
        if (!row) return { urn, found: false };
        const cb = row.querySelector('input[type="checkbox"]');
        const label = row.querySelector('label.invitee-picker-connections-result-item__checkbox') || row.querySelector('label');
        const name = (row.querySelector('.a11y-text')||{}).textContent?.replace(/\\s+/g,' ').trim();
        if (!cb.checked && label) label.click();
        return { urn, found: true, name, checkedAfter: cb.checked };
      })(${JSON.stringify(urn)})
    `);
    await sleep(700);
    // Re-read: Ember updates asynchronously.
    const confirmed = await page.evaluate(`${PRELUDE}
      ((urn) => {
        const cb = Array.from(document.querySelectorAll('input[type="checkbox"]'))
          .find(c => c.id && c.id.includes(urn));
        return cb ? cb.checked : null;
      })(${JSON.stringify(urn)})
    `);
    tickResults.push({ ...(res as object), confirmedChecked: confirmed });
    console.log('tick:', JSON.stringify(tickResults[tickResults.length - 1]));
  }

  const state = await page.evaluate(`${PRELUDE}
    (() => {
      const modal = document.querySelector('div[role="dialog"].invitee-picker__modal')
        || document.querySelector('.invitee-picker__results-container').closest('div[role="dialog"]');
      const txt = (e) => (e?.textContent||'').replace(/\\s+/g,' ').trim();
      const submit = Array.from(modal.querySelectorAll('button'))
        .filter(b => /^invite/i.test(txt(b)));
      return {
        checkedInModal: modal.querySelectorAll('input[type="checkbox"]:checked').length,
        selectedPanel: Array.from(modal.querySelectorAll('*'))
          .map(txt).filter(t => /^\\d+ selected$/.test(t))[0] || null,
        submit: submit.map(b => ({ text: txt(b), disabled: b.disabled,
          hasDisabledClass: (b.className||'').includes('artdeco-button--disabled') })),
        quotaText: Array.from(modal.querySelectorAll('p,span,div')).map(txt)
          .filter(t => t.length < 200 && /invit\\w+ (left|remaining)|you can invite|credit|limit|maximum/i.test(t)).slice(0,5),
      };
    })()
  `);
  console.log('SELECTION STATE:', JSON.stringify(state, null, 2));

  // Dismiss WITHOUT submitting.
  await page.evaluate(`${PRELUDE}
    (() => {
      const d = document.querySelector('.invitee-picker__modal button.artdeco-modal__dismiss')
        || document.querySelector('div[role="dialog"] button[aria-label="Dismiss"]');
      if (d) d.click();
    })()
  `);
  await sleep(1500);
  console.log('modal dismissed — NOTHING SUBMITTED');
} catch (e) {
  console.error('[probe-event-tick] ERROR:', (e as Error).message);
} finally {
  await ctx.close();
  console.log('[probe-event-tick] closed. No invitation was submitted.');
}
