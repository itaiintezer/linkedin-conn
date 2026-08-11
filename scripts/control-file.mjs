/**
 * data/control.json — the one piece of state that survives a restart.
 *
 * The dashboard asks the app to update; the app writes a request here and exits; the supervisor
 * reads it, does the work, records the outcome, and starts the app again. By then the browser is
 * talking to a *different process* than the one it asked, so without this file there would be no
 * way to tell "updated, 5 changes" apart from "crashed and came back on the old code".
 *
 * Lives in scripts/ rather than src/ because it is the supervisor↔app contract and the
 * supervisor must run on a bare Node with zero dependencies — so this file is plain ESM, and
 * control-file.d.mts is what lets the TypeScript server import it. One definition of the state
 * machine, used by both sides.
 *
 * States: requested → running → done | failed.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const CONTROL_FILE = 'control.json';

export function controlPath(dataDir) {
  return join(dataDir, CONTROL_FILE);
}

/** null when absent or unreadable — a corrupt control file must never crash either side. */
export function readControl(dataDir) {
  try {
    const raw = readFileSync(controlPath(dataDir), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Written via a temp file and renamed. A reader polling this file every second would otherwise
 * eventually catch a half-written one, and the dashboard would report nonsense at exactly the
 * moment the operator is watching it most closely.
 */
export function writeControl(dataDir, control) {
  mkdirSync(dataDir, { recursive: true });
  const target = controlPath(dataDir);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(control, null, 2) + '\n');
  renameSync(tmp, target);
  return control;
}

export function clearControl(dataDir) {
  const target = controlPath(dataDir);
  if (existsSync(target)) writeControl(dataDir, { ...(readControl(dataDir) ?? {}), status: 'done' });
}

// ---------------------------------------------------------------------------
// Pure transitions
// ---------------------------------------------------------------------------

/** A fresh request from the dashboard. `action` is 'update' or 'restart'. */
export function newRequest(action, nowIso) {
  return {
    action,
    status: 'requested',
    requested_at: nowIso,
    finished_at: null,
    from_sha: null,
    to_sha: null,
    changes: [],
    error: null,
    unchanged: false,
  };
}

export function markRunning(control, nowIso) {
  return { ...control, status: 'running', started_at: nowIso };
}

export function markDone(control, { from = null, to = null, changes = [], unchanged = false } = {}, nowIso) {
  return { ...control, status: 'done', finished_at: nowIso, from_sha: from, to_sha: to, changes, unchanged, error: null };
}

export function markFailed(control, error, nowIso) {
  return { ...control, status: 'failed', finished_at: nowIso, error: String(error ?? 'unknown error') };
}

/** True while the supervisor still owes this request an outcome. */
export function isPending(control) {
  return control?.status === 'requested' || control?.status === 'running';
}

/**
 * The sentence the dashboard shows. Plain language, no status codes — this is read by someone
 * who clicked a button and wants to know whether it worked.
 */
export function summarizeControl(control) {
  if (!control) return { state: 'idle', message: '' };
  const n = Array.isArray(control.changes) ? control.changes.length : 0;

  if (control.status === 'requested' || control.status === 'running') {
    return {
      state: 'busy',
      message: control.action === 'update' ? 'Updating The Machine…' : 'Restarting The Machine…',
    };
  }
  if (control.status === 'failed') {
    return {
      state: 'failed',
      message: control.action === 'update'
        ? `The update did not finish, so The Machine is still running the version it was on. ${control.error ?? ''}`.trim()
        : `The restart ran into a problem. ${control.error ?? ''}`.trim(),
    };
  }
  if (control.action === 'restart') return { state: 'done', message: 'Restarted.' };
  if (control.unchanged) return { state: 'done', message: 'Already up to date — there was nothing new to install.' };
  return {
    state: 'done',
    message: n > 0
      ? `Updated — ${n} new change${n === 1 ? '' : 's'} installed.`
      : 'Updated.',
  };
}
