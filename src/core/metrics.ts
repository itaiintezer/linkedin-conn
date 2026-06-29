export interface MetricRow {
  cohort_id: number;
  cohort_name: string;
  status: string;
  sent_at: string | null;
  accepted_at: string | null;
}

export interface CohortMetrics {
  cohort_id: number;
  cohort_name: string;
  total: number;
  sent: number;
  pending: number;
  accepted: number;
  expired: number;
  acceptance_rate: number;
  median_time_to_accept_days: number | null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function computeCohortMetrics(rows: MetricRow[]): CohortMetrics[] {
  const groups = new Map<number, MetricRow[]>();
  for (const r of rows) {
    if (!groups.has(r.cohort_id)) groups.set(r.cohort_id, []);
    groups.get(r.cohort_id)!.push(r);
  }
  const out: CohortMetrics[] = [];
  for (const [cohortId, grp] of groups) {
    const accepted = grp.filter((r) => r.status === 'accepted').length;
    const pending = grp.filter((r) => r.status === 'sent').length;
    const expired = grp.filter((r) => r.status === 'expired').length;
    const attempted = accepted + pending + expired;
    const ttaDays = grp
      .filter((r) => r.status === 'accepted' && r.sent_at && r.accepted_at)
      .map((r) => (new Date(r.accepted_at!).getTime() - new Date(r.sent_at!).getTime()) / 86400000);
    out.push({
      cohort_id: cohortId,
      cohort_name: grp[0].cohort_name,
      total: grp.length,
      sent: attempted,
      pending,
      accepted,
      expired,
      acceptance_rate: attempted > 0 ? accepted / attempted : 0,
      median_time_to_accept_days: median(ttaDays),
    });
  }
  return out;
}
