import type { Repos } from '../db/repositories.js';
import type { BrowserDriver } from '../types.js';
import { selectNoteSource } from '../core/message.js';
import { windowStartIso, remainingCapacity } from '../core/rate-limit.js';
import { pickDue } from '../core/schedule.js';
import { isTripped, tripCheckpoint, tripLoginLost, recordFailure, recordSuccess } from './guardrail.js';

export async function runSenderOnce(repos: Repos, driver: BrowserDriver, now: Date): Promise<void> {
  const settings = repos.settings.get();
  if (settings.paused) return;
  if (isTripped(repos)) return;

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
        continue;
      }
    }

    switch (outcome.result) {
      case 'sent':
        repos.profiles.setStatus(p.id, 'sent', { sent_at: now.toISOString() });
        repos.events.recordSend(p.id, 'sent');
        recordSuccess(repos); // reset the failure streak
        remaining--;
        break;
      case 'already':
        repos.profiles.setStatus(p.id, 'already_connected', { last_error: null });
        repos.events.recordEvent(p.id, 'already_connected');
        break;
      case 'unavailable':
        repos.profiles.setStatus(p.id, 'skipped', { last_error: outcome.result });
        repos.events.recordEvent(p.id, 'skipped');
        if (recordFailure(repos, 'send composer unavailable', now)) return;
        break;
      case 'checkpoint':
        repos.profiles.setStatus(p.id, 'needs_attention', { last_error: 'checkpoint' });
        tripCheckpoint(repos, now);
        return;
      case 'error':
      default:
        repos.profiles.setStatus(p.id, 'failed', { last_error: outcome.error ?? 'unknown' });
        repos.events.recordEvent(p.id, 'failed');
        if (recordFailure(repos, outcome.error ?? 'unknown', now)) return;
        break;
    }
    if (remaining <= 0) break;
  }
}
