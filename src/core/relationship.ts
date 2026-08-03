/**
 * How the profile page describes our relationship to one person, and the three policies
 * that read it. Pure on purpose: the DOM reads live in the driver, the DECISIONS live here
 * where a truth table can pin them (same split as scripts/update.mjs' pure checks).
 *
 * Why this exists: the old code inferred "already connected" from the ABSENCE of both a
 * Pending badge and a Connect control. On a Sales Navigator account that inference is
 * wrong — the licence adds "Save in Sales Navigator" to the top card, and whichever of
 * Connect / Pending / Message loses the primary slot is demoted into the "More" overflow,
 * where nothing is visible until the menu is expanded. A live pending invite therefore
 * looked identical to an existing connection, and real invites were recorded as terminal
 * `already_connected` skips (2026-08-03).
 *
 * Every state now has its own POSITIVE signal — verified live on a Sales Navigator account
 * across all three cases (scripts/probe-pending.ts):
 *   pending     → [aria-label*="Pending"], label reads "…invitation sent to <Full Name>"
 *   connectable → a[href*="custom-invite"][href*="vanityName=<slug>"]
 *   connected   → "Remove connection" in the expanded overflow
 */

export type Relationship =
  /** An invite of ours is outstanding. */
  | 'pending'
  /** A Connect affordance for this person exists — they can be invited. */
  | 'connectable'
  /** Positively an existing 1st-degree connection ("Remove connection" present). */
  | 'connected'
  /** The page rendered but showed none of the three. NOT the same as 'connected'. */
  | 'unknown'
  /** The page did not render at all (no name readable) — infer nothing from it. */
  | 'unreadable';

/** What the driver actually saw, after expanding the "More" overflow if needed. */
export interface RelationshipSignals {
  /** False when the profile did not render — a blank page must never imply a verdict. */
  nameRead: boolean;
  /** A Pending badge belonging to THIS person (name-scoped where the label allows). */
  pendingForTarget: boolean;
  /** A Connect / custom-invite affordance for THIS person. */
  connectForTarget: boolean;
  /** A "Remove connection" control — only an existing connection has one. */
  removeConnection: boolean;
}

/**
 * Most specific signal wins. Pending outranks connectable because a withdrawn-but-cached
 * Connect anchor alongside a live Pending badge should read as pending, never as sendable —
 * re-inviting someone we already invited is the one outcome with no undo.
 */
export function classifyRelationship(s: RelationshipSignals): Relationship {
  if (!s.nameRead) return 'unreadable';
  if (s.pendingForTarget) return 'pending';
  if (s.connectForTarget) return 'connectable';
  if (s.removeConnection) return 'connected';
  return 'unknown';
}

/**
 * PRE-VISIT policy: do not attempt an invite.
 *
 * 'unknown' is included DELIBERATELY, to preserve the pre-2026-08-03 behaviour exactly. On a
 * classic (non-Sales-Navigator) top card, an existing connection shows no Pending badge and
 * no Connect control, and the old code called that "connected" and skipped. Whether such a
 * profile also exposes "Remove connection" is unverified on that layout, so treating
 * 'unknown' as a skip keeps every classic outcome bit-for-bit identical rather than betting
 * on a signal we have only observed under Sales Navigator.
 *
 * This is the ONLY policy that trusts absence. See confirmsInviteLanded for why the
 * post-submit branch must not.
 */
export function skipsInvite(r: Relationship): boolean {
  return r === 'pending' || r === 'connected' || r === 'unknown';
}

/**
 * POST-SUBMIT policy: did the invite we just submitted register?
 *
 * 'unknown' is REFUSED here, which is the actual bug fix. Reaching this point proves the
 * pre-visit classified them as invitable seconds earlier, so "no signals" cannot mean "they
 * were already connected" — it means we failed to read the page. The old code returned
 * 'already' here, recording a live pending invite as a terminal skip with no send_log row.
 *
 * 'connected' DOES confirm: they were invitable moments ago, so a connection existing now
 * means our invite landed and was accepted immediately — a send, not a skip.
 */
export function confirmsInviteLanded(r: Relationship): boolean {
  return r === 'pending' || r === 'connected';
}

/**
 * DIRECT-MESSAGE policy: may we message them? Fail-safe — never InMail a non-connection.
 *
 * 'pending' is the fix: under Sales Navigator a pending invite classified as connected, so
 * the gate inverted and Relay could DM someone who is not a connection. On a classic layout
 * a pending profile shows its badge on the top card and was already blocked, so this
 * tightening changes nothing there.
 *
 * 'unknown' stays permitted to preserve today's behaviour for the classic layout, where an
 * existing connection may present no positive signal at all. 'unreadable' is refused, as it
 * is today — a page that did not render is no evidence of a connection.
 */
export function mayReceiveDirectMessage(r: Relationship): boolean {
  return r === 'connected' || r === 'unknown';
}
