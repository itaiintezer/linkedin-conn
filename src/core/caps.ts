import type { Settings, CampaignKind } from '../types.js';

export interface KindCaps { weeklyCap: number; batchSize: number; batchesPerDay: number; }

/** The pacing numbers for a campaign kind. Working hours/weekday rules stay shared. */
export function capsFor(s: Settings, kind: CampaignKind): KindCaps {
  return kind === 'message'
    ? { weeklyCap: s.msg_weekly_cap, batchSize: s.msg_batch_size, batchesPerDay: s.msg_batches_per_day }
    : { weeklyCap: s.weekly_cap, batchSize: s.batch_size, batchesPerDay: s.batches_per_day };
}

/**
 * The pacing numbers for the engagement pipeline.
 *
 * A sibling of capsFor rather than a third branch inside it: capsFor is typed on
 * CampaignKind, and engagements are deliberately not a CampaignKind (a post is not a
 * person — see the engagements block in schema.sql). Returning the same KindCaps shape is
 * what lets both feed the one shared planner without forcing engagements into that union.
 *
 * Note these numbers are much larger than the invite ones: a reaction is a far cheaper
 * action than a connection request. `engage_comment_daily_cap` is deliberately NOT here —
 * it gates a sub-step of a task rather than the task itself, so it does not fit KindCaps
 * and the planner applies it separately.
 */
export function engagementCaps(s: Settings): KindCaps {
  return {
    weeklyCap: s.engage_weekly_cap,
    batchSize: s.engage_batch_size,
    batchesPerDay: s.engage_batches_per_day,
  };
}
