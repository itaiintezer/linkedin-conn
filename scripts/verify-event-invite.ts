/**
 * End-to-end verification for the event-invite pipeline, against the real browser and
 * the real database.
 *
 * Default is a DRY run: it drives the whole flow — attend, Share -> Invite, resolve the
 * geo, page the list, tick the matches, assert the counter — and then discards the
 * selection without submitting. Nothing is sent.
 *
 * Pass --live to actually dispatch invitations. That is irreversible.
 *
 * Run with the app STOPPED (the browser profile is single-instance):
 *   npx tsx scripts/verify-event-invite.ts <eventUrl> <slug,slug> [--live]
 */
import { openDatabase } from '../src/db/database.js';
import { Repos } from '../src/db/repositories.js';
import { LinkedInDriver } from '../src/browser/linkedin-driver.js';
import { createEventCampaign, armEventCampaign } from '../src/worker/event-campaign.js';
import { runEventCampaign } from '../src/worker/event-runner.js';
import { normalizeEventUrl } from '../src/core/event-page.js';
import { DB_PATH } from '../src/config.js';

const args = process.argv.slice(2);
const live = args.includes('--live');
const [eventUrlRaw, slugCsv] = args.filter((a) => !a.startsWith('--'));
if (!eventUrlRaw || !slugCsv) {
  console.error('usage: verify-event-invite.ts <eventUrl> <slug,slug> [--live]');
  process.exit(1);
}
const eventUrl = normalizeEventUrl(eventUrlRaw);
if (eventUrl === null) { console.error('not an event URL'); process.exit(1); }

const urls = slugCsv.split(',').map((s) => `https://www.linkedin.com/in/${s.trim()}`);
const repos = new Repos(openDatabase(DB_PATH));
const driver = new LinkedInDriver();

function report(eventId: number): void {
  const ev = repos.eventCampaigns.findById(eventId)!;
  console.log('\n--- campaign ---');
  console.log({
    id: ev.id, status: ev.status, title: ev.title, startsAt: ev.starts_at,
    attended: ev.attended, cursor: ev.bucket_cursor, cap: ev.invite_cap,
  });
  console.log('counts:', repos.eventInvitees.countsByStatus(eventId));
  console.log('buckets:', repos.eventBuckets.list(eventId).map((b) => ({
    rank: b.rank, label: b.label, geo: b.geo_label, targets: b.target_count,
    roster: b.roster_count, status: b.status,
  })));
  for (const run of repos.eventRuns.listForEvent(eventId).slice(0, 2)) {
    console.log(`run #${run.id} [${run.mode}] ${run.outcome ?? 'running'} invited=${run.invited_count}`,
      run.error ? `error=${run.error}` : '');
    console.log('  progress:', repos.eventRuns.bucketProgress(run.id).map((p) => ({
      bucket: p.bucket_id, rows: p.rows_loaded, matched: p.matched,
      ticked: p.ticked, submitted: p.submitted, outcome: p.outcome,
    })));
  }
  console.log('invitees:', repos.eventInvitees.list(eventId).map((i) => ({
    name: i.full_name, status: i.status, invitedAt: i.invited_at, note: i.note,
  })));
}

try {
  let event = repos.eventCampaigns.findByUrl(eventUrl);
  if (!event) {
    const created = createEventCampaign(repos, eventUrl, urls);
    if ('error' in created) throw new Error(created.error);
    console.log('created:', {
      added: created.added, rejected: created.rejected,
      unreachable: created.unreachable, buckets: created.bucketCount,
    });
    event = created.event;
  } else {
    console.log(`reusing existing campaign #${event.id} (${event.status})`);
  }

  if (event.status === 'draft') {
    const armed = armEventCampaign(repos, event.id, new Date());
    if (!armed.ok) throw new Error(armed.error);
    console.log('armed');
    event = repos.eventCampaigns.findById(event.id)!;
  }

  const snap = await driver.readLoginState();
  repos.appState.setLogin(snap, new Date().toISOString());
  if (!snap.loggedIn) throw new Error('not logged in — start the app and sign in first');

  console.log(`\nrunning ${live ? 'LIVE (invitations WILL be sent)' : 'DRY (nothing will be sent)'}…`);
  const summary = await runEventCampaign(repos, driver, event, {
    mode: live ? 'live' : 'dry',
    deadline: new Date(Date.now() + 25 * 60 * 1000),
  });
  console.log('\nsummary:', summary);
  report(event.id);
} catch (e) {
  console.error('[verify-event-invite] ERROR:', (e as Error).message);
  process.exitCode = 1;
} finally {
  await driver.close();
}
