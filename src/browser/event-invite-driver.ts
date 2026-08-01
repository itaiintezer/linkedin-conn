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
import { typeaheadQueryFor } from '../core/event-buckets.js';
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

/** Close the picker, discarding any selection. */
export async function closePicker(page: Page): Promise<void> {
  await dismissOverlays(page);
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

  const opened = await openInvitePicker(page);
  if (opened.status !== 'ok') {
    return { ...empty, outcome: opened.status === 'checkpoint' ? 'checkpoint' : 'failed',
      error: opened.error, evidence: opened.evidence };
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
    await closePicker(page);
    // Never guess at a near-match: skip the bucket and say so.
    return { ...empty, outcome: 'no_geo', error: `no exact geo match for ${req.geoCandidates.join(' / ')}` };
  }
  await sleep(1500);

  // The real gate on the filter having applied: a CHECKED value must now exist.
  const checkedGeo = await page.evaluate(`${P}
    (() => {
      const c = Array.from(document.querySelectorAll('${EVSEL.locationValue}')).find(i => i.checked);
      return c ? c.value : null;
    })()
  `) as string | null;
  if (checkedGeo === null) {
    await closePicker(page);
    return { ...empty, outcome: 'no_geo', geoLabel, error: 'location filter did not apply' };
  }

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
        const seen = [];
        for (const r of rows) {
          const cb = r.querySelector('input[type="checkbox"]');
          const m = cb && cb.id && cb.id.match(/${MEMBER_URN_PATTERN}/);
          if (m && want.indexOf(m[1]) !== -1) seen.push(m[1]);
        }
        return { rows: rows.length, found: seen };
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
  const ticked = await page.evaluate(`${P}
    ((want, limit) => {
      const rows = Array.from(document.querySelectorAll('${EVSEL.resultRow}'));
      const done = [];
      for (const r of rows) {
        if (done.length >= limit) break;
        const cb = r.querySelector('input[type="checkbox"]');
        if (!cb || !cb.id) continue;
        const m = cb.id.match(/${MEMBER_URN_PATTERN}/);
        if (!m || want.indexOf(m[1]) === -1) continue;
        if (cb.checked) { done.push(m[1]); continue; }
        // Click the LABEL: a bare input.click() can bypass Ember's change binding.
        const label = r.querySelector('${EVSEL.rowLabel}') || r.querySelector('label');
        if (label) label.click(); else cb.click();
        done.push(m[1]);
      }
      return done;
    })(${JSON.stringify([...pending])}, ${Math.max(0, req.limit)})
  `) as string[];

  await sleep(800);

  const state = await page.evaluate(`${P}
    (() => {
      const modal = document.querySelector('${EVSEL.pickerModal}')
        || (document.querySelector('${EVSEL.resultsContainer}') || {}).closest?.('${EVSEL.anyDialog}');
      if (!modal) return null;
      const txt = (e) => (e && e.textContent || '').replace(/\\s+/g,' ').trim();
      const submit = Array.from(modal.querySelectorAll('button'))
        .find(b => /^invite\\s*\\d*$/i.test(txt(b)));
      return {
        checked: modal.querySelectorAll('input[type="checkbox"]:checked').length,
        submitText: submit ? txt(submit) : null,
        submitDisabled: submit ? (submit.disabled || (submit.className||'').includes('artdeco-button--disabled')) : true,
      };
    })()
  `) as { checked: number; submitText: string | null; submitDisabled: boolean } | null;

  if (ticked.length === 0) {
    await closePicker(page);
    return { outcome, geoLabel, geoUrn: checkedGeo, rowsLoaded,
      matchedUrns: [], tickedUrns: [], submitted: false };
  }

  // Assert the UI agrees with us before anything irreversible. A count mismatch means we
  // ticked something the page did not register, or vice versa.
  const expected = ticked.length;
  if (state === null || state.checked !== expected) {
    await closePicker(page);
    return { outcome: 'failed', geoLabel, geoUrn: checkedGeo, rowsLoaded,
      matchedUrns: ticked, tickedUrns: [], submitted: false,
      error: `selection mismatch: ticked ${expected}, modal shows ${state?.checked ?? 'no modal'}`,
      evidence: await errorEvidence(page, 'selection mismatch') };
  }

  if (req.dryRun) {
    log.info('events', 'dry run — not submitting', { geoLabel, wouldInvite: expected });
    await closePicker(page);
    return { outcome, geoLabel, geoUrn: checkedGeo, rowsLoaded,
      matchedUrns: ticked, tickedUrns: ticked, submitted: false };
  }

  // --- Submit. The only irreversible step. ----------------------------------------
  if (state.submitDisabled) {
    await closePicker(page);
    return { outcome: 'failed', geoLabel, geoUrn: checkedGeo, rowsLoaded,
      matchedUrns: ticked, tickedUrns: [], submitted: false,
      error: 'submit button disabled with a non-empty selection',
      evidence: await errorEvidence(page, 'submit disabled') };
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
