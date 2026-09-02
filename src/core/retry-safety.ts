/**
 * Which parked rows a bulk retry must NOT touch.
 *
 * `POST /api/retry` re-queues every failed / needs_attention profile for a FRESH send. For an
 * invite a duplicate is cheap — LinkedIn dedupes a second request to the same person. For a
 * message it is a second DM in front of a real prospect, and it has already happened: on
 * 2026-08-31 "Retry all profiles" re-sent to two people whose first message had landed but
 * was reported `message send not confirmed` (see core/message-confirm.ts for why).
 *
 * The contract is the `last_error` text, because that is the only place the sender records
 * WHY a row was parked. Every message-side verdict whose outcome is "it may already have
 * been delivered" ends with CHECK_THREAD_HINT so this predicate can find it; the legacy
 * `message send not confirmed (composer/thread state)` string is matched too, so rows parked
 * by the old check on a machine that updates later stay protected.
 *
 * Rows this excludes remain retryable one at a time via `POST /api/profiles/:id/retry` —
 * a deliberate per-person decision made after looking at the conversation.
 */

/** The suffix every "may already have been delivered" message verdict carries. */
export const CHECK_THREAD_HINT = 'check the conversation before retrying';

const AMBIGUOUS_MESSAGE_ERROR = new RegExp(
  [
    CHECK_THREAD_HINT,
    'may (?:already )?have been sent',
    'message send not confirmed',
    'message submitted but not confirmed',
  ].join('|'),
  'i',
);

/** True when a bulk retry of this row could put a second DM in front of a real person. */
export function mayHaveBeenDelivered(row: { kind: string; last_error: string | null }): boolean {
  return row.kind === 'message' && !!row.last_error && AMBIGUOUS_MESSAGE_ERROR.test(row.last_error);
}
