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
  // One per hour across a 12-hour workday (workday_start_hour..workday_end_hour) is the
  // most batches that can actually land without doubling up inside the same hour.
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

  // --- Posts feed ---
  // The only group here bounded by money rather than by what LinkedIn tolerates. The sweep
  // buys posts from Apify per result, and these four multiply together into the bill:
  // profiles × posts-per-profile × sweeps-per-day. Nothing downstream notices an expensive
  // setting — the sweep runs unattended — so the ceiling is the whole safeguard.
  //
  // `posts_max_per_sweep` is the one that has to be right. It reaches the actor as `maxPosts`,
  // where **0 means "all posts, ever"** — and 0 is exactly what an operator types to mean
  // "off". A single save would turn a ~$1.60/month sweep into an unbounded scrape of every
  // tracked profile's entire posting history, repeating daily until someone reads the invoice.
  // A `min` of 1 is what makes that untypable; `HttpApifyPostsClient` and the run's `maxItems`
  // ceiling are the two layers behind it.
  //
  // Sweeps / day is the one posts setting whose floor is 0: it only gates the tick, so
  // "never sweep automatically" is a legitimate — and free — choice.
  posts_sweep_per_day: { label: 'Sweeps / day (posts)', min: 0, max: 4 },
  // 200 profiles × 3 posts × 30 days ≈ $36/mo at the top of the window, so the default is 3.
  // The actor substitutes its own default of 10 for a missing value; a ceiling above that
  // stays honest about what the actor will do while still bounding a mistyped digit.
  posts_max_per_sweep: { label: 'Posts / profile / sweep', min: 1, max: 25 },
  // Costs disk, not money — engaged posts are kept regardless. A year is well past the point
  // where an un-engaged post is still worth reacting to.
  posts_retention_days: { label: 'Keep posts for (days)', min: 1, max: 365 },
  // The outer multiplier on every sweep. 1000 matches the event picker's row cap for
  // consistency; at that many profiles the Apify bill binds long before the code does.
  tracked_profile_cap: { label: 'Tracked profile cap', min: 1, max: 1000 },

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
  // A safety valve rather than a dial (see README): how many profiles ride in one Apify run.
  // The actor documents no maximum on `targetUrls`, so this ceiling matches
  // `tracked_profile_cap`'s — one run can always cover the largest legal roster.
  posts_sweep_batch_size: { label: 'Posts sweep batch size', min: 1, max: 1000 },
};

export interface SettingFailure { key: string; message: string; }

/**
 * The value a patch will leave in place for `key`: the patched one when present, otherwise
 * what is stored. Cross-field rules read this so a patch touching only one side of a pair is
 * still checked against the other.
 */
function effective(patch: Record<string, unknown>, current: Settings, key: keyof Settings): number {
  return key in patch ? (patch[key] as number) : (current[key] as number);
}

/**
 * Every rule violation in a patch. Empty means the patch is safe to apply.
 *
 * Ordering: per-field failures come first, in table order — they all come from one loop over
 * `Object.entries(SETTING_RULES)`. Cross-field failures are appended afterward, in the fixed
 * sequence they're written below, NOT interleaved at their table position. That ordering must
 * stay deterministic: `POST /api/settings` (`src/api/server.ts`) reports `failures[0].message`
 * as the headline `error`, so the same patch has to keep producing the same first sentence.
 *
 * Two deliberate restraints:
 *  - A cross-field rule runs ONLY when the patch touches one of its keys. An install can
 *    already hold an inverted workday window — nothing rejected one before this existed — and
 *    failing every unrelated patch on account of it would leave that operator unable to change
 *    anything at all, including pausing.
 *  - A cross-field rule is skipped when either of its keys already failed its own range.
 *    "must be after the start hour" stacked on "must be between 0 and 23" is noise.
 */
export function validateSettingsPatch(
  patch: Record<string, unknown>,
  current: Settings,
): SettingFailure[] {
  const failures: SettingFailure[] = [];

  for (const [key, rule] of Object.entries(SETTING_RULES)) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      failures.push({ key, message: `${rule.label} must be a whole number.` });
    } else if (value < rule.min || value > rule.max) {
      failures.push({ key, message: `${rule.label} must be between ${rule.min} and ${rule.max}.` });
    }
  }

  const failed = new Set(failures.map((f) => f.key));
  const checkable = (a: keyof Settings, b: keyof Settings) =>
    (a in patch || b in patch) && !failed.has(a) && !failed.has(b);

  if (checkable('workday_start_hour', 'workday_end_hour')) {
    const start = effective(patch, current, 'workday_start_hour');
    const end = effective(patch, current, 'workday_end_hour');
    // Equal is rejected alongside inverted: a zero-length window schedules nothing, silently.
    if (end <= start) {
      failures.push({
        key: 'workday_end_hour',
        message: `Workday end hour must be after the start hour (currently ${start}).`,
      });
    }
  }

  if (checkable('min_delay_ms', 'max_delay_ms')) {
    const lo = effective(patch, current, 'min_delay_ms');
    const hi = effective(patch, current, 'max_delay_ms');
    // Equal is fine here — a fixed delay is deterministic, not broken. Only inverted fails.
    if (hi < lo) {
      failures.push({
        key: 'max_delay_ms',
        message: `Maximum send delay must be at least the minimum (${lo} ms).`,
      });
    }
  }

  return failures;
}
