import type { Repos } from '../db/repositories.js';
import type { CampaignKind, Settings } from '../types.js';
import { CAMPAIGN_KINDS } from '../core/campaign-kind.js';
import { planDailyBatches, assignSchedule } from '../core/schedule.js';
import { windowStartIso, remainingCapacity, dayStartIso } from '../core/rate-limit.js';
import { dailyRemainingFor } from '../core/daily-budget.js';
import { capsFor, engagementCaps, type KindCaps } from '../core/caps.js';
import {
  conflictsWithReservation, filterReservedSlots, type ReservationWindow,
} from '../core/reservations.js';
import { log } from '../core/log.js';

/** How long a scheduled profile may sit past its slot before it's re-queued. */
export const OVERDUE_GRACE_MS = 10 * 60 * 1000;

/**
 * Return scheduled profiles that missed their slot by more than the grace period to
 * 'queued' so the planner re-flows them into a valid future working-hours slot.
 * Healthy items never hit this: the sender picks up anything due within a minute.
 * Only blocked slots accumulate here (paused, guardrail, logged out, app was off).
 */
export function requeueOverdue(repos: Repos, now: Date, graceMs: number = OVERDUE_GRACE_MS): number {
  const cutoff = now.getTime() - graceMs;
  const isStale = (at: string | null) => at !== null && new Date(at).getTime() < cutoff;

  const stale = repos.profiles.byStatus('scheduled').filter((p) => isStale(p.scheduled_for));
  for (const p of stale) repos.profiles.setStatus(p.id, 'queued', { scheduled_for: null });

  const staleEng = repos.engagements.byStatus('scheduled').filter((e) => isStale(e.scheduled_for));
  for (const e of staleEng) repos.engagements.setStatus(e.id, 'queued', { scheduled_for: null });

  const total = stale.length + staleEng.length;
  if (total > 0) {
    log.info('scheduler', 'requeued overdue rows for re-scheduling',
      { profiles: stale.length, engagements: staleEng.length });
  }
  return total;
}

export function planAndAssignToday(repos: Repos, now: Date, rng: () => number = Math.random): void {
  // Self-heal first: stale past-due slots must not inflate committedToday() and zero out
  // the daily budget. Runs on every path (startup, hourly tick, resume, guardrail-ack).
  requeueOverdue(repos, now);
  const s = repos.settings.get();
  // While paused or halted the sender won't run — don't materialize slots that will
  // only go stale. /api/resume and a guardrail acknowledge re-plan immediately.
  if (s.paused || repos.appState.get().guardrail_tripped) return;
  if (s.weekdays_only && (now.getDay() === 0 || now.getDay() === 6)) return;

  // Never schedule outside today's working-hours window. Once the window has closed we
  // leave profiles queued; a later tick (next morning / next weekday) schedules them
  // in-window. This guarantees every send lands within working hours, even if the app
  // is started in the evening or on a weekend.
  const windowEnd = new Date(now);
  windowEnd.setHours(s.workday_end_hour, 0, 0, 0);
  if (now.getTime() >= windowEnd.getTime()) return;

  // Windows something else has claimed the browser for (currently only event-invite
  // runs). Read once and shared across kinds — it is the same day for both.
  const reserved = repos.reservations.between(now.toISOString(), windowEnd.toISOString());

  // Iterate the shared kind list, not a local literal: a kind added to CAMPAIGN_KINDS but
  // missed here would never be scheduled at all — silently, with nothing to notice.
  for (const kind of CAMPAIGN_KINDS) {
    planKind(repos, s, now, kind, windowEnd, rng, reserved);
  }

  // The fourth pipeline. Not in the loop above because engagements are deliberately not a
  // CampaignKind — but they share the same window, the same reservations and the same
  // planner.
  planEngagements(repos, s, now, windowEnd, rng, reserved);
}

/**
 * How long a batch of `batchSize` sends occupies the browser, worst case: the sender waits
 * a randomized min..max between consecutive sends. Deliberately pessimistic — the cost of
 * overestimating is a slightly smaller usable gap, the cost of underestimating is a batch
 * running into a reservation, which is the thing reservations exist to prevent.
 */
export function estimatedBatchRuntimeMs(s: Settings, batchSize: number): number {
  const perSend = Number(s.max_delay_ms);
  const gap = Number.isFinite(perSend) && perSend > 0 ? perSend : 0;
  return Math.max(1, batchSize) * gap;
}

/**
 * One queue's worth of planning: pick today's slots, route around reservations, clamp to
 * the weekly/daily/slot budget, and assign.
 *
 * Extracted from planKind so a third pipeline (engagements) reuses it rather than owning a
 * second near-copy of the slot maths. Takes no Repos: every database read is the adapter's
 * job, which also makes this directly unit-testable.
 *
 * ORDERING MATTERS. The three early returns happen BEFORE any rng value is drawn, so an
 * empty or capped-out queue costs zero draws and never shifts another queue's rng
 * sequence. planAndAssignToday shares one rng across every queue. Do not reorder them.
 */
export interface QueueSpec {
  /** Log label: 'invite' | 'message' | 'engagement'. */
  name: string;
  caps: KindCaps;
  /** Already spent in the rolling weekly window. */
  sentInWindow: number;
  /** Remaining for today. */
  dailyRemaining: number;
  /** Queued row ids in priority order, already clamped by any queue-specific rule. */
  queuedIds: number[];
  setScheduled(id: number, iso: string): void;
}

export function planQueue(
  s: Settings, now: Date, windowEnd: Date, rng: () => number,
  reserved: ReservationWindow[], spec: QueueSpec,
): void {
  const weeklyRemaining = remainingCapacity(spec.caps.weeklyCap, spec.sentInWindow);
  if (weeklyRemaining <= 0) return;

  // Pace by day, not just by week: the weekly cap is a backstop, but the intended daily
  // volume is batchesPerDay * batchSize. Without this, a single day could spend the
  // entire weekly allowance at once (and a late-day run would pile it onto one slot).
  const batchSize = Math.max(1, spec.caps.batchSize);
  if (spec.dailyRemaining <= 0) return;

  // Check the queue before drawing any rng values — see the ORDERING note above.
  if (spec.queuedIds.length === 0) return;

  const allTimes = planDailyBatches(now, {
    startHour: s.workday_start_hour, endHour: s.workday_end_hour, count: spec.caps.batchesPerDay,
  }, rng);
  // Route around held windows BEFORE the empty-times fallback, so the fallback cannot
  // reintroduce a collision the filter just removed.
  const runtimeMs = estimatedBatchRuntimeMs(s, batchSize);
  let times = filterReservedSlots(
    allTimes.filter((t) => t.getTime() > now.getTime()), reserved, runtimeMs);
  if (times.length === 0) {
    // Inside the window but every random slot fell before now (or every one collided with
    // a reservation): pick a random time in the remaining window [now, end) so the send
    // still lands within working hours. Retry a bounded number of times to dodge
    // reservations; if the window is so congested that we cannot find a free instant, leave
    // the queue alone rather than scheduling into a reservation — the next hourly tick
    // tries again.
    let at: Date | null = null;
    for (let i = 0; i < 12; i++) {
      const candidate = new Date(
        now.getTime() + Math.floor(rng() * Math.max(1, windowEnd.getTime() - now.getTime())));
      if (!conflictsWithReservation(candidate, reserved, runtimeMs)) { at = candidate; break; }
    }
    if (at === null) return;
    times = [at];
  }

  // Cap by (future slots * batch_size) so no single slot ever receives more than
  // batch_size — the assigner would otherwise clamp the overflow onto the last slot.
  const slotCapacity = times.length * batchSize;
  const budget = Math.min(weeklyRemaining, spec.dailyRemaining, slotCapacity);
  if (budget <= 0) return;

  const queued = spec.queuedIds.slice(0, budget);
  if (queued.length === 0) return;

  const assignments = assignSchedule(queued, times, batchSize);
  for (const a of assignments) spec.setScheduled(a.id, a.when.toISOString());

  log.debug('scheduler', 'assigned slots', {
    queue: spec.name, count: assignments.length, slots: times.length, budget,
  });
}

/**
 * Adapter: one CampaignKind's queue of profiles.
 *
 * Note this now reads the daily budget and the queue eagerly, where the old inline version
 * computed them lazily after the weekly check. That costs up to two extra indexed reads when
 * a cap is already exhausted and changes nothing observable — neither read touches rng.
 */
function planKind(
  repos: Repos, s: Settings, now: Date, kind: CampaignKind, windowEnd: Date,
  rng: () => number, reserved: ReservationWindow[] = [],
): void {
  planQueue(s, now, windowEnd, rng, reserved, {
    name: kind,
    caps: capsFor(s, kind),
    sentInWindow: repos.events.countSentSince(windowStartIso(now), kind),
    dailyRemaining: dailyRemainingFor(repos, s, now, kind),
    queuedIds: repos.profiles.queuedByPriorityKind(kind).map((p) => p.id),
    setScheduled: (id, iso) => repos.profiles.setScheduled(id, iso),
  });
}

/**
 * How many engagements today's quota has already committed: rows still scheduled plus rows
 * that already reacted today. Subtracting this from the daily target keeps repeated planning
 * runs (startup + hourly) from stacking past the daily cap.
 *
 * A row that reacted today AND is scheduled again would be counted twice. That is not
 * reachable today — nothing re-schedules a row after it reacts — and if a future retry path
 * introduces it, double-counting errs toward planning FEWER engagements, which is the safe
 * direction for a cap.
 */
export function engagementsCommittedToday(repos: Repos, now: Date): number {
  return repos.engagements.byStatus('scheduled').length
    + repos.engagements.countReactedSince(dayStartIso(now));
}

/**
 * Adapter: the engagement queue.
 *
 * The daily comment cap is applied HERE, not only in the sender. Without it, comment-bearing
 * tasks would be planned every day, deferred every day by the sender, and would consume slot
 * capacity that reaction-only tasks could have used. A task over the budget is held WHOLE —
 * never planned reaction-only — so it cannot straddle two days in a partial state.
 *
 * Every read below (the queue and two COUNTs) is rng-free, so an empty engagement queue still
 * costs zero draws — see the ORDERING note on planQueue.
 */
function planEngagements(
  repos: Repos, s: Settings, now: Date, windowEnd: Date,
  rng: () => number, reserved: ReservationWindow[] = [],
): void {
  const caps = engagementCaps(s);
  let commentsLeft = Math.max(0,
    s.engage_comment_daily_cap - repos.engagements.countCommentedSince(dayStartIso(now)));

  const queuedIds: number[] = [];
  for (const e of repos.engagements.queuedByPriority()) {
    if (e.comment_text !== null) {
      if (commentsLeft <= 0) continue;
      commentsLeft--;
    }
    queuedIds.push(e.id);
  }

  const dailyTarget = Math.max(0, caps.batchesPerDay * Math.max(1, caps.batchSize));
  planQueue(s, now, windowEnd, rng, reserved, {
    name: 'engagement',
    caps,
    sentInWindow: repos.engagements.countReactedSince(windowStartIso(now)),
    dailyRemaining: Math.max(0, dailyTarget - engagementsCommittedToday(repos, now)),
    queuedIds,
    setScheduled: (id, iso) => repos.engagements.setScheduled(id, iso),
  });
}

/**
 * Full rebuild: return EVERY scheduled profile to the queue (clearing its slot), then
 * re-flow the whole backlog into fresh policy-compliant batches. Called at startup so a
 * backlog of past-due (or otherwise stale) slots is re-sorted to policy — same batch size
 * and spacing — instead of firing as a burst or suppressing today's plan. `scheduled_for`
 * is always today-or-past (the planner never schedules beyond today's window), so requeuing
 * all scheduled rows is safe. Priority order is preserved: requeue leaves `priority` intact
 * and queuedByPriority() re-orders by (priority, id).
 */
export function resortSchedule(repos: Repos, now: Date, rng: () => number = Math.random): void {
  for (const p of repos.profiles.byStatus('scheduled')) {
    repos.profiles.setStatus(p.id, 'queued', { scheduled_for: null });
  }
  for (const e of repos.engagements.byStatus('scheduled')) {
    repos.engagements.setStatus(e.id, 'queued', { scheduled_for: null });
  }
  planAndAssignToday(repos, now, rng);
}

/**
 * Recover profiles stranded in 'sending' by a process killed mid-send. The sender marks a
 * profile 'sending' (attempts already incremented) before driving the browser; a crash between
 * that mark and the outcome leaves the row stuck — never re-queued, never re-planned, and
 * invisible to committedToday(). Return them to 'queued' (clearing the stale slot) so the
 * planner re-flows them into policy batches; attempts is left as-is (the attempt was consumed).
 *
 * STARTUP-ONLY: the browser is in-process, so a fresh process has nothing genuinely in flight —
 * every 'sending' row is definitively orphaned. Never call this mid-run, where a 'sending' row
 * is a live send.
 */
/**
 * Rescue rows abandoned in 'sending' by an abrupt exit — a crash, or an external kill the
 * process can't intercept (observed 2026-07-29: the app was terminated mid-send with no
 * stderr and no handler firing).
 *
 * The recovery has to guess, and it splits by kind because the two funnels punish the wrong
 * guess very differently. Nothing in the row says whether the send actually landed:
 * `full_name`, `thread_url` and the send_log entry are ALL written from the outcome that
 * never arrived, so "died before the click" and "died after the click" are indistinguishable.
 *
 *  - invite: requeue. A duplicate invite is harmless — LinkedIn dedupes it against the
 *    pending one — so silent automatic recovery is better than nagging the operator.
 *  - message: park as needs_attention. A DM is NOT idempotent for the recipient; requeuing
 *    can deliver the same message to a real person twice, which is exactly the failure the
 *    operator would want to have been asked about. They can check the conversation, then
 *    retry or dismiss from the attention view.
 */
export function recoverOrphanedSending(repos: Repos): number {
  const stuck = repos.profiles.byStatus('sending');
  let requeued = 0;
  let parked = 0;
  for (const p of stuck) {
    if (p.kind === 'message') {
      repos.profiles.setStatus(p.id, 'needs_attention', {
        scheduled_for: null,
        last_error: 'interrupted mid-send — it may have been sent; check the conversation before retrying',
      });
      parked++;
    } else {
      repos.profiles.setStatus(p.id, 'queued', { scheduled_for: null });
      requeued++;
    }
  }
  if (stuck.length > 0) {
    log.info('scheduler', 'recovered orphaned sending profiles', { requeued, needs_attention: parked });
  }
  return stuck.length;
}
