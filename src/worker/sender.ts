import type { Repos } from '../db/repositories.js';
import type { BrowserDriver, Profile, Settings } from '../types.js';
import { selectNoteSource } from '../core/message.js';
import { windowStartIso, remainingCapacity } from '../core/rate-limit.js';
import { pickDue } from '../core/schedule.js';
import { isTripped, tripCheckpoint, tripLoginLost, recordFailure, recordSuccess } from './guardrail.js';
import { log } from '../core/log.js';

export interface SenderOptions {
  /** Bypass the working-hours guard — used by the manual "Run batch now" trigger. */
  force?: boolean;
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

  // Capacity + due work are computed from the DB only — so idle ticks never open the browser.
  const sentInWindow = repos.events.countSentSince(windowStartIso(now));
  let remaining = remainingCapacity(settings.weekly_cap, sentInWindow);
  if (remaining <= 0) return;

  const scheduled = repos.profiles.byStatus('scheduled');
  const due = pickDue(scheduled, now, Math.min(remaining, settings.batch_size));
  if (due.length === 0) return; // nothing due -> stay dark

  // Cached-login gate (no browser): login only ever happens through our own browser, so
  // the cache is authoritative. Not logged in is transient — skip, the dashboard surfaces it.
  if (repos.appState.get().login_logged_in !== 1) return;

  // Committing to act: confirm live (this lazily opens the browser and keeps it open) and
  // refresh the cache. A live miss after a logged-in cache means the session was lost.
  const snap = await driver.readLoginState();
  repos.appState.setLogin(snap, now.toISOString());
  if (!snap.loggedIn) { tripLoginLost(repos, now); return; }

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
        repos.profiles.setStatus(p.id, 'sent', { sent_at: now.toISOString() });
        repos.events.recordSend(p.id, 'sent');
        recordSuccess(repos); // reset the failure streak
        logVerdict(p, 'sent — invite pending');
        remaining--;
        break;
      case 'already':
        repos.profiles.setStatus(p.id, 'already_connected', { last_error: null });
        repos.events.recordEvent(p.id, 'already_connected');
        logVerdict(p, 'already connected');
        break;
      case 'unavailable':
        repos.profiles.setStatus(p.id, 'skipped', { last_error: outcome.result });
        repos.events.recordEvent(p.id, 'skipped');
        logVerdict(p, 'skipped: send composer unavailable');
        if (recordFailure(repos, 'send composer unavailable', now)) return;
        break;
      case 'checkpoint':
        repos.profiles.setStatus(p.id, 'needs_attention', { last_error: 'checkpoint' });
        logVerdict(p, 'needs attention: checkpoint / captcha');
        tripCheckpoint(repos, now);
        return;
      case 'error':
      default:
        repos.profiles.setStatus(p.id, 'failed', { last_error: outcome.error ?? 'unknown' });
        repos.events.recordEvent(p.id, 'failed');
        logVerdict(p, `failed: ${outcome.error ?? 'unknown'}`);
        if (recordFailure(repos, outcome.error ?? 'unknown', now)) return;
        break;
    }
    if (remaining <= 0) break;
  }
}
