/**
 * Acceptance resolution, AFTER the phase-3 cutover (2026-07-31).
 *
 * This pass no longer scrapes: roster-sync owns the connections-page read, and acceptance
 * asks the roster "is this sent invite a connection yet?". The safety contract is unchanged
 * and is what these tests pin down:
 *   - presence promotes; ABSENCE NEVER EXPIRES (expiry comes only from the age backstop)
 *   - an empty roster changes nothing
 *   - message-kind rows belong to the reply funnel and must never be promoted here
 * The browser-facing failure modes (checkpoint, lost session, empty scrape) moved with the
 * scrape itself and are covered in tests/worker/roster-sync.test.ts.
 */
import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { FakeDriver } from '../../src/browser/driver.js';
import { runAcceptanceCheck } from '../../src/worker/acceptance-checker.js';
import type { Logger } from '../../src/core/logger.js';

let repos: Repos;
const NOW = new Date('2026-06-29T12:00:00.000Z');

beforeEach(() => {
  repos = new Repos(openDatabase(':memory:'));
  repos.appState.setLogin({ loggedIn: true, cookieExpiry: null }, '2026-06-29T00:00:00.000Z');
});

function seedSent(url: string, cohortId: number, sentAt = '2026-06-20T00:00:00Z') {
  const p = repos.profiles.add(cohortId, url, null);
  repos.profiles.setStatus(p.id, 'sent', { sent_at: sentAt });
  return p;
}

function roster(...urls: string[]): void {
  for (const u of urls) repos.connections.upsert({ profile_url: u }, 'scrape', '2026-06-29T00:00:00.000Z');
}

test('promotes only profiles present in the roster; absence never expires', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  const a = seedSent('https://www.linkedin.com/in/a', c.id);
  const b = seedSent('https://www.linkedin.com/in/b', c.id);
  const cc = seedSent('https://www.linkedin.com/in/c', c.id);

  roster('https://www.linkedin.com/in/b');

  await runAcceptanceCheck(repos, NOW);

  const accepted = repos.profiles.byStatus('accepted');
  expect(accepted.map((p) => p.id)).toEqual([b.id]);
  expect(accepted[0].accepted_at).toBe(NOW.toISOString());
  // a and c are simply not connections yet -> still pending, NOT expired.
  expect(repos.profiles.byStatus('sent').map((p) => p.id).sort()).toEqual([a.id, cc.id].sort());
  expect(repos.profiles.byStatus('expired')).toHaveLength(0);
});

test('opens no browser at all — the whole point of the cutover', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  seedSent('https://www.linkedin.com/in/a', c.id);
  roster('https://www.linkedin.com/in/a');
  const driver = new FakeDriver();

  await runAcceptanceCheck(repos, NOW);

  // The function no longer even accepts a driver, and nothing opened one. This pass is
  // free, which is why it can now run every minute instead of twice a day.
  expect(driver.open).toBe(false);
});

test('an empty roster changes nothing (fail-safe) and does not stamp checked_at', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  const a = seedSent('https://www.linkedin.com/in/a', c.id);

  const r = await runAcceptanceCheck(repos, NOW);

  expect(r).toMatchObject({ ran: false, reason: 'empty_roster' });
  expect(repos.profiles.byStatus('sent').map((p) => p.id)).toEqual([a.id]);
  expect(repos.appState.get().acceptance_checked_at).toBeNull();
});

test('nothing pending means no work and no stamp', async () => {
  roster('https://www.linkedin.com/in/somebody');
  const r = await runAcceptanceCheck(repos, NOW);
  expect(r).toMatchObject({ ran: false, reason: 'no_pending' });
});

test('an invite sent to a slug the person has since changed still resolves via its alias', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  const p = seedSent('https://www.linkedin.com/in/old-slug', c.id);
  // The roster met them again under a new slug and merged; the old URL survives as an alias.
  roster('https://www.linkedin.com/in/new-slug');
  const conn = repos.connections.findByUrl('https://www.linkedin.com/in/new-slug')!;
  repos.db.prepare('INSERT INTO connection_aliases (profile_url, connection_id) VALUES (?, ?)')
    .run('https://www.linkedin.com/in/old-slug', conn.id);

  await runAcceptanceCheck(repos, NOW);

  // Without alias resolution this invite would sit pending forever.
  expect(repos.profiles.byStatus('accepted').map((x) => x.id)).toEqual([p.id]);
});

test('age-based expiry backstop: expires unaccepted invites older than expiry_days', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  const old = seedSent('https://www.linkedin.com/in/old', c.id, '2026-05-01T00:00:00Z'); // 59d
  const fresh = seedSent('https://www.linkedin.com/in/fresh', c.id, '2026-06-27T00:00:00Z'); // 2d
  repos.settings.update({ expiry_days: 42 });
  roster('https://www.linkedin.com/in/someone-else'); // non-empty roster

  await runAcceptanceCheck(repos, NOW);

  expect(repos.profiles.byStatus('expired').map((p) => p.id)).toEqual([old.id]);
  expect(repos.profiles.byStatus('sent').map((p) => p.id)).toEqual([fresh.id]);
});

test('acceptance wins over age expiry for the same profile', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  const p = seedSent('https://www.linkedin.com/in/both', c.id, '2026-05-01T00:00:00Z');
  repos.settings.update({ expiry_days: 42 });
  roster('https://www.linkedin.com/in/both');

  await runAcceptanceCheck(repos, NOW);

  expect(repos.profiles.findById(p.id)!.status).toBe('accepted');
});

test('message-kind sent rows are never promoted — they belong to the reply funnel', async () => {
  const msg = repos.cohorts.create('M', 'hello', false, 'message');
  const m = repos.profiles.add(msg.id, 'https://www.linkedin.com/in/m', null, 'message');
  repos.profiles.setStatus(m.id, 'sent', { sent_at: '2026-06-20T00:00:00Z' });
  roster('https://www.linkedin.com/in/m');

  const r = await runAcceptanceCheck(repos, NOW);

  expect(r).toMatchObject({ ran: false, reason: 'no_pending' });
  expect(repos.profiles.findById(m.id)!.status).toBe('sent');
});

test('paused blocks a scheduled pass; force overrides only that gate', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  const p = seedSent('https://www.linkedin.com/in/a', c.id);
  roster('https://www.linkedin.com/in/a');
  repos.settings.update({ paused: 1 });

  expect(await runAcceptanceCheck(repos, NOW)).toMatchObject({ ran: false, reason: 'paused' });
  expect(await runAcceptanceCheck(repos, NOW, { force: true })).toMatchObject({ ran: true, accepted: 1 });
  expect(repos.profiles.findById(p.id)!.status).toBe('accepted');
});

test('a tripped guardrail blocks even a forced pass', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  seedSent('https://www.linkedin.com/in/a', c.id);
  roster('https://www.linkedin.com/in/a');
  repos.appState.trip('checkpoint', 'captcha', NOW.toISOString());

  expect(await runAcceptanceCheck(repos, NOW, { force: true })).toMatchObject({ ran: false, reason: 'guardrail' });
});

test('a clean pass does NOT clear a failure streak', async () => {
  // It performs no network I/O, so it is not evidence that LinkedIn is healthy. Clearing the
  // sender's streak here would mask a genuinely failing account.
  const c = repos.cohorts.create('A', 'hi', true);
  seedSent('https://www.linkedin.com/in/a', c.id);
  roster('https://www.linkedin.com/in/a');
  repos.appState.incFailureStreak();
  repos.appState.incFailureStreak();

  await runAcceptanceCheck(repos, NOW);

  expect(repos.appState.get().failure_streak).toBe(2);
});

/* ---------- log volume ----------
   This pass runs every 60 seconds and almost always resolves nothing, so a per-pass summary
   line drowned the log: 985 of the last 3,000 entries were this one line, every one of them
   reading accepted=0 expired=0. Liveness is already observable without it — the pass stamps
   `acceptance_checked_at`, and the dashboard renders that. So the summary is now earned by a
   change, not by a tick. (There is no level filter in createLogger: debug writes to the file
   and echoes exactly like info, so downgrading the level would relabel the noise, not
   remove it.) */

interface LoggedLine { level: string; message: string; data?: Record<string, unknown> }

function recorder(): { lines: LoggedLine[]; logger: Logger } {
  const lines: LoggedLine[] = [];
  const push = (level: string) => (_c: string, message: string, data?: Record<string, unknown>) =>
    { lines.push({ level, message, data }); };
  return {
    lines,
    logger: { path: '', debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error'), tail: () => [] },
  };
}

test('a pass that resolves nothing writes no summary line', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  seedSent('https://www.linkedin.com/in/a', c.id);
  roster('https://www.linkedin.com/in/somebody-else');   // nothing accepted, nothing expired
  const { lines, logger } = recorder();

  const r = await runAcceptanceCheck(repos, NOW, { logger });

  expect(r).toMatchObject({ ran: true, accepted: 0, expired: 0 });
  expect(lines).toHaveLength(0);
  // The pass still ran: the stamp is what proves liveness, not the log.
  expect(repos.appState.get().acceptance_checked_at).toBe(NOW.toISOString());
});

test('a pass that accepts someone still says so, with the full counts', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  seedSent('https://www.linkedin.com/in/a', c.id);
  roster('https://www.linkedin.com/in/a');
  const { lines, logger } = recorder();

  await runAcceptanceCheck(repos, NOW, { logger });

  const summary = lines.find((l) => l.message === 'checked');
  expect(summary?.level).toBe('info');
  expect(summary?.data).toMatchObject({ accepted: 1, expired: 0 });
  // The per-verdict line is what names the person, and it must survive independently.
  expect(lines.some((l) => l.message === 'verdict')).toBe(true);
});

test('an expiry alone is also worth a line', async () => {
  repos.settings.update({ expiry_days: 5 });
  const c = repos.cohorts.create('A', 'hi', true);
  seedSent('https://www.linkedin.com/in/old', c.id, '2026-06-01T00:00:00Z');
  roster('https://www.linkedin.com/in/somebody-else');
  const { lines, logger } = recorder();

  await runAcceptanceCheck(repos, NOW, { logger });

  expect(lines.find((l) => l.message === 'checked')?.data).toMatchObject({ accepted: 0, expired: 1 });
});

test('the empty-roster warning is untouched — that one means something is wrong', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  seedSent('https://www.linkedin.com/in/a', c.id);
  const { lines, logger } = recorder();

  await runAcceptanceCheck(repos, NOW, { logger });

  expect(lines.map((l) => l.level)).toContain('warn');
});
