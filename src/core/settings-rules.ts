/**
 * Range rules for every numeric setting, and the validator both writers run.
 *
 * One table, two consumers. The server imports it directly; the browser receives it on
 * GET /api/settings and stamps min/max/step onto the form inputs. That is why index.html
 * carries no min/max of its own any more — a limit written in two places drifts, and the
 * copy in the HTML is the one nobody remembers to update.
 *
 * Most ceilings here are pacing decisions rather than arithmetic ones: they are bounded by
 * what LinkedIn tolerates, not by what the code can represent, so each carries its reasoning.
 * `label` is operator-facing and goes verbatim into the 400 body, which is what the
 * non-technical reader in RUNBOOK.md ends up seeing.
 *
 * Declaration order is significant: it fixes which failure a multi-failure patch reports as
 * its headline `error`, so the same patch always produces the same sentence.
 */
import type { Settings } from '../types.js';

export interface SettingRule {
  /** Operator-facing name. Appears verbatim in error text — not a column name. */
  label: string;
  min: number;
  max: number;
}

export const SETTING_RULES: Record<string, SettingRule> = {
  // --- Connection requests ---
  // LinkedIn's invite limit sits near 100/week. Past ~150 the outcome is a restriction on
  // the account, not a faster campaign.
  weekly_cap: { label: 'Weekly cap (invites)', min: 0, max: 150 },
  // Sends are spaced min_delay_ms..max_delay_ms apart (20-90s), so 25 in a batch is already
  // ~35 minutes of unbroken automation inside one browser session.
  batch_size: { label: 'Batch size (invites)', min: 1, max: 25 },
  batches_per_day: { label: 'Batches / day (invites)', min: 0, max: 12 },

  // --- Messages ---
  // A DM to a 1st-degree connection is cheaper than an invite; 100/day sustained is the top.
  msg_weekly_cap: { label: 'Weekly cap (messages)', min: 0, max: 700 },
  msg_batch_size: { label: 'Batch size (messages)', min: 1, max: 10 },
  msg_batches_per_day: { label: 'Batches / day (messages)', min: 0, max: 12 },
  reply_checks_per_day: { label: 'Reply checks / day', min: 1, max: 4 },

  // --- Event invites ---
  events_per_day: { label: 'Events / day', min: 0, max: 2 },
  // The LinkedIn invite picker hard-caps at 1000 rows (see schema.sql), so a larger cap
  // describes invitees that can never be reached.
  event_invite_cap: { label: 'Invites / event', min: 1, max: 1000 },
  event_bucket_ceiling: { label: 'Locations / run', min: 1, max: 50 },
  event_run_budget_minutes: { label: 'Run budget (minutes)', min: 1, max: 120 },

  // --- Post engagements ---
  // A reaction is the cheapest action the engine takes; ~140/day is the plausible top.
  engage_weekly_cap: { label: 'Weekly cap (reactions)', min: 0, max: 1000 },
  // No composer and no page dwell, so a bigger batch than an invite's is fine.
  engage_batch_size: { label: 'Batch size (reactions)', min: 1, max: 50 },
  engage_batches_per_day: { label: 'Batches / day (reactions)', min: 0, max: 12 },
  // Public and attributable, so deliberately an order of magnitude below reactions.
  engage_comment_daily_cap: { label: 'Comments / day', min: 0, max: 50 },

  // --- Both engines ---
  workday_start_hour: { label: 'Workday start hour', min: 0, max: 23 },
  workday_end_hour: { label: 'Workday end hour', min: 0, max: 23 },
  roster_sync_per_day: { label: 'Connection syncs / day', min: 1, max: 24 },

  // --- API-only. No form input; ruled because POST /api/settings accepts them and a
  //     negative send delay would remove the pacing that protects the account. ---
  min_delay_ms: { label: 'Minimum send delay (ms)', min: 5000, max: 600000 },
  max_delay_ms: { label: 'Maximum send delay (ms)', min: 5000, max: 600000 },
  enrich_ttl_days: { label: 'Enrichment TTL (days)', min: 1, max: 3650 },
  // No LinkedIn risk — bounded only by the operator's Apify plan.
  enrich_concurrency: { label: 'Enrichment concurrency', min: 1, max: 32 },
  // Above the picker's 1000-row cap the threshold could never trigger.
  event_shard_threshold: { label: 'Event shard threshold', min: 1, max: 1000 },
};
