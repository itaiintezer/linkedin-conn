// @vitest-environment jsdom
/// <reference lib="dom" />
/**
 * Search -> select -> message campaign.
 *
 * This is the only place in the app where a search box can turn into outbound sends, so the
 * tests that matter are the ones about not sending to the wrong people: what "select all"
 * actually selects, whether a stale selection can survive a changed query, and whether the
 * operator is shown the real count before committing.
 */
import { test, expect, beforeEach, afterEach } from 'vitest';
import { loadApp, byId, stubFetchRoutes, type AppInternals } from './helpers/load-app.js';

let app: AppInternals;
const realFetch = globalThis.fetch;

beforeEach(() => { app = loadApp(); app.initSearch(); });
afterEach(() => { globalThis.fetch = realFetch; });

const flush = () => new Promise((r) => setTimeout(r, 0));

const row = (slug: string, name: string) => ({
  profile_url: `https://www.linkedin.com/in/${slug}`, full_name: name,
  headline: 'Security person', current_title: 'CISO', current_company: 'Acme',
  location_raw: 'Seattle, Washington, United States', location_city: 'Seattle',
  location_country: 'United States', connected_on: '2024-03-04',
  enriched_at: '2026-07-30T00:00:00.000Z', matched: {},
});

const results = (n: number, total = n) => ({
  total, limit: 25, offset: 0,
  coverage: { total: 7153, enriched: 7151, pending: 0, unresolvable: 2 },
  results: Array.from({ length: n }, (_, i) => row(`p${i}`, `Person ${i}`)),
});

const COHORTS = [
  { id: 1, name: 'Invite folks', kind: 'invite', message_template: 'Hi', allow_no_note: 0 },
  { id: 2, name: 'Q3 outreach', kind: 'message', message_template: 'Hey {firstName}, …', allow_no_note: 0 },
];

async function search(body: unknown = results(3)) {
  stubFetchRoutes({
    '/api/connections/search': { body },
    '/api/cohorts': { body: COHORTS },
    '/api/settings': { body: { msg_weekly_cap: 250, apify_key_set: true } },
    '/api/lists': { body: { added: 3, found: 3 } },
  });
  byId('searchForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await flush();
}

const check = (i: number) => {
  const boxes = byId('searchResults').querySelectorAll<HTMLInputElement>('input.row-select');
  boxes[i].checked = true;
  boxes[i].dispatchEvent(new Event('change', { bubbles: true }));
};

test('the selection bar stays hidden until something is selected', async () => {
  await search();
  expect(byId('selectionBar').hidden).toBe(true);

  check(0);
  expect(byId('selectionBar').hidden).toBe(false);
  expect(byId('selectionCount').textContent).toContain('1');
});

test('the header checkbox selects the loaded page only', async () => {
  await search(results(3, 312));   // 3 loaded, 312 matching
  const all = byId<HTMLInputElement>('selectAllPage');
  all.checked = true;
  all.dispatchEvent(new Event('change', { bubbles: true }));

  expect(byId('selectionCount').textContent).toContain('3');
  // The escape hatch appears, stating the real total — but selects nothing on its own.
  expect(byId('selectAllMatching').hidden).toBe(false);
  expect(byId('selectAllMatching').textContent).toContain('312');
});

test('no escape hatch when the page already IS every match', async () => {
  await search(results(3, 3));
  const all = byId<HTMLInputElement>('selectAllPage');
  all.checked = true;
  all.dispatchEvent(new Event('change', { bubbles: true }));
  expect(byId('selectAllMatching').hidden).toBe(true);
});

test('a new search clears the selection, so a stale filter cannot be queued', async () => {
  await search();
  check(0);
  expect(byId('selectionBar').hidden).toBe(false);

  await search(results(2));   // different query, fresh results

  expect(byId('selectionBar').hidden).toBe(true);
  expect(byId('searchResults').querySelectorAll<HTMLInputElement>('input.row-select:checked')).toHaveLength(0);
});

test('Clear drops the selection without touching the results', async () => {
  await search();
  check(0); check(1);
  byId('selectionClear').dispatchEvent(new Event('click', { bubbles: true }));

  expect(byId('selectionBar').hidden).toBe(true);
  expect(byId('searchResults').querySelectorAll('tr')).toHaveLength(3);
});

test('the campaign dialog offers only message cohorts', async () => {
  await search();
  check(0);
  byId('selectionAdd').dispatchEvent(new Event('click', { bubbles: true }));
  await flush();

  const opts = Array.from(byId<HTMLSelectElement>('campCohort').options).map((o) => o.textContent);
  // An invite cohort would earn a 409 from /api/lists; never offer it.
  expect(opts).not.toContain('Invite folks');
  expect(opts).toContain('Q3 outreach');
});

test('an existing cohort shows its template read-only', async () => {
  await search();
  check(0);
  byId('selectionAdd').dispatchEvent(new Event('click', { bubbles: true }));
  await flush();

  const ta = byId<HTMLTextAreaElement>('campTemplate');
  expect(ta.value).toBe('Hey {firstName}, …');
  // Read-only on purpose: /api/lists overwrites the cohort template, which would rewrite
  // the message for everyone already queued-but-unsent in that cohort.
  expect(ta.readOnly).toBe(true);
});

test('choosing New cohort makes the template editable and required', async () => {
  await search();
  check(0);
  byId('selectionAdd').dispatchEvent(new Event('click', { bubbles: true }));
  await flush();

  const sel = byId<HTMLSelectElement>('campCohort');
  sel.value = '__new__';
  sel.dispatchEvent(new Event('change', { bubbles: true }));

  expect(byId<HTMLTextAreaElement>('campTemplate').readOnly).toBe(false);
  expect(byId('campNameField').hidden).toBe(false);
});

test('an existing cohort is sent WITHOUT a template, so the cohort is not rewritten', async () => {
  const calls = stubFetchRoutes({
    '/api/connections/search': { body: results(3) },
    '/api/cohorts': { body: COHORTS },
    '/api/settings': { body: { msg_weekly_cap: 250 } },
    '/api/lists': { body: { added: 2, found: 2 } },
  });
  byId('searchForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await flush();
  check(0); check(1);
  byId('selectionAdd').dispatchEvent(new Event('click', { bubbles: true }));
  await flush();
  byId('campConfirm').dispatchEvent(new Event('click', { bubbles: true }));
  await flush();

  const post = calls.find((c) => c.path === '/api/lists')!;
  const b = post.body as Record<string, unknown>;
  expect(b.kind).toBe('message');
  expect(b.cohort).toBe('Q3 outreach');
  expect(b.message_template).toBeUndefined();
  expect((b.text as string).split('\n')).toHaveLength(2);
});

test('a new cohort sends its template', async () => {
  const calls = stubFetchRoutes({
    '/api/connections/search': { body: results(3) },
    '/api/cohorts': { body: COHORTS },
    '/api/settings': { body: { msg_weekly_cap: 250 } },
    '/api/lists': { body: { added: 1, found: 1 } },
  });
  byId('searchForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await flush();
  check(0);
  byId('selectionAdd').dispatchEvent(new Event('click', { bubbles: true }));
  await flush();

  const sel = byId<HTMLSelectElement>('campCohort');
  sel.value = '__new__';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  (byId('campName') as HTMLInputElement).value = 'Seattle CISOs';
  (byId('campTemplate') as HTMLTextAreaElement).value = 'Hi {firstName}, quick question';
  byId('campConfirm').dispatchEvent(new Event('click', { bubbles: true }));
  await flush();

  const b = calls.find((c) => c.path === '/api/lists')!.body as Record<string, unknown>;
  expect(b.cohort).toBe('Seattle CISOs');
  expect(b.message_template).toBe('Hi {firstName}, quick question');
});

test('a new cohort with a blank template is refused client-side', async () => {
  const calls = stubFetchRoutes({
    '/api/connections/search': { body: results(3) },
    '/api/cohorts': { body: COHORTS },
    '/api/settings': { body: { msg_weekly_cap: 250 } },
    '/api/lists': { body: { added: 1, found: 1 } },
  });
  byId('searchForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await flush();
  check(0);
  byId('selectionAdd').dispatchEvent(new Event('click', { bubbles: true }));
  await flush();

  const sel = byId<HTMLSelectElement>('campCohort');
  sel.value = '__new__';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  (byId('campName') as HTMLInputElement).value = 'Nameless';
  (byId('campTemplate') as HTMLTextAreaElement).value = '   ';
  byId('campConfirm').dispatchEvent(new Event('click', { bubbles: true }));
  await flush();

  expect(calls.some((c) => c.path === '/api/lists')).toBe(false);
  expect(byId('campResult').textContent).toMatch(/message/i);
});

test('the dialog states how long the queue will take to drain', async () => {
  await search(results(3));
  check(0); check(1); check(2);
  byId('selectionAdd').dispatchEvent(new Event('click', { bubbles: true }));
  await flush();
  // 3 people against a 250/week cap is well under a week; the point is that a number is
  // shown at all, before the operator commits.
  expect(byId('campImpact').textContent).toMatch(/3 people/i);
});

test('the outcome reports how many were already in a campaign', async () => {
  const body = results(3);
  stubFetchRoutes({
    '/api/connections/search': { body },
    '/api/cohorts': { body: COHORTS },
    '/api/settings': { body: { msg_weekly_cap: 250 } },
    '/api/lists': { body: { added: 1, found: 3 } },   // 2 already queued elsewhere
  });
  byId('searchForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await flush();
  check(0); check(1); check(2);
  byId('selectionAdd').dispatchEvent(new Event('click', { bubbles: true }));
  await flush();
  byId('campConfirm').dispatchEvent(new Event('click', { bubbles: true }));
  await flush();

  const txt = byId('campResult').textContent!;
  expect(txt).toContain('1');
  expect(txt).toMatch(/2 (were )?already/i);
});
