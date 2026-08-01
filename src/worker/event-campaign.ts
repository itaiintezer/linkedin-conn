/**
 * Building and scheduling an event-invite campaign — everything up to the point the
 * browser gets involved.
 *
 * Creation is deliberately cheap and browser-free: normalise the list, validate it
 * against the roster, compute the histogram, persist a DRAFT. The operator reviews the
 * ranked buckets and the projected reach before anything irreversible can happen.
 */
import type { Repos } from '../db/repositories.js';
import type { LinkedInEvent } from '../types.js';
import { normalizeProfileUrl } from '../core/url.js';
import { normalizeEventUrl, eventUrnFrom, hasStarted } from '../core/event-page.js';
import {
  buildBuckets, keyId, bucketKeyFor, type LocatedRow, type UnreachableReason,
} from '../core/event-buckets.js';
import { findFreeWindow } from '../core/reservations.js';
import { estimatedBatchRuntimeMs } from './scheduler-service.js';
import { capsFor } from '../core/caps.js';
import { CAMPAIGN_KINDS } from '../core/campaign-kind.js';
import { log } from '../core/log.js';

export const RESERVATION_PURPOSE = 'event_invite';

export interface RejectedUrl {
  url: string;
  reason: 'invalid_url' | 'not_a_connection';
}

export interface CreateEventResult {
  event: LinkedInEvent;
  /** Invitees stored as pending — the reachable ones. */
  added: number;
  /** Never even made it to a bucket. */
  rejected: RejectedUrl[];
  /** In the roster, but with no location we can filter by. */
  unreachable: { url: string; reason: UnreachableReason }[];
  bucketCount: number;
}

/**
 * Validate a list of profile URLs against the roster and plan the buckets.
 *
 * Only 1st-degree connections can be invited to an event, and only an enriched roster row
 * carries the location the bucketing needs — so a URL with no roster row is rejected up
 * front, by name, rather than failing invisibly mid-run.
 */
export function createEventCampaign(
  repos: Repos, eventUrlRaw: string, profileUrlsRaw: string[],
): CreateEventResult | { error: string } {
  const eventUrl = normalizeEventUrl(eventUrlRaw);
  if (eventUrl === null) return { error: `not a LinkedIn event URL: ${eventUrlRaw}` };

  const existing = repos.eventCampaigns.findByUrl(eventUrl);
  if (existing) return { error: `event already has a campaign (#${existing.id})` };

  const rejected: RejectedUrl[] = [];
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const raw of profileUrlsRaw) {
    const url = normalizeProfileUrl(raw);
    if (url === null) { rejected.push({ url: raw, reason: 'invalid_url' }); continue; }
    if (seen.has(url)) continue;
    seen.add(url);
    normalized.push(url);
  }

  const connections = repos.connections.findManyByUrls(normalized);
  const byUrl = new Map(connections.map((c) => [c.profile_url, c]));
  for (const url of normalized) {
    if (!byUrl.has(url)) rejected.push({ url, reason: 'not_a_connection' });
  }

  const located: LocatedRow[] = connections.map((c) => ({
    profile_url: c.profile_url,
    location_country: c.location_country,
    location_country_code: c.location_country_code,
    location_region: c.location_region,
  }));

  const s = repos.settings.get();
  const rosterCounts = repos.connections.locationHistogram();
  // Child regions only for the countries that could actually need sharding — one query
  // per oversized country rather than one per country in the list.
  const childRegions = new Map<string, { region: string; count: number }[]>();
  for (const row of located) {
    const key = bucketKeyFor(row);
    if (typeof key === 'string' || key.kind !== 'country') continue;
    if (childRegions.has(key.country)) continue;
    if ((rosterCounts.get(keyId(key)) ?? 0) < s.event_shard_threshold) continue;
    childRegions.set(key.country, repos.connections.childRegions(key.country));
  }

  const plan = buildBuckets(located, {
    rosterCounts, childRegions, shardThreshold: s.event_shard_threshold,
  });

  const event = repos.eventCampaigns.create(eventUrl, {
    eventUrn: eventUrnFrom(eventUrl),
    inviteCap: s.event_invite_cap,
    bucketCeiling: s.event_bucket_ceiling,
  });

  const unreachableUrls = new Set(plan.unreachable.map((u) => u.profile_url));
  const added = repos.eventInvitees.addMany(event.id, connections.map((c) => {
    const bad = unreachableUrls.has(c.profile_url);
    return {
      profile_url: c.profile_url,
      connection_id: c.id,
      member_urn: c.linkedin_id,
      full_name: c.full_name,
      status: bad ? ('unreachable' as const) : ('pending' as const),
      note: bad
        ? plan.unreachable.find((u) => u.profile_url === c.profile_url)!.reason
        : null,
    };
  }));

  repos.eventBuckets.replaceAll(event.id, plan.buckets);

  log.info('events', 'campaign created', {
    event: event.id, url: eventUrl, added, rejected: rejected.length,
    unreachable: plan.unreachable.length, buckets: plan.buckets.length,
  });

  return {
    event,
    added,
    rejected,
    unreachable: plan.unreachable.map((u) => ({ url: u.profile_url, reason: u.reason })),
    bucketCount: plan.buckets.length,
  };
}

/**
 * Arm a draft. Arming does NOT place the reservation — that is a scheduling concern the
 * periodic tick owns, so a campaign armed at 11pm on a Friday still gets a sensible
 * Monday window instead of failing to arm.
 */
export function armEventCampaign(
  repos: Repos, eventId: number, now: Date,
): { ok: true } | { ok: false; error: string } {
  const event = repos.eventCampaigns.findById(eventId);
  if (!event) return { ok: false, error: 'no such event' };
  if (event.status !== 'draft') return { ok: false, error: `campaign is ${event.status}, not draft` };
  if (repos.eventBuckets.list(eventId).length === 0) {
    return { ok: false, error: 'no location buckets — nothing on this list can be reached' };
  }
  const pending = repos.eventInvitees.countsByStatus(eventId).pending ?? 0;
  if (pending === 0) return { ok: false, error: 'no reachable invitees' };
  if (hasStarted(event.starts_at, now)) {
    return { ok: false, error: 'the event has already started' };
  }
  repos.eventCampaigns.update(eventId, { status: 'armed', armed_at: now.toISOString() });
  log.info('events', 'campaign armed', { event: eventId, pending });
  return { ok: true };
}

/** Today's working-hours window, or null if it has already closed. */
function todayWindow(repos: Repos, now: Date): { start: Date; end: Date } | null {
  const s = repos.settings.get();
  if (s.weekdays_only && (now.getDay() === 0 || now.getDay() === 6)) return null;
  const end = new Date(now);
  end.setHours(s.workday_end_hour, 0, 0, 0);
  if (now.getTime() >= end.getTime()) return null;
  const start = new Date(now);
  start.setHours(s.workday_start_hour, 0, 0, 0);
  return { start: now.getTime() > start.getTime() ? new Date(now) : start, end };
}

/**
 * Give the next armed campaign a window today, if the day has room for one.
 *
 * Runs from the hourly planner tick, BEFORE send slots are assigned, so the reservation
 * is in place when `planKind` reads it. Idempotent: a campaign that already holds a
 * future reservation is left alone.
 */
export function ensureEventReservation(repos: Repos, now: Date): void {
  const s = repos.settings.get();
  if (s.paused || repos.appState.get().guardrail_tripped === 1) return;

  repos.reservations.purgeBefore(new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString());

  const window = todayWindow(repos, now);
  if (window === null) return;

  // One event run per day, counting live runs only — a dry run is free.
  if (repos.eventCampaigns.countRunsOnDate(now.toISOString()) >= Math.max(1, s.events_per_day)) return;

  const held = repos.reservations.between(now.toISOString(), window.end.toISOString());
  if (held.length > 0) return; // a window is already claimed for today

  const armed = repos.eventCampaigns.byStatus('armed')
    .filter((e) => !hasStarted(e.starts_at, now));
  const target = armed[0];
  if (!target) return;

  // Route around today's already-scheduled sends. Each occupies the browser for roughly
  // one batch's worth of randomized delays.
  const busy: Date[] = [];
  let busyRuntimeMs = 0;
  for (const kind of CAMPAIGN_KINDS) {
    const caps = capsFor(s, kind);
    busyRuntimeMs = Math.max(busyRuntimeMs, estimatedBatchRuntimeMs(s, caps.batchSize));
    for (const p of repos.profiles.byStatusKind('scheduled', kind)) {
      if (p.scheduled_for === null) continue;
      const at = new Date(p.scheduled_for);
      if (at.getTime() >= now.getTime()) busy.push(at);
    }
  }

  const durationMs = Math.max(1, s.event_run_budget_minutes) * 60 * 1000;
  const slot = findFreeWindow({
    windowStart: window.start, windowEnd: window.end, durationMs, busy, busyRuntimeMs,
  });
  if (slot === null) {
    log.info('events', 'no free window today for the armed campaign', { event: target.id });
    return;
  }

  repos.reservations.create(
    slot.from.toISOString(), slot.to.toISOString(), RESERVATION_PURPOSE, target.id);
  log.info('events', 'reserved a run window', {
    event: target.id, from: slot.from.toISOString(), to: slot.to.toISOString(),
  });
}

/** The campaign whose reserved window is open right now, if any. */
export function dueEventRun(
  repos: Repos, now: Date,
): { event: LinkedInEvent; from: string; to: string } | null {
  const rows = repos.db.prepare(`
    SELECT r.from_ts, r.to_ts, r.ref_id
    FROM reservations r
    WHERE r.purpose = ? AND r.from_ts <= ? AND r.to_ts > ?
    ORDER BY r.from_ts LIMIT 1
  `).all(RESERVATION_PURPOSE, now.toISOString(), now.toISOString()) as unknown as
    { from_ts: string; to_ts: string; ref_id: number | null }[];
  const row = rows[0];
  if (!row || row.ref_id === null) return null;
  const event = repos.eventCampaigns.findById(row.ref_id);
  if (!event || event.status !== 'armed') return null;
  return { event, from: row.from_ts, to: row.to_ts };
}
