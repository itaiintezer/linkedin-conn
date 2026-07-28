import type { Repos } from '../db/repositories.js';
import type { BrowserDriver, Profile, Settings, CampaignKind } from '../types.js';
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
    const halted = await runInvitePass(repos, driver, invDue, clock);
    if (halted) return; // checkpoint / weekly-limit / streak trip — don't start the other pass
  }
  if (msgDue.length > 0) await runMessagePass(repos, driver, msgDue, clock);
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

/** One invite batch. Returns true if a halt-worthy verdict stopped the pass
 *  (checkpoint, weekly_limit, or a repeated-failures streak trip). */
async function runInvitePass(
  repos: Repos, driver: BrowserDriver, due: Profile[], clock: () => Date,
): Promise<boolean> {
  for (const p of due) {
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
        continue;
      }
    }

    switch (outcome.result) {
      case 'sent':
        repos.profiles.setStatus(p.id, 'sent', { sent_at: clock().toISOString() });
        repos.events.recordSend(p.id, 'sent');
        recordSuccess(repos); // reset the failure streak
        logVerdict(p, 'sent — invite pending');
        break;
      case 'already':
        repos.profiles.setStatus(p.id, 'skipped', { last_error: null, skip_reason: 'already_connected' });
        repos.events.recordEvent(p.id, 'skipped');
        logVerdict(p, 'skipped: already connected');
        break;
      case 'email_required':
        // LinkedIn gates this member behind "enter their email to connect" — a
        // per-profile verdict that can never succeed on retry. Terminal skip; does
        // NOT touch the failure streak.
        repos.profiles.setStatus(p.id, 'skipped', { last_error: null, skip_reason: 'email_required' });
        repos.events.recordEvent(p.id, 'skipped');
        logVerdict(p, 'skipped: LinkedIn requires their email to connect');
        break;
      case 'weekly_limit':
        // LinkedIn's account-level weekly invite cap: expected, resolves on its own
        // when the window resets. Amber pause (user-resumable, clear reason) instead
        // of the red guardrail — this is not a UI change or a block. The profile is
        // blameless: back to the queue for after the resume.
        repos.profiles.setStatus(p.id, 'queued', { last_error: null });
        repos.settings.update({ paused: 1, pause_reason: 'LinkedIn weekly invitation limit reached — resume next week' });
        logVerdict(p, 'weekly invitation limit reached — sending paused, profile requeued');
        return true;
      case 'not_found':
        // The profile URL 404s (deleted account / renamed slug) — a per-profile
        // verdict that can never succeed on retry. Terminal skip; does NOT touch
        // the failure streak (a batch of stale imports must not halt the engine).
        repos.profiles.setStatus(p.id, 'skipped', { last_error: null, skip_reason: 'not_found' });
        repos.events.recordEvent(p.id, 'skipped');
        logVerdict(p, 'skipped: profile no longer exists (LinkedIn 404)');
        break;
      case 'unavailable': {
        repos.profiles.setStatus(p.id, 'skipped', { last_error: null, skip_reason: 'unavailable' });
        repos.events.recordEvent(p.id, 'skipped');
        // Carry the evidence into the streak detail so a repeated_failures halt
        // links the screenshot of THIS failure, not some older incident.
        const shot = outcome.evidence?.screenshot;
        const detail = `send composer unavailable${shot ? ` — screenshot: /incidents/${shot}` : ''}`;
        logVerdict(p, `skipped: ${detail}`);
        if (recordFailure(repos, detail, clock())) return true;
        break;
      }
      case 'checkpoint': {
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
        return true;
      }
      case 'error':
      default: {
        const shot = outcome.evidence?.screenshot;
        repos.profiles.setStatus(p.id, 'failed', { last_error: outcome.error ?? 'unknown' });
        repos.events.recordEvent(p.id, 'failed');
        logVerdict(p, `failed: ${outcome.error ?? 'unknown'}${shot ? ` — screenshot: /incidents/${shot}` : ''}`);
        if (recordFailure(repos, outcome.error ?? 'unknown', clock())) return true;
        break;
      }
    }
  }
  return false;
}

/** One message batch. Returns true if a halt-worthy verdict stopped the pass. */
async function runMessagePass(
  repos: Repos, driver: BrowserDriver, due: Profile[], clock: () => Date,
): Promise<boolean> {
  for (const p of due) {
    const cohort = repos.cohorts.findById(p.cohort_id)!;
    // Messages REQUIRE text: the API validates this at enqueue, but the engine must
    // never fall through to an empty send if a row slips past (imports, manual edits).
    const text = selectNoteSource(p.custom_message, cohort.message_template);
    if (text === null) {
      repos.profiles.setStatus(p.id, 'needs_attention', { last_error: 'message cohort has no template or custom message' });
      logVerdict(p, 'needs attention: no message text');
      continue;
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
        break;
      case 'not_connected':
        // Not a 1st-degree connection — per-profile, terminal, never InMail, no streak.
        repos.profiles.setStatus(p.id, 'skipped', { last_error: null, skip_reason: 'not_connected' });
        repos.events.recordEvent(p.id, 'skipped');
        logVerdict(p, 'skipped: not a 1st-degree connection');
        break;
      case 'not_found':
        repos.profiles.setStatus(p.id, 'skipped', { last_error: null, skip_reason: 'not_found' });
        repos.events.recordEvent(p.id, 'skipped');
        logVerdict(p, 'skipped: profile no longer exists (LinkedIn 404)');
        break;
      case 'unavailable': {
        repos.profiles.setStatus(p.id, 'skipped', { last_error: null, skip_reason: 'unavailable' });
        repos.events.recordEvent(p.id, 'skipped');
        const shot = outcome.evidence?.screenshot;
        const detail = `message composer unavailable${shot ? ` — screenshot: /incidents/${shot}` : ''}`;
        logVerdict(p, `skipped: ${detail}`);
        if (recordFailure(repos, detail, clock())) return true;
        break;
      }
      case 'checkpoint': {
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
        return true;
      }
      case 'error':
      default: {
        const shot = outcome.evidence?.screenshot;
        repos.profiles.setStatus(p.id, 'failed', { last_error: outcome.error ?? 'unknown' });
        repos.events.recordEvent(p.id, 'failed');
        logVerdict(p, `failed: ${outcome.error ?? 'unknown'}${shot ? ` — screenshot: /incidents/${shot}` : ''}`);
        if (recordFailure(repos, outcome.error ?? 'unknown', clock())) return true;
        break;
      }
    }
  }
  return false;
}
