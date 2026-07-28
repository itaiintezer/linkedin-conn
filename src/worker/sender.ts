import type { Repos } from '../db/repositories.js';
import type { BrowserDriver, Profile, Settings, CampaignKind, SendOutcome } from '../types.js';
import { selectNoteSource } from '../core/message.js';
import { windowStartIso, remainingCapacity } from '../core/rate-limit.js';
import { pickDue } from '../core/schedule.js';
import { capsFor } from '../core/caps.js';
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
  if (invDue.length === 0 && msgDue.length === 0) return; // nothing due -> stay dark

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
    if (msgDue.length > 0) await delay();
  }
  if (msgDue.length > 0) await runMessagePass(repos, driver, msgDue, clock, delay);
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
  let outcome = await driver.sendConnectionRequest(p.profile_url, note);

  if (outcome.firstName) repos.profiles.setStatus(p.id, 'sending', { first_name: outcome.firstName });

  if (outcome.result === 'note_quota') {
    repos.settings.update({ note_quota_exhausted: 1 });
    if (cohort.allow_no_note) {
      outcome = await driver.sendConnectionRequest(p.profile_url, null);
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
    repos.profiles.setStatus(p.id, 'needs_attention', { last_error: 'message cohort has no template or custom message' });
    logVerdict(p, 'needs attention: no message text');
    return { halted: false, contacted: false };
  }
  repos.profiles.setStatus(p.id, 'sending', { attempts: p.attempts + 1 });
  log.debug('sender', 'attempting message', { profile: p.id, url: p.profile_url });

  const outcome = await driver.sendMessage(p.profile_url, text);
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
