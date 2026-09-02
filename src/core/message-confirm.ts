/**
 * The post-send verdict for a direct message — PURE, and outside the page on purpose.
 *
 * Until 2026-09-02 this judgement lived inside `page.evaluate` in `sendMessage`, which is
 * exactly why a broken comparison survived six weeks of live runs: no test could reach it.
 * `confirmPostedComment` (post-selectors.ts) set the precedent — the reads stay in one
 * evaluate so the composer and the thread describe the same instant; only the judgement
 * lives here, where fixtures built from data/incidents captures can pin it down.
 *
 * WHY WHITESPACE IS REMOVED, NOT COLLAPSED. LinkedIn renders a template's line breaks inside
 * `msg-s-event-listitem__body` as `<br>`, and a `<br>` contributes NOTHING to textContent —
 * `Hi Dana,<br><br>I wanted…` reads back as `Hi Dana,I wanted…`. The old check collapsed
 * `\s+` to one space on BOTH sides, which is not the inverse of that: our needle became
 * `Hi Dana, I wanted…` (space), the page's `Hi Dana,I wanted…` (none), and the first 40
 * characters of every `Hi {firstName},\n\n…` template failed to match on a message that HAD
 * landed. Between 2026-08-25 and 2026-08-31 that was 16 false failures, 4 guardrail halts and
 * 2 duplicate DMs to real prospects (Dominic's and Jacob's machines, macOS / US). Other
 * renderings observed on the same surface — `<span class="white-space-pre"> </span>` where a
 * trailing space preceded the break (the variant that happened to keep working), a Hebrew UI
 * injecting bidi marks — all agree once every whitespace and invisible-format character is
 * dropped from both sides. The check must never depend on which rendering LinkedIn picks.
 */

/** Whitespace plus the zero-width / bidi format characters a right-to-left UI can inject
 *  (U+200B–U+200F, U+202A–U+202E, U+2060, U+2066–U+2069, U+FEFF). None of them carry message content. */
const INVISIBLE = /[\s\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]+/g;

/** Drop every whitespace and invisible-format character. Applied to BOTH sides of every
 *  comparison below, so how LinkedIn chose to render a line break can never matter. */
export function squeeze(text: string): string {
  return text.replace(INVISIBLE, '');
}

/**
 * The needle used to recognise our own message in the thread: the first `maxCodePoints`
 * squeezed characters. Truncated by CODE POINT, not UTF-16 unit — slicing an emoji in half
 * yields a lone surrogate, and a template that opens with one would otherwise never match.
 */
export function messageNeedle(text: string, maxCodePoints = 40): string {
  return [...squeeze(text)].slice(0, Math.max(0, maxCodePoints)).join('');
}

/** What one `page.evaluate` read off the compose surface, verbatim (NOT squeezed — that
 *  happens here, so the callback stays a dumb reader with no inner helper for esbuild's
 *  keep-names to rewrite into a `__name(…)` call the page cannot resolve). */
export interface MessageSurfaceRead {
  /** textContent of the composer we typed into (the LAST msg-form box on the page). */
  boxText: string;
  /** textContent of every thread history element (`SEL.msgEvent`), in DOM order. */
  events: readonly string[];
  /** LinkedIn's own "couldn't send" banner is on the page. */
  failedBanner: boolean;
}

export type MessageVerdict = 'sent' | 'unconfirmed' | 'error';

export interface MessageConfirmation {
  /** The composer no longer holds the text we typed. */
  cleared: boolean;
  /** MORE thread elements carry our needle than did before we clicked Send. */
  inThread: boolean;
  /** LinkedIn said the send failed. */
  failed: boolean;
  /** How many thread elements carried the needle before the click / at this read. */
  matchesBefore: number;
  matchesAfter: number;
  verdict: MessageVerdict;
}

/**
 * Judge whether the message we just submitted is in the thread.
 *
 * NOVELTY IS THE PROOF, as with comments. `inThread` requires the number of thread elements
 * carrying our needle to have GROWN since the snapshot taken before the click. Matching any
 * row on the page would "confirm" a copy from a previous attempt — which is precisely the
 * state a retried row is in, and the one where a false confirmation hides a duplicate send.
 * Counting rather than diffing texts is deliberate: a duplicate DM has identical text to the
 * original, so identity-by-text cannot tell old from new, and a count can.
 *
 * The verdicts, in order:
 *  - `error`       — LinkedIn's failed-to-send banner is up, OR the composer still holds our
 *                    text (the click did not take). Nothing left the account.
 *  - `sent`        — composer cleared AND a new copy of our text is in the thread.
 *  - `unconfirmed` — composer cleared (the send was accepted) but we could not read it back.
 *                    Submitted-but-unverified is NOT a failure: the sender records the send so
 *                    the weekly cap cannot under-count, resets the failure streak, and parks
 *                    the row for a human instead of inviting a duplicate via Retry. Even with
 *                    the whitespace bug in place, this verdict alone would have prevented every
 *                    halt and both duplicate DMs of 2026-08-25..31.
 *
 * An empty needle confirms nothing — it would match every element — and reads as
 * `unconfirmed` rather than `sent` (the composer may well have cleared).
 */
export function confirmSentMessage(
  read: MessageSurfaceRead,
  sentText: string,
  eventsBefore: readonly string[],
): MessageConfirmation {
  const needle = messageNeedle(sentText);
  const composerNeedle = messageNeedle(sentText, 30);
  const failed = read.failedBanner;
  const boxText = squeeze(read.boxText);
  const cleared = composerNeedle.length === 0 ? boxText.length === 0 : !boxText.includes(composerNeedle);
  const count = (texts: readonly string[]): number =>
    (needle.length === 0 ? 0 : texts.filter((t) => squeeze(t).includes(needle)).length);
  const matchesBefore = count(eventsBefore);
  const matchesAfter = count(read.events);
  const inThread = needle.length > 0 && matchesAfter > matchesBefore;
  const verdict: MessageVerdict = failed || !cleared ? 'error' : inThread ? 'sent' : 'unconfirmed';
  return { cleared, inThread, failed, matchesBefore, matchesAfter, verdict };
}

/** How long the sent message gets to appear in the thread after the click, polled. A timeout
 *  is `unconfirmed`, NEVER `error` — mirrors COMMENT_CONFIRM_TIMEOUT_MS. Send attempts were
 *  observed taking ~3× longer on 2026-08-31 than on 08-26, so the single fixed read that
 *  preceded this was already on borrowed time. */
export const MESSAGE_CONFIRM_TIMEOUT_MS = 12000;
/** Poll interval for the confirmation read. */
export const MESSAGE_CONFIRM_POLL_MS = 700;
