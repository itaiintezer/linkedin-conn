/**
 * Roster health alerts — the red "this needs your attention" strip on the dashboard.
 *
 * These are NOT halts: nothing here stops an engine, so there is no latch and no
 * acknowledge button. Both conditions are otherwise silent — the dashboard looks
 * perfectly healthy while connection search and event campaigns quietly run against a
 * roster that was never imported, or one whose profiles never filled in. Each alert is
 * recomputed from two indexed counts on every /api/status poll and clears on its own
 * the moment the condition does.
 *
 * Kept pure so the thresholds are testable without a DB or a server.
 */

export interface HealthAlert {
  /** Stable key. The dashboard maps it to an action button (Open Connections / Retry). */
  id: 'roster_missing' | 'enrich_failures';
  /** Bolded lead-in, a complete sentence. */
  title: string;
  /** Plain-language explanation with the numbers already in it. */
  detail: string;
}

/**
 * Below this many connections the roster is treated as unimported, not merely small.
 * A real LinkedIn network that uses this tool is well past 1,000; a roster under it
 * almost always means the connections CSV was never loaded.
 */
export const ROSTER_EXPECTED_MIN = 1000;

/**
 * "Many failed enrichments" needs both an absolute floor and a share of the roster:
 * a floor alone nags a 10,000-row roster over a handful of genuinely dead profiles,
 * and a share alone ignores hundreds of failures once the roster is large. It fires
 * at ENRICH_FAILED_MIN failures once they are ENRICH_FAILED_SHARE of the roster — or
 * at ENRICH_FAILED_ABSOLUTE outright, however big the roster is.
 */
export const ENRICH_FAILED_MIN = 25;
export const ENRICH_FAILED_SHARE = 0.05;
export const ENRICH_FAILED_ABSOLUTE = 250;

const fmt = (n: number): string => n.toLocaleString('en-US');

export function computeHealthAlerts(input: {
  connectionsTotal: number;
  enrichFailed: number;
}): HealthAlert[] {
  const { connectionsTotal: total, enrichFailed: failed } = input;
  const alerts: HealthAlert[] = [];

  if (total < ROSTER_EXPECTED_MIN) {
    alerts.push({
      id: 'roster_missing',
      title: 'Connections not imported.',
      detail: total === 0
        ? 'The roster is empty, so connection search and event invites have nothing to work with. Import your LinkedIn connections on the Connections tab.'
        : `Only ${fmt(total)} connections are in the roster — a full LinkedIn network is ${fmt(ROSTER_EXPECTED_MIN)}+. Import your LinkedIn connections export on the Connections tab.`,
    });
  }

  if (failed >= ENRICH_FAILED_ABSOLUTE
      || (failed >= ENRICH_FAILED_MIN && failed >= total * ENRICH_FAILED_SHARE)) {
    alerts.push({
      id: 'enrich_failures',
      title: 'Connection enrichment is failing.',
      detail: `${fmt(failed)} of ${fmt(total)} connections failed to enrich, so their profiles are missing from search. Retry them — and check the Apify key on the Connections tab if it keeps happening.`,
    });
  }

  return alerts;
}
