// @vitest-environment jsdom
/// <reference lib="dom" />
/**
 * Search -> select -> event campaign.
 *
 * The second destination a search result can have, and the riskier of the two: an event
 * invitation cannot be recalled. So the tests here are about the guardrails rather than
 * the happy path — that this route only ever builds a DRAFT, that it can only extend a
 * campaign whose location plan is still editable, and that the people it could not use
 * are named while the selection that produced them is still on screen.
 */
import { test, expect, beforeEach, afterEach } from 'vitest';
import { loadApp, byId, stubFetchRoutes, type AppInternals } from './helpers/load-app.js';

let app: AppInternals;
const realFetch = globalThis.fetch;

beforeEach(() => { app = loadApp(); app.initSearch(); });
afterEach(() => { globalThis.fetch = realFetch; });

const flush = () => new Promise((r) => setTimeout(r, 0));

const row = (slug: string) => ({
  profile_url: `https://www.linkedin.com/in/${slug}`, full_name: slug,
  headline: 'Security person', current_title: 'CISO', current_company: 'Acme',
  location_raw: 'Tel Aviv, Israel', location_country: 'Israel',
  connected_on: '2024-03-04', enriched_at: '2026-07-30T00:00:00.000Z', matched: {},
});

const RESULTS = {
  total: 2, limit: 25, offset: 0,
  coverage: { total: 100, enriched: 100, pending: 0, unresolvable: 0 },
  results: [row('keren'), row('or')],
};

const EVENTS = [
  { id: 5, title: 'Cloud Security Forum', event_url: 'https://www.linkedin.com/events/111/', status: 'armed', counts: {} },
  { id: 6, title: 'AppSec Tel Aviv', event_url: 'https://www.linkedin.com/events/222/', status: 'draft', counts: {} },
];

const CREATED = {
  event: { id: 9, status: 'draft' }, added: 2, rejected: [], unreachable: [], bucketCount: 1,
};

async function selectTwo(routes: Record<string, { body?: unknown; error?: string; status?: number }> = {}) {
  const calls = stubFetchRoutes({
    '/api/connections/search': { body: RESULTS },
    '/api/events': { body: EVENTS },
    ...routes,
  });
  byId('searchForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await flush();
  for (const box of byId('searchResults').querySelectorAll<HTMLInputElement>('input.row-select')) {
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return calls;
}

const openDialog = async () => {
  byId('selectionEvent').dispatchEvent(new Event('click', { bubbles: true }));
  await flush();
};

test('the selection bar offers the event route beside the message one', async () => {
  await selectTwo();
  expect(byId('selectionBar').hidden).toBe(false);
  expect(byId('selectionEvent').textContent).toBe('Invite to event');
});

test('only DRAFT campaigns are offered — an armed plan is frozen', async () => {
  await selectTwo();
  await openDialog();

  const opts = Array.from(byId<HTMLSelectElement>('evtCampaign').options).map((o) => o.textContent);
  // Adding to an armed campaign would re-rank a bucket list the run's cursor indexes into.
  expect(opts).not.toContain('Cloud Security Forum');
  expect(opts).toContain('AppSec Tel Aviv');
  expect(opts).toContain('+ New event campaign…');
});

test('with no drafts at all it falls through to a new campaign', async () => {
  await selectTwo({ '/api/events': { body: [EVENTS[0]] } });
  await openDialog();
  expect(byId<HTMLSelectElement>('evtCampaign').value).toBe('__new__');
  expect(byId('evtUrlField').hidden).toBe(false);
});

test('the event URL is asked for only when there is no campaign to add to', async () => {
  await selectTwo();
  await openDialog();
  expect(byId('evtUrlField').hidden).toBe(true);          // a draft is preselected
  expect(byId('evtConfirm').textContent).toBe('Add to campaign');

  const sel = byId<HTMLSelectElement>('evtCampaign');
  sel.value = '__new__';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  expect(byId('evtUrlField').hidden).toBe(false);
  expect(byId('evtConfirm').textContent).toBe('Build the plan');
});

test('a new campaign posts the selection together with the event URL', async () => {
  await selectTwo();
  await openDialog();
  const sel = byId<HTMLSelectElement>('evtCampaign');
  sel.value = '__new__';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  (byId('evtUrl') as HTMLInputElement).value = 'https://www.linkedin.com/events/333/';

  // Re-route so the POST resolves with a creation payload rather than the campaign list.
  const calls = stubFetchRoutes({ '/api/events': { body: CREATED } });
  byId('evtConfirm').dispatchEvent(new Event('click', { bubbles: true }));
  await flush();

  const post = calls.find((c) => c.method === 'POST')!;
  expect(post.path).toBe('/api/events');
  const body = post.body as { event_url: string; profile_urls: string[] };
  expect(body.event_url).toBe('https://www.linkedin.com/events/333/');
  expect(body.profile_urls).toHaveLength(2);
});

test('adding to a draft posts to that campaign, not to a new one', async () => {
  await selectTwo();
  await openDialog();

  const calls = stubFetchRoutes({ '/api/events/6/invitees': { body: CREATED } });
  byId('evtConfirm').dispatchEvent(new Event('click', { bubbles: true }));
  await flush();

  const post = calls.find((c) => c.method === 'POST')!;
  expect(post.path).toBe('/api/events/6/invitees');
  expect((post.body as { profile_urls: string[] }).profile_urls).toEqual([
    'https://www.linkedin.com/in/keren', 'https://www.linkedin.com/in/or',
  ]);
  // No event_url: the campaign already has one, and re-sending it could point elsewhere.
  expect((post.body as Record<string, unknown>).event_url).toBeUndefined();
});

test('a new campaign refuses to submit without an event URL', async () => {
  await selectTwo();
  await openDialog();
  const sel = byId<HTMLSelectElement>('evtCampaign');
  sel.value = '__new__';
  sel.dispatchEvent(new Event('change', { bubbles: true }));

  const calls = stubFetchRoutes({ '/api/events': { body: CREATED } });
  byId('evtConfirm').dispatchEvent(new Event('click', { bubbles: true }));
  await flush();

  expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  expect(byId('evtResult').textContent).toMatch(/event URL/i);
});

test('who could NOT be used is reported, not swallowed', async () => {
  await selectTwo();
  await openDialog();
  stubFetchRoutes({
    '/api/events/6/invitees': {
      body: {
        ...CREATED, added: 1,
        rejected: [{ url: 'https://www.linkedin.com/in/or', reason: 'not_a_connection' }],
        unreachable: [{ url: 'https://www.linkedin.com/in/x', reason: 'no_country' }],
      },
    },
  });
  byId('evtConfirm').dispatchEvent(new Event('click', { bubbles: true }));
  await flush();

  const msg = byId('evtResult').textContent ?? '';
  expect(msg).toContain('1 on the list');
  expect(msg).toContain('1 not in your roster');
  expect(msg).toContain('1 with no location we can filter on');
});

test('success clears the selection and offers the plan rather than jumping to it', async () => {
  await selectTwo();
  await openDialog();
  stubFetchRoutes({ '/api/events/6/invitees': { body: CREATED } });
  byId('evtConfirm').dispatchEvent(new Event('click', { bubbles: true }));
  await flush();

  expect(byId('selectionBar').hidden).toBe(true);          // selection consumed
  expect(byId('evtModal').hidden).toBe(false);             // counts still readable
  expect(byId('evtConfirm').hidden).toBe(true);
  expect(byId('evtOpen').hidden).toBe(false);
});

test('a server error leaves the selection intact so it can be retried', async () => {
  await selectTwo();
  await openDialog();
  stubFetchRoutes({ '/api/events/6/invitees': { error: 'campaign is armed', status: 409 } });
  byId('evtConfirm').dispatchEvent(new Event('click', { bubbles: true }));
  await flush();

  expect(byId('evtResult').textContent).toContain('campaign is armed');
  expect(byId('selectionBar').hidden).toBe(false);
  expect(byId('evtConfirm').hidden).toBe(false);
  expect(byId<HTMLButtonElement>('evtConfirm').disabled).toBe(false);
});
