// @vitest-environment jsdom
/// <reference lib="dom" />
/**
 * Deep links (LINKS.md): `/add?p=…` and `/add-event?event=…`, which the server redirects to
 * `/?link=add&…` / `/?link=event&…`. A link only FILLS a screen — the tests pin that nothing
 * is posted on open, that the add form lands on the agreed defaults, and that the event modal
 * aims at the linked event rather than whichever draft happens to be first.
 */
import { test, expect, beforeEach, afterEach } from 'vitest';
import { loadApp, byId, stubFetchRoutes, type AppInternals } from './helpers/load-app.js';

let app: AppInternals;
const realFetch = globalThis.fetch;
const flush = () => new Promise((r) => setTimeout(r, 0));

const EVENT_ID = '7486088214579982336';
const OTHER_ID = '7493353085235343360';

beforeEach(() => {
  app = loadApp();
  app.initTabs();
  app.initAddList();
  app.initSearch();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  history.replaceState(null, '', '/');
});

function openLink(path: string) {
  history.replaceState(null, '', path);
  app.applyDeepLink();
}

/* ---------- pure parsing ---------- */

test('slugs, in/ prefixes and whole URLs all become profile URLs', () => {
  const { urls, invalid } = app.profileUrlsFromLink([
    'jane-doe,in/john-smith/,/in/ana-lee', 'https://www.linkedin.com/in/bo-k/?utm=x', 'linkedin.com/in/raw',
  ]);
  expect(urls).toEqual([
    'https://www.linkedin.com/in/jane-doe/',
    'https://www.linkedin.com/in/john-smith/',
    'https://www.linkedin.com/in/ana-lee/',
    'https://www.linkedin.com/in/bo-k/?utm=x',
    'https://linkedin.com/in/raw',
  ]);
  expect(invalid).toEqual([]);
});

test('a non-Latin slug arrives decoded and is re-encoded into the server charset', () => {
  const { urls } = app.profileUrlsFromLink(['דנה-כהן-12']);
  expect(urls[0]).toMatch(/^https:\/\/www\.linkedin\.com\/in\/[A-Za-z0-9\-_%]+\/$/);
});

test('entries that cannot be a profile are returned, not dropped silently', () => {
  const { urls, invalid } = app.profileUrlsFromLink(['ok-one,,bad.slug!, ']);
  expect(urls).toEqual(['https://www.linkedin.com/in/ok-one/']);
  expect(invalid).toEqual(['bad.slug!']);
});

test('event ids: bare digits, canonical URLs and share-button fused slugs', () => {
  expect(app.eventIdOf(EVENT_ID)).toBe(EVENT_ID);
  expect(app.eventIdOf(`https://www.linkedin.com/events/${EVENT_ID}/`)).toBe(EVENT_ID);
  expect(app.eventIdOf(`https://www.linkedin.com/events/aisoclivewheredoesint${EVENT_ID}/?x=1`)).toBe(EVENT_ID);
  expect(app.eventIdOf('https://example.com/events/123')).toBeNull();
});

/* ---------- add link ---------- */

test('an add link fills Add to Queue with the agreed defaults and posts nothing', async () => {
  const calls = stubFetchRoutes({ '/api/cohorts': { body: [{ name: 'Security VPs', kind: 'invite', message_template: 'Hi' }] } });
  // Dirty the form first: the link must override all of it, not inherit it.
  byId<HTMLInputElement>('listPrioritize').checked = true;
  byId<HTMLTextAreaElement>('listTemplate').value = 'leftover note';
  const msg = document.querySelector<HTMLInputElement>('input[name="listKind"][value="message"]')!;
  msg.checked = true;
  msg.dispatchEvent(new Event('change', { bubbles: true }));

  openLink('/?link=add&p=jane-doe,john-smith&p=ana-lee');
  await flush();

  expect(byId('tab-add').hidden).toBe(false);
  expect(byId<HTMLTextAreaElement>('listText').value.split('\n')).toEqual([
    'https://www.linkedin.com/in/jane-doe/',
    'https://www.linkedin.com/in/john-smith/',
    'https://www.linkedin.com/in/ana-lee/',
  ]);
  expect(byId('listCount').textContent).toBe('3 profiles detected');
  expect(document.querySelector<HTMLInputElement>('input[name="listKind"]:checked')!.value).toBe('invite');
  expect(byId<HTMLSelectElement>('listCohortSelect').value).toBe('');
  expect(byId<HTMLTextAreaElement>('listTemplate').value).toBe('');
  expect(byId<HTMLInputElement>('listPrioritize').checked).toBe(false);
  expect(byId('listResult').textContent).toContain('3 people');
  expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  // The link is consumed: a reload must not refill a form the operator has since edited.
  expect(location.search).toBe('');
});

test('an add link names the entries it left out', async () => {
  stubFetchRoutes({ '/api/cohorts': { body: [] } });
  openLink('/?link=add&p=jane-doe,not%20a%20slug!');
  await flush();
  expect(byId('listCount').textContent).toBe('1 profile detected');
  expect(byId('listResult').className).toContain('error');
  expect(byId('listResult').textContent).toContain('not a LinkedIn profile');
});

/* ---------- event link ---------- */

const EVENTS = [
  { id: 6, title: 'Some Other Event', event_url: `https://www.linkedin.com/events/${OTHER_ID}/`, status: 'draft', counts: {} },
  { id: 7, title: 'AI SOC Live', event_url: `https://www.linkedin.com/events/${EVENT_ID}/`, status: 'draft', counts: {} },
];

async function selectOne() {
  stubFetchRoutes({
    '/api/connections/search': { body: {
      total: 1, limit: 25, offset: 0, coverage: { total: 1, enriched: 1, pending: 0, unresolvable: 0 },
      results: [{ profile_url: 'https://www.linkedin.com/in/keren', full_name: 'Keren', matched: {} }],
    } },
    '/api/events': { body: EVENTS },
  });
  byId('searchForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await flush();
  const box = byId('searchResults').querySelector<HTMLInputElement>('input.row-select')!;
  box.checked = true;
  box.dispatchEvent(new Event('change', { bubbles: true }));
}

test('an event link opens Connections with a banner naming the event', async () => {
  const calls = stubFetchRoutes({ '/api/events': { body: EVENTS } });
  openLink(`/?link=event&event=${encodeURIComponent(`https://www.linkedin.com/events/${EVENT_ID}/`)}`);
  await flush();
  expect(byId('tab-connections').hidden).toBe(false);
  expect(byId('eventLinkBanner').hidden).toBe(false);
  expect(byId('eventLinkTitle').textContent).toBe('Inviting to AI SOC Live');
  expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
});

test('Invite to event then targets the linked event\'s draft, not the first draft', async () => {
  stubFetchRoutes({ '/api/events': { body: EVENTS } });
  openLink(`/?link=event&event=${EVENT_ID}`);
  await flush();
  await selectOne();
  byId('selectionEvent').dispatchEvent(new Event('click', { bubbles: true }));
  await flush();
  expect(byId<HTMLSelectElement>('evtCampaign').value).toBe('7');
});

test('with no campaign yet, the modal starts a new one with the event URL filled in', async () => {
  stubFetchRoutes({ '/api/events': { body: [EVENTS[0]] } });
  openLink(`/?link=event&event=${EVENT_ID}`);
  await flush();
  expect(byId('eventLinkSub').textContent).toContain('builds a draft');
  await selectOne();
  stubFetchRoutes({ '/api/events': { body: [EVENTS[0]] } });
  byId('selectionEvent').dispatchEvent(new Event('click', { bubbles: true }));
  await flush();
  expect(byId<HTMLSelectElement>('evtCampaign').value).toBe('__new__');
  expect(byId<HTMLInputElement>('evtUrl').value).toBe(`https://www.linkedin.com/events/${EVENT_ID}/`);
});

test('an event whose campaign is already armed says so up front', async () => {
  stubFetchRoutes({ '/api/events': { body: [{ ...EVENTS[1], status: 'armed' }] } });
  openLink(`/?link=event&event=${EVENT_ID}`);
  await flush();
  expect(byId('eventLinkBanner').className).toContain('is-blocked');
  expect(byId('eventLinkSub').textContent).toContain('already armed');
});

test('a link that is not an event says so, and Done clears the banner', async () => {
  stubFetchRoutes({ '/api/events': { body: [] } });
  openLink('/?link=event&event=https://example.com/nope');
  await flush();
  expect(byId('eventLinkTitle').textContent).toContain("doesn't point at a LinkedIn event");
  byId('eventLinkDismiss').dispatchEvent(new Event('click', { bubbles: true }));
  expect(byId('eventLinkBanner').hidden).toBe(true);
});
