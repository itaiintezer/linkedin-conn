import type { Repos } from '../db/repositories.js';
import type {
  BrowserDriver, Profile, Settings, CampaignKind, SendOutcome,
  Engagement, EngagementOutcome, EngagementSkipReason,
} from '../types.js';
import { selectNoteSource } from '../core/message.js';
import { windowStartIso, remainingCapacity, dayStartIso } from '../core/rate-limit.js';
import { pickDue } from '../core/schedule.js';
import { capsFor, engagementCaps } from '../core/caps.js';
import { isTripped, tripCheckpoint, tripLoginLost, recordFailure, recordSuccess } from './guardrail.js';
import { log } from '../core/log.js';

export interface SenderOptions {
  /** Bypass the working-hours guard — used by the manual "Run batch now" trigger. */
  force?: boolean;
  /** Time source for per-profile timestamps (sent_at, guardrail trips). A batch can run
   *  for many minutes, so stamping everything with the batch-start `now` recorded the
   *  wrong halt time (the 2026-07-02 "Halted 3:56 PM" was really a 4:02 PM trip).
   *  Defaults to the batch `now` so deterministic tests are unaffected. */
  clock?: () => Date;
  /** Delay primitive used to pace consecutive sends (settings.min_delay_ms /
   *  max_delay_ms) — a real timer-based sleep by default. Tests inject a no-op so the
   *  suite never actually waits the 20-90s the production settings imply. */
  sleep?: (ms: number) => Promise<void>;
  /** Source of randomness for the inter-send delay. Defaults to Math.random; tests
   *  inject a stub for deterministic delay assertions. */
  rng?: () => number;
}

/** Real timer-based sleep — the production default for `SenderOptions.sleep`. */
const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The greeting name for a send. The roster is preferred because it is already sanitised and
 * available without a page read — but invitees are by definition NOT connections (measured:
 * 0 of 79 pending invites had a roster row), so `undefined` here means "let the driver read
 * it live", which is the normal path for invites.
 */
function rosterFirstName(repos: Repos, profileUrl: string): string | undefined {
  return repos.connections.findByUrl(profileUrl)?.first_name ?? undefined;
}

/** min + floor(rng() * (max - min + 1)), the repo's existing randomized-wait idiom
 *  (see core/schedule.ts, worker/scheduler-service.ts). `Number(...)` coerces a
 *  numeric-string setting (POST /api/settings does no coercion) instead of letting
 *  `NaN > 0` silently collapse the delay to 0. Clamped so a negative/NaN/non-numeric
 *  min degrades to 0, a misconfigured max < min degrades to min, and — since rng() can
 *  legitimately return exactly 1 — the result never overshoots max by 1ms either. */
function randomDelayMs(min: number, max: number, rng: () => number): number {
  const minN = Number(min);
  const maxN = Number(max);
  const lo = Number.isFinite(minN) && minN > 0 ? minN : 0;
  const hi = Number.isFinite(maxN) && maxN > lo ? maxN : lo;
  return Math.min(hi, lo + Math.floor(rng() * (hi - lo + 1)));
}

/** Local-time working-hours + sending-day test, mirroring the scheduler. */
function withinSendWindow(now: Date, s: Settings): boolean {
  if (s.weekdays_only && (now.getDay() === 0 || now.getDay() === 6)) return false;
  const h = now.getHours();
  return h >= s.workday_start_hour && h < s.workday_end_hour;
}

/** One human-readable line per profile so the run log answers "what happened to X?". */
function logVerdict(p: Profile, verdict: string): void {
  log.info('sender', 'verdict', { profile: p.id, url: p.profile_url, verdict });
}

/** Shared 'checkpoint' verdict: needs_attention + guardrail trip. Identical for invites
 *  and messages — a checkpoint halts the whole engine, not just one campaign kind. */
function handleCheckpoint(repos: Repos, p: Profile, outcome: SendOutcome, clock: () => Date): void {
  const ev = outcome.evidence;
  const detail = ev
    ? `Checkpoint/captcha page at ${ev.pageUrl}`
      + (ev.matched ? ` (matched "${ev.matched}")` : '')
      + (ev.screenshot ? ` — screenshot: /incidents/${ev.screenshot}` : '')
    : undefined;
  repos.profiles.setStatus(p.id, 'needs_attention', {
    last_error: ev?.matched ? `checkpoint (matched "${ev.matched}")` : 'checkpoint',
  });
  logVerdict(p, `needs attention: checkpoint / captcha${detail ? ` — ${detail}` : ''}`);
  tripCheckpoint(repos, clock(), detail);
}

/** Shared 'unavailable' verdict: terminal skip + failure-streak count. `label` is the
 *  full detail phrase ('send composer unavailable' for invites, 'message composer
 *  unavailable' for messages) so the streak detail stays specific to which pass hit it.
 *  Returns whether the streak tripped. */
function handleUnavailable(
  repos: Repos, p: Profile, outcome: SendOutcome, clock: () => Date, label: string,
): boolean {
  repos.profiles.setStatus(p.id, 'skipped', { last_error: null, skip_reason: 'unavailable' });
  repos.events.recordEvent(p.id, 'skipped');
  // Carry the evidence into the streak detail so a repeated_failures halt
  // links the screenshot of THIS failure, not some older incident.
  const shot = outcome.evidence?.screenshot;
  const detail = `${label}${shot ? ` — screenshot: /incidents/${shot}` : ''}`;
  logVerdict(p, `skipped: ${detail}`);
  return recordFailure(repos, detail, clock());
}

/** Shared 'error'/default verdict: failed + failure-streak count. Returns whether the
 *  streak tripped so the caller can halt the pass. */
function handleError(repos: Repos, p: Profile, outcome: SendOutcome, clock: () => Date): boolean {
  const shot = outcome.evidence?.screenshot;
  repos.profiles.setStatus(p.id, 'failed', { last_error: outcome.error ?? 'unknown' });
  repos.events.recordEvent(p.id, 'failed');
  logVerdict(p, `failed: ${outcome.error ?? 'unknown'}${shot ? ` — screenshot: /incidents/${shot}` : ''}`);
  return recordFailure(repos, outcome.error ?? 'unknown', clock());
}

// --- Post engagements ------------------------------------------------------------------

/** One human-readable line per engagement, mirroring logVerdict for profiles. */
function logEngagementVerdict(e: Engagement, verdict: string): void {
  log.info('sender', 'engagement verdict', { engagement: e.id, url: e.post_url, verdict });
}

/**
 * Terminal skip that does NOT COUNT TOWARD the failure streak — a per-post fact that can
 * never succeed on retry (post deleted, commenting disabled).
 *
 * `reactionLanded` says whether a reaction of ours is provably on the post by the time we
 * skip. When it is, the skip RESETS the streak: LinkedIn just accepted a real action from
 * us, which is exactly the evidence recordSuccess exists to consume, and a run that keeps
 * landing reactions must not accumulate its way to a repeated_failures halt.
 *
 * It is a parameter rather than an unconditional call because the distinction is the bug
 * this file already got wrong once (see the `contacted` gate at the end of
 * attemptEngagement): a skip on a path that never placed anything — a post that 404s before
 * we touch it — is no evidence the browser is healthy and must leave the streak alone.
 */
function skipEngagement(
  repos: Repos, e: Engagement, reason: EngagementSkipReason, detail: string,
  reactionLanded: boolean,
): AttemptResult {
  repos.engagements.setStatus(e.id, 'skipped', { last_error: null, skip_reason: reason });
  if (reactionLanded) recordSuccess(repos);
  logEngagementVerdict(e, `skipped: ${detail}`);
  return { halted: false, contacted: true };
}

/** Skip that DOES count toward the failure streak — the control was missing, which usually
 *  means a selector broke rather than anything being wrong with this post. */
function skipEngagementCounted(
  repos: Repos, e: Engagement, outcome: EngagementOutcome, clock: () => Date, label: string,
): boolean {
  repos.engagements.setStatus(e.id, 'skipped', { last_error: null, skip_reason: 'unavailable' });
  const shot = outcome.evidence?.screenshot;
  const detail = `${label}${shot ? ` — screenshot: /incidents/${shot}` : ''}`;
  logEngagementVerdict(e, `skipped: ${detail}`);
  return recordFailure(repos, detail, clock());
}

function failEngagement(
  repos: Repos, e: Engagement, outcome: EngagementOutcome, clock: () => Date,
): boolean {
  const shot = outcome.evidence?.screenshot;
  repos.engagements.setStatus(e.id, 'failed', { last_error: outcome.error ?? 'unknown' });
  logEngagementVerdict(e, `failed: ${outcome.error ?? 'unknown'}${shot ? ` — screenshot: /incidents/${shot}` : ''}`);
  return recordFailure(repos, outcome.error ?? 'unknown', clock());
}

/**
 * Fold this row onto the identity the live post reports, once the reaction is recorded.
 *
 * Returns a terminal AttemptResult when the row turns out to be redundant — another row
 * already holds the canonical URN, so continuing would engage the same post twice.
 * Returns null to carry on.
 */
function reconcileAfterReaction(
  repos: Repos, e: Engagement, outcome: EngagementOutcome,
): AttemptResult | null {
  if (!outcome.observedUrn) return null;
  if (repos.engagements.reconcileUrn(e.id, outcome.observedUrn) !== 'duplicate') return null;
  // Only ever called with a reaction just recorded, so the streak resets: the row is
  // redundant, but the reaction it placed is real and LinkedIn accepted it.
  return skipEngagement(repos, e, 'dismissed',
    'the same post is already engaged under its canonical URN', true);
}

/** A checkpoint halts the whole engine, not one pipeline — the LinkedIn account is the
 *  shared resource. Same shape as handleCheckpoint for profiles. */
function handleEngagementCheckpoint(
  repos: Repos, e: Engagement, outcome: EngagementOutcome, clock: () => Date,
): void {
  const ev = outcome.evidence;
  const detail = ev
    ? `Checkpoint/captcha page at ${ev.pageUrl}`
      + (ev.matched ? ` (matched "${ev.matched}")` : '')
      + (ev.screenshot ? ` — screenshot: /incidents/${ev.screenshot}` : '')
    : undefined;
  repos.engagements.setStatus(e.id, 'needs_attention', {
    last_error: ev?.matched ? `checkpoint (matched "${ev.matched}")` : 'checkpoint',
  });
  logEngagementVerdict(e, `needs attention: checkpoint / captcha${detail ? ` — ${detail}` : ''}`);
  tripCheckpoint(repos, clock(), detail);
}

export async function runSenderOnce(
  repos: Repos, driver: BrowserDriver, now: Date, opts: SenderOptions = {},
): Promise<void> {
  const settings = repos.settings.get();
  if (settings.paused) return;
  if (isTripped(repos)) return;
  // Backstop: overdue items (e.g. after a resume) must not fire off-hours. The
  // scheduler only creates in-window slots; this guards the send side of that promise.
  if (!opts.force && !withinSendWindow(now, settings)) return;

  const clock = opts.clock ?? (() => now);
  const sleep = opts.sleep ?? realSleep;
  const rng = opts.rng ?? Math.random;
  // One randomized-wait primitive shared by both passes and the inter-pass gap: every
  // consecutive pair of sends against LinkedIn in this tick — whether within a pass or
  // across the invite/message boundary — is paced the same way.
  const delay = () => sleep(randomDelayMs(settings.min_delay_ms, settings.max_delay_ms, rng));

  // Capacity + due work are computed from the DB only — so idle ticks never open the browser.
  const invDue = dueForKind(repos, now, 'invite');
  const msgDue = dueForKind(repos, now, 'message');
  const engDue = dueEngagements(repos, now);
  if (invDue.length === 0 && msgDue.length === 0 && engDue.length === 0) return; // stay dark

  // Cached-login gate (no browser): login only ever happens through our own browser, so
  // the cache is authoritative. Not logged in is transient — skip, the dashboard surfaces it.
  if (repos.appState.get().login_logged_in !== 1) return;

  // Committing to act: confirm live (this lazily opens the browser and keeps it open) and
  // refresh the cache. A live miss after a logged-in cache means the session was lost.
  const snap = await driver.readLoginState();
  repos.appState.setLogin(snap, now.toISOString());
  if (!snap.loggedIn) { tripLoginLost(repos, now); return; }

  if (invDue.length > 0) {
    const halted = await runInvitePass(repos, driver, invDue, clock, delay);
    // checkpoint / weekly-limit / streak trip — don't start the other pass. For weekly_limit
    // specifically this is a deliberate conservative choice: the account was just rate-limited
    // on invites, and paused=1 halts everything next tick anyway; messages resume with the
    // manual resume rather than being allowed to run standalone this tick.
    if (halted) return;
    // Both passes attempted something in this tick: the last invite send and the first
    // message send are still two consecutive actions against LinkedIn, so pace them too.
    if (msgDue.length > 0 || engDue.length > 0) await delay();
  }
  if (msgDue.length > 0) {
    // The message pass's halt verdict is load-bearing now that a third pass follows it: a
    // checkpoint or streak trip there must not let engagements keep driving the browser.
    const halted = await runMessagePass(repos, driver, msgDue, clock, delay);
    if (halted) return;
    if (engDue.length > 0) await delay();
  }
  if (engDue.length > 0) await runEngagementPass(repos, driver, engDue, clock, delay);
}

/** Due, capacity-clamped profiles for one kind (DB only, no browser). */
function dueForKind(repos: Repos, now: Date, kind: CampaignKind): Profile[] {
  const caps = capsFor(repos.settings.get(), kind);
  const sentInWindow = repos.events.countSentSince(windowStartIso(now), kind);
  const remaining = remainingCapacity(caps.weeklyCap, sentInWindow);
  if (remaining <= 0) return [];
  const scheduled = repos.profiles.byStatusKind('scheduled', kind);
  return pickDue(scheduled, now, Math.min(remaining, caps.batchSize));
}

/** Result of one profile attempt: whether it halted the pass, and whether it actually
 *  contacted LinkedIn (called the driver at least once). Pacing only makes sense after
 *  a real contact — a row that never reached the driver (e.g. no message text) leaves
 *  nothing to pace, so delaying after it would just hold the browser lock for nothing. */
interface AttemptResult { halted: boolean; contacted: boolean }

/** One invite batch. Returns true if a halt-worthy verdict stopped the pass
 *  (checkpoint, weekly_limit, or a repeated-failures streak trip).
 *  `delay` paces consecutive LinkedIn contacts — invoked between profiles only when the
 *  one just attempted actually contacted LinkedIn, never before the first or after the
 *  last (a trailing wait would just hold the browser lock for nothing), and never after
 *  a halting profile (nothing follows it in this pass anyway). */
async function runInvitePass(
  repos: Repos, driver: BrowserDriver, due: Profile[], clock: () => Date, delay: () => Promise<void>,
): Promise<boolean> {
  for (let i = 0; i < due.length; i++) {
    const { halted, contacted } = await attemptInvite(repos, driver, due[i], clock);
    if (halted) return true;
    if (contacted && i < due.length - 1) await delay();
  }
  return false;
}

/** One profile's invite attempt. Every branch calls driver.sendConnectionRequest at
 *  least once before returning (the note_quota retry included), so `contacted` is
 *  always true here — unlike messages, there is no early-return-before-contact path. */
async function attemptInvite(
  repos: Repos, driver: BrowserDriver, p: Profile, clock: () => Date,
): Promise<AttemptResult> {
  const cohort = repos.cohorts.findById(p.cohort_id)!;
  repos.profiles.setStatus(p.id, 'sending', { attempts: p.attempts + 1 });
  log.debug('sender', 'attempting', { profile: p.id, url: p.profile_url });

  // Pass the raw note template (with {firstName} intact); the driver substitutes the
  // real name it reads from the profile at send time.
  const note = selectNoteSource(p.custom_message, cohort.message_template);
  const firstName = rosterFirstName(repos, p.profile_url);
  let outcome = await driver.sendConnectionRequest(p.profile_url, note, { firstName });

  if (outcome.firstName) repos.profiles.setStatus(p.id, 'sending', { first_name: outcome.firstName });

  if (outcome.result === 'note_quota') {
    repos.settings.update({ note_quota_exhausted: 1 });
    if (cohort.allow_no_note) {
      outcome = await driver.sendConnectionRequest(p.profile_url, null, { firstName });
    } else {
      repos.profiles.setStatus(p.id, 'needs_attention', { last_error: 'note quota exhausted; no-note disabled' });
      logVerdict(p, 'needs attention: note quota exhausted, no-note disabled');
      return { halted: false, contacted: true };
    }
  }

  switch (outcome.result) {
    case 'sent':
      repos.profiles.setStatus(p.id, 'sent', { sent_at: clock().toISOString() });
      repos.events.recordSend(p.id, 'sent');
      recordSuccess(repos); // reset the failure streak
      logVerdict(p, 'sent — invite pending');
      return { halted: false, contacted: true };
    case 'already':
      repos.profiles.setStatus(p.id, 'skipped', { last_error: null, skip_reason: 'already_connected' });
      repos.events.recordEvent(p.id, 'skipped');
      logVerdict(p, 'skipped: already connected');
      return { halted: false, contacted: true };
    case 'email_required':
      // LinkedIn gates this member behind "enter their email to connect" — a
      // per-profile verdict that can never succeed on retry. Terminal skip; does
      // NOT touch the failure streak.
      repos.profiles.setStatus(p.id, 'skipped', { last_error: null, skip_reason: 'email_required' });
      repos.events.recordEvent(p.id, 'skipped');
      logVerdict(p, 'skipped: LinkedIn requires their email to connect');
      return { halted: false, contacted: true };
    case 'weekly_limit':
      // LinkedIn's account-level weekly invite cap: expected, resolves on its own
      // when the window resets. Amber pause (user-resumable, clear reason) instead
      // of the red guardrail — this is not a UI change or a block. The profile is
      // blameless: back to the queue for after the resume.
      repos.profiles.setStatus(p.id, 'queued', { last_error: null });
      repos.settings.update({ paused: 1, pause_reason: 'LinkedIn weekly invitation limit reached — resume next week' });
      logVerdict(p, 'weekly invitation limit reached — sending paused, profile requeued');
      return { halted: true, contacted: true };
    case 'not_found':
      // The profile URL 404s (deleted account / renamed slug) — a per-profile
      // verdict that can never succeed on retry. Terminal skip; does NOT touch
      // the failure streak (a batch of stale imports must not halt the engine).
      repos.profiles.setStatus(p.id, 'skipped', { last_error: null, skip_reason: 'not_found' });
      repos.events.recordEvent(p.id, 'skipped');
      logVerdict(p, 'skipped: profile no longer exists (LinkedIn 404)');
      return { halted: false, contacted: true };
    case 'unavailable':
      return { halted: handleUnavailable(repos, p, outcome, clock, 'send composer unavailable'), contacted: true };
    case 'checkpoint':
      handleCheckpoint(repos, p, outcome, clock);
      return { halted: true, contacted: true };
    case 'error':
    default:
      return { halted: handleError(repos, p, outcome, clock), contacted: true };
  }
}

/** One message batch. Returns true if a halt-worthy verdict stopped the pass.
 *  `delay` paces consecutive LinkedIn contacts — see runInvitePass for the same contract. */
async function runMessagePass(
  repos: Repos, driver: BrowserDriver, due: Profile[], clock: () => Date, delay: () => Promise<void>,
): Promise<boolean> {
  for (let i = 0; i < due.length; i++) {
    const { halted, contacted } = await attemptMessage(repos, driver, due[i], clock);
    if (halted) return true;
    if (contacted && i < due.length - 1) await delay();
  }
  return false;
}

/** One profile's message attempt. The no-text guard returns BEFORE calling
 *  driver.sendMessage — that row never contacted LinkedIn, so `contacted: false`. */
async function attemptMessage(
  repos: Repos, driver: BrowserDriver, p: Profile, clock: () => Date,
): Promise<AttemptResult> {
  const cohort = repos.cohorts.findById(p.cohort_id)!;
  // Messages REQUIRE text: the API validates this at enqueue, but the engine must
  // never fall through to an empty send if a row slips past (imports, manual edits).
  const text = selectNoteSource(p.custom_message, cohort.message_template);
  if (text === null) {
    // Count the attempt even though we never reach LinkedIn: this row consumed one of
    // today's message slots, so an Attention entry reading attempts: 0 would misreport a
    // campaign that is silently draining. `contacted: false` still suppresses the
    // inter-send delay — the pacing guarantee is about LinkedIn contacts, not attempts.
    repos.profiles.setStatus(p.id, 'needs_attention', {
      attempts: p.attempts + 1,
      last_error: 'message cohort has no template or custom message',
    });
    logVerdict(p, 'needs attention: no message text');
    return { halted: false, contacted: false };
  }
  repos.profiles.setStatus(p.id, 'sending', { attempts: p.attempts + 1 });
  log.debug('sender', 'attempting message', { profile: p.id, url: p.profile_url });

  const outcome = await driver.sendMessage(p.profile_url, text, {
    firstName: rosterFirstName(repos, p.profile_url),
  });
  if (outcome.firstName) repos.profiles.setStatus(p.id, 'sending', { first_name: outcome.firstName });

  switch (outcome.result) {
    case 'sent':
      repos.profiles.setStatus(p.id, 'sent', {
        sent_at: clock().toISOString(),
        full_name: outcome.fullName ?? null,
        thread_url: outcome.threadUrl ?? null,
      });
      repos.events.recordSend(p.id, 'sent');
      recordSuccess(repos);
      logVerdict(p, 'message sent');
      return { halted: false, contacted: true };
    case 'not_connected':
      // Not a 1st-degree connection — per-profile, terminal, never InMail, no streak.
      repos.profiles.setStatus(p.id, 'skipped', { last_error: null, skip_reason: 'not_connected' });
      repos.events.recordEvent(p.id, 'skipped');
      logVerdict(p, 'skipped: not a 1st-degree connection');
      return { halted: false, contacted: true };
    case 'not_found':
      repos.profiles.setStatus(p.id, 'skipped', { last_error: null, skip_reason: 'not_found' });
      repos.events.recordEvent(p.id, 'skipped');
      logVerdict(p, 'skipped: profile no longer exists (LinkedIn 404)');
      return { halted: false, contacted: true };
    case 'unavailable':
      return { halted: handleUnavailable(repos, p, outcome, clock, 'message composer unavailable'), contacted: true };
    case 'checkpoint':
      handleCheckpoint(repos, p, outcome, clock);
      return { halted: true, contacted: true };
    case 'error':
    default:
      return { halted: handleError(repos, p, outcome, clock), contacted: true };
  }
}

/**
 * Due, capacity-clamped engagements (DB only, no browser).
 *
 * The comment budget is re-checked here as a backstop for the planner's own limit. A
 * comment-bearing task over budget is dropped from the batch WHOLE — never run
 * reaction-only — so one task cannot straddle two days in a partial state.
 *
 * That filter runs AFTER pickDue has clamped to batchSize, so a batch can come out smaller
 * than batchSize while reaction-only tasks sit due behind the dropped ones. Deliberate: the
 * alternative is to refill from the tail, which reorders the queue out of scheduled_for
 * order and lets a later task jump an earlier one. Under-filling only slows the drain (the
 * held rows stay `scheduled` and lead the next tick); it can never over-send.
 */
function dueEngagements(repos: Repos, now: Date): Engagement[] {
  const s = repos.settings.get();
  const caps = engagementCaps(s);
  const reactedInWindow = repos.engagements.countReactedSince(windowStartIso(now));
  const remaining = remainingCapacity(caps.weeklyCap, reactedInWindow);
  if (remaining <= 0) return [];

  const scheduled = repos.engagements.byStatus('scheduled');
  const due = pickDue(scheduled, now, Math.min(remaining, caps.batchSize));

  let commentsLeft = Math.max(0,
    s.engage_comment_daily_cap - repos.engagements.countCommentedSince(dayStartIso(now)));
  return due.filter((e) => {
    if (e.comment_text === null) return true;
    if (commentsLeft <= 0) return false;
    commentsLeft--;
    return true;
  });
}

/** One engagement batch. Returns true if a halt-worthy verdict stopped the pass.
 *  `delay` paces consecutive LinkedIn contacts — see runInvitePass for the same contract. */
async function runEngagementPass(
  repos: Repos, driver: BrowserDriver, due: Engagement[], clock: () => Date, delay: () => Promise<void>,
): Promise<boolean> {
  for (let i = 0; i < due.length; i++) {
    const { halted, contacted } = await attemptEngagement(repos, driver, due[i], clock, delay);
    if (halted) return true;
    if (contacted && i < due.length - 1) await delay();
  }
  return false;
}

/**
 * One post's engagement: react, then comment if the task carries one.
 *
 * The reaction step is guarded on `reacted_at === null`, so a task retried after a failed
 * comment never re-drives the reaction. That guard, and the split reacted_at/commented_at
 * timestamps behind it, are the whole reason this pipeline does not use a single sent_at.
 *
 * `contacted` tracks whether this attempt actually drove the browser — a resumed task can
 * skip straight past the reaction, and a step we did not perform must neither be paced
 * (delay) nor counted as evidence the browser is healthy (recordSuccess).
 */
async function attemptEngagement(
  repos: Repos, driver: BrowserDriver, e: Engagement, clock: () => Date, delay: () => Promise<void>,
): Promise<AttemptResult> {
  repos.engagements.setStatus(e.id, 'sending', { attempts: e.attempts + 1 });
  log.debug('sender', 'attempting engagement', { engagement: e.id, url: e.post_url });
  let contacted = false;

  if (e.reacted_at === null) {
    contacted = true;
    const outcome = await driver.reactToPost(e.post_url, e.reaction);

    // ORDER MATTERS: stamp a landed reaction BEFORE touching identity. reconcileUrn throws
    // on a missing row, and running it between the click and the stamp would put that throw
    // on the one path where a real reaction is already live and unrecorded.
    switch (outcome.result) {
      case 'done':
        repos.engagements.setStatus(e.id, 'sending', { reacted_at: clock().toISOString() });
        break;
      case 'already':
        // A reaction of ours we never recorded — placed by hand, or orphaned by a crash.
        // We do NOT replace it with the requested one: overwriting a reaction the operator
        // placed themselves is a side effect nobody asked for.
        //
        // reacted_at is stamped with NOW even though the reaction predates this run: it is
        // both the retry guard and the weekly-cap unit, and neither works unset. The fact
        // that we found rather than placed it lives in the verdict line below.
        repos.engagements.setStatus(e.id, 'sending', { reacted_at: clock().toISOString() });
        logEngagementVerdict(e, `reaction already present (${outcome.existingReaction ?? 'unknown'}) — left as is`);
        break;
      case 'not_found':
        // Nothing of ours is on the post — there is no post. The one skip path that leaves
        // the failure streak exactly where it found it.
        return skipEngagement(repos, e, 'not_found', 'post no longer exists (LinkedIn 404)', false);
      case 'unavailable':
      case 'comments_disabled': // not reachable from a reaction; the union is shared
        return {
          halted: skipEngagementCounted(repos, e, outcome, clock, 'reaction control unavailable'),
          contacted: true,
        };
      case 'checkpoint':
        handleEngagementCheckpoint(repos, e, outcome, clock);
        return { halted: true, contacted: true };
      case 'unverified': // comment-only in practice; treated as retryable here
      case 'error':
      default:
        return { halted: failEngagement(repos, e, outcome, clock), contacted: true };
    }

    const retired = reconcileAfterReaction(repos, e, outcome);
    if (retired) return retired;
  }

  if (e.comment_text !== null && e.commented_at === null) {
    // The reaction and the comment are two consecutive LinkedIn contacts — but only when the
    // reaction happened in THIS attempt. A resumed comment is simply the next contact of the
    // tick, and the gap before it was already spent by runEngagementPass.
    if (contacted) await delay();
    contacted = true;
    const outcome = await driver.commentOnPost(e.post_url, e.comment_text);
    switch (outcome.result) {
      case 'done':
        repos.engagements.setStatus(e.id, 'sent', { commented_at: clock().toISOString() });
        recordSuccess(repos);
        logEngagementVerdict(e, `reacted (${e.reaction}) and commented`);
        return { halted: false, contacted: true };
      // Both of these are reached only past the reaction step, so the row's reaction is
      // provably on the post (placed in this attempt or stamped by an earlier one) and the
      // skip resets the streak.
      case 'comments_disabled':
        return skipEngagement(repos, e, 'comments_disabled',
          'commenting is disabled on this post (the reaction landed)', true);
      case 'not_found':
        return skipEngagement(repos, e, 'not_found', 'post no longer exists (LinkedIn 404)', true);
      case 'unverified':
        // NEVER auto-retry: the comment may already be published under the operator's name.
        //
        // commented_at IS stamped here, on a comment nothing confirmed. THE BUDGET MUST
        // COUNT SUBMITS, NOT CONFIRMATIONS: the submit click is irreversible and happens
        // strictly before the confirmation read, so an unverified comment is one that may
        // well be live — and engage_comment_daily_cap is metered purely by commented_at.
        // Leaving it NULL meant a driver that stops confirming (a renamed comment-row
        // class is enough) found the full budget intact on every batch of the day, and
        // `unverified` deliberately trips no failure streak, so nothing else would notice.
        // Erring the other way costs at most one under-counted slot; erring this way
        // removes the cap exactly when the DOM rots.
        //
        // The stamp also engages the comment guard below (`commented_at === null`), which
        // is why POST /api/engagements/:id/retry clears it: that endpoint means "I checked,
        // it did not post", and clearing the stamp is both the budget refund and what lets
        // the retry actually re-comment.
        repos.engagements.setStatus(e.id, 'needs_attention', {
          commented_at: clock().toISOString(),
          last_error: 'comment could not be verified — it may have posted; check the post before retrying',
        });
        logEngagementVerdict(e, 'needs attention: comment unverified');
        return { halted: false, contacted: true };
      case 'unavailable':
        return {
          halted: skipEngagementCounted(repos, e, outcome, clock, 'comment box unavailable'),
          contacted: true,
        };
      case 'checkpoint':
        handleEngagementCheckpoint(repos, e, outcome, clock);
        return { halted: true, contacted: true };
      case 'already':
      case 'error':
      default:
        return { halted: failEngagement(repos, e, outcome, clock), contacted: true };
    }
  }

  // Everything this task asked for is on the post: the reaction landed (now or on an earlier
  // tick) and either there is no comment or it is already published — both are genuinely
  // 'sent'. recordSuccess is gated on `contacted`: a row that completed without driving the
  // browser is no evidence LinkedIn is reachable, so it must not clear a failure streak.
  repos.engagements.setStatus(e.id, 'sent', {});
  if (contacted) recordSuccess(repos);
  logEngagementVerdict(e, contacted ? `reacted (${e.reaction})` : 'already complete — nothing left to do');
  return { halted: false, contacted };
}
