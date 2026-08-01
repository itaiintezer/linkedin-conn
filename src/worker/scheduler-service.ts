import type { Repos } from '../db/repositories.js';
import type { CampaignKind, Settings } from '../types.js';
import { CAMPAIGN_KINDS } from '../core/campaign-kind.js';
import { planDailyBatches, assignSchedule } from '../core/schedule.js';
import { windowStartIso, remainingCapacity } from '../core/rate-limit.js';
import { dailyRemainingFor } from '../core/daily-budget.js';
import { capsFor } from '../core/caps.js';
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
  const stale = repos.profiles.byStatus('scheduled')
    .filter((p) => p.scheduled_for !== null && new Date(p.scheduled_for).getTime() < cutoff);
  for (const p of stale) repos.profiles.setStatus(p.id, 'queued', { scheduled_for: null });
  if (stale.length > 0) log.info('scheduler', 'requeued overdue profiles for re-scheduling', { count: stale.length });
  return stale.length;
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

function planKind(
  repos: Repos, s: Settings, now: Date, kind: CampaignKind, windowEnd: Date,
  rng: () => number, reserved: ReservationWindow[] = [],
): void {
  const caps = capsFor(s, kind);
  const sentInWindow = repos.events.countSentSince(windowStartIso(now), kind);
  const weeklyRemaining = remainingCapacity(caps.weeklyCap, sentInWindow);
  if (weeklyRemaining <= 0) return;

  // Pace by day, not just by week: the weekly cap is a backstop, but the intended daily
  // volume is batchesPerDay * batchSize. Without this, a single day could spend the
  // entire weekly allowance at once (and a late-day run would pile it onto one slot).
  const batchSize = Math.max(1, caps.batchSize);
  const dailyBudget = dailyRemainingFor(repos, s, now, kind);
  if (dailyBudget <= 0) return;

  // Check the queue before drawing any rng values: an empty per-kind queue should cost
  // zero rng draws, so one kind's emptiness never shifts the other kind's rng sequence.
  const queuedAll = repos.profiles.queuedByPriorityKind(kind);
  if (queuedAll.length === 0) return;

  const allTimes = planDailyBatches(now, {
    startHour: s.workday_start_hour, endHour: s.workday_end_hour, count: caps.batchesPerDay,
  }, rng);
  // Route around held windows BEFORE the empty-times fallback, so the fallback cannot
  // reintroduce a collision the filter just removed.
  const runtimeMs = estimatedBatchRuntimeMs(s, batchSize);
  let times = filterReservedSlots(
    allTimes.filter((t) => t.getTime() > now.getTime()), reserved, runtimeMs);
  if (times.length === 0) {
    // Inside the window but every random slot fell before now (or every one collided with
    // a reservation): pick a random time in the remaining window [now, end) so the send
    // still lands within working hours (not the old "now + 60s", which could fire after
    // hours). Retry a bounded number of times to dodge reservations; if the window is so
    // congested that we cannot find a free instant, leave the queue alone rather than
    // scheduling into a reservation — the next hourly tick tries again.
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
  const budget = Math.min(weeklyRemaining, dailyBudget, slotCapacity);
  if (budget <= 0) return;

  const queued = queuedAll.slice(0, budget);
  if (queued.length === 0) return;

  const assignments = assignSchedule(queued.map((p) => p.id), times, batchSize);
  for (const a of assignments) repos.profiles.setScheduled(a.id, a.when.toISOString());

  log.debug('scheduler', 'assigned slots', { kind, count: assignments.length, slots: times.length, budget });
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
