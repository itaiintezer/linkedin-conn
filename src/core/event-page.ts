/**
 * Pure helpers for reading a LinkedIn event page: URL normalization and the start time.
 *
 * The start time is scraped from prose because LinkedIn offers nothing better — the event
 * page carries no JSON-LD, no `<time>` element and no date meta tag (verified 2026-08-01).
 * It renders as "Thu, Sep 10, 2026, 6:15 PM - 10:30 PM (your local time)", already
 * converted to the viewer's timezone, so a local Date is the correct interpretation.
 */

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Canonical form: https://www.linkedin.com/events/<digits>/
 *
 * The path segment LinkedIn hands out varies: bare digits, `slug-<digits>`, or a slug fused
 * straight into the digits (`aisoclivewheredoes...int7493353085235343360`) — so the id is
 * "the digit run that ends the segment", not "digits after a dash". Slugs can contain their
 * own digit runs mid-word, which is why the end-of-segment lookahead does the anchoring.
 */
export function normalizeEventUrl(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const m = raw.trim().match(/linkedin\.com\/events\/[^/?#]*?(\d{6,})(?=[/?#]|$)/i);
  if (!m) return null;
  return `https://www.linkedin.com/events/${m[1]}/`;
}

/** The numeric event id, which is also the URN suffix. */
export function eventUrnFrom(raw: string): string | null {
  const normalized = normalizeEventUrl(raw);
  if (normalized === null) return null;
  return normalized.match(/events\/(\d+)\//)![1]!;
}

/**
 * Parse the event start out of the top-card date line.
 *
 * Requires an explicit year: relative forms ("Today, 11:00 PM") appear on the sidebar
 * "more events" cards, and silently accepting one would stamp a neighbouring event's
 * date onto this campaign — which then decides when the campaign stops. Returning null
 * is the safe answer; the caller leaves `starts_at` unknown rather than wrong.
 */
export function parseEventStart(text: string): Date | null {
  if (typeof text !== 'string') return null;
  const cleaned = text.replace(/\s+/g, ' ').trim();
  // "<Mon> <D>, <YYYY>" then, optionally after a comma, "<h>:<mm> <AM|PM>".
  const m = cleaned.match(
    /\b([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),\s*(\d{4})(?:,\s*(\d{1,2}):(\d{2})\s*([AaPp])\.?[Mm]\.?)?/,
  );
  if (!m) return null;
  const month = MONTHS[m[1]!.toLowerCase()];
  if (month === undefined) return null;

  const day = Number(m[2]);
  const year = Number(m[3]);
  if (day < 1 || day > 31) return null;

  let hour = 0;
  let minute = 0;
  if (m[4] !== undefined) {
    hour = Number(m[4]);
    minute = Number(m[5]);
    if (hour < 1 || hour > 12 || minute > 59) return null;
    const pm = m[6]!.toLowerCase() === 'p';
    if (pm && hour !== 12) hour += 12;
    if (!pm && hour === 12) hour = 0;
  }

  const d = new Date(year, month, day, hour, minute, 0, 0);
  // Reject a rolled-over date (Feb 31 becomes Mar 3).
  if (d.getMonth() !== month || d.getDate() !== day) return null;
  return d;
}

/** Has the event already begun? Unknown start time is NOT treated as started. */
export function hasStarted(startsAt: string | null, now: Date): boolean {
  if (startsAt === null) return false;
  const t = new Date(startsAt).getTime();
  if (!Number.isFinite(t)) return false;
  return t <= now.getTime();
}

/**
 * The member URN embedded in a picker row's checkbox id
 * (`i18n_checkbox-invitee-suggestion-ACoAA...`). This is THE join key: it equals
 * `connections.linkedin_id` exactly.
 *
 * Exported as a pattern string rather than wrapped in a helper because the matching
 * happens inside `page.evaluate`, in the page's own realm — the driver interpolates this
 * into its evaluate bodies. A helper here would be a lookalike that tests exercise and
 * production never calls, so a "fix" to it would change nothing that runs.
 */
export const MEMBER_URN_PATTERN = '(ACoAA[A-Za-z0-9_-]+)';
