/**
 * The reactions the engine can place on a post, and the one validator every boundary uses.
 *
 * `REACTIONS` is the single source of truth: `Reaction` is DERIVED from it, so the runtime
 * list and the compile-time type can never drift. Deliberately modelled on
 * `core/campaign-kind.ts` — same shape, same reason.
 *
 * ONE DIVERGENCE from parseKind, and it is intentional. There, absent is not a default,
 * because mis-defaulting a campaign kind sends an unsendable connection request. Here the
 * worst case is a `like` where the caller wanted an `insightful` — cosmetic and
 * retractable — so absent resolves to DEFAULT_REACTION at the call site.
 *
 * These are OUR names, and they are not LinkedIn's. LinkedIn's internal enum disagrees with
 * its own display names (celebrate is PRAISE, love is EMPATHY, and so on), so no caller may
 * derive the DOM value from a member of this list. That translation lives with the rest of
 * the DOM knowledge in `browser/post-selectors.ts`; keeping it out of here is what stops a
 * page-markup change from reaching a core vocabulary module.
 */
export const REACTIONS = ['like', 'celebrate', 'support', 'love', 'insightful', 'funny'] as const;

export type Reaction = typeof REACTIONS[number];

/** What an omitted reaction becomes. Applied by the caller, never inside parseReaction. */
export const DEFAULT_REACTION: Reaction = 'like';

/** Runtime membership test. Deliberately case-sensitive: the DB stores lowercase. */
export function isReaction(v: unknown): v is Reaction {
  return typeof v === 'string' && (REACTIONS as readonly string[]).includes(v);
}

export type ParsedReaction =
  | { ok: true; reaction: Reaction | undefined }
  | { ok: false; error: string };

/**
 * Parse a caller-supplied `reaction`.
 *
 *   absent (undefined) -> { ok: true, reaction: undefined }   (call site applies DEFAULT_REACTION)
 *   a valid reaction   -> { ok: true, reaction }
 *   anything else      -> { ok: false, error }
 *
 * `null` is invalid, not absent: the caller chose to send it. So is `''`, and so is an
 * untrimmed `' like '`. Because absent is granted a default here, widening "absent" to
 * cover a blank <select> would turn a caller's empty value into a silent `like` — exactly
 * the coercion this module exists to refuse. A UI that means "unspecified" omits the key.
 */
export function parseReaction(raw: unknown): ParsedReaction {
  if (raw === undefined) return { ok: true, reaction: undefined };
  if (isReaction(raw)) return { ok: true, reaction: raw };
  return { ok: false, error: `unknown reaction: ${String(raw)}` };
}
