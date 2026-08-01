/**
 * Held-open windows the send planner must not schedule into.
 *
 * An event-invite run needs the single browser to itself for ~20 minutes. Without a
 * reservation the sender would collide with it: the sender takes the browser lock with
 * `tryRun`, so a colliding tick is DROPPED, its profiles miss their slot, and 10 minutes
 * later `requeueOverdue` re-plans them. Nothing breaks, but a batch silently slides. A
 * reservation makes the planner route around the window in the first place.
 *
 * Pure: no DB, no clock of its own.
 */

export interface ReservationWindow {
  /** ISO. */
  from_ts: string;
  /** ISO. */
  to_ts: string;
}

interface Span { from: number; to: number }

function toSpans(reservations: ReservationWindow[]): Span[] {
  return reservations
    .map((r) => ({ from: new Date(r.from_ts).getTime(), to: new Date(r.to_ts).getTime() }))
    .filter((s) => Number.isFinite(s.from) && Number.isFinite(s.to) && s.to > s.from)
    .sort((a, b) => a.from - b.from);
}

/**
 * Would a batch starting at `at` run into a reservation?
 *
 * `runtimeMs` is how long the batch is expected to occupy the browser. A slot three
 * minutes before a reservation still collides with it, so the check is against the whole
 * span the batch would cover, not the instant it starts.
 */
export function conflictsWithReservation(
  at: Date, reservations: ReservationWindow[], runtimeMs = 0,
): boolean {
  const start = at.getTime();
  const end = start + Math.max(0, runtimeMs);
  // Half-open at the end, closed at the start: a slot landing exactly ON `from` is
  // inside the reservation, one landing exactly on `to` is not. `end >= s.from` rather
  // than `>` so a zero-runtime slot at `from` still registers.
  return toSpans(reservations).some((s) => start < s.to && end >= s.from);
}

/** Drop the slot times that would collide with a reservation. */
export function filterReservedSlots(
  times: Date[], reservations: ReservationWindow[], runtimeMs = 0,
): Date[] {
  if (reservations.length === 0) return times;
  return times.filter((t) => !conflictsWithReservation(t, reservations, runtimeMs));
}

export interface FreeWindowOptions {
  /** Earliest the window may start. */
  windowStart: Date;
  /** Latest the window may end. */
  windowEnd: Date;
  /** How long the window must be. */
  durationMs: number;
  /** Busy instants to route around — today's already-scheduled sends. */
  busy: Date[];
  /** How long each busy instant occupies the browser. */
  busyRuntimeMs?: number;
  /** Existing reservations to route around as well. */
  reservations?: ReservationWindow[];
}

/**
 * Place a reservation in the LARGEST free gap, centred in it.
 *
 * Centring rather than earliest-fit is deliberate: it puts the maximum distance between
 * the event run and the sends on either side, so an overrun (a bucket in flight runs to
 * completion past the ceiling) still has slack before it disturbs anything.
 *
 * Returns null when no gap is long enough — the caller should try again on a later tick
 * or a later day rather than forcing a collision.
 */
export function findFreeWindow(opts: FreeWindowOptions): { from: Date; to: Date } | null {
  const { durationMs } = opts;
  const lo = opts.windowStart.getTime();
  const hi = opts.windowEnd.getTime();
  if (durationMs <= 0 || hi - lo < durationMs) return null;

  const busyRuntime = Math.max(0, opts.busyRuntimeMs ?? 0);
  const blocked: Span[] = [
    ...opts.busy
      .map((b) => ({ from: b.getTime(), to: b.getTime() + busyRuntime }))
      .filter((s) => s.to > lo && s.from < hi),
    ...toSpans(opts.reservations ?? []).filter((s) => s.to > lo && s.from < hi),
  ].sort((a, b) => a.from - b.from);

  // Merge overlaps so adjacent busy spans don't produce phantom gaps between them.
  const merged: Span[] = [];
  for (const s of blocked) {
    const last = merged[merged.length - 1];
    if (last && s.from <= last.to) last.to = Math.max(last.to, s.to);
    else merged.push({ ...s });
  }

  let best: { from: number; to: number; len: number } | null = null;
  let cursor = lo;
  for (const s of [...merged, { from: hi, to: hi }]) {
    const gapEnd = Math.min(s.from, hi);
    const len = gapEnd - cursor;
    if (len >= durationMs && (best === null || len > best.len)) {
      best = { from: cursor, to: gapEnd, len };
    }
    cursor = Math.max(cursor, s.to);
    if (cursor >= hi) break;
  }
  if (best === null) return null;

  const start = best.from + Math.floor((best.len - durationMs) / 2);
  return { from: new Date(start), to: new Date(start + durationMs) };
}
