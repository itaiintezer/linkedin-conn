/**
 * The manual "Run batch now" trigger — one belt at a time.
 *
 * A click is always two separable steps: PROMOTE (a durable DB write that makes one belt's
 * backlog due now) and KICK (a best-effort attempt to grab the browser and send). Splitting
 * them is what lets the endpoint report honestly when the browser is busy: the promotion
 * definitely happened and the next 60s tick will drain it, even though this request sent
 * nothing.
 *
 * Nothing here touches HTTP or the browser, so the whole policy is testable against an
 * in-memory database.
 */
import type { Repos } from '../db/repositories.js';
import { capsFor, engagementCaps } from '../core/caps.js';
import { windowStartIso, remainingCapacity } from '../core/rate-limit.js';
import { nextEventRun } from './event-campaign.js';

/**
 * The four conveyors on the dashboard, each with its own manual trigger.
 *
 * `BELTS` is the single source of truth: `Belt` is DERIVED from it, so the runtime list and
 * the compile-time type can never drift. Mirrors src/core/campaign-kind.ts, and for the same
 * reason — without this direction, adding a fifth belt to a hand-written `Belt` union would
 * compile cleanly while `parseBelt` silently rejected it forever, with no compiler error to
 * catch the omission.
 */
export const BELTS = ['invite', 'message', 'engagement', 'event'] as const;
export type Belt = typeof BELTS[number];
/** `all` is the no-belt alias: every SENDER belt, which deliberately excludes events. */
export type BeltArg = Belt | 'all';

/**
 * The belts `runSenderOnce` drains. Events are excluded because they are not scheduled
 * rows at all — they are a reserved browser window, moved by `moveEventWindow`.
 */
export const SENDER_BELTS: readonly Exclude<Belt, 'event'>[] = ['invite', 'message', 'engagement'];

const BELT_ARGS: readonly BeltArg[] = [...BELTS, 'all'];

/** An unrecognised belt is null (a 400), not a silent fallback to 'all' — a typo'd belt
 *  must never quietly promote every pipeline. */
export function parseBelt(raw: unknown): BeltArg | null {
  if (raw === undefined || raw === null) return 'all';
  return BELT_ARGS.includes(raw as BeltArg) ? (raw as BeltArg) : null;
}

/**
 * Sends left this week on one sender belt, using the same computation the sender itself
 * uses — so the button can never promise a send `runSenderOnce` would then refuse.
 */
export function weeklyRemaining(
  repos: Repos, belt: Exclude<Belt, 'event'>, now: Date,
): number {
  const s = repos.settings.get();
  if (belt === 'engagement') {
    return remainingCapacity(
      engagementCaps(s).weeklyCap,
      repos.engagements.countReactedSince(windowStartIso(now)),
    );
  }
  // TypeScript already narrows `belt` to 'invite' | 'message' here, which IS CampaignKind —
  // no cast needed, so a future Belt member that isn't a CampaignKind fails the build here
  // rather than being silently swallowed by an `as`.
  return remainingCapacity(
    capsFor(s, belt).weeklyCap,
    repos.events.countSentSince(windowStartIso(now), belt),
  );
}

/** A refused click: a machine-readable `code` for the UI to map to a short button label,
 *  and the sentence a human reads. `error` (not `message`) because the dashboard's api()
 *  helper reads `error` off a non-ok body, as does every other endpoint in this server. */
export interface Refusal { code: string; error: string }

/** Plural nouns for the capped message, per belt. */
const CAP_NOUN: Record<Exclude<Belt, 'event'>, string> = {
  invite: 'invites', message: 'messages', engagement: 'reactions',
};

/** `title ?? "campaign #<id>"` — matches the lowercase fallback src/web/app.js already
 *  renders for this same concept, so the two operator-facing strings agree. */
function titleOf(event: { id: number; title: string | null }): string {
  return event.title ?? `campaign #${event.id}`;
}

/**
 * The event belt's own gates.
 *
 * `nextEventRun` is reused rather than re-deriving the target, so this button can never
 * promise a different campaign than the planner would pick.
 *
 * Order is deliberate: a campaign that is running right now has ALREADY incremented
 * countRunsOnDate, so checking the daily cap first would report "already ran today" about
 * the run currently in progress.
 */
function eventPreflight(repos: Repos, now: Date): Refusal | null {
  // Running-detection needs a reservation-independent signal. nextEventRun only surfaces a
  // running campaign while its window is unexpired (to_ts > now), and a run is EXPECTED to
  // overrun by up to one bucket (see event-runner.ts). Asking nextEventRun alone would
  // answer "nothing armed" about a campaign that is inviting people right now.
  const running = repos.eventCampaigns.byStatus('running')[0];
  if (running) {
    return { code: 'already_running', error: `${titleOf(running)} is already running` };
  }

  const next = nextEventRun(repos, now);
  if (!next) return { code: 'nothing_armed', error: 'No armed event campaign to run' };
  if (next.event.status !== 'armed') {
    return { code: 'nothing_armed', error: `${titleOf(next.event)} is ${next.event.status}, not armed` };
  }

  const s = repos.settings.get();
  const perDay = Math.max(1, s.events_per_day);
  const runsToday = repos.eventCampaigns.countRunsOnDate(now.toISOString());
  if (runsToday >= perDay) {
    return {
      code: 'daily_cap',
      error: `Already ran an event campaign today (${runsToday}/${perDay})`,
    };
  }
  return null;
}

/**
 * Why this click cannot run, or null to proceed.
 *
 * Called BEFORE any promotion, always. The three shared gates apply to every belt including
 * the `all` alias; the weekly cap is per-belt, so `all` skips it (a capped belt simply
 * promotes nothing when `promote` runs).
 */
export function preflight(repos: Repos, belt: BeltArg, now: Date): Refusal | null {
  const s = repos.settings.get();
  const a = repos.appState.get();
  if (s.paused === 1) {
    return { code: 'paused', error: s.pause_reason ? `Paused — ${s.pause_reason}` : 'Paused' };
  }
  if (a.guardrail_tripped === 1) {
    // `guardrail_detail` is the operator-facing sentence; `guardrail_reason` is the enum
    // ('checkpoint' | 'login_lost' | 'repeated_failures'). Showing the enum here would put
    // a machine token in the slot this type promises is human-readable.
    return {
      code: 'guardrail',
      error: a.guardrail_detail ?? (a.guardrail_reason
        ? `Halted — ${a.guardrail_reason}`
        : 'Halted by the guardrail'),
    };
  }
  if (a.login_logged_in !== 1) {
    return { code: 'not_logged_in', error: 'Not logged in to LinkedIn' };
  }
  if (belt === 'all') return null;
  if (belt === 'event') return eventPreflight(repos, now);

  if (weeklyRemaining(repos, belt, now) <= 0) {
    const cap = belt === 'engagement'
      ? engagementCaps(s).weeklyCap
      : capsFor(s, belt).weeklyCap;
    return {
      code: 'capped',
      error: `Weekly cap reached — ${cap}/${cap} ${CAP_NOUN[belt]} this week`,
    };
  }
  return null;
}

/**
 * Make one belt's next batch due now, and report how many rows are due as a result.
 *
 * Pulls from already-scheduled (future) rows first and then backfills from queued, so a
 * manual run always has something to send when work exists at all — the same pool the old
 * global endpoint drew from.
 *
 * Already-scheduled rows come FIRST, not last: the returned count is "rows due now", NOT
 * "rows newly moved" — a second click at the same instant must re-stamp the very same rows
 * (a genuine no-op) rather than reaching past them into fresh queued backlog. With a queued
 * backlog bigger than one batch, queued-first would make a second click pick a DIFFERENT
 * slice of queued rows every time (the first slice having just left 'queued' status), which
 * breaks that idempotency. Scheduled-first is stable: once a batch is promoted, it fills the
 * pool by itself on every subsequent call at the same `now`, so nothing new gets pulled in
 * until those rows actually send and leave 'scheduled'.
 *
 * The weekly cap is re-checked here as well as in preflight, because the `all` alias skips
 * the per-belt cap gate — a capped belt must promote nothing rather than stack up rows the
 * sender will then refuse.
 *
 * `batchSize` is clamped before it ever reaches `.slice()`. POST /api/settings does no
 * validation or coercion (see src/api/server.ts) and there is no CHECK constraint on
 * batch_size/msg_batch_size/engage_batch_size in schema.sql, so a hand-edited or
 * fat-fingered negative setting reaches here unfiltered — and `[].slice(0, -1)` means
 * "all but the last element", not "nothing". The floor here is 0, NOT 1: unlike the
 * `Math.max(1, ...)` clamps in scheduler-service.ts (which must keep the planner making
 * forward progress), `promote()` treats `batch_size: 0` as a legitimate "promote nothing on
 * this click" — silently promoting one row against an explicit zero would be wrong. Do not
 * "fix" this floor to match the scheduler's.
 */
export function promote(repos: Repos, belt: Exclude<Belt, 'event'>, now: Date): number {
  if (weeklyRemaining(repos, belt, now) <= 0) return 0;
  // A second in the past, so the sender's `scheduled_for <= now` test is satisfied even
  // when the two timestamps would otherwise be identical to the millisecond.
  const dueIso = new Date(now.getTime() - 1000).toISOString();
  const s = repos.settings.get();

  if (belt === 'engagement') {
    const batchSize = Math.max(0, Math.floor(Number(engagementCaps(s).batchSize) || 0));
    const rows = [
      ...repos.engagements.byStatus('scheduled'),
      ...repos.engagements.queuedByPriority(),
    ].slice(0, batchSize);
    for (const e of rows) repos.engagements.setScheduled(e.id, dueIso);
    return rows.length;
  }

  const batchSize = Math.max(0, Math.floor(Number(capsFor(s, belt).batchSize) || 0));
  const rows = [
    ...repos.profiles.byStatusKind('scheduled', belt),
    ...repos.profiles.queuedByPriorityKind(belt),
  ].slice(0, batchSize);
  for (const p of rows) repos.profiles.setScheduled(p.id, dueIso);
  return rows.length;
}
