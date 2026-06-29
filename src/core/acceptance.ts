export interface SentRow { id: number; profile_url: string; }

export function computeAcceptanceTransitions(
  sent: SentRow[],
  pendingUrls: Set<string>,
  connectionUrls: Set<string>,
): { accepted: number[]; expired: number[] } {
  const accepted: number[] = [];
  const expired: number[] = [];
  for (const row of sent) {
    if (pendingUrls.has(row.profile_url)) continue;
    if (connectionUrls.has(row.profile_url)) accepted.push(row.id);
    else expired.push(row.id);
  }
  return { accepted, expired };
}
