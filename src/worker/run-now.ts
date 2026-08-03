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
import type { CampaignKind } from '../types.js';
import { capsFor, engagementCaps } from '../core/caps.js';
import { windowStartIso, remainingCapacity } from '../core/rate-limit.js';

/** The four conveyors on the dashboard, each with its own manual trigger. */
export type Belt = 'invite' | 'message' | 'engagement' | 'event';
/** `all` is the no-belt alias: every SENDER belt, which deliberately excludes events. */
export type BeltArg = Belt | 'all';

/**
 * The belts `runSenderOnce` drains. Events are excluded because they are not scheduled
 * rows at all — they are a reserved browser window, moved by `moveEventWindow`.
 */
export const SENDER_BELTS: readonly Exclude<Belt, 'event'>[] = ['invite', 'message', 'engagement'];

const BELT_ARGS: readonly BeltArg[] = ['invite', 'message', 'engagement', 'event', 'all'];

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
  const kind = belt as CampaignKind;
  return remainingCapacity(
    capsFor(s, kind).weeklyCap,
    repos.events.countSentSince(windowStartIso(now), kind),
  );
}
