/**
 * Browser operations for the event-invite pipeline.
 *
 * Free functions over a Playwright `Page` rather than a class, so `LinkedInDriver` can
 * expose them while they stay independently testable and the single browser session
 * remains owned in one place.
 *
 * The one irreversible action in here is `submitInvites`. Everything else — opening
 * menus, filtering, paging, ticking checkboxes — is discardable: closing the modal throws
 * the selection away. That is exactly what dry-run mode relies on.
 */
import type { Page } from 'playwright-core';
import type {
  BucketRunRequest, BucketRunResult, EventPageInfo, EventStepOutcome, SendEvidence,
} from '../types.js';
import { EVSEL, PICKER_ROW_CAP, PICKER_SETTLE_MS } from './event-selectors.js';
import { detectCheckpoint } from '../core/checkpoint.js';
import { captureEvidence } from './evidence.js';
import { selectionDiff, typeaheadQueryFor } from '../core/event-buckets.js';
import { MEMBER_URN_PATTERN } from '../core/event-page.js';
import { log } from '../core/log.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = (min: number, max: number) => min + Math.floor(Math.random() * (max - min));

/**
 * esbuild (via tsx) injects `__name` calls into transpiled function bodies, which throws
 * inside the page. String-bodied evaluates bypass transpilation entirely, so the
 * DOM-heavy steps below are written as strings — the same form the live probes used.
 */
const P = '(globalThis).__name = (t) => t;';

async function scan(page: Page) {
  const url = page.url();
  const title = (await page.title().catch(() => '')) || '';
  const headings = await page.locator('h1').allInnerTexts().catch(() => [] as string[]);
  return detectCheckpoint({ url, title, headings });
}

async function checkpointOutcome(page: Page, matched: string | null): Promise<EventStepOutcome> {
  const ev = await captureEvidence(page, 'checkpoint', { matched });
  return {
    status: 'checkpoint',
    error: `checkpoint detected at ${page.url()}`,
    evidence: { pageUrl: page.url(), matched, screenshot: ev?.screenshot ?? null },
  };
}

async function errorEvidence(page: Page, error: string): Promise<SendEvidence> {
  const ev = await captureEvidence(page, 'event-invite-failed', { error });
  return { pageUrl: page.url(), screenshot: ev?.screenshot ?? null };
}

/** Close any open modal and any toast. Attending pops a "Next steps" dialog that would
 *  otherwise be mistaken for the picker, and the "You are now attending" toast overlays
 *  the picker's lower rows. */
async function dismissOverlays(page: Page): Promise<void> {
  await page.evaluate(`${P}
    (() => {
      document.querySelectorAll('${EVSEL.anyDialog} ${EVSEL.modalDismiss}, ${EVSEL.anyDialog} button[aria-label="Dismiss"]')
        .forEach(b => b.click());
      document.querySelectorAll('${EVSEL.toastDismiss}').forEach(b => b.click());
    })()
  `).catch(() => undefined);
  await sleep(900);
}

/** Navigate to the event and read its top card. */
export async function openEvent(page: Page, eventUrl: string): Promise<EventStepOutcome> {
  await page.goto(eventUrl, { waitUntil: 'domcontentloaded' });
  await sleep(rand(6000, 9000));

  const cp = await scan(page);
  if (cp.hit) return checkpointOutcome(page, cp.matched);

  const info = await page.evaluate(`${P}
    (() => {
      const txt = (e) => (e && e.textContent || '').replace(/\\s+/g, ' ').trim();
      const buttons = Array.from(document.querySelectorAll('button'));
      const attend = buttons.find(b => /^attend$/i.test(txt(b)));
      // The share control only exists on a real event page; its absence means we did not
      // land where we thought we did.
      const share = document.querySelector('${EVSEL.shareButton}');
      // Scope the date to the top card. A document-wide sweep also matches the sidebar
      // "more events" cards, and stamping a neighbouring event's date onto this campaign
      // would decide when the campaign stops inviting.
      const card = share ? share.closest('section, .artdeco-card, main') : null;
      const scope = card || document;
      const dateish = Array.from(scope.querySelectorAll('span, p, div'))
        .map(txt)
        .filter(t => t.length > 0 && t.length < 120
          && /\\b20\\d\\d\\b/.test(t)
          && /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(t));
      return {
        title: txt(document.querySelector('h1')) || null,
        startsAtText: dateish[0] || null,
        attending: !attend && !!share,
        canAttend: !!attend,
        hasShare: !!share,
      };
    })()
  `) as EventPageInfo & { hasShare: boolean };

  if (!info.hasShare) {
    return { status: 'unavailable', error: 'no Share control — not an event page, or no access',
      evidence: await errorEvidence(page, 'no share control') };
  }
  return { status: 'ok', info };
}

/**
 * RSVP. Verified prerequisite, not a courtesy: with the account not attending, the Share
 * menu offers only Repost / Send in a message / Copy link / Twitter / Facebook — the
 * Invite item does not exist at all.
 */
export async function attendEvent(page: Page): Promise<EventStepOutcome> {
  const clicked = await page.evaluate(`${P}
    (() => {
      const b = Array.from(document.querySelectorAll('button'))
        .find(b => /^attend$/i.test((b.textContent||'').replace(/\\s+/g,' ').trim()));
      if (!b) return false;
      b.click();
      return true;
    })()
  `) as boolean;
  if (!clicked) return { status: 'ok' }; // already attending

  await sleep(rand(4000, 6500));
  const cp = await scan(page);
  if (cp.hit) return checkpointOutcome(page, cp.matched);
  await dismissOverlays(page);

  const stillOffering = await page.evaluate(`${P}
    !!Array.from(document.querySelectorAll('button'))
      .find(b => /^attend$/i.test((b.textContent||'').replace(/\\s+/g,' ').trim()))
  `) as boolean;
  if (stillOffering) {
    return { status: 'unavailable', error: 'Attend did not take effect',
      evidence: await errorEvidence(page, 'attend did not take') };
  }
  log.info('events', 'attended');
  return { status: 'ok' };
}

/** Share -> Invite, waiting for the picker's first rows. */
export async function openInvitePicker(page: Page): Promise<EventStepOutcome> {
  await dismissOverlays(page);
  await page.evaluate(`${P}
    (() => { const b = document.querySelector('${EVSEL.shareButton}'); if (b) b.click(); })()
  `);
  await sleep(rand(1800, 2800));

  const clicked = await page.evaluate(`${P}
    (() => {
      const el = document.querySelector('${EVSEL.inviteMenuItem}')
        || Array.from(document.querySelectorAll('${EVSEL.menuItem}'))
            .find(e => /^invite$/i.test((e.textContent||'').replace(/\\s+/g,' ').trim()));
      if (!el) return false;
      el.click();
      return true;
    })()
  `) as boolean;
  if (!clicked) {
    return { status: 'unavailable', error: 'no Invite item in the Share menu (are we attending?)',
      evidence: await errorEvidence(page, 'no invite menu item') };
  }

  // The list is fetched async. Poll for a real row — never settle for "some dialog is
  // open", which the Next-steps dialog would satisfy.
  for (let i = 0; i < 30; i++) {
    const ready = await page.evaluate(`${P} !!document.querySelector('${EVSEL.resultRow}')`) as boolean;
    if (ready) return { status: 'ok' };
    await sleep(1000);
  }
  const cp = await scan(page);
  if (cp.hit) return checkpointOutcome(page, cp.matched);
  return { status: 'unavailable', error: 'invitee picker did not load',
    evidence: await errorEvidence(page, 'picker did not load') };
}

/** Reload the event page — the reset no stuck modal can survive. */
async function reloadEventPage(page: Page, eventUrl: string): Promise<void> {
  await page.goto(eventUrl, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
  await sleep(rand(4000, 6000));
}

/**
 * Close the picker, discarding any selection — and PROVE it closed.
 *
 * The 2026-08-14 incident captures showed the old click-and-sleep close never actually
 * closing the modal: every later bucket then inherited its location filters and its ticks
 * (the "2 Locations filters are applied" cascade), and the leftover modal covered the
 * Share button. Closing is now verified the way submitInvites verifies success — the
 * modal must detach — and when it will not, the event page is reloaded instead.
 */
export async function closePicker(page: Page, eventUrl: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    await dismissOverlays(page);
    // Dismissing a non-empty selection pops a confirmation that keeps the picker alive
    // until answered. Matched by text — it has no stable selector of its own.
    await page.evaluate(`${P}
      (() => {
        const txt = (e) => (e && e.textContent || '').replace(/\\s+/g,' ').trim();
        const b = Array.from(document.querySelectorAll('${EVSEL.anyDialog} button'))
          .find(b => /^discard/i.test(txt(b)));
        if (b) b.click();
      })()
    `).catch(() => undefined);
    for (let i = 0; i < 8; i++) {
      const gone = await page.evaluate(`${P} !document.querySelector('${EVSEL.pickerModal}')`)
        .catch(() => false) as boolean;
      if (gone) return;
      await sleep(1000);
    }
  }
  log.warn('events', 'picker would not close — reloading the event page');
  await reloadEventPage(page, eventUrl);
}

/**
 * Distinct member URNs whose row checkbox is checked right now.
 *
 * Duplicate rows for the same person share a checkbox id, and on duplicate ids only the
 * FIRST node in the document carries real state (it is the one every matching label's
 * `for=` resolves to) — so state is read off `getElementById`, and the result is a set
 * of people, never a count of nodes.
 */
async function checkedUrns(page: Page): Promise<string[]> {
  const urns = await page.evaluate(`${P}
    (() => {
      const out = new Set();
      for (const cb of document.querySelectorAll('${EVSEL.rowCheckbox}')) {
        if (!cb.id) continue;
        const m = cb.id.match(/${MEMBER_URN_PATTERN}/);
        if (!m) continue;
        const canonical = document.getElementById(cb.id);
        if (canonical && canonical.checked) out.add(m[1]);
      }
      return Array.from(out);
    })()
  `).catch(() => null) as string[] | null;
  return urns ?? [];
}

/**
 * Apply one location filter, exhaust the list, tick every pending match, and (unless dry)
 * submit.
 *
 * Ticking is driven by the caller's `pending` set, never by the bucket's own membership:
 * a Tel Aviv invitee who surfaces under the parent "Israel" pass should still be invited.
 * And because only URNs in that set are ever ticked, a mis-resolved geo can lose coverage
 * but can never invite the wrong person.
 */
export async function runBucket(page: Page, req: BucketRunRequest): Promise<BucketRunResult> {
  const empty: BucketRunResult = {
    outcome: 'failed', geoLabel: null, geoUrn: null, rowsLoaded: 0,
    matchedUrns: [], tickedUrns: [], submitted: false,
  };

  // A leftover modal from a previous bucket poisons everything after it: filters and
  // ticks accumulate inside it, and it covers the Share button (the 2026-08-14 Georgia
  // failure). Never build on a page that already has one.
  const stale = await page.evaluate(`${P} !!document.querySelector('${EVSEL.pickerModal}')`)
    .catch(() => false) as boolean;
  if (stale) {
    log.warn('events', 'stale picker modal at bucket start — reloading the event page');
    await reloadEventPage(page, req.eventUrl);
  }

  let opened = await openInvitePicker(page);
  if (opened.status !== 'ok') {
    return { ...empty, outcome: opened.status === 'checkpoint' ? 'checkpoint' : 'failed',
      error: opened.error, evidence: opened.evidence };
  }

  // A fresh picker starts with nobody selected. A retained selection means the previous
  // bucket's state survived; one reset is attempted, then the bucket refuses to run —
  // ticking on top of leftovers is how 605 people ended up selected under a 500 cap.
  let preChecked = await checkedUrns(page);
  if (preChecked.length > 0) {
    log.warn('events', 'picker opened with a retained selection — resetting', { checked: preChecked.length });
    await closePicker(page, req.eventUrl);
    opened = await openInvitePicker(page);
    if (opened.status !== 'ok') {
      return { ...empty, outcome: opened.status === 'checkpoint' ? 'checkpoint' : 'failed',
        error: opened.error, evidence: opened.evidence };
    }
    preChecked = await checkedUrns(page);
    if (preChecked.length > 0) {
      const evidence = await errorEvidence(page, 'picker retained a previous selection');
      await closePicker(page, req.eventUrl);
      return { ...empty, error: `picker retained a previous selection (${preChecked.length} checked)`, evidence };
    }
  }

  // --- Resolve the geo ------------------------------------------------------------
  await page.evaluate(`${P}
    (() => { const p = document.querySelector('${EVSEL.locationsPill}'); if (p) p.click(); })()
  `);
  await sleep(rand(1800, 2600));

  let geoLabel: string | null = null;
  for (const candidate of req.geoCandidates) {
    const input = page.locator(EVSEL.locationInput);
    if (!(await input.count())) break;
    await input.click().catch(() => undefined);
    await input.fill('');
    await sleep(350);
    await input.type(typeaheadQueryFor(candidate), { delay: 85 });
    await sleep(rand(2400, 3200));
    // Exact text only. "Georgia" ranks the COUNTRY first and "Georgia, United States"
    // second; "California" also returns "California, Maryland, United States".
    const hit = await page.evaluate(`${P}
      ((want) => {
        const opts = Array.from(document.querySelectorAll('${EVSEL.typeaheadOption}'));
        const exact = opts.find(o => {
          const h = o.querySelector('${EVSEL.typeaheadHitText}');
          return h && h.textContent.replace(/\\s+/g,' ').trim() === want;
        });
        if (!exact) return false;
        exact.click();
        return true;
      })(${JSON.stringify(candidate)})
    `) as boolean;
    if (hit) { geoLabel = candidate; break; }
  }

  if (geoLabel === null) {
    await closePicker(page, req.eventUrl);
    // Never guess at a near-match: skip the bucket and say so.
    return { ...empty, outcome: 'no_geo', error: `no exact geo match for ${req.geoCandidates.join(' / ')}` };
  }
  await sleep(1500);

  // The real gate on the filter having applied: EXACTLY ONE checked value must exist.
  // More than one means a previous bucket's filter survived — and reading "the first
  // checked" is how Texas got stamped with Tennessee's geo URN in event_buckets.
  const geoState = await page.evaluate(`${P}
    (() => {
      const checked = Array.from(document.querySelectorAll('${EVSEL.locationValue}')).filter(i => i.checked);
      return { count: checked.length, value: checked.length > 0 ? checked[0].value : null };
    })()
  `) as { count: number; value: string | null };
  if (geoState.count === 0 || geoState.value === null) {
    await closePicker(page, req.eventUrl);
    return { ...empty, outcome: 'no_geo', geoLabel, error: 'location filter did not apply' };
  }
  if (geoState.count > 1) {
    const evidence = await errorEvidence(page, 'stale location filters');
    await closePicker(page, req.eventUrl);
    return { ...empty, geoLabel, error: `stale location filters: ${geoState.count} applied`, evidence };
  }
  const checkedGeo = geoState.value;

  await page.evaluate(`${P}
    (() => { const b = document.querySelector('${EVSEL.showResults}'); if (b) b.click(); })()
  `);
  await sleep(rand(4000, 5500));

  // --- Exhaust the list -----------------------------------------------------------
  const pending = new Set(req.pending);
  let rowsLoaded = 0;
  let stable = 0;
  let prev = -1;
  let outcome: BucketRunResult['outcome'] = 'done';

  for (;;) {
    const snap = await page.evaluate(`${P}
      ((want) => {
        const rows = Array.from(document.querySelectorAll('${EVSEL.resultRow}'));
        // A Set of PEOPLE: the picker serves duplicate rows, and counting rows here
        // would satisfy the early-exit below before everyone was actually on screen.
        const seen = new Set();
        for (const r of rows) {
          const cb = r.querySelector('input[type="checkbox"]');
          const m = cb && cb.id && cb.id.match(/${MEMBER_URN_PATTERN}/);
          if (m && want.indexOf(m[1]) !== -1) seen.add(m[1]);
        }
        return { rows: rows.length, found: Array.from(seen) };
      })(${JSON.stringify([...pending])})
    `) as { rows: number; found: string[] };

    rowsLoaded = snap.rows;
    req.onProgress?.({ rowsLoaded, matched: snap.found.length });

    // Every target accounted for — no reason to keep paging. Measured at ~55% saved.
    if (snap.found.length >= pending.size) { outcome = 'early_exit'; break; }
    if (rowsLoaded >= PICKER_ROW_CAP) { outcome = 'row_cap'; break; }
    if (Date.now() > req.deadline.getTime()) { outcome = 'deadline'; break; }
    if (stable >= 3) { outcome = 'done'; break; }

    await page.evaluate(`${P}
      (() => {
        const c = document.querySelector('${EVSEL.resultsContainer}');
        if (!c) return;
        const btn = document.querySelector('${EVSEL.loadMoreButton}');
        if (btn && btn.offsetParent) btn.click();
        c.scrollTop = c.scrollHeight;
      })()
    `);
    await sleep(PICKER_SETTLE_MS);
    stable = rowsLoaded === prev ? stable + 1 : 0;
    prev = rowsLoaded;
  }

  // --- Tick the matches -----------------------------------------------------------
  // Each PERSON is ticked at most once. Duplicate rows for the same person share a
  // checkbox id; label.click() resolves `for=` to the FIRST node with that id, so a
  // second click on the same person would UNTICK them — that is exactly how 500 clicks
  // became 483 selected in the 2026-08-14 captures. `limit` therefore caps people.
  const ticked = await page.evaluate(`${P}
    ((want, limit) => {
      const rows = Array.from(document.querySelectorAll('${EVSEL.resultRow}'));
      const seen = new Set();
      for (const r of rows) {
        if (seen.size >= limit) break;
        const cb = r.querySelector('input[type="checkbox"]');
        if (!cb || !cb.id) continue;
        const m = cb.id.match(/${MEMBER_URN_PATTERN}/);
        if (!m || want.indexOf(m[1]) === -1 || seen.has(m[1])) continue;
        const canonical = document.getElementById(cb.id) || cb;
        if (canonical.checked) { seen.add(m[1]); continue; }
        // Click the LABEL: a bare input.click() can bypass Ember's change binding.
        const label = r.querySelector('${EVSEL.rowLabel}') || r.querySelector('label');
        if (label) label.click(); else canonical.click();
        seen.add(m[1]);
      }
      return Array.from(seen);
    })(${JSON.stringify([...pending])}, ${Math.max(0, req.limit)})
  `) as string[];

  if (ticked.length === 0) {
    await closePicker(page, req.eventUrl);
    return { outcome, geoLabel, geoUrn: checkedGeo, rowsLoaded,
      matchedUrns: [], tickedUrns: [], submitted: false };
  }

  // Assert the UI agrees with us before anything irreversible — as SETS of member URNs,
  // never counts (duplicate rows make node counts meaningless), and polled until the
  // page settles instead of hoping one fixed sleep is enough.
  let agreed = false;
  let pageUrns: string[] = [];
  for (let i = 0; i < 10; i++) {
    await sleep(500);
    pageUrns = await checkedUrns(page);
    const d = selectionDiff(ticked, pageUrns);
    if (d.missing.length === 0 && d.extra.length === 0) { agreed = true; break; }
  }

  const state = await page.evaluate(`${P}
    (() => {
      const modal = document.querySelector('${EVSEL.pickerModal}')
        || (document.querySelector('${EVSEL.resultsContainer}') || {}).closest?.('${EVSEL.anyDialog}');
      if (!modal) return null;
      const txt = (e) => (e && e.textContent || '').replace(/\\s+/g,' ').trim();
      const submit = Array.from(modal.querySelectorAll('button'))
        .find(b => /^invite\\s*\\d*$/i.test(txt(b)));
      return {
        submitText: submit ? txt(submit) : null,
        submitDisabled: submit ? (submit.disabled || (submit.className||'').includes('artdeco-button--disabled')) : true,
      };
    })()
  `) as { submitText: string | null; submitDisabled: boolean } | null;

  const expected = ticked.length;
  if (!agreed || state === null) {
    const d = selectionDiff(ticked, pageUrns);
    const sample = (a: string[]) => a.slice(0, 3).join(',') + (a.length > 3 ? ` +${a.length - 3}` : '');
    const detail = state === null ? 'no modal'
      : `page shows ${pageUrns.length}`
        + (d.missing.length > 0 ? `; missing ${sample(d.missing)}` : '')
        + (d.extra.length > 0 ? `; extra ${sample(d.extra)}` : '');
    const evidence = await errorEvidence(page, 'selection mismatch');
    await closePicker(page, req.eventUrl);
    return { outcome: 'failed', geoLabel, geoUrn: checkedGeo, rowsLoaded,
      matchedUrns: ticked, tickedUrns: [], submitted: false,
      error: `selection mismatch: ticked ${expected}, ${detail}`, evidence };
  }

  if (req.dryRun) {
    log.info('events', 'dry run — not submitting', { geoLabel, wouldInvite: expected });
    await closePicker(page, req.eventUrl);
    return { outcome, geoLabel, geoUrn: checkedGeo, rowsLoaded,
      matchedUrns: ticked, tickedUrns: ticked, submitted: false };
  }

  // --- Submit. The only irreversible step. ----------------------------------------
  if (state.submitDisabled) {
    const evidence = await errorEvidence(page, 'submit disabled');
    await closePicker(page, req.eventUrl);
    return { outcome: 'failed', geoLabel, geoUrn: checkedGeo, rowsLoaded,
      matchedUrns: ticked, tickedUrns: [], submitted: false,
      error: 'submit button disabled with a non-empty selection', evidence };
  }

  const submitted = await submitInvites(page, expected);
  if (!submitted.ok) {
    return { outcome: 'failed', geoLabel, geoUrn: checkedGeo, rowsLoaded,
      matchedUrns: ticked, tickedUrns: [], submitted: false,
      error: submitted.error, evidence: await errorEvidence(page, submitted.error) };
  }

  log.info('events', 'invites submitted', { geoLabel, count: expected });
  return { outcome, geoLabel, geoUrn: checkedGeo, rowsLoaded,
    matchedUrns: ticked, tickedUrns: ticked, submitted: true };
}

/**
 * Click Invite. IRREVERSIBLE — this dispatches real invitations.
 *
 * The label's trailing count is asserted against the intended selection first, so a
 * miscount can never be submitted. Afterwards the modal must detach: a lingering enabled
 * button with an unchanged counter means the POST failed, and that should be reported
 * rather than blindly re-clicked.
 */
async function submitInvites(
  page: Page, expectedCount: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const clicked = await page.evaluate(`${P}
    ((expected) => {
      const modal = document.querySelector('${EVSEL.pickerModal}');
      if (!modal) return 'no-modal';
      const txt = (e) => (e && e.textContent || '').replace(/\\s+/g,' ').trim();
      const submit = Array.from(modal.querySelectorAll('button.artdeco-button--primary'))
        .find(b => /^invite\\s*\\d*$/i.test(txt(b)));
      if (!submit) return 'no-button';
      const m = txt(submit).match(/(\\d+)/);
      const shown = m ? Number(m[1]) : null;
      if (shown !== expected) return 'count:' + String(shown);
      submit.click();
      return 'ok';
    })(${expectedCount})
  `) as string;

  if (clicked !== 'ok') {
    return { ok: false, error: `submit refused (${clicked}), expected ${expectedCount}` };
  }

  // The modal detaching is the success signal.
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    const gone = await page.evaluate(`${P} !document.querySelector('${EVSEL.pickerModal}')`) as boolean;
    if (gone) return { ok: true };
  }
  return { ok: false, error: 'modal did not close after submit — the POST may have failed' };
}
