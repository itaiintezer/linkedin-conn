// Read-only DOM probe for the event-invite flow, phase 2: the invitee picker.
// Answers: is Invite in the Share menu before attending, what does a person row look
// like, does the Locations typeahead expose US states as geos, and is the filtered
// result list capped?
//
// SAFETY: this NEVER clicks the final "Invite N" submit. It opens menus, applies a
// location filter, scrolls, and reads. Nothing here dispatches an invitation.
//
// Run (app stopped): npx tsx scripts/probe-event-invite.ts <eventUrl> [geoQuery] [scrollSeconds]
import { launchPersistentContext } from 'cloakbrowser';
import { BROWSER_PROFILE_DIR } from '../src/config.js';

const [url, geoQuery = 'Israel', scrollSecondsRaw = '150'] = process.argv.slice(2);
if (!url) { console.error('usage: probe-event-invite.ts <eventUrl> [geoQuery] [scrollSeconds]'); process.exit(1); }
const scrollSeconds = Number(scrollSecondsRaw);

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
const out: Record<string, unknown> = {};

/** Injected into every page.evaluate: esbuild emits __name calls into evaluated fns. */
const PRELUDE = `(globalThis).__name = (t) => t;`;

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await sleep(9000);

  // --- Step 0: Attend. Verified prerequisite — with the account not attending, the
  // Share menu offers only Repost/Send/Copy link/Twitter/Facebook; no Invite item. ---
  out.attendBefore = await page.evaluate(`${PRELUDE}
    (() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const t = b => (b.textContent||'').replace(/\\s+/g,' ').trim();
      const attend = btns.find(b => /^attend$/i.test(t(b)));
      // What does the control become once you are attending? Dump every short-labelled
      // button in the top card so the already-attending state can be recognised.
      const topCardButtons = btns.filter(b => t(b).length > 0 && t(b).length < 40)
        .slice(0, 18).map(b => ({ text: t(b), aria: b.getAttribute('aria-label'), cls: (b.className||'').toString().slice(0,90) }));
      return { hasAttend: !!attend, topCardButtons };
    })()
  `);
  console.log('[0] attend state before:', JSON.stringify(out.attendBefore));

  if ((out.attendBefore as { hasAttend: boolean }).hasAttend) {
    await page.evaluate(`${PRELUDE}
      (() => {
        const b = Array.from(document.querySelectorAll('button'))
          .find(b => /^attend$/i.test((b.textContent||'').replace(/\\s+/g,' ').trim()));
        b.click();
      })()
    `);
    await sleep(6000);
    out.attendAfter = await page.evaluate(`${PRELUDE}
      (() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const attending = btns.find(b => /^attending/i.test((b.textContent||'').replace(/\\s+/g,' ').trim()));
        // A confirmation dialog sometimes appears asking to confirm the RSVP.
        const dialog = document.querySelector('div[role="dialog"]');
        return {
          hasAttending: !!attending,
          attendingText: attending ? (attending.textContent||'').replace(/\\s+/g,' ').trim() : null,
          dialogHeading: dialog ? (dialog.querySelector('h2,h3')||{}).textContent?.replace(/\\s+/g,' ').trim() : null,
          toast: Array.from(document.querySelectorAll('.artdeco-toast-item'))
            .map(t => (t.textContent||'').replace(/\\s+/g,' ').trim().slice(0,120)),
        };
      })()
    `);
    console.log('[0b] attend state after:', JSON.stringify(out.attendAfter, null, 2));
  }

  // Attending pops a "Next steps" dialog that sits in front of everything and is NOT the
  // invitee picker — dismiss any open modal before touching Share. Also dismiss the
  // "You are now attending" toast, which the spec warns overlays the picker's low rows.
  await page.evaluate(`${PRELUDE}
    (() => {
      document.querySelectorAll('div[role="dialog"] button.artdeco-modal__dismiss, div[role="dialog"] button[aria-label="Dismiss"]')
        .forEach(b => b.click());
      document.querySelectorAll('.artdeco-toast-item button[aria-label="Dismiss"]').forEach(b => b.click());
    })()
  `);
  await sleep(2000);

  // --- Step 1: open the Share dropdown. ----------------------------------------
  await page.evaluate(`${PRELUDE}
    document.querySelector('button.events-components-shared-support-share__share-button').click();
  `);
  await sleep(2500);

  out.shareMenu = await page.evaluate(`${PRELUDE}
    (() => {
      const items = Array.from(document.querySelectorAll('[role="menuitem"]'));
      return {
        open: !!document.querySelector('.artdeco-dropdown__content--is-open'),
        items: items.map(el => ({
          text: (el.textContent||'').replace(/\\s+/g,' ').trim(),
          tag: el.tagName.toLowerCase(),
          cls: (el.className||'').toString().slice(0,120),
        })),
      };
    })()
  `);
  console.log('[1] share menu:', JSON.stringify(out.shareMenu, null, 2));

  // --- Step 2: click Invite, wait for the picker modal. ------------------------
  const clickedInvite = await page.evaluate(`${PRELUDE}
    (() => {
      const el = Array.from(document.querySelectorAll('[role="menuitem"]'))
        .find(e => /^invite$/i.test((e.textContent||'').replace(/\\s+/g,' ').trim()));
      if (!el) return false;
      el.click();
      return true;
    })()
  `);
  console.log('[2] clicked Invite menu item:', clickedInvite);
  if (!clickedInvite) throw new Error('no Invite menu item — is attending a prerequisite?');

  // The invitee list is fetched async. Poll for the results container rather than
  // guessing a fixed wait, and never settle for "some dialog is open" — the Next-steps
  // dialog would satisfy that.
  for (let i = 0; i < 30; i++) {
    const ready = await page.evaluate(`${PRELUDE}
      !!document.querySelector('.invitee-picker__results-container li[role="option"]')
    `);
    if (ready) break;
    await sleep(1000);
  }

  out.modal = await page.evaluate(`${PRELUDE}
    (() => {
      const brief = (el) => el ? el.tagName.toLowerCase() + (el.id?('#'+el.id):'') + '.' + (el.className||'').toString().split(/\\s+/).slice(0,4).join('.') : null;
      const container = document.querySelector('.invitee-picker__results-container');
      const modal = document.querySelector('div[role="dialog"].invitee-picker__modal')
                 || (container && container.closest('div[role="dialog"]'))
                 || document.querySelector('div[role="dialog"]');
      if (!modal) return { found: false };
      const rows = Array.from(modal.querySelectorAll('li[role="option"]'));
      const pills = Array.from(modal.querySelectorAll('button')).filter(b => /filter/i.test(b.getAttribute('aria-label')||''));
      const submit = Array.from(modal.querySelectorAll('button')).filter(b => /^invite/i.test((b.textContent||'').replace(/\\s+/g,' ').trim()));
      return {
        found: true,
        heading: (modal.querySelector('h3')||{}).textContent?.replace(/\\s+/g,' ').trim(),
        modalSel: brief(modal),
        rowCount: rows.length,
        scrollBox: brief(modal.querySelector('.invitee-picker__results-container')),
        searchByName: !!modal.querySelector('input[placeholder="Search by name"]'),
        selectAll: !!modal.querySelector('#invitee-picker-filters-bar-select-all-checkbox'),
        filterPills: pills.map(p => ({ aria: p.getAttribute('aria-label'), text: (p.textContent||'').replace(/\\s+/g,' ').trim() })),
        submitButtons: submit.map(b => ({ text: (b.textContent||'').replace(/\\s+/g,' ').trim(), disabled: b.disabled, cls: (b.className||'').toString().slice(0,120) })),
        // Anything that looks like a quota/credit notice.
        quotaText: Array.from(modal.querySelectorAll('p,span,div'))
          .map(e => (e.textContent||'').replace(/\\s+/g,' ').trim())
          .filter(t => t.length < 200 && /invit\\w+ (left|remaining)|you can invite|credit|limit/i.test(t))
          .slice(0,5),
        sampleRows: rows.slice(0,3).map(r => {
          const cb = r.querySelector('input[type="checkbox"]');
          return {
            checkboxId: cb ? cb.id : null,
            checked: cb ? cb.checked : null,
            disabled: cb ? cb.disabled : null,
            a11y: (r.querySelector('.a11y-text')||{}).textContent?.replace(/\\s+/g,' ').trim(),
            text: (r.textContent||'').replace(/\\s+/g,' ').trim().slice(0,160),
            html: r.outerHTML.slice(0, 700),
          };
        }),
      };
    })()
  `);
  console.log('[3] modal:', JSON.stringify(out.modal, null, 2));

  // --- Step 3: open the Locations filter and probe the typeahead. --------------
  await page.evaluate(`${PRELUDE}
    (() => {
      const pill = document.querySelector('button.search-reusables__filter-pill-button[aria-label^="Locations filter"]')
        || Array.from(document.querySelectorAll('button')).find(b => /Locations/i.test((b.textContent||'')));
      pill.click();
    })()
  `);
  await sleep(2500);

  // THE location input is the one with aria-label="Add a location". Without that
  // qualifier `input.basic-input[role="combobox"]` also matches the global nav search
  // box, and a bare keyboard.type() then goes to whatever holds focus — which is the
  // nav search, silently producing company/school hits instead of geos.
  const LOC_INPUT = 'input.basic-input[role="combobox"][aria-label="Add a location"]';

  /** The values the dropdown offers with no query typed at all. */
  out.locationDefaults = await page.evaluate(`${PRELUDE}
    (() => Array.from(document.querySelectorAll('input[name="locations-filter-value"]'))
      .map(i => ({ id: i.id, value: i.value, checked: i.checked,
        label: (document.querySelector('label[for="'+i.id+'"]')||{}).innerText?.replace(/\\s+/g,' ').trim() })))()
  `);
  console.log('[3b] location values offered before typing:', JSON.stringify(out.locationDefaults, null, 2));

  /** Type a query into the location combobox and dump the geo suggestions. */
  async function typeahead(q: string) {
    const input = page.locator(LOC_INPUT);
    await input.click();
    await input.fill('');
    await sleep(400);
    await input.type(q, { delay: 90 });
    await sleep(2800);
    return page.evaluate(`${PRELUDE}
      (() => Array.from(document.querySelectorAll('.basic-typeahead__triggered-content [role="option"]'))
        .map(o => {
          const hit = o.querySelector('.search-typeahead-v2__hit-text');
          const sub = o.querySelector('.search-typeahead-v2__hit-subtitle');
          return {
            id: o.id || null,
            text: (o.textContent||'').replace(/\\s+/g,' ').trim().slice(0,90),
            hitText: hit ? hit.textContent.replace(/\\s+/g,' ').trim() : null,
            subtitle: sub ? sub.textContent.replace(/\\s+/g,' ').trim() : null,
          };
        }))()
    `);
  }

  out.typeaheadCalifornia = await typeahead('California');
  console.log('[4] typeahead "California":', JSON.stringify(out.typeaheadCalifornia, null, 2));
  // Georgia is the adversarial case: a US state AND a country. If exact-matching on
  // "Georgia, United States" can't separate them, US state bucketing is unsafe.
  out.typeaheadGeorgia = await typeahead('Georgia');
  console.log('[5] typeahead "Georgia":', JSON.stringify(out.typeaheadGeorgia, null, 2));
  out.typeaheadGeo = await typeahead(geoQuery);
  console.log(`[6] typeahead "${geoQuery}":`, JSON.stringify(out.typeaheadGeo, null, 2));

  // --- Step 4: select the requested geo exactly, apply, and measure the list. --
  const picked = await page.evaluate(`${PRELUDE}
    ((want) => {
      const opts = Array.from(document.querySelectorAll('.basic-typeahead__triggered-content [role="option"]'));
      const exact = opts.find(o => {
        const h = o.querySelector('.search-typeahead-v2__hit-text');
        return h && h.textContent.replace(/\\s+/g,' ').trim() === want;
      });
      const target = exact || opts[0];
      if (!target) return null;
      const label = (target.querySelector('.search-typeahead-v2__hit-text')||{}).textContent?.replace(/\\s+/g,' ').trim();
      target.click();
      return { exactMatch: !!exact, label };
    })(${JSON.stringify(geoQuery)})
  `);
  console.log('[7] picked suggestion:', JSON.stringify(picked));
  await sleep(2000);

  out.checkedValues = await page.evaluate(`${PRELUDE}
    (() => Array.from(document.querySelectorAll('input[name="locations-filter-value"]'))
      .map(i => ({ id: i.id, value: i.value, checked: i.checked,
        label: (document.querySelector('label[for="'+i.id+'"]')||{}).innerText?.replace(/\\s+/g,' ').trim() }))
      .filter(x => x.checked))()
  `);
  console.log('[8] checked location values:', JSON.stringify(out.checkedValues, null, 2));

  await page.evaluate(`${PRELUDE}
    document.querySelector('button[aria-label="Apply current filter to show results"]').click();
  `);
  await sleep(5000);

  // --- Step 5: exhaust the scroll, watching for a plateau (= a cap). -----------
  const deadline = Date.now() + scrollSeconds * 1000;
  const trace: { t: number; rows: number; scrollHeight: number; loader: boolean; loadBtn: boolean }[] = [];
  let stable = 0; let prev = -1;
  const t0 = Date.now();
  while (Date.now() < deadline && stable < 4) {
    const snap = await page.evaluate(`${PRELUDE}
      (() => {
        const c = document.querySelector('.invitee-picker__results-container');
        if (!c) return null;
        const btn = document.querySelector('.scaffold-finite-scroll__load-button');
        if (btn && btn.offsetParent) btn.click();
        c.scrollTop = c.scrollHeight;
        return {
          rows: c.querySelectorAll('li[role="option"]').length,
          scrollHeight: c.scrollHeight,
          loader: !!c.querySelector('.artdeco-loader'),
          loadBtn: !!(btn && btn.offsetParent),
        };
      })()
    `) as { rows: number; scrollHeight: number; loader: boolean; loadBtn: boolean } | null;
    if (!snap) break;
    await sleep(1300);
    stable = snap.rows === prev ? stable + 1 : 0;
    prev = snap.rows;
    trace.push({ t: Math.round((Date.now() - t0) / 1000), ...snap });
    if (trace.length % 10 === 0) console.log(`    ...${snap.rows} rows @ ${Math.round((Date.now()-t0)/1000)}s`);
  }
  out.scrollTrace = trace.filter((_, i) => i % 5 === 0 || i === trace.length - 1);
  out.finalRowCount = prev;
  out.plateauReached = stable >= 4;
  console.log('[9] scroll result:', JSON.stringify({ finalRowCount: prev, plateau: stable >= 4, samples: out.scrollTrace }, null, 2));

  // --- Step 6: what does the fully-loaded list look like? ---------------------
  const dump = await page.evaluate(`${PRELUDE}
    (() => {
      const rows = Array.from(document.querySelectorAll('.invitee-picker__results-container li[role="option"]'));
      const urn = (r) => {
        const cb = r.querySelector('input[type="checkbox"]');
        if (!cb || !cb.id) return null;
        const m = cb.id.match(/(ACoAA[A-Za-z0-9_-]+)/);
        return m ? m[1] : null;
      };
      const name = (r) => {
        const a = r.querySelector('.a11y-text');
        return a ? a.textContent.replace(/^Select\\s+/, '').replace(/\\s+/g,' ').trim() : null;
      };
      return {
        total: rows.length,
        withUrn: rows.filter(r => urn(r)).length,
        disabledCount: rows.filter(r => { const c = r.querySelector('input[type="checkbox"]'); return c && c.disabled; }).length,
        checkedCount: rows.filter(r => { const c = r.querySelector('input[type="checkbox"]'); return c && c.checked; }).length,
        people: rows.map(r => ({ urn: urn(r), name: name(r) })),
      };
    })()
  `) as { total: number; withUrn: number; disabledCount: number; checkedCount: number; people: { urn: string | null; name: string | null }[] };

  out.urnSummary = {
    total: dump.total, withUrn: dump.withUrn,
    disabledCount: dump.disabledCount, checkedCount: dump.checkedCount,
    first3: dump.people.slice(0, 3), last3: dump.people.slice(-3),
  };
  console.log('[10] urn extraction:', JSON.stringify(out.urnSummary, null, 2));

  const dumpPath = process.env.PROBE_DUMP;
  if (dumpPath) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(dumpPath, JSON.stringify({ geo: geoQuery, picked, people: dump.people }, null, 2));
    console.log('[11] wrote', dump.people.length, 'people to', dumpPath);
  }

  console.log('\\n=== FULL ===\\n' + JSON.stringify(out, null, 2));
} catch (e) {
  console.error('[probe-event-invite] ERROR:', (e as Error).message);
  console.error('partial:', JSON.stringify(out, null, 2));
} finally {
  await ctx.close();
  console.log('[probe-event-invite] closed. No invitation was submitted.');
}
