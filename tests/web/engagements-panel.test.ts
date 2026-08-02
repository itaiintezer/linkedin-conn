// @vitest-environment jsdom
/// <reference lib="dom" />
/**
 * The engagements card, and the Attention modal's two-shape row rendering.
 *
 * The first block here is not a cosmetic test. /api/attention returns profile rows AND
 * engagement rows in one list, and the two tables have INDEPENDENT id sequences. The client
 * used to render every row as a profile, so an engagement's Retry button POSTed its id to
 * /api/profiles/:id/retry — re-queueing whichever PERSON happened to share that number, who
 * would then be contacted a second time. The mapping is a pure function precisely so it can
 * be pinned here rather than inferred from a DOM click.
 *
 * The rest guards two honesty rules the card exists to keep: `counts` omits zero-row
 * statuses (so a missing key must read as 0, not as blank or NaN), and a null
 * `next_scheduled` must say "Not scheduled" rather than invent a time — the defect the
 * invite-side next-batch pill still has.
 */
import { test, expect, beforeEach, afterEach } from 'vitest';
import { loadApp, text, byId, stubFetchRoutes, type AppInternals } from './helpers/load-app.js';

let app: AppInternals;
const realFetch = globalThis.fetch;

beforeEach(() => { app = loadApp(); });
afterEach(() => { globalThis.fetch = realFetch; });

/* ---------- the destructive mis-target ---------- */

test('an engagement row retries against the engagements table, never profiles', () => {
  const row = { source: 'engagement', id: 7, post_url: 'https://www.linkedin.com/feed/update/urn:li:activity:7/' };
  expect(app.attentionActionPath(row, 'retry')).toBe('/api/engagements/7/retry');
  expect(app.attentionActionPath(row, 'dismiss')).toBe('/api/engagements/7/dismiss');
  // The specific write that used to hit an unrelated person.
  expect(app.attentionActionPath(row, 'retry')).not.toContain('/api/profiles/');
});

test('a profile row keeps exactly its old endpoints', () => {
  const row = { source: 'profile', id: 7, profile_url: 'https://www.linkedin.com/in/jane-doe/' };
  expect(app.attentionActionPath(row, 'retry')).toBe('/api/profiles/7/retry');
  expect(app.attentionActionPath(row, 'dismiss')).toBe('/api/profiles/7/dismiss');
});

test('an untagged row is classified by shape, not defaulted blindly', () => {
  // Both sides carry `source` today. If a response ever loses the tag, the shapes are still
  // distinguishable — and guessing "profile" for a post is the direction that hurts.
  expect(app.attentionRowSource({ id: 1, post_url: 'https://x/', reaction: 'like' })).toBe('engagement');
  expect(app.attentionRowSource({ id: 1, profile_url: 'https://x/in/a' })).toBe('profile');
  expect(app.attentionActionPath({ id: 4, post_url: 'https://x/' }, 'retry')).toBe('/api/engagements/4/retry');
});

/* ---------- the modal renders both shapes ---------- */

const attnEngagement = (o: Record<string, unknown> = {}) => ({
  source: 'engagement', id: 12, status: 'needs_attention', attempts: 1,
  post_url: 'https://www.linkedin.com/feed/update/urn:li:activity:7318/',
  post_urn: 'urn:li:activity:7318', reaction: 'insightful',
  comment_text: 'Sharp framing.', last_error: 'comment not found after posting',
  scheduled_for: null, reacted_at: '2026-08-02T09:00:00.000Z', commented_at: null, ...o,
});

const attnProfile = (o: Record<string, unknown> = {}) => ({
  source: 'profile', id: 12, status: 'failed', attempts: 2, kind: 'invite',
  profile_url: 'https://www.linkedin.com/in/jane-doe/', cohort_name: 'Q3 CISOs',
  last_error: 'Connect button not found', sent_at: null, scheduled_for: null, ...o,
});

test('an engagement row shows the post, the reaction and a pending comment', async () => {
  stubFetchRoutes({ '/api/attention': { body: [attnEngagement()] } });
  await app.loadAttention();

  const tr = byId('attentionBody').querySelector('tr');
  expect(tr).not.toBeNull();
  const txt = tr!.textContent ?? '';
  expect(txt).toContain('linkedin.com/feed/update/urn:li:activity:7318');
  expect(txt).toContain('Insightful');
  expect(txt).toContain('comment pending');
  expect(txt).toContain('comment not found after posting');
  // The post URL is a real link, so the operator can go and look before retrying.
  expect(tr!.querySelector('a')?.getAttribute('href'))
    .toBe('https://www.linkedin.com/feed/update/urn:li:activity:7318/');
  // Its glyph must not claim to be a connection request.
  expect(tr!.querySelector('.kind-mark')?.className).toContain('engagement');
});

test('a landed comment is not reported as pending', async () => {
  stubFetchRoutes({ '/api/attention': { body: [attnEngagement({ commented_at: '2026-08-02T09:01:00.000Z' })] } });
  await app.loadAttention();
  const txt = byId('attentionBody').textContent ?? '';
  expect(txt).toContain('comment posted');
  expect(txt).not.toContain('comment pending');
});

test('clicking Retry on an engagement row posts to the engagements endpoint', async () => {
  const calls = stubFetchRoutes({
    '/api/attention': { body: [attnEngagement({ id: 12 })] },
    '/api/engagements/12/retry': { body: { ok: true } },
    '/api/status': { body: { counts: {}, msg_counts: {}, forecast: {}, guardrail: {}, sending: [] } },
  });
  await app.loadAttention();

  const retry = Array.from(byId('attentionBody').querySelectorAll('button'))
    .find((b) => b.textContent === 'Retry') as HTMLButtonElement;
  retry.click();
  await new Promise((r) => setTimeout(r, 0));

  const writes = calls.filter((c) => c.method === 'POST');
  expect(writes.map((c) => c.path)).toEqual(['/api/engagements/12/retry']);
  // The row this used to hit.
  expect(calls.some((c) => c.path.startsWith('/api/profiles/'))).toBe(false);
});

test('profile and engagement rows coexist, each with its own actions', async () => {
  stubFetchRoutes({ '/api/attention': { body: [attnProfile({ id: 3 }), attnEngagement({ id: 3 })] } });
  await app.loadAttention();

  const rows = Array.from(byId('attentionBody').querySelectorAll('tr'));
  expect(rows).toHaveLength(2);
  // Same id, two tables — the whole reason the discriminator has to be read per row.
  expect(rows[0].textContent).toContain('jane-doe');
  expect(rows[0].textContent).toContain('Q3 CISOs');
  expect(rows[1].textContent).toContain('urn:li:activity:7318');
});

/* ---------- the card ---------- */

const engagements = (o: Record<string, unknown> = {}) => ({
  counts: { queued: 3, scheduled: 2, sent: 8 },
  weekly_used: 8, weekly_cap: 500, weekly_remaining: 492,
  comments_today: 2, comment_daily_cap: 10,
  next_scheduled: '2026-08-02T14:30:00.000Z',
  ...o,
});

test('a null next_scheduled says "Not scheduled" and never a time', () => {
  app.renderEngagements(engagements({ next_scheduled: null }));

  // The invite-side pill's known defect is an estimated forecast pinned to `now`, which
  // renders as an imminent clock time on a queue nothing is planned for. Not here.
  expect(text('engNextTxt')).toBe('Not scheduled');
  expect(text('engNextTxt')).not.toMatch(/\d/);
  expect(text('engScheduledFoot')).toBe('not scheduled');
});

test('a real next_scheduled is shown as a time', () => {
  app.renderEngagements(engagements());
  expect(text('engNextTxt')).toMatch(/\d/);
  expect(text('engNextTxt')).toContain('next');
});

test('an empty pipeline says nothing is queued rather than "Not scheduled"', () => {
  // "Not scheduled" on an empty queue reads as a stall. Nothing queued is not a stall.
  app.renderEngagements(engagements({ counts: {}, next_scheduled: null }));
  expect(text('engNextTxt')).toBe('nothing queued');
});

test('absent count keys read as 0, not blank or NaN', () => {
  // /api/status omits any status with no rows, so `counts` here has NO queued/sent keys.
  app.renderEngagements(engagements({ counts: { scheduled: 4 } }));

  expect(text('engQueued')).toBe('0');
  expect(text('engSent')).toBe('0');
  expect(text('engScheduled')).toBe('4');
  // Zero rows must not light the stuck-work chips.
  expect(byId('engEngineFoot').hidden).toBe(true);
  expect(byId('engSendingPill').hidden).toBe(true);
});

test('a whole missing engagements block degrades to zeroes, not a crash', () => {
  // An older server, or a poll that raced a deploy.
  app.renderEngagements(undefined);
  expect(text('engQueued')).toBe('0');
  expect(text('engFuelSent')).toBe('0');
  expect(text('engNextTxt')).toBe('nothing queued');
  expect(byId('engEngine').classList.contains('is-idle')).toBe(true);
});

test('both caps are stated: reactions this week and comments today', () => {
  app.renderEngagements(engagements({ weekly_used: 37, weekly_cap: 500, comments_today: 4, comment_daily_cap: 10 }));

  expect(text('engFuelSent')).toBe('37');
  expect(text('engFuelCap')).toBe('500');
  expect(text('engCommentsTxt')).toContain('4 / 10');
  expect(byId('engFuelBar').style.width).toBe('7%');
});

test('parked and failed rows get their own chips instead of being rounded away', () => {
  app.renderEngagements(engagements({ counts: { needs_attention: 2, failed: 1, sent: 4 } }));

  expect(byId('engEngineFoot').hidden).toBe(false);
  expect(byId('engFootAttn').hidden).toBe(false);
  expect(byId('engFootAttn').textContent).toContain('parked for a manual look');
  expect(byId('engFootFailed').hidden).toBe(false);
  expect(byId('engFootFailed').textContent).toContain('failed');
});

test('a sending row shows a live pill, since the status poll cannot name the post', () => {
  app.renderEngagements(engagements({ counts: { sending: 1, sent: 2 } }));
  expect(byId('engSendingPill').hidden).toBe(false);
  expect(text('engSendingTxt')).toBe('engaging · 1 post');
});

test('the card stays collapsed until the pipeline has ever been used', () => {
  app.renderEngagements(engagements({ counts: {} }));
  expect(byId('engEngine').classList.contains('is-idle')).toBe(true);
  expect(byId('engEngineIdle').hidden).toBe(false);

  app.renderEngagements(engagements({ counts: { sent: 1 } }));
  expect(byId('engEngine').classList.contains('is-idle')).toBe(false);
  expect(byId('engEngineIdle').hidden).toBe(true);
});

test('the engagements engine wears the shared pause / halt state', () => {
  app.applyEngineState({ paused: 1, guardrail: { tripped: 0 } });
  expect(byId('engEngine').classList.contains('is-paused')).toBe(true);
  expect(byId('engEngineState').hidden).toBe(false);
  expect(text('engEngineStateTxt')).toBe('Paused');

  app.applyEngineState({ paused: 0, guardrail: { tripped: 1 } });
  expect(byId('engEngine').classList.contains('is-halted')).toBe(true);
  expect(text('engEngineStateTxt')).toBe('Halted');
});

/* ---------- stuck posts must stay reachable ---------- */

function status(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    paused: 0, counts: {}, msg_counts: {}, forecast: {},
    weekly_sent: 0, weekly_cap: 100, msg_weekly_sent: 0, msg_weekly_cap: 250,
    sending: [], guardrail: { tripped: 0 },
    ...over,
  };
}

test('a post-only failure still opens the attention modal', () => {
  // Same failure mode the message side shipped with: the Attention card is the modal's only
  // entry point and only becomes clickable on a non-zero count, so an engagement-only
  // casualty list has to be inside that number.
  app.renderEngine(status({ engagements: { counts: { needs_attention: 2, failed: 1 } } }));

  expect(text('outAttn')).toBe('3');
  const card = byId('outAttnCard');
  expect(card.classList.contains('has-attn')).toBe(true);
  expect(card.classList.contains('is-clickable')).toBe(true);
});

test('the bulk Retry button counts only what /api/retry can actually reach', () => {
  // /api/retry walks the profiles table. Labelling it "(3)" when two of those are posts
  // would promise a requeue pressing it cannot perform.
  app.renderEngine(status({
    counts: { failed: 1 },
    engagements: { counts: { needs_attention: 2 } },
  }));

  expect(text('outAttn')).toBe('3');
  const retry = byId<HTMLButtonElement>('retryFailed');
  expect(retry.hidden).toBe(false);
  expect(retry.textContent).toBe('Retry failed (1)');
});

test('with only posts stuck the profiles-only bulk button stays hidden', () => {
  app.renderEngine(status({ engagements: { counts: { failed: 2 } } }));
  expect(text('outAttn')).toBe('2');
  expect(byId<HTMLButtonElement>('retryFailed').hidden).toBe(true);
});

/* ---------- "Up next" ---------- */

const scheduled = (o: Record<string, unknown> = {}) => ({
  id: 1, post_url: 'https://www.linkedin.com/feed/update/urn:li:activity:1/',
  post_urn: 'urn:li:activity:1', reaction: 'like', comment_text: null,
  status: 'scheduled', scheduled_for: '2026-08-02T12:00:00.000Z', ...o,
});

test('upcoming rows are ordered by when they run, not by when they were added', async () => {
  // /api/engagements is ORDER BY id DESC — newest ENQUEUED first. For "up next" that is the
  // wrong axis: a post added today can be scheduled after one added last week.
  stubFetchRoutes({
    '/api/engagements': {
      body: [
        scheduled({ id: 3, scheduled_for: '2026-08-02T18:00:00.000Z', post_urn: 'urn:li:activity:3', post_url: 'https://www.linkedin.com/feed/update/urn:li:activity:3/' }),
        scheduled({ id: 2, scheduled_for: '2026-08-02T09:00:00.000Z', post_url: 'https://www.linkedin.com/feed/update/urn:li:activity:2/' }),
        scheduled({ id: 1, scheduled_for: '2026-08-02T13:00:00.000Z' }),
      ],
    },
  });
  await app.refreshEngagementUpNext();

  const urls = Array.from(byId('engUpNextList').querySelectorAll('a'))
    .map((a) => a.getAttribute('href'));
  expect(urls).toEqual([
    'https://www.linkedin.com/feed/update/urn:li:activity:2/',
    'https://www.linkedin.com/feed/update/urn:li:activity:1/',
    'https://www.linkedin.com/feed/update/urn:li:activity:3/',
  ]);
});

test('a row that will also comment is marked, and its reaction named', async () => {
  stubFetchRoutes({
    '/api/engagements': { body: [scheduled({ reaction: 'insightful', comment_text: 'Good point.' })] },
  });
  await app.refreshEngagementUpNext();

  const li = byId('engUpNextList').querySelector('li');
  expect(li!.textContent).toContain('Insightful');
  const mark = li!.querySelector('.eng-up-comment');
  expect(mark).not.toBeNull();
  expect(mark!.getAttribute('title')).toBe('Good point.');
});

test('at most five are named, and the remainder is counted rather than dropped', async () => {
  const rows = Array.from({ length: 8 }, (_, i) => scheduled({
    id: i + 1,
    post_url: `https://www.linkedin.com/feed/update/urn:li:activity:${i + 1}/`,
    scheduled_for: `2026-08-0${i + 1}T12:00:00.000Z`,
  }));
  stubFetchRoutes({ '/api/engagements': { body: rows } });
  await app.refreshEngagementUpNext();

  expect(byId('engUpNextList').querySelectorAll('li.eng-up')).toHaveLength(5);
  expect(byId('engUpNextList').textContent).toContain('+3 more scheduled');
});

test('a scheduled row with no time sorts last and says so, rather than vanishing', async () => {
  // A scheduled row without a slot is a planner bug. Showing it is the point.
  stubFetchRoutes({
    '/api/engagements': {
      body: [
        scheduled({ id: 2, scheduled_for: null, post_url: 'https://www.linkedin.com/feed/update/urn:li:activity:2/' }),
        scheduled({ id: 1 }),
      ],
    },
  });
  await app.refreshEngagementUpNext();

  const items = Array.from(byId('engUpNextList').querySelectorAll('li.eng-up'));
  expect(items).toHaveLength(2);
  expect(items[1].textContent).toContain('no slot yet');
});

test('nothing scheduled hides the list instead of leaving a stale one', async () => {
  stubFetchRoutes({ '/api/engagements': { body: [scheduled()] } });
  await app.refreshEngagementUpNext();
  expect(byId('engUpNext').hidden).toBe(false);

  stubFetchRoutes({ '/api/engagements': { body: [] } });
  await app.refreshEngagementUpNext();
  expect(byId('engUpNext').hidden).toBe(true);
  expect(byId('engUpNextList').children).toHaveLength(0);
});

test('it asks only for scheduled rows, and deeper than it displays', async () => {
  const calls = stubFetchRoutes({ '/api/engagements': { body: [] } });
  await app.refreshEngagementUpNext();

  expect(calls).toHaveLength(1);
  expect(calls[0].path).toContain('status=scheduled');
  // Deep enough that the re-sort has the real earliest rows to choose from.
  expect(calls[0].path).toContain('limit=100');
});
