// @vitest-environment jsdom
/// <reference lib="dom" />
/**
 * The Events tab.
 *
 * The tests that matter here are about honesty. This pipeline is best-effort by
 * construction — LinkedIn caps the invitee list at 1000 rows, and people with no usable
 * location can never be reached at all — so the screen's job is to say so BEFORE the
 * operator arms anything irreversible. A ladder that quietly draws a 2000-connection
 * bucket as if it were fully reachable would be worse than no ladder.
 */
import { test, expect, beforeEach, afterEach } from 'vitest';
import { loadApp, byId, stubFetchRoutes, type AppInternals } from './helpers/load-app.js';

let app: AppInternals;
const realFetch = globalThis.fetch;

beforeEach(() => { app = loadApp(); });
afterEach(() => { globalThis.fetch = realFetch; });

const bucket = (o: Partial<Record<string, unknown>> = {}) => ({
  id: 1, event_id: 1, rank: 0, label: 'Israel', geo_label: 'Israel', geo_urn: null,
  kind: 'country', target_count: 4, roster_count: 300, parent_bucket_id: null,
  status: 'pending', ...o,
});

const detail = (o: Record<string, unknown> = {}) => ({
  event: {
    id: 1, event_url: 'https://www.linkedin.com/events/7486088214579982336/',
    title: 'NYC Forum', starts_at: '2026-09-10T15:15:00.000Z', status: 'draft',
    invite_cap: 500, bucket_ceiling: 10, bucket_cursor: 0, attended: 0,
    close_reason: null, ...(o.event as object ?? {}),
  },
  counts: { pending: 4 },
  buckets: [bucket()],
  reservation: null,
  runs: [],
  ...o,
});

test('draws the 1000-row ceiling only on a bucket that actually overflows it', () => {
  app.evRenderDetail(detail({ buckets: [bucket({ roster_count: 300 })] }));
  expect(byId('evDetail').querySelector('.rung-cap')).toBeNull();
  expect(byId('evDetail').querySelector('.rung-over')).toBeNull();

  app.evRenderDetail(detail({ buckets: [bucket({ roster_count: 2017 })] }));
  expect(byId('evDetail').querySelector('.rung-cap')).not.toBeNull();
  expect(byId('evDetail').querySelector('.rung-over')).not.toBeNull();
});

test('says in words that an oversized bucket is only partly listable', () => {
  app.evRenderDetail(detail({ buckets: [bucket({ roster_count: 2017 })] }));
  expect(byId('evDetail').textContent).toContain('only the first 1,000 are listable');
});

test('states reach and the unreachable count before anything is armed', () => {
  app.evRenderDetail(detail({
    counts: { pending: 4, unreachable: 3 },
    buckets: [bucket({ target_count: 4 })],
  }));
  const txt = byId('evDetail').textContent ?? '';
  expect(txt).toContain('Best effort');
  expect(txt).toContain('4 of 7 are reachable by location');
  expect(txt).toContain('will never be invited');
});

test('offers Arm on a draft, and never a second time once armed', () => {
  app.evRenderDetail(detail());
  const draftBtns = Array.from(byId('evDetail').querySelectorAll('button')).map((b) => b.textContent);
  expect(draftBtns).toContain('Arm campaign');
  expect(draftBtns).toContain('Dry run');
  expect(draftBtns).not.toContain('Run now');

  app.evRenderDetail(detail({ event: { status: 'armed' } }));
  const armedBtns = Array.from(byId('evDetail').querySelectorAll('button')).map((b) => b.textContent);
  expect(armedBtns).not.toContain('Arm campaign');
  expect(armedBtns).toContain('Run now');
});

test('a draft offers Add people; a frozen plan does not', () => {
  app.evRenderDetail(detail());
  const host = byId('evDetail');
  const btns = Array.from(host.querySelectorAll('button')).map((b) => b.textContent);
  expect(btns).toContain('Add people');
  const form = host.querySelector('.ev-add') as HTMLElement;
  expect(form).not.toBeNull();
  expect(form.hidden).toBe(true); // closed until asked for

  app.evRenderDetail(detail({ event: { status: 'armed' } }));
  expect(Array.from(byId('evDetail').querySelectorAll('button')).map((b) => b.textContent))
    .not.toContain('Add people');
  expect(byId('evDetail').querySelector('.ev-add')).toBeNull();
});

test('the Add people form stays open across a re-render of the same draft', () => {
  app.evRenderDetail(detail());
  const btn = Array.from(byId('evDetail').querySelectorAll('button'))
    .find((b) => b.textContent === 'Add people') as HTMLButtonElement;
  btn.click();
  expect((byId('evDetail').querySelector('.ev-add') as HTMLElement).hidden).toBe(false);
  const ta = byId('evDetail').querySelector('.ev-add textarea') as HTMLTextAreaElement;
  ta.value = 'https://www.linkedin.com/in/half-pasted';
  ta.dispatchEvent(new Event('input'));

  // Dropping a bucket re-renders the whole detail; the operator's half-pasted list
  // must not vanish into a re-collapsed, emptied form.
  app.evRenderDetail(detail());
  expect((byId('evDetail').querySelector('.ev-add') as HTMLElement).hidden).toBe(false);
  expect((byId('evDetail').querySelector('.ev-add textarea') as HTMLTextAreaElement).value)
    .toBe('https://www.linkedin.com/in/half-pasted');
});

test('a failed or stopped campaign offers Reopen as draft; open and done ones do not', () => {
  const btns = () => Array.from(byId('evDetail').querySelectorAll('button')).map((b) => b.textContent);
  app.evRenderDetail(detail({ event: { status: 'failed', close_reason: 'no Share control' } }));
  expect(btns()).toContain('Reopen as draft');
  app.evRenderDetail(detail({ event: { status: 'stopped' } }));
  expect(btns()).toContain('Reopen as draft');
  app.evRenderDetail(detail());
  expect(btns()).not.toContain('Reopen as draft');
  app.evRenderDetail(detail({ event: { status: 'done' } }));
  expect(btns()).not.toContain('Reopen as draft');
});

test('a bucket can be dropped only while the plan is still a draft', () => {
  app.evRenderDetail(detail());
  expect(byId('evDetail').querySelectorAll('.rung-drop')).toHaveLength(1);

  // Once armed the resume cursor indexes into this list, so editing it would silently
  // re-point the cursor at different work.
  app.evRenderDetail(detail({ event: { status: 'armed' } }));
  expect(byId('evDetail').querySelectorAll('.rung-drop')).toHaveLength(0);
});

test('shows live per-bucket progress while a run is in flight', () => {
  app.evRenderDetail(detail({
    event: { status: 'running' },
    runs: [{
      id: 9, mode: 'live', started_at: '2026-08-03T10:00:00.000Z', ended_at: null,
      invited_count: 0, outcome: null, error: null,
      buckets: [{ bucket_id: 1, rows_loaded: 840, matched: 3, ticked: 0, submitted: 0, outcome: null }],
    }],
  }));
  const host = byId('evDetail');
  expect(host.textContent).toContain('3 of 4 found');
  expect(host.querySelector('.rung.is-live')).not.toBeNull();
  expect(host.querySelector('.rung-fill')).not.toBeNull();
});

test('a finished bucket no longer looks live', () => {
  app.evRenderDetail(detail({
    runs: [{
      id: 9, mode: 'dry', started_at: '2026-08-03T10:00:00.000Z',
      ended_at: '2026-08-03T10:05:00.000Z', invited_count: 0, outcome: 'completed', error: null,
      buckets: [{ bucket_id: 1, rows_loaded: 520, matched: 4, ticked: 4, submitted: 0, outcome: 'early_exit' }],
    }],
  }));
  expect(byId('evDetail').querySelector('.rung.is-live')).toBeNull();
});

test('distinguishes a dry run from a live one in the run log', () => {
  app.evRenderDetail(detail({
    runs: [{
      id: 9, mode: 'dry', started_at: '2026-08-03T10:00:00.000Z',
      ended_at: '2026-08-03T10:05:00.000Z', invited_count: 0, outcome: 'completed',
      error: null, buckets: [],
    }],
  }));
  const mode = byId('evDetail').querySelector('.ev-run-head .mode');
  expect(mode?.textContent).toBe('dry');
  expect(mode?.className).toContain('dry');
});

test('renders an empty plan as a plain statement rather than an empty ladder', () => {
  app.evRenderDetail(detail({ buckets: [], counts: { unreachable: 2 } }));
  expect(byId('evDetail').textContent).toContain('nothing on this list can be reached');
});

test('the settings form exposes the event caps', () => {
  for (const id of ['setEventsPerDay', 'setEventInviteCap', 'setEventBucketCeiling', 'setEventBudget']) {
    expect(byId(id)).not.toBeNull();
  }
});

test('the tab exists and its panel is present', () => {
  const tab = Array.from(document.querySelectorAll('.tab'))
    .find((t) => (t as HTMLElement).dataset.tab === 'events');
  expect(tab).toBeDefined();
  expect(byId('tab-events')).not.toBeNull();
});

test('the closed card tracks the open detail\'s numbers, not the page load', async () => {
  // The detail polls every 4s while a run is live; the card list is only rebuilt on load.
  // Without the sync, the card said "0 invited" while the numbers underneath it climbed.
  const list = [
    { id: 1, title: 'NYC Forum', event_url: 'https://www.linkedin.com/events/1/', status: 'armed', counts: { invited: 0, pending: 40 }, starts_at: null },
  ];
  stubFetchRoutes({ '/api/events': { body: list } });
  await app.evLoadList();
  const card = byId('evList').querySelector('.ev-card') as HTMLElement;
  expect(card.textContent).toContain('0 invited · 40 to go');

  // A poll re-renders the detail with fresher numbers and a new status — the card follows,
  // with no evLoadList in between.
  app.evRenderDetail(detail({
    // id spelled out: the helper's trailing `...o` replaces the whole merged event object.
    event: { id: 1, status: 'running', starts_at: null },
    counts: { invited: 15, pending: 25 },
  }));
  expect(card.textContent).toContain('15 invited · 25 to go');
  expect(card.querySelector('.ev-card-right')?.textContent?.toLowerCase()).toContain('running');
});

test('opening a campaign marks its card, and does not report a failure that did not happen', async () => {
  // `$('.ev-card').forEach` — querySelector, not querySelectorAll — threw a TypeError on
  // every open. The catch turned it into "Could not load the campaign: …" over a campaign
  // that had just rendered fine.
  const list = [
    { id: 1, title: 'NYC Forum', event_url: 'https://www.linkedin.com/events/1/', status: 'draft', counts: {} },
    { id: 2, title: 'AppSec', event_url: 'https://www.linkedin.com/events/2/', status: 'draft', counts: {} },
  ];
  stubFetchRoutes({ '/api/events/1': { body: detail() }, '/api/events': { body: list } });
  await app.evLoadList();
  await app.evOpen(1);

  const cards = Array.from(byId('evList').querySelectorAll('.ev-card'));
  expect(cards.map((c) => c.classList.contains('is-open'))).toEqual([true, false]);
  expect(byId('evDetail').hidden).toBe(false);
});
