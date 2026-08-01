/**
 * The campaign kinds the engine can send, and the one validator every boundary uses.
 *
 * `CAMPAIGN_KINDS` is the single source of truth: `CampaignKind` is DERIVED from it, so the
 * runtime list and the compile-time type can never drift. Adding a kind is one edit here.
 *
 * This module exists because the old inline `kindRaw === 'message' ? 'message' : 'invite'`
 * silently coerced anything unrecognized to 'invite' — and since 'invite' is a valid
 * CampaignKind, adding a kind to the union produced NO compile error at those sites. A
 * request meant to like a post would have sent a real connection request instead, which
 * cannot be unsent. Validate at the boundary; never default the unknown.
 */
export const CAMPAIGN_KINDS = ['invite', 'message'] as const;

export type CampaignKind = typeof CAMPAIGN_KINDS[number];

/** Runtime membership test. Deliberately case-sensitive: the DB stores lowercase kinds. */
export function isCampaignKind(v: unknown): v is CampaignKind {
  return typeof v === 'string' && (CAMPAIGN_KINDS as readonly string[]).includes(v);
}

export type ParsedKind =
  | { ok: true; kind: CampaignKind | undefined }
  | { ok: false; error: string };

/**
 * Parse a caller-supplied `kind`.
 *
 *   absent (undefined) -> { ok: true, kind: undefined }
 *   a valid kind       -> { ok: true, kind }
 *   anything else      -> { ok: false, error }
 *
 * ABSENT IS NOT A DEFAULT. It reports `undefined` and leaves the default to the call site,
 * because POST /api/cohorts needs "did the caller explicitly state a kind?" to tell a real
 * mismatch from an edit that merely omitted a frozen field. Defaulting in here would
 * collapse that distinction.
 *
 * `null` is invalid, not absent: the caller chose to send it. No existing caller does —
 * the web UI sends 'invite'/'message' or omits the key entirely.
 */
export function parseKind(raw: unknown): ParsedKind {
  if (raw === undefined) return { ok: true, kind: undefined };
  if (isCampaignKind(raw)) return { ok: true, kind: raw };
  return { ok: false, error: `unknown kind: ${String(raw)}` };
}
