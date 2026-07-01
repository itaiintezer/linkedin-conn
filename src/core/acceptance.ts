export interface SentRow { id: number; profile_url: string; sent_at: string | null; }

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Acceptance reconciliation is ADDITIVE ONLY: a profile is promoted to "accepted"
 * solely because it now appears in the connections list. We deliberately do NOT
 * infer "expired" from absence — the sent-invitations list is huge and only its
 * newest page loads, so absence is not evidence an invite is gone. (LinkedIn invites
 * effectively never expire on our timescale anyway.) This is what prevents the
 * false-expire class of bugs where still-pending invites were mislabelled.
 */
export function computeAccepted(sent: SentRow[], connectionUrls: Set<string>): number[] {
  return sent.filter((r) => connectionUrls.has(r.profile_url)).map((r) => r.id);
}

/**
 * The ONLY path to "expired": a deterministic, scrape-free age backstop. A sent invite
 * older than `expiryDays` (measured from sent_at) that hasn't been accepted is expired.
 * `expiryDays <= 0` disables expiry entirely (the default). Because this reads no list,
 * it can never false-expire a fresh, still-valid invite.
 */
export function computeExpiredByAge(sent: SentRow[], now: Date, expiryDays: number): number[] {
  if (!Number.isFinite(expiryDays) || expiryDays <= 0) return [];
  const cutoff = now.getTime() - expiryDays * DAY_MS;
  return sent
    .filter((r) => r.sent_at != null && new Date(r.sent_at).getTime() < cutoff)
    .map((r) => r.id);
}
