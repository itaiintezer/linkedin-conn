/**
 * Executing one event-invite run.
 *
 * A run works `bucket_ceiling` location buckets starting at the campaign's cursor, ticking
 * any still-pending invitee it sees and submitting per bucket. It is deliberately
 * restartable: everything durable is written as it goes, so a crash at bucket 9 keeps the
 * first 8 buckets' invitations and tomorrow resumes at the cursor.
 */
import type { Repos } from '../db/repositories.js';
import type { BrowserDriver, LinkedInEvent } from '../types.js';
import { hasStarted, parseEventStart } from '../core/event-page.js';
import { tripCheckpoint, isTripped } from './guardrail.js';
import { RESERVATION_PURPOSE } from './event-campaign.js';
import { log } from '../core/log.js';

export interface RunOptions {
  mode?: 'dry' | 'live';
  /** Hard stop for STARTING another bucket. A bucket already in flight runs to
   *  completion — the worst-case overrun is one bucket. */
  deadline?: Date;
  reserved?: { from: string; to: string } | null;
  clock?: () => Date;
}

export type RunOutcome =
  | 'completed' | 'exhausted' | 'ceiling' | 'cap' | 'deadline'
  | 'event_started' | 'halted' | 'failed';

export interface RunSummary {
  outcome: RunOutcome;
  invited: number;
  bucketsWorked: number;
  error?: string;
}

/**
 * Run one campaign. Assumes the caller holds the browser lock and has already checked
 * pause/login — mirroring how the sender is driven.
 */
export async function runEventCampaign(
  repos: Repos, driver: BrowserDriver, event: LinkedInEvent, opts: RunOptions = {},
): Promise<RunSummary> {
  const clock = opts.clock ?? (() => new Date());
  const mode = opts.mode ?? 'live';
  const dryRun = mode === 'dry';
  const run = repos.eventRuns.start(event.id, mode, opts.reserved ?? null);

  const finish = (outcome: RunOutcome, invited: number, worked: number, error?: string): RunSummary => {
    repos.eventRuns.finish(run.id, outcome, invited, clock().toISOString(), error);
    // A live run releases the window it was given; a dry run never held one.
    if (!dryRun) repos.reservations.clearFor(RESERVATION_PURPOSE, event.id);
    if (!dryRun && repos.eventCampaigns.findById(event.id)?.status === 'running') {
      repos.eventCampaigns.update(event.id, { status: 'armed' });
    }
    log.info('events', 'run finished', { event: event.id, mode, outcome, invited, buckets: worked });
    return { outcome, invited, bucketsWorked: worked, ...(error ? { error } : {}) };
  };

  if (!dryRun) repos.eventCampaigns.update(event.id, { status: 'running' });

  // --- Land on the event and read the top card ------------------------------------
  const opened = await driver.openEvent(event.event_url);
  if (opened.status === 'checkpoint') {
    tripCheckpoint(repos, clock(), opened.error);
    return finish('halted', 0, 0, opened.error);
  }
  if (opened.status !== 'ok' || !opened.info) {
    if (!dryRun) {
      repos.eventCampaigns.close(event.id, 'failed', opened.error ?? 'could not open event', clock().toISOString());
    }
    return finish('failed', 0, 0, opened.error);
  }

  // Persist what the page told us. The start time is the campaign's terminal condition,
  // so record it even on a dry run.
  const parsed = opened.info.startsAtText ? parseEventStart(opened.info.startsAtText) : null;
  repos.eventCampaigns.update(event.id, {
    title: opened.info.title,
    ...(parsed ? { starts_at: parsed.toISOString() } : {}),
  });
  const startsAt = parsed ? parsed.toISOString() : event.starts_at;
  if (hasStarted(startsAt, clock())) {
    repos.eventInvitees.markRemainingUnreachable(event.id, 'event started before they were invited');
    repos.eventCampaigns.close(event.id, 'done', 'the event has started', clock().toISOString());
    return finish('event_started', 0, 0);
  }

  // --- Attend. Hard prerequisite: no Attend, no Invite menu item. ------------------
  if (opened.info.canAttend) {
    const attended = await driver.attendEvent();
    if (attended.status === 'checkpoint') {
      tripCheckpoint(repos, clock(), attended.error);
      return finish('halted', 0, 0, attended.error);
    }
    if (attended.status !== 'ok') return finish('failed', 0, 0, attended.error);
    repos.eventCampaigns.update(event.id, { attended: 1 });
  } else if (opened.info.attending) {
    repos.eventCampaigns.update(event.id, { attended: 1 });
  }

  // --- Work the buckets ------------------------------------------------------------
  const ceiling = Math.max(1, event.bucket_ceiling);
  const buckets = repos.eventBuckets.forRun(event.id, event.bucket_cursor, ceiling);
  const allBuckets = repos.eventBuckets.list(event.id);
  let invited = 0;
  let worked = 0;
  let outcome: RunOutcome = 'completed';
  let cursor = event.bucket_cursor;

  for (const bucket of buckets) {
    // The ceiling is checked BETWEEN buckets only, never mid-bucket: abandoning a bucket
    // halfway would discard a full scroll for nothing.
    if (opts.deadline && clock().getTime() > opts.deadline.getTime()) { outcome = 'deadline'; break; }
    if (isTripped(repos)) { outcome = 'halted'; break; }

    const alreadyInvited = repos.eventInvitees.invitedCount(event.id);
    const remainingCap = Math.max(0, event.invite_cap - alreadyInvited);
    if (remainingCap === 0) { outcome = 'cap'; break; }

    const pending = repos.eventInvitees.pendingByUrn(event.id);
    if (pending.size === 0) { outcome = 'exhausted'; break; }

    repos.eventRuns.progress(run.id, bucket.id, {});
    const result = await driver.runEventBucket({
      eventUrl: event.event_url,
      geoCandidates: repos.eventBuckets.candidates(bucket),
      pending: [...pending.keys()],
      limit: remainingCap,
      deadline: opts.deadline ?? new Date(clock().getTime() + 60 * 60 * 1000),
      dryRun,
      onProgress: (p) => repos.eventRuns.progress(run.id, bucket.id, {
        rows_loaded: p.rowsLoaded, matched: p.matched,
      }),
    });

    worked++;
    repos.eventRuns.progress(run.id, bucket.id, {
      rows_loaded: result.rowsLoaded,
      matched: result.matchedUrns.length,
      ticked: result.tickedUrns.length,
      submitted: result.submitted ? result.tickedUrns.length : 0,
      outcome: result.outcome,
      error: result.error ?? null,
    });

    if (result.geoLabel && result.geoUrn) {
      repos.eventBuckets.setGeo(bucket.id, result.geoLabel, result.geoUrn);
    }

    if (result.outcome === 'checkpoint') {
      tripCheckpoint(repos, clock(), result.error);
      outcome = 'halted';
      break;
    }

    // A dry run must leave no trace on the plan. It does not advance the cursor, so
    // marking buckets worked would make the campaign look partly done when nothing has
    // happened — and the real run would still redo every one of them.
    const markBucket = (status: 'done' | 'skipped' | 'failed') => {
      if (!dryRun) repos.eventBuckets.setStatus(bucket.id, status);
    };

    if (result.outcome === 'no_geo') {
      // Never guess at a near-match. The bucket is skipped, loudly, and its people stay
      // pending for a later bucket or a later day.
      markBucket('skipped');
      log.warn('events', 'bucket skipped: no exact geo match', { event: event.id, bucket: bucket.label });
      cursor = bucket.rank + 1;
      continue;
    }

    if (result.outcome === 'failed') {
      markBucket('failed');
      log.error('events', 'bucket failed', { event: event.id, bucket: bucket.label, error: result.error });
      cursor = bucket.rank + 1;
      continue;
    }

    // Only a real submit marks people invited. A dry run records nothing durable about
    // who "would have been" invited — they must stay pending for the real run.
    if (result.submitted && result.tickedUrns.length > 0) {
      const ids = result.tickedUrns
        .map((urn) => pending.get(urn)?.id)
        .filter((id): id is number => typeof id === 'number');
      repos.eventInvitees.markInvited(ids, bucket.id, clock().toISOString());
      invited += ids.length;
    }
    markBucket('done');
    cursor = bucket.rank + 1;
  }

  if (!dryRun) repos.eventCampaigns.update(event.id, { bucket_cursor: cursor });

  // --- Decide what happens next ----------------------------------------------------
  const stillPending = repos.eventInvitees.countsByStatus(event.id).pending ?? 0;
  if (!dryRun) {
    if (stillPending === 0) {
      repos.eventCampaigns.close(event.id, 'done', 'everyone reachable was invited', clock().toISOString());
      outcome = outcome === 'completed' ? 'exhausted' : outcome;
    } else if (cursor >= allBuckets.length) {
      // Every bucket has been tried; whoever is left cannot be reached by location.
      const parked = repos.eventInvitees.markRemainingUnreachable(
        event.id, 'not found in any location bucket');
      repos.eventCampaigns.close(event.id, 'done', 'all location buckets exhausted', clock().toISOString());
      log.info('events', 'campaign closed with unreachable remainder', { event: event.id, parked });
    } else if (outcome === 'completed') {
      // More buckets to walk — tomorrow's run picks up at the cursor.
      outcome = 'ceiling';
    }
  }

  return finish(outcome, invited, worked);
}
