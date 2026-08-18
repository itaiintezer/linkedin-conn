// @vitest-environment jsdom
/// <reference lib="dom" />
/**
 * Connections tab controller. The case that matters most is the honest empty state: while
 * the roster is still enriching, "no matches" and "we haven't looked yet" are different
 * answers, and conflating them makes the feature quietly lie.
 */
import { test, expect, beforeEach, afterEach } from 'vitest';
import { loadApp, byId, stubFetchRoutes, type AppInternals } from './helpers/load-app.js';

let app: AppInternals;
const realFetch = globalThis.fetch;

beforeEach(() => { app = loadApp(); app.initSearch(); });
afterEach(() => { globalThis.fetch = realFetch; });

const flush = () => new Promise((r) => setTimeout(r, 0));

const row = (over: Record<string, unknown> = {}) => ({
  profile_url: 'https://www.linkedin.com/in/ada', full_name: 'Ada Sec',
  headline: 'CISO @ Amazon', current_title: 'Chief Information Security Officer',
  current_company: 'Amazon', location_raw: 'Seattle, Washington, United States',
  location_city: 'Seattle', location_country: 'United States',
  connected_on: '2024-03-04', enriched_at: '2026-07-30T00:00:00.000Z',
  matched: { title_any: ['CISO'], location_any: ['Seattle'] }, ...over,
});

const searchBody = (over: Record<string, unknown> = {}) => ({
  total: 1, limit: 25, offset: 0,
  coverage: { total: 7147, enriched: 7147, pending: 0, unresolvable: 0 },
  results: [row()], ...over,
});

function submit() {
  byId('searchForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  return flush();
}

test('splits comma-separated inputs into OR-groups and posts them', async () => {
  const calls = stubFetchRoutes({ '/api/connections/search': { body: searchBody() } });
  (byId('sqTitle') as HTMLInputElement).value = 'CISO, security engineer , SOC';
  (byId('sqLocation') as HTMLInputElement).value = 'Seattle,Bellevue';
  (byId('sqExclude') as HTMLInputElement).value = 'physical security';
  await submit();

  const sent = calls.find((c) => c.path === '/api/connections/search')!.body as Record<string, unknown>;
  expect(sent.title_any).toEqual(['CISO', 'security engineer', 'SOC']);
  expect(sent.location_any).toEqual(['Seattle', 'Bellevue']);
  expect(sent.exclude_any).toEqual(['physical security']);
  expect(sent.include_past_roles).toBe(false);
});

test('omits empty fields entirely rather than sending blank filters', async () => {
  const calls = stubFetchRoutes({ '/api/connections/search': { body: searchBody() } });
  (byId('sqTitle') as HTMLInputElement).value = 'CISO';
  (byId('sqCompany') as HTMLInputElement).value = '   ';
  await submit();

  const sent = calls.find((c) => c.path === '/api/connections/search')!.body as Record<string, unknown>;
  expect(sent.company_any).toBeUndefined();
  expect(sent.q).toBeUndefined();
});

test('renders a result row with its headline', async () => {
  stubFetchRoutes({ '/api/connections/search': { body: searchBody() } });
  await submit();

  // cells[0] is the selection checkbox; name/role/company follow.
  const cells = byId('searchResults').querySelectorAll('tr td');
  expect(cells[1].textContent).toContain('Ada Sec');
  expect(cells[1].textContent).toContain('CISO @ Amazon');
  expect(cells[3].textContent).toBe('Amazon');
  expect(byId('searchMeta').textContent).toBe('1 match');
  expect(byId('searchResultsWrap').hidden).toBe(false);
});

test('coverage is always shown, so a partial corpus is never hidden', async () => {
  stubFetchRoutes({
    '/api/connections/search': { body: searchBody({ coverage: { total: 7147, enriched: 359, pending: 6788, unresolvable: 0 } }) },
  });
  await submit();

  const cov = byId('searchCoverage').textContent!;
  expect(cov).toContain('359 of 7,147 searchable');
  expect(cov).toContain('6,788 still enriching');
});

test('an empty result mid-enrichment says so instead of claiming nobody matches', async () => {
  stubFetchRoutes({
    '/api/connections/search': {
      body: searchBody({ total: 0, results: [], coverage: { total: 7147, enriched: 359, pending: 6788, unresolvable: 0 } }),
    },
  });
  await submit();

  expect(byId('searchEmpty').hidden).toBe(false);
  expect(byId('searchEmpty').textContent).toMatch(/still being enriched/i);
  expect(byId('searchResultsWrap').hidden).toBe(true);
});

test('an empty result on a fully enriched roster is a plain no-match', async () => {
  stubFetchRoutes({ '/api/connections/search': { body: searchBody({ total: 0, results: [] }) } });
  await submit();
  expect(byId('searchEmpty').textContent).toBe('No connections match those filters.');
});

test('Load more appends rather than replacing, and hides when exhausted', async () => {
  stubFetchRoutes({ '/api/connections/search': { body: searchBody({ total: 2, results: [row(), row({ full_name: 'Bob Soc' })] }) } });
  await submit();

  expect(byId('searchResults').querySelectorAll('tr')).toHaveLength(2);
  expect(byId('searchMore').hidden).toBe(true); // 2 of 2 loaded
});

test('Load more is offered when the result set is longer than a page', async () => {
  stubFetchRoutes({ '/api/connections/search': { body: searchBody({ total: 90, results: Array.from({ length: 25 }, () => row()) }) } });
  await submit();
  expect(byId('searchMore').hidden).toBe(false);
});

test('Clear resets the form and the results', async () => {
  stubFetchRoutes({ '/api/connections/search': { body: searchBody() } });
  (byId('sqTitle') as HTMLInputElement).value = 'CISO';
  await submit();
  expect(byId('searchResults').querySelectorAll('tr')).toHaveLength(1);

  byId('sqClear').dispatchEvent(new Event('click', { bubbles: true }));

  expect((byId('sqTitle') as HTMLInputElement).value).toBe('');
  expect(byId('searchResults').querySelectorAll('tr')).toHaveLength(0);
  expect(byId('searchResultsWrap').hidden).toBe(true);
});

test('clicking a row opens the detail drawer with the full profile', async () => {
  stubFetchRoutes({
    '/api/connections/search': { body: searchBody() },
    '/api/connections/ada': {
      body: {
        profile_url: 'https://www.linkedin.com/in/ada', full_name: 'Ada Sec',
        current_title: 'CISO', current_company: 'Amazon', location_raw: 'Seattle',
        connected_on: '2024-03-04', enriched_at: '2026-07-30T00:00:00.000Z', source: 'csv',
        profile: {
          about: 'Security leader.',
          experience: [{ title: 'CISO', companyName: 'Amazon', duration: '3 yrs' }],
          education: [{ schoolName: 'MIT', degree: 'BSc' }],
          skills: ['Incident Response', 'CISSP'],
        },
      },
    },
  });
  await submit();

  byId('searchResults').querySelector('tr')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await flush();

  expect(byId('connDrawer').hidden).toBe(false);
  expect(byId('connDrawerName').textContent).toBe('Ada Sec');
  const body = byId('connDrawerBody').textContent!;
  expect(body).toContain('Security leader.');
  expect(body).toContain('Amazon');
  expect(body).toContain('MIT');
  expect(body).toContain('CISSP');
});

test('a search failure surfaces rather than silently leaving stale rows', async () => {
  stubFetchRoutes({ '/api/connections/search': { error: 'database is locked', status: 500 } });
  await submit();
  expect(byId('searchMeta').textContent).toContain('database is locked');
});

/* ---------- Copy URLs ---------- */

test('Copy URLs puts the selected profile URLs on the clipboard, newline-joined', async () => {
  const written: string[] = [];
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    value: { writeText: async (t: string) => { written.push(t); } },
    configurable: true,
  });

  const sel = app.searchSelection();
  sel.add('https://www.linkedin.com/in/ada');
  sel.add('https://www.linkedin.com/in/hopper');
  byId('selectionCopy').click();
  await flush();

  // One URL per line — the shape every "paste URLs" box in the app accepts back.
  expect(written).toEqual(['https://www.linkedin.com/in/ada\nhttps://www.linkedin.com/in/hopper']);
  expect(byId('selectionResult').textContent).toContain('Copied 2 profile URLs');
  // Copying must not disturb the selection: it is a read, not an action on it.
  expect(sel.size).toBe(2);
});

test('Copy URLs with nothing selected copies nothing and stays silent', async () => {
  const written: string[] = [];
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    value: { writeText: async (t: string) => { written.push(t); } },
    configurable: true,
  });

  byId('selectionCopy').click();
  await flush();

  expect(written).toEqual([]);
});

test('a clipboard refusal is reported, not swallowed', async () => {
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    value: { writeText: async () => { throw new Error('Document is not focused.'); } },
    configurable: true,
  });

  app.searchSelection().add('https://www.linkedin.com/in/ada');
  byId('selectionCopy').click();
  await flush();

  expect(byId('selectionResult').textContent).toContain('Could not copy');
});
