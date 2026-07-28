import type { Settings, CampaignKind } from '../types.js';

export interface KindCaps { weeklyCap: number; batchSize: number; batchesPerDay: number; }

/** The pacing numbers for a campaign kind. Working hours/weekday rules stay shared. */
export function capsFor(s: Settings, kind: CampaignKind): KindCaps {
  return kind === 'message'
    ? { weeklyCap: s.msg_weekly_cap, batchSize: s.msg_batch_size, batchesPerDay: s.msg_batches_per_day }
    : { weeklyCap: s.weekly_cap, batchSize: s.batch_size, batchesPerDay: s.batches_per_day };
}
