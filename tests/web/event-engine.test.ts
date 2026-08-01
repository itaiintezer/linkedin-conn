// @vitest-environment jsdom
/// <reference lib="dom" />
/**
 * The dashboard's third conveyor, and the event run in "Up next".
 *
 * What these lock down is mostly about NOT overstating things. The event pipeline is
 * "best effort" by construction — people with no filterable location are never invited,
 * locations past the per-run ceiling wait for another day, and a campaign can be armed for
 * hours before the planner finds it 20 free minutes. Each of those has a number on the
 * dashboard, and each one is a place where rounding to a friendlier figure would quietly
 * turn "we will not reach these people" into silence.
 */
import { test, expect, beforeEach, afterEach } from 'vitest';
import { loadApp, text, byId, stubFetchRoutes, type AppInternals } from './helpers/load-app.js';

let app: AppInternals;
const realFetch = globalThis.fetch;

beforeEach(() => { app = loadApp(); });
afterEach(() => { globalThis.fetch = realFetch; });

const flush = () => new Promise((r) => setTimeout(r, 0));

/** A /api/status payload whose `event` block is the part under test. */
function status(event: Record<string, unknown> | null = null): Record<string, unknown> {
  return {
    paused: 0, counts: {}, msg_counts: {}, forecast: {},
    weekly_sent: 0, weekly_cap: 100, msg_weekly_sent: 0, msg_weekly_cap: 250,
    sending: [], guardrail: { tripped: 0 },
    event: event ?? {
      campaigns: 0, open: 0, listed: 0, up_next: 0, invited: 0, unreachable: 0,
      locations_next: 0, locations_left: 0, runs_today: 0, events_per_day: 1,
      next_run: null, running: null,
    },
  };
}

const at = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();

test('an account that has never used the pipeline sees a placeholder, not a dead conveyor', () => {
  app.renderEngine(status());
  expect(byId('evEngine').classList.contains('is-idle')).toBe(true);
  expect(byId('evEngineIdle').hidden).toBe(false);
});

test('one campaign unfolds the conveyor and fills every station', () => {
  app.renderEngine(status({
    campaigns: 1, open: 1, listed: 214, up_next: 96, invited: 128, unreachable: 31,
    locations_next: 4, locations_left: 6, runs_today: 0, events_per_day: 1,
    next_run: { event_id: 3, title: 'Cloud Security Forum', from: at(3600e3), to: at(4800e3) },
    running: null,
  }));

  expect(byId('evEngine').classList.contains('is-idle')).toBe(false);
  expect(text('evListed')).toBe('214');
  expect(text('evUpNext')).toBe('96');
  expect(text('evInvited')).toBe('128');
  expect(text('evUpNextFoot')).toBe('4 locations');
});

test('the fuel gauge counts RUNS against the daily cap, not invitations', () => {
  app.renderEngine(status({
    campaigns: 1, open: 1, listed: 10, up_next: 10, invited: 0, unreachable: 0,
    locations_next: 1, locations_left: 0, runs_today: 1, events_per_day: 2,
    next_run: null, running: null,
  }));
  expect(text('evFuelSent')).toBe('1');
  expect(text('evFuelCap')).toBe('2');
  expect(byId('evFuelBar').style.width).toBe('50%');
});

test('an armed-but-unscheduled campaign is not given a clock time it does not have', () => {
  // Arming does not place the window — the hourly planner does, once the day has room.
  // Printing a time here would be the same lie the invite pill used to tell.
  app.renderEngine(status({
    campaigns: 1, open: 1, listed: 40, up_next: 40, invited: 0, unreachable: 0,
    locations_next: 2, locations_left: 0, runs_today: 0, events_per_day: 1,
    next_run: { event_id: 1, title: null, from: null, to: null }, running: null,
  }));
  expect(text('evNextTxt')).toContain('awaiting a free window');
  expect(text('evNextTxt')).not.toMatch(/\d{1,2}:\d{2}/);
});

test('the pill distinguishes "no campaigns" from "nothing armed"', () => {
  app.renderEngine(status());
  expect(text('evNextTxt')).toBe('no campaigns');

  app.renderEngine(status({
    campaigns: 2, open: 1, listed: 0, up_next: 0, invited: 0, unreachable: 0,
    locations_next: 0, locations_left: 0, runs_today: 0, events_per_day: 1,
    next_run: null, running: null,
  }));
  expect(text('evNextTxt')).toBe('nothing armed');
});

test('the people and locations no run will reach are stated, not rounded away', () => {
  app.renderEngine(status({
    campaigns: 1, open: 1, listed: 214, up_next: 96, invited: 0, unreachable: 31,
    locations_next: 4, locations_left: 6, runs_today: 0, events_per_day: 1,
    next_run: null, running: null,
  }));
  expect(byId('evEngineFoot').hidden).toBe(false);
  expect(text('evFootLeft')).toBe('6 more locations after that run');
  expect(text('evFootUnreachable')).toBe('31 unreachable by location');
});

test('the foot disappears when there is nothing left over to admit', () => {
  app.renderEngine(status({
    campaigns: 1, open: 1, listed: 5, up_next: 5, invited: 0, unreachable: 0,
    locations_next: 1, locations_left: 0, runs_today: 0, events_per_day: 1,
    next_run: null, running: null,
  }));
  expect(byId('evEngineFoot').hidden).toBe(true);
});

test('a run in flight names the campaign holding the browser', () => {
  app.renderEngine(status({
    campaigns: 1, open: 1, listed: 100, up_next: 40, invited: 12, unreachable: 0,
    locations_next: 2, locations_left: 1, runs_today: 1, events_per_day: 1,
    next_run: null, running: { event_id: 7, title: 'AppSec Tel Aviv' },
  }));
  expect(byId('evRunningPill').hidden).toBe(false);
  expect(text('evRunningTxt')).toBe('inviting · AppSec Tel Aviv');
});

test('one pause and one halt: the third engine wears them too', () => {
  const base = { counts: {}, msg_counts: {}, forecast: {}, sending: [] };
  app.applyEngineState({ ...base, paused: 1, guardrail: { tripped: 0 } });
  expect(byId('evEngine').classList.contains('is-paused')).toBe(true);
  expect(byId('evEngineState').hidden).toBe(false);
  expect(text('evEngineStateTxt')).toBe('Paused');

  app.applyEngineState({ ...base, paused: 0, guardrail: { tripped: 1 } });
  expect(byId('evEngine').classList.contains('is-halted')).toBe(true);
  expect(text('evEngineStateTxt')).toBe('Halted');
});

/* ---------- "Up next" ---------- */

const EVENT_GROUP = {
  id: 3, title: 'Cloud Security Forum 2026',
  event_url: 'https://www.linkedin.com/events/7486088214579982336/',
  status: 'armed', pending: 214,
  reserved_from: at(3600e3), reserved_to: at(4800e3),
  locations_left: 6,
  buckets: [
    { rank: 0, label: 'Israel', target_count: 48, roster_count: 1840 },
    { rank: 1, label: 'California (US state)', target_count: 26, roster_count: 612 },
  ],
};

const queue = (over: Record<string, unknown> = {}) => ({
  cohorts: [], events: [EVENT_GROUP], ...over,
});

test('an armed run leads the queue, listed by location rather than by person', async () => {
  stubFetchRoutes({ '/api/queue/grouped': { body: queue() } });
  await app.refreshQueue();
  await flush();

  const group = byId('queueGroups').querySelector('.qg-event')!;
  expect(group.querySelector('.qg-name')!.textContent).toBe('Cloud Security Forum 2026');
  expect(group.querySelector('.qg-count')!.textContent).toBe('214 people to invite');

  const rows = group.querySelectorAll('.qg-row');
  expect(rows).toHaveLength(2);
  expect(rows[0].querySelector('.qg-loc')!.textContent).toContain('Israel');
  expect(rows[0].querySelector('.qg-loc')!.textContent).toContain('1,840 connections');
  expect(rows[0].querySelector('.qg-loc-n')!.textContent).toBe('48 to invite');
  // The locations this run will NOT get to, said out loud beneath them.
  expect(group.querySelector('.qg-foot')!.textContent).toBe('6 locations roll into a later run.');
});

test('an event run cannot be reordered or dropped from the queue', async () => {
  // Its place in the day belongs to the planner, and dropping a location is only safe
  // beside the full ladder on the Events tab.
  stubFetchRoutes({ '/api/queue/grouped': { body: queue() } });
  await app.refreshQueue();
  await flush();

  const head = byId('queueGroups').querySelector('.qg-event .qg-head')!;
  expect(head.getAttribute('draggable')).toBeNull();
  expect(head.querySelectorAll('.qg-ico.rm')).toHaveLength(0);
});

test('an unscheduled run says so instead of showing a time', async () => {
  stubFetchRoutes({
    '/api/queue/grouped': { body: queue({ events: [{ ...EVENT_GROUP, reserved_from: null, reserved_to: null }] }) },
  });
  await app.refreshQueue();
  await flush();
  const when = byId('queueGroups').querySelector('.qg-event .qg-when')!;
  expect(when.textContent).toBe('awaiting a free window');
  expect(when.classList.contains('is-unscheduled')).toBe(true);
});

test('the queue is not "empty" when the only work is an event run', async () => {
  stubFetchRoutes({ '/api/queue/grouped': { body: queue() } });
  await app.refreshQueue();
  await flush();
  expect(byId('queueEmpty').hidden).toBe(true);
  expect(text('queueCount')).toBe('0 up for processing · 214 event invites');
});

test('with nothing anywhere, the queue still reports empty', async () => {
  stubFetchRoutes({ '/api/queue/grouped': { body: { cohorts: [], events: [] } } });
  await app.refreshQueue();
  await flush();
  expect(byId('queueEmpty').hidden).toBe(false);
});
